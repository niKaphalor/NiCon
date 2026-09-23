// Package relay implements NiCon's local relay: a WebSocket<->RCON bridge
// plus a thin HTTP proxy for the Nitrado API. It exists because browser
// JavaScript cannot open raw TCP sockets (required for the Source RCON
// protocol) and shouldn't hold a Nitrado API token across a CORS boundary
// with unknown support. The relay stores nothing: every WebSocket session's
// RCON connection and every Nitrado sync request are scoped to that single
// request/connection and hold no state on disk.
package relay

import (
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"strings"
	"sync"

	"github.com/gorcon/rcon"
	"github.com/gorilla/websocket"

	"github.com/niKaphalor/NiCon/internal/nitrado"
)

type Relay struct {
	log            *log.Logger
	allowedOrigins map[string]bool
	upgrader       websocket.Upgrader
}

func New(logger *log.Logger, allowedOrigins []string) *Relay {
	origins := make(map[string]bool, len(allowedOrigins))
	for _, o := range allowedOrigins {
		origins[o] = true
	}
	rel := &Relay{log: logger, allowedOrigins: origins}
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
		w.Header().Set("Access-Control-Allow-Methods", "POST, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
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

// --- WebSocket RCON bridge ---

// wsMessage is the JSON protocol spoken over the WebSocket connection.
// Client -> relay: {"type":"connect", host, port, password, protocol} then
// any number of {"type":"command", command}. protocol is "source" (default,
// classic Source RCON over raw TCP) or "webrcon" (Rust's WebSocket-based
// RCON).
// Relay -> client: {"type":"connected"} / {"type":"response", output} /
// {"type":"error", message} / {"type":"broadcast", output} — the last is
// WebRCON-only: messages the game server pushes unsolicited over the same
// connection (chat, kill feed, log lines), not a response to any command
// the client sent.
type wsMessage struct {
	Type     string `json:"type"`
	Host     string `json:"host,omitempty"`
	Port     int    `json:"port,omitempty"`
	Password string `json:"password,omitempty"`
	Protocol string `json:"protocol,omitempty"`
	Command  string `json:"command,omitempty"`
	Output   string `json:"output,omitempty"`
	Message  string `json:"message,omitempty"`
}

// gameConn abstracts over the two RCON transports NiCon speaks: classic
// Source RCON (*rcon.Conn, which already satisfies this) and WebRCON
// (*webRconConn).
type gameConn interface {
	Execute(command string) (string, error)
	Close() error
}

func connectGame(msg wsMessage) (gameConn, error) {
	if msg.Protocol == "webrcon" {
		c, err := dialWebRcon(msg.Host, msg.Port, msg.Password)
		if err != nil {
			return nil, err
		}
		return c, nil
	}
	address := fmt.Sprintf("%s:%d", msg.Host, msg.Port)
	c, err := rcon.Dial(address, msg.Password)
	if err != nil {
		return nil, err
	}
	return c, nil
}

func (rel *Relay) handleWS(w http.ResponseWriter, r *http.Request) {
	conn, err := rel.upgrader.Upgrade(w, r, nil)
	if err != nil {
		rel.log.Printf("ws upgrade: %v", err)
		return
	}
	defer conn.Close()

	// The main loop below and the broadcast-forwarding goroutine (started
	// on "connect" for WebRCON) can both write to conn; gorilla/websocket
	// allows only one writer at a time.
	var writeMu sync.Mutex
	writeJSON := func(msg wsMessage) error {
		writeMu.Lock()
		defer writeMu.Unlock()
		return conn.WriteJSON(msg)
	}

	var gc gameConn
	var stopBroadcast func()
	disconnect := func() {
		if stopBroadcast != nil {
			stopBroadcast()
			stopBroadcast = nil
		}
		if gc != nil {
			gc.Close()
			gc = nil
		}
	}
	defer disconnect()

	for {
		var msg wsMessage
		if err := conn.ReadJSON(&msg); err != nil {
			return
		}

		switch msg.Type {
		case "connect":
			disconnect()

			newConn, dialErr := connectGame(msg)
			if dialErr != nil {
				_ = writeJSON(wsMessage{Type: "error", Message: dialErr.Error()})
				continue
			}
			gc = newConn
			_ = writeJSON(wsMessage{Type: "connected"})

			// WebRCON servers (Rust) push chat/log lines unsolicited over
			// the same connection; forward those to the browser live.
			if wrc, ok := newConn.(*webRconConn); ok {
				done := make(chan struct{})
				stopBroadcast = func() { close(done) }
				go func() {
					for {
						select {
						case line, ok := <-wrc.Broadcast:
							if !ok {
								return
							}
							_ = writeJSON(wsMessage{Type: "broadcast", Output: line})
						case <-done:
							return
						}
					}
				}()
			}

		case "command":
			if gc == nil {
				_ = writeJSON(wsMessage{Type: "error", Message: "not connected"})
				continue
			}
			output, execErr := gc.Execute(msg.Command)
			if execErr != nil {
				_ = writeJSON(wsMessage{Type: "error", Message: execErr.Error()})
				disconnect()
				continue
			}
			_ = writeJSON(wsMessage{Type: "response", Output: output})

		default:
			_ = writeJSON(wsMessage{Type: "error", Message: "unknown message type: " + msg.Type})
		}
	}
}

// --- Nitrado sync (plain HTTP, so the frontend never needs the Nitrado
// token to be usable cross-origin from arbitrary JS beyond this one call) ---

type nitradoSyncRequest struct {
	Token string `json:"token"`
}

type nitradoServer struct {
	ServiceID int    `json:"service_id"`
	Name      string `json:"name"`
	Game      string `json:"game"`
	Host      string `json:"host"`
	Port      int    `json:"port"`
	Protocol  string `json:"protocol"` // "source" or "webrcon"
}

func (rel *Relay) handleNitradoSync(w http.ResponseWriter, r *http.Request) {
	if !rel.cors(w, r) {
		return
	}

	var req nitradoSyncRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.Token == "" {
		http.Error(w, "token is required", http.StatusBadRequest)
		return
	}

	ctx := r.Context()
	client := nitrado.NewClient(req.Token)
	services, err := client.ListServices(ctx)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadGateway)
		return
	}

	result := []nitradoServer{}
	for _, svc := range services {
		gs, err := client.GetGameserver(ctx, svc.ID)
		if err != nil {
			rel.log.Printf("nitrado sync: gameserver %d: %v", svc.ID, err)
			continue
		}
		// Rust doesn't use classic RCON at all - it has its own WebSocket-based
		// "WebRCON" protocol, so Nitrado's has_rcon flag likely doesn't (and
		// isn't expected to) cover it. Treat any Rust service as eligible on
		// host/port alone, and use the webrcon transport for it.
		isRust := strings.Contains(strings.ToLower(gs.GameHuman), "rust")
		hasConnectionInfo := gs.RconPort != 0 && gs.IP != ""
		eligible := (gs.GameSpecific.Features.HasRcon || isRust) && hasConnectionInfo

		if !eligible {
			rel.log.Printf(
				"nitrado sync: skipping service %d (%s, status=%s): has_rcon=%v rcon_port=%d ip=%q",
				svc.ID, gs.GameHuman, gs.Status, gs.GameSpecific.Features.HasRcon, gs.RconPort, gs.IP,
			)
			continue
		}

		protocol := "source"
		if isRust {
			protocol = "webrcon"
		}

		name := gs.Query.ServerName
		if name == "" {
			name = gs.GameHuman
		}
		result = append(result, nitradoServer{
			ServiceID: svc.ID,
			Name:      name,
			Game:      gs.GameHuman,
			Host:      gs.IP,
			Port:      gs.RconPort,
			Protocol:  protocol,
		})
	}

	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(result)
}
