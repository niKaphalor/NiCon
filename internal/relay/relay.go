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
	"sync"
	"time"

	"github.com/gorilla/websocket"

	"github.com/niKaphalor/NiCon/internal/auth"
	"github.com/niKaphalor/NiCon/internal/store"
)

// maxConnsPerUser bounds how many WebSocket/RCON connections one account
// can hold open at the same time. The WS handshake itself is cheap and
// otherwise uncapped per-user, so without this a compromised or scripted
// client could open connections until the relay ran out of file
// descriptors or upstream RCON sessions — this keeps that blast radius to
// one account's own share.
const maxConnsPerUser = 20

// queryTestLimit/queryTestWindow bound how often one account can trigger
// an on-demand "query_test" (ws.go) — an outbound A2S/Minecraft-Query UDP
// probe against a caller-supplied host:port, independent of any saved
// server or RCON credential. Without this, a single authenticated session
// could otherwise generate unlimited outbound UDP traffic toward an
// arbitrary third-party host just by repeating the request; 10/minute
// matches the existing nitrado-power rate limit's shape (see
// webspace/handlers/nitrado_sync.php).
const (
	queryTestLimit  = 10
	queryTestWindow = time.Minute
)

type Relay struct {
	log            *log.Logger
	allowedOrigins map[string]bool
	upgrader       websocket.Upgrader
	store          *store.Store
	auth           *auth.Auth

	connsMu     sync.Mutex
	connsByUser map[int64]int

	queryTestMu  sync.Mutex
	queryTestLog map[int64][]time.Time
}

func New(logger *log.Logger, allowedOrigins []string, st *store.Store, au *auth.Auth) *Relay {
	origins := make(map[string]bool, len(allowedOrigins))
	for _, o := range allowedOrigins {
		origins[o] = true
	}
	rel := &Relay{
		log: logger, allowedOrigins: origins, store: st, auth: au,
		connsByUser:  make(map[int64]int),
		queryTestLog: make(map[int64][]time.Time),
	}
	rel.upgrader = websocket.Upgrader{CheckOrigin: rel.checkOrigin}
	return rel
}

// queryTestAllowed reports whether userID may run another query_test right
// now, recording this attempt if so. A fixed sliding window over the last
// queryTestWindow, kept in memory per relay process (this doesn't need to
// survive a restart or be shared across instances — see maxConnsPerUser
// for the same reasoning applied to connection count).
func (rel *Relay) queryTestAllowed(userID int64) bool {
	rel.queryTestMu.Lock()
	defer rel.queryTestMu.Unlock()
	now := time.Now()
	var kept []time.Time
	for _, t := range rel.queryTestLog[userID] {
		if now.Sub(t) < queryTestWindow {
			kept = append(kept, t)
		}
	}
	if len(kept) >= queryTestLimit {
		rel.queryTestLog[userID] = kept
		return false
	}
	rel.queryTestLog[userID] = append(kept, now)
	return true
}

// acquireConn reserves one of userID's concurrent connection slots,
// returning false (and reserving nothing) if they already have
// maxConnsPerUser open.
func (rel *Relay) acquireConn(userID int64) bool {
	rel.connsMu.Lock()
	defer rel.connsMu.Unlock()
	if rel.connsByUser[userID] >= maxConnsPerUser {
		return false
	}
	rel.connsByUser[userID]++
	return true
}

// releaseConn frees a slot reserved by acquireConn. Must be called exactly
// once for every acquireConn that returned true.
func (rel *Relay) releaseConn(userID int64) {
	rel.connsMu.Lock()
	defer rel.connsMu.Unlock()
	rel.connsByUser[userID]--
	if rel.connsByUser[userID] <= 0 {
		delete(rel.connsByUser, userID)
	}
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
	// HSTS doesn't need to appear on every response to work — a browser
	// that's seen it once from this origin enforces HTTPS/WSS for
	// everything else on that origin, including the /ws/rcon upgrade this
	// function isn't involved in. /healthz is the one plain HTTP path in
	// this relay, so setting it here is enough to cover the whole origin.
	// This app transmits encrypted RCON credentials and bearer tokens, so
	// closing off a TLS-stripping downgrade is worth it even though the
	// relay itself sits behind Caddy rather than terminating TLS directly.
	w.Header().Set("Strict-Transport-Security", "max-age=31536000; includeSubDomains")
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
