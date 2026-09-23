package relay

import (
	"fmt"
	"net/url"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

const (
	// webRconExecuteTimeout bounds how long Execute waits for a response
	// with a matching Identifier before giving up.
	webRconExecuteTimeout = 15 * time.Second

	// webRconPingInterval: Rust's WebRCON closes connections it considers
	// idle. A WebSocket-level ping resets that without sending a bogus
	// command to the game.
	webRconPingInterval = 25 * time.Second
)

// webRconConn speaks Rust's WebRCON protocol
// (https://github.com/Facepunch/webrcon): a WebSocket connection, opened at
// ws://host:port/<url-escaped password> (the password authenticates via the
// connection URL itself, not a separate handshake message), carrying JSON
// {"Identifier", "Message", "Name"} requests and
// {"Identifier", "Message", "Type"} responses.
//
// The server also pushes messages unsolicited over the same connection
// (chat lines, kill feed, log spam) with no Execute call waiting for them;
// those surface on the Broadcast channel instead of being discarded.
//
// A single background goroutine (readLoop) owns all reads, since
// gorilla/websocket only allows one concurrent reader. Execute calls are
// matched to their response via a map of Identifier -> channel, so
// multiple commands and the read loop can run concurrently without each
// Execute call blocking the others. writeMu serializes writes, since
// Execute and the keep-alive ping loop both write to the same connection.
type webRconConn struct {
	ws      *websocket.Conn
	writeMu sync.Mutex

	mu      sync.Mutex
	nextID  int
	pending map[int]chan webRconMessage
	closed  bool

	// Broadcast delivers server-pushed messages that weren't a response to
	// any pending Execute call. Closed when the connection's read loop
	// ends (i.e. the connection dropped or was closed).
	Broadcast chan string

	stopPing  chan struct{}
	closeOnce sync.Once
}

func dialWebRcon(host string, port int, password string) (*webRconConn, error) {
	u := url.URL{
		Scheme: "ws",
		Host:   fmt.Sprintf("%s:%d", host, port),
		Path:   "/" + url.PathEscape(password),
	}
	ws, _, err := websocket.DefaultDialer.Dial(u.String(), nil)
	if err != nil {
		return nil, fmt.Errorf("webrcon: %w", err)
	}

	c := &webRconConn{
		ws:        ws,
		pending:   make(map[int]chan webRconMessage),
		Broadcast: make(chan string, 64),
		stopPing:  make(chan struct{}),
	}
	go c.readLoop()
	go c.pingLoop()
	return c, nil
}

type webRconMessage struct {
	Identifier int    `json:"Identifier"`
	Message    string `json:"Message"`
	Name       string `json:"Name,omitempty"`
	Type       string `json:"Type,omitempty"`
}

// readLoop is the connection's only reader. It dispatches each incoming
// message either to the Execute call waiting for its Identifier, or, if
// nothing is waiting, to Broadcast.
func (c *webRconConn) readLoop() {
	defer close(c.Broadcast)
	for {
		var msg webRconMessage
		if err := c.ws.ReadJSON(&msg); err != nil {
			c.mu.Lock()
			c.closed = true
			for _, ch := range c.pending {
				close(ch)
			}
			c.pending = nil
			c.mu.Unlock()
			return
		}

		c.mu.Lock()
		ch, ok := c.pending[msg.Identifier]
		if ok {
			delete(c.pending, msg.Identifier)
		}
		c.mu.Unlock()

		if ok {
			ch <- msg
			close(ch)
			continue
		}

		select {
		case c.Broadcast <- msg.Message:
		default:
			// Nobody's reading Broadcast fast enough; drop rather than
			// block the read loop (and every pending Execute with it).
		}
	}
}

func (c *webRconConn) pingLoop() {
	ticker := time.NewTicker(webRconPingInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ticker.C:
			c.writeMu.Lock()
			err := c.ws.WriteControl(websocket.PingMessage, nil, time.Now().Add(5*time.Second))
			c.writeMu.Unlock()
			if err != nil {
				return
			}
		case <-c.stopPing:
			return
		}
	}
}

func (c *webRconConn) Execute(command string) (string, error) {
	c.mu.Lock()
	if c.closed {
		c.mu.Unlock()
		return "", fmt.Errorf("webrcon: connection closed")
	}
	c.nextID++
	id := c.nextID
	respCh := make(chan webRconMessage, 1)
	c.pending[id] = respCh
	c.mu.Unlock()

	c.writeMu.Lock()
	err := c.ws.WriteJSON(webRconMessage{Identifier: id, Message: command, Name: "NiCon"})
	c.writeMu.Unlock()
	if err != nil {
		c.mu.Lock()
		delete(c.pending, id)
		c.mu.Unlock()
		return "", fmt.Errorf("webrcon: write: %w", err)
	}

	select {
	case resp, ok := <-respCh:
		if !ok {
			return "", fmt.Errorf("webrcon: connection closed while waiting for response")
		}
		return resp.Message, nil
	case <-time.After(webRconExecuteTimeout):
		c.mu.Lock()
		delete(c.pending, id)
		c.mu.Unlock()
		return "", fmt.Errorf("webrcon: timed out waiting for response")
	}
}

func (c *webRconConn) Close() error {
	c.closeOnce.Do(func() { close(c.stopPing) })
	return c.ws.Close()
}
