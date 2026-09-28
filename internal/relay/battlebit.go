package relay

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

// battlebitConn implements the BattleBit Community API WebSocket protocol.
// Authentication uses x-password (not Rust's URL path)
// and commands are JSON objects with a command and identifier.
type battlebitConn struct {
	ws        *websocket.Conn
	writeMu   sync.Mutex
	mu        sync.Mutex
	nextID    int
	pending   map[int]chan []byte
	closed    bool
	Broadcast chan string
	closeOnce sync.Once
}

func dialBattlebit(host string, port int, password string) (*battlebitConn, error) {
	u := url.URL{Scheme: "ws", Host: fmt.Sprintf("%s:%d", host, port), Path: "/"}
	header := http.Header{}
	header.Set("x-password", password)
	ws, _, err := websocket.DefaultDialer.Dial(u.String(), header)
	if err != nil {
		return nil, fmt.Errorf("battlebit: %w", err)
	}
	c := &battlebitConn{ws: ws, pending: make(map[int]chan []byte), Broadcast: make(chan string, 64)}
	go c.readLoop()
	return c, nil
}

func (c *battlebitConn) readLoop() {
	defer close(c.Broadcast)
	for {
		_, raw, err := c.ws.ReadMessage()
		if err != nil {
			c.mu.Lock()
			c.closed = true
			for _, ch := range c.pending {
				close(ch)
			}
			c.pending = nil
			c.mu.Unlock()
			return
		}
		var envelope struct {
			Identifier *int `json:"identifier"`
		}
		_ = json.Unmarshal(raw, &envelope)
		if envelope.Identifier != nil {
			c.mu.Lock()
			ch, ok := c.pending[*envelope.Identifier]
			if ok {
				delete(c.pending, *envelope.Identifier)
			}
			c.mu.Unlock()
			if ok {
				ch <- raw
				close(ch)
				continue
			}
		}
		select {
		case c.Broadcast <- string(raw):
		default:
		}
	}
}

func (c *battlebitConn) Execute(command string) (string, error) {
	c.mu.Lock()
	if c.closed {
		c.mu.Unlock()
		return "", fmt.Errorf("battlebit: connection closed")
	}
	c.nextID++
	id := c.nextID
	response := make(chan []byte, 1)
	c.pending[id] = response
	c.mu.Unlock()

	fields := strings.Fields(command)
	verb := "executeCommand"
	request := map[string]any{"identifier": id, "payload": command}
	if len(fields) > 0 {
		switch strings.ToLower(fields[0]) {
		case "playerlist", "players":
			verb, request = "playerList", map[string]any{"identifier": id}
		case "state":
			verb, request = "state", map[string]any{"identifier": id}
		case "kick":
			if len(fields) < 2 {
				c.removePending(id)
				return "", fmt.Errorf("battlebit: kick requires a Steam ID")
			}
			reason := "Kicked by admin"
			if len(fields) > 2 {
				reason = strings.Join(fields[2:], " ")
			}
			verb, request = "kick", map[string]any{"identifier": id, "steamID": fields[1], "reason": reason}
		case "say", "broadcast":
			verb, request = "sayToAllChat", map[string]any{"identifier": id, "message": strings.TrimSpace(strings.TrimPrefix(command, fields[0]))}
		}
	}
	request["command"] = verb
	c.writeMu.Lock()
	err := c.ws.WriteJSON(request)
	c.writeMu.Unlock()
	if err != nil {
		c.removePending(id)
		return "", fmt.Errorf("battlebit: write: %w", err)
	}
	select {
	case raw, ok := <-response:
		if !ok {
			return "", fmt.Errorf("battlebit: connection closed while waiting for response")
		}
		return string(raw), nil
	case <-time.After(15 * time.Second):
		c.removePending(id)
		return "", fmt.Errorf("battlebit: timed out waiting for response")
	}
}

func (c *battlebitConn) removePending(id int) { c.mu.Lock(); delete(c.pending, id); c.mu.Unlock() }
func (c *battlebitConn) Close() error {
	var err error
	c.closeOnce.Do(func() { err = c.ws.Close() })
	return err
}
