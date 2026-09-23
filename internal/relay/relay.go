// Package relay implements NiCon's local relay: a WebSocket<->RCON bridge
// backed by internal/store's MariaDB persistence.
//
// Everything else NiCon used to serve from here — accounts, registration,
// per-user server CRUD, the admin panel — now lives in webspace/, a PHP
// API meant for an always-on host (e.g. shared webspace), since none of it
// actually needs the relay to be running. This relay's only remaining job
// is the one thing that does need a persistent local process: bridging a
// browser WebSocket to a game server's RCON port. See the README's
// "Cloud API vs. relay" section for the split.
//
// A WebSocket "connect" message references a server by ID; the relay
// looks up and decrypts its credentials itself (internal/store, sharing
// the same database and encryption key as the PHP API) rather than
// trusting the client, and confirms the session token's owner matches
// before doing so.
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

// cors applies the same allow-list to plain HTTP requests (just /healthz
// now) and handles the CORS preflight. It returns false if the caller
// should stop (preflight already answered).
func (rel *Relay) cors(w http.ResponseWriter, r *http.Request) bool {
	origin := r.Header.Get("Origin")
	if origin != "" && rel.allowedOrigins[origin] {
		w.Header().Set("Access-Control-Allow-Origin", origin)
		w.Header().Set("Access-Control-Allow-Methods", "GET, OPTIONS")
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
	mux.HandleFunc("OPTIONS /healthz", rel.handleHealth)
	mux.HandleFunc("GET /ws/rcon", rel.handleWS)
	return mux
}

func (rel *Relay) handleHealth(w http.ResponseWriter, r *http.Request) {
	if !rel.cors(w, r) {
		return
	}
	_, _ = w.Write([]byte("ok"))
}
