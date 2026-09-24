package relay

import (
	"errors"
	"fmt"
	"net/http"
	"sync"
	"time"

	"github.com/gorcon/rcon"
	"github.com/gorilla/websocket"

	"github.com/niKaphalor/NiCon/internal/store"
)

// wsMessage is the JSON protocol spoken over the WebSocket connection.
//
// Client -> relay: first {"type":"auth", token} (must be a valid session
// token from /api/login), then any number of {"type":"connect", server_id}
// / {"type":"command", command}. "connect" takes only a server ID — the
// relay looks up that server's host/port/password/protocol itself (and
// checks it belongs to the authenticated user) rather than trusting
// whatever the client sends, so a compromised client can't be pointed at
// an arbitrary host with someone else's stored password.
//
// Relay -> client: {"type":"authenticated"} / {"type":"connected"} /
// {"type":"response", output} / {"type":"error", message} /
// {"type":"broadcast", output} — the last is WebRCON-only: messages the
// game server pushes unsolicited over the same connection (chat, kill
// feed, log lines), not a response to any command the client sent.
type wsMessage struct {
	Type     string `json:"type"`
	Token    string `json:"token,omitempty"`
	ServerID int64  `json:"server_id,omitempty"`
	Command  string `json:"command,omitempty"`
	Output   string `json:"output,omitempty"`
	Message  string `json:"message,omitempty"`
}

// gameConn abstracts over the RCON transports NiCon speaks: classic
// Source RCON (*rcon.Conn, which already satisfies this), WebRCON
// (*webRconConn), Palworld's REST API (*palworldRestConn), and BattlEye
// RCon (*battleyeConn, Arma 3 and DayZ).
type gameConn interface {
	Execute(command string) (string, error)
	Close() error
}

// maxWSMessageBytes bounds a single incoming WebSocket message (the JSON
// auth/connect/command envelope — never the game server's own response,
// which the relay itself reads and re-wraps). Every message this protocol
// actually sends is short text, so this only exists to stop a compromised
// or malicious client from holding an oversized frame in memory;
// gorilla/websocket closes the connection outright if it's exceeded.
const maxWSMessageBytes = 64 * 1024

// maxCommandLength is enforced separately, with a normal {"type":"error"}
// reply rather than dropping the connection, so a client that fat-fingers
// a long paste into the console gets a clear message instead of just
// being disconnected by the read-limit check above.
const maxCommandLength = 8000

// pongWait/pingPeriod/writeWait implement the standard gorilla/websocket
// heartbeat: without it, a connection whose network path drops silently
// (a laptop put to sleep, a NAT/proxy that stops forwarding packets, a
// crashed browser tab) stays "open" from the relay's point of view
// forever — nothing here is exchanged unless the user issues a command —
// pinning down a maxConnsPerUser slot and an upstream RCON connection
// indefinitely. pingPeriod must be well under pongWait so a couple of
// missed pings (not just one) trip the deadline before it expires.
const (
	pongWait   = 60 * time.Second
	pingPeriod = (pongWait * 9) / 10
	writeWait  = 10 * time.Second
)

func connectGame(srv store.Server) (gameConn, error) {
	switch srv.Protocol {
	case "webrcon":
		return dialWebRcon(srv.Host, srv.Port, srv.Password)
	case "palworld_rest":
		return dialPalworldRest(srv.Host, srv.Port, srv.Password)
	case "battleye":
		return dialBattleye(srv.Host, srv.Port, srv.Password)
	default:
		address := fmt.Sprintf("%s:%d", srv.Host, srv.Port)
		return rcon.Dial(address, srv.Password)
	}
}

