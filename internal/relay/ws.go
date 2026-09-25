package relay

import (
	"errors"
	"fmt"
	"net"
	"net/http"
	"strings"
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
//
// {"type":"test", host, port, password, protocol} is the odd one out: it
// carries connection details directly rather than a server_id, for
// trying a set of credentials before they're saved as a server (the "Add
// server" form's Test Connection button) — there's no server_id yet to
// look them up by. Answered with {"type":"test_result", ok, message}
// (message set only when ok is false) and never leaves a connection
// open either way; it goes through connectGame() the same as "connect"
// does, so it's covered by the same metadata-host guard.
type wsMessage struct {
	Type     string `json:"type"`
	Token    string `json:"token,omitempty"`
	ServerID int64  `json:"server_id,omitempty"`
	Command  string `json:"command,omitempty"`
	Output   string `json:"output,omitempty"`
	Message  string `json:"message,omitempty"`
	Host     string `json:"host,omitempty"`
	Port     int    `json:"port,omitempty"`
	Password string `json:"password,omitempty"`
	Protocol string `json:"protocol,omitempty"`
	OK       bool   `json:"ok,omitempty"`
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

// blockedMetadataHosts/blockedMetadataIPs mirror
// webspace/handlers/servers.php's nicon_is_cloud_metadata_host — same
// list, same reasoning (these endpoints hand out unauthenticated
// high-privilege cloud credentials to whatever can reach them, with no
// legitimate use as an RCON target; this deliberately does NOT block
// localhost/private/LAN addresses, since a self-hosted game server on the
// same network is the documented primary use case).
//
// The PHP check alone has a DNS-rebinding gap: a host that resolves to a
// safe IP when a server is first added could resolve to a metadata IP by
// the time this process actually connects to it, since DNS is looked up
// fresh here, in a different process, later. This check happens
// immediately before dialing — the only place that gap can actually be
// closed — checked against every resolved IP, not just the literal host
// string.
var blockedMetadataHosts = map[string]bool{
	"metadata.google.internal": true,
}

var blockedMetadataIPs = map[string]bool{
	"169.254.169.254": true, // AWS, GCP, Azure, DigitalOcean, Oracle Cloud, ...
	"169.254.170.2":   true, // AWS ECS task metadata
	"fd00:ec2::254":   true, // AWS IMDSv2, IPv6
	"100.100.100.200": true, // Alibaba Cloud
}

func isBlockedMetadataHost(host string) bool {
	normalized := strings.ToLower(strings.Trim(host, "[]"))
	if blockedMetadataHosts[normalized] || blockedMetadataIPs[normalized] {
		return true
	}
	ips, err := net.LookupIP(normalized)
	if err != nil {
		return false // unresolvable either way — dialing will fail on its own
	}
	for _, ip := range ips {
		if blockedMetadataIPs[ip.String()] {
			return true
		}
	}
	return false
}

func connectGame(srv store.Server) (gameConn, error) {
	if isBlockedMetadataHost(srv.Host) {
		return nil, errors.New("this host is not allowed")
	}
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

// HealthCheck attempts a real RCON connect to srv — the same connectGame
// path a normal console "connect" or the "test" WS message uses — and
// reports the outcome. Used by main.go's periodic background health-check
// loop, not by handleWS itself. Unlike a normal connect, this always
// closes the connection right away; nothing is left open afterward. Every
// protocol's dial has its own bounded timeout already (5-45s depending on
// protocol), so this never hangs indefinitely on an unresponsive server.
func HealthCheck(srv store.Server) (ok bool, latencyMs int, errMsg string) {
	start := time.Now()
	conn, err := connectGame(srv)
	elapsed := time.Since(start)
	if err != nil {
		return false, 0, err.Error()
	}
	conn.Close()
	return true, int(elapsed.Milliseconds()), ""
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

		case "test":
			testConn, dialErr := connectGame(store.Server{
				Host:     msg.Host,
				Port:     msg.Port,
				Password: msg.Password,
				Protocol: msg.Protocol,
			})
			if dialErr != nil {
				_ = writeJSON(wsMessage{Type: "test_result", OK: false, Message: dialErr.Error()})
				continue
			}
			testConn.Close()
			_ = writeJSON(wsMessage{Type: "test_result", OK: true})

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
