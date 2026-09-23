// Package relay implements NiCon's local relay: a WebSocket<->RCON bridge,
// a Nitrado API proxy, and the HTTP API for accounts and each user's
// server list (backed by internal/store's MariaDB persistence).
//
// Every server-scoped operation is authenticated first and then scoped to
// that user's own rows in the database — a user can never see, edit, or
// connect through another user's server, enforced by the query itself
// (internal/store), not just hidden in the UI. RCON passwords are stored
// encrypted (internal/store/crypto.go) and, once saved, never need to
// travel back to the browser: WebSocket "connect" messages reference a
// server by ID, and the relay looks up and decrypts its credentials
// server-side.
package relay

import (
	"log"
	"net/http"

	"github.com/gorilla/websocket"

	"github.com/niKaphalor/NiCon/internal/auth"
	"github.com/niKaphalor/NiCon/internal/store"
)

type Relay struct {
	log            *log.Logger
	allowedOrigins map[string]bool
	upgrader       websocket.Upgrader
	store          *store.Store
	auth           *auth.Auth
}

func New(logger *log.Logger, allowedOrigins []string, st *store.Store, au *auth.Auth) *Relay {
	origins := make(map[string]bool, len(allowedOrigins))
	for _, o := range allowedOrigins {
		origins[o] = true
	}
	rel := &Relay{log: logger, allowedOrigins: origins, store: st, auth: au}
	rel.upgrader = websocket.Upgrader{CheckOrigin: rel.checkOrigin}
	return rel
}

// checkOrigin restricts who can open a WebSocket to this relay. Without it,
// any web page open in the same browser could connect to
// ws://localhost:<port> and issue RCON commands through it. Non-browser
// clients (curl, scripts) send no Origin header and are allowed through,
// since Origin checks only guard against unwanted *browser* pages.
func (rel *Relay) checkOrigin(r *http.Request) bool {
	origin := r.Header.Get("Origin")
	if origin == "" {
		return true
	}
	return rel.allowedOrigins[origin]
}

// cors applies the same allow-list to plain HTTP requests and handles the
// CORS preflight. It returns false if the caller should stop (preflight
// already answered).
func (rel *Relay) cors(w http.ResponseWriter, r *http.Request) bool {
	origin := r.Header.Get("Origin")
	if origin != "" && rel.allowedOrigins[origin] {
		w.Header().Set("Access-Control-Allow-Origin", origin)
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type, Authorization")
	}
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusNoContent)
		return false
	}
	return true
}

func (rel *Relay) Routes() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", rel.handleHealth)
	mux.HandleFunc("GET /ws/rcon", rel.handleWS)

	mux.HandleFunc("POST /api/login", rel.handleLogin)
	mux.HandleFunc("OPTIONS /api/login", rel.handleLogin)
	mux.HandleFunc("POST /api/logout", rel.handleLogout)
	mux.HandleFunc("OPTIONS /api/logout", rel.handleLogout)
	mux.HandleFunc("POST /api/register", rel.handleRegister)
	mux.HandleFunc("OPTIONS /api/register", rel.handleRegister)
	mux.HandleFunc("DELETE /api/account", rel.handleDeleteAccount)
	mux.HandleFunc("OPTIONS /api/account", rel.handleDeleteAccount)

	mux.HandleFunc("GET /api/servers", rel.handleListServers)
	mux.HandleFunc("OPTIONS /api/servers", rel.handleListServers)
	mux.HandleFunc("POST /api/servers", rel.handleCreateServer)
	mux.HandleFunc("PUT /api/servers/{id}/password", rel.handleSetServerPassword)
	mux.HandleFunc("OPTIONS /api/servers/{id}/password", rel.handleSetServerPassword)
	mux.HandleFunc("DELETE /api/servers/{id}", rel.handleDeleteServer)
	mux.HandleFunc("OPTIONS /api/servers/{id}", rel.handleDeleteServer)

	mux.HandleFunc("POST /api/nitrado/sync", rel.handleNitradoSync)
	mux.HandleFunc("OPTIONS /api/nitrado/sync", rel.handleNitradoSync)

	return mux
}

func (rel *Relay) handleHealth(w http.ResponseWriter, r *http.Request) {
	if !rel.cors(w, r) {
		return
	}
	_, _ = w.Write([]byte("ok"))
}

// authenticateRequest resolves the "Authorization: Bearer <token>" header
// to a user ID, or writes a 401 and returns ok=false.
func (rel *Relay) authenticateRequest(w http.ResponseWriter, r *http.Request) (userID int64, ok bool) {
	tokenHeader := r.Header.Get("Authorization")
	const prefix = "Bearer "
	if len(tokenHeader) <= len(prefix) || tokenHeader[:len(prefix)] != prefix {
		http.Error(w, "missing bearer token", http.StatusUnauthorized)
		return 0, false
	}
	token := tokenHeader[len(prefix):]

	userID, err := rel.auth.Authenticate(r.Context(), token)
	if err != nil {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return 0, false
	}
	return userID, true
}