func (rel *Relay) handleWS(w http.ResponseWriter, r *http.Request) {
	conn, err := rel.upgrader.Upgrade(w, r, nil)
	if err != nil {
		rel.log.Printf("ws upgrade: %v", err)
		return
	}
	defer conn.Close()
	conn.SetReadLimit(maxWSMessageBytes)

	// Heartbeat: a missing pong within pongWait means the peer is gone
	// (even if TCP hasn't noticed yet), so ReadJSON below returns an error
	// and the handler cleans up instead of holding the connection — and
	// its maxConnsPerUser slot — open forever.
	_ = conn.SetReadDeadline(time.Now().Add(pongWait))
	conn.SetPongHandler(func(string) error {
		return conn.SetReadDeadline(time.Now().Add(pongWait))
	})

	// The main loop below, the ping ticker, and the broadcast-forwarding
	// goroutine (started on "connect" for WebRCON) can all write to conn;
	// gorilla/websocket allows only one writer at a time.
	var writeMu sync.Mutex
	writeJSON := func(msg wsMessage) error {
		writeMu.Lock()
		defer writeMu.Unlock()
		_ = conn.SetWriteDeadline(time.Now().Add(writeWait))
		return conn.WriteJSON(msg)
	}

	connDone := make(chan struct{})
	defer close(connDone)
	go func() {
		ticker := time.NewTicker(pingPeriod)
		defer ticker.Stop()
		for {
			select {
			case <-ticker.C:
				writeMu.Lock()
				_ = conn.SetWriteDeadline(time.Now().Add(writeWait))
				err := conn.WriteMessage(websocket.PingMessage, nil)
				writeMu.Unlock()
				if err != nil {
					return
				}
			case <-connDone:
				return
			}
		}
	}()

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

	// The connection must authenticate before doing anything else.
	var userID int64
	{
		var msg wsMessage
		if err := conn.ReadJSON(&msg); err != nil {
			return
		}
		if msg.Type != "auth" {
			_ = writeJSON(wsMessage{Type: "error", Message: "must authenticate first"})
			return
		}
		uid, err := rel.auth.Authenticate(r.Context(), msg.Token)
		if err != nil {
			_ = writeJSON(wsMessage{Type: "error", Message: "unauthorized"})
			return
		}
		if !rel.acquireConn(uid) {
			_ = writeJSON(wsMessage{Type: "error", Message: "too many open connections for this account"})
			return
		}
		defer rel.releaseConn(uid)
		userID = uid
		_ = writeJSON(wsMessage{Type: "authenticated"})
	}

	for {
		var msg wsMessage
		if err := conn.ReadJSON(&msg); err != nil {
			return
		}

		switch msg.Type {
		case "connect":
			disconnect()

			srv, err := rel.store.GetServer(r.Context(), userID, msg.ServerID)
			if err != nil {
				if errors.Is(err, store.ErrNotFound) {
					_ = writeJSON(wsMessage{Type: "error", Message: "server not found"})
				} else {
					rel.log.Printf("ws connect: get server: %v", err)
					_ = writeJSON(wsMessage{Type: "error", Message: "internal error"})
				}
				continue
			}
			if srv.Password == "" {
				_ = writeJSON(wsMessage{Type: "error", Message: "no RCON password set for this server yet"})
				continue
			}

			newConn, dialErr := connectGame(*srv)
			if dialErr != nil {
				_ = writeJSON(wsMessage{Type: "error", Message: dialErr.Error()})
				continue
			}
			gc = newConn
			_ = writeJSON(wsMessage{Type: "connected"})

			// WebRCON (Rust) and BattlEye (Arma 3, DayZ) both push
			// messages unsolicited over the same connection — chat/log
			// lines, or player join/leave notices — forward those to the
			// browser live rather than only ever responding to commands.
			var broadcast <-chan string
			if wrc, ok := newConn.(*webRconConn); ok {
				broadcast = wrc.Broadcast
			} else if bc, ok := newConn.(*battleyeConn); ok {
				broadcast = bc.Broadcast
			}
			if broadcast != nil {
				done := make(chan struct{})
				stopBroadcast = func() { close(done) }
				go func() {
					for {
						select {
						case line, ok := <-broadcast:
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
			if len(msg.Command) > maxCommandLength {
				_ = writeJSON(wsMessage{Type: "error", Message: fmt.Sprintf("command too long (max %d characters)", maxCommandLength)})
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
