package relay

import (
	"errors"
	"fmt"
	"net/http"
	"sync"

	"github.com/gorcon/rcon"

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

// gameConn abstracts over the two RCON transports NiCon speaks: classic
// Source RCON (*rcon.Conn, which already satisfies this) and WebRCON
// (*webRconConn).
type gameConn interface {
	Execute(command string) (string, error)
	Close() error
}

func connectGame(srv store.Server) (gameConn, error) {
	if srv.Protocol == "webrcon" {
		c, err := dialWebRcon(srv.Host, srv.Port, srv.Password)
		if err != nil {
			return nil, err
		}
		return c, nil
	}
	address := fmt.Sprintf("%s:%d", srv.Host, srv.Port)
	c, err := rcon.Dial(address, srv.Password)
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
