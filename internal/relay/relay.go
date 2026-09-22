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
// Client -> relay: {"type":"connect", host, port, password} then any number
// of {"type":"command", command}.
// Relay -> client: {"type":"connected"} / {"type":"response", output} /
// {"type":"error", message}.
type wsMessage struct {
	Type     string `json:"type"`
	Host     string `json:"host,omitempty"`
	Port     int    `json:"port,omitempty"`
	Password string `json:"password,omitempty"`
	Command  string `json:"command,omitempty"`
	Output   string `json:"output,omitempty"`
	Message  string `json:"message,omitempty"`
}

func (rel *Relay) handleWS(w http.ResponseWriter, r *http.Request) {
	conn, err := rel.upgrader.Upgrade(w, r, nil)
	if err != nil {
		rel.log.Printf("ws upgrade: %v", err)
		return
	}
	defer conn.Close()

	var rc *rcon.Conn
	defer func() {
		if rc != nil {
			rc.Close()
		}
	}()

	for {
		var msg wsMessage
		if err := conn.ReadJSON(&msg); err != nil {
			return
		}

		switch msg.Type {
		case "connect":
			if rc != nil {
				rc.Close()
				rc = nil
			}
			address := fmt.Sprintf("%s:%d", msg.Host, msg.Port)
			rc, err = rcon.Dial(address, msg.Password)
			if err != nil {
				_ = conn.WriteJSON(wsMessage{Type: "error", Message: err.Error()})
				continue
			}
			_ = conn.WriteJSON(wsMessage{Type: "connected"})

		case "command":
			if rc == nil {
				_ = conn.WriteJSON(wsMessage{Type: "error", Message: "not connected"})
				continue
			}
			output, execErr := rc.Execute(msg.Command)
			if execErr != nil {
				_ = conn.WriteJSON(wsMessage{Type: "error", Message: execErr.Error()})
				rc.Close()
				rc = nil
				continue
			}
			_ = conn.WriteJSON(wsMessage{Type: "response", Output: output})

		default:
			_ = conn.WriteJSON(wsMessage{Type: "error", Message: "unknown message type: " + msg.Type})
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
		if !gs.GameSpecific.Features.HasRcon || gs.RconPort == 0 || gs.IP == "" {
			continue
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
		})
	}

	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(result)
}
