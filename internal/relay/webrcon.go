package relay

import (
	"fmt"
	"net/url"
	"time"

	"github.com/gorilla/websocket"
)

// webRconReadTimeout bounds how long Execute waits for a response with a
// matching Identifier before giving up.
const webRconReadTimeout = 15 * time.Second

// webRconConn speaks Rust's WebRCON protocol
// (https://github.com/Facepunch/webrcon): a WebSocket connection, opened at
// ws://host:port/<url-escaped password> (the password authenticates via the
// connection URL itself, not a separate handshake message), carrying JSON
// {"Identifier", "Message", "Name"} requests and
// {"Identifier", "Message", "Type"} responses.
type webRconConn struct {
	ws     *websocket.Conn
	nextID int
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
	return &webRconConn{ws: ws}, nil
}

type webRconMessage struct {
	Identifier int    `json:"Identifier"`
	Message    string `json:"Message"`
	Name       string `json:"Name,omitempty"`
	Type       string `json:"Type,omitempty"`
}

// Execute sends one command and waits for the response carrying the same
// Identifier, discarding any other messages the server sends in between
// (WebRCON servers, notably Rust, also push unrelated broadcast messages
// such as chat/log lines over the same connection).
func (c *webRconConn) Execute(command string) (string, error) {
	c.nextID++
	id := c.nextID

	if err := c.ws.WriteJSON(webRconMessage{Identifier: id, Message: command, Name: "NiCon"}); err != nil {
		return "", fmt.Errorf("webrcon: write: %w", err)
	}

	deadline := time.Now().Add(webRconReadTimeout)
	for {
		if err := c.ws.SetReadDeadline(deadline); err != nil {
			return "", fmt.Errorf("webrcon: set read deadline: %w", err)
		}
		var resp webRconMessage
		if err := c.ws.ReadJSON(&resp); err != nil {
			return "", fmt.Errorf("webrcon: read: %w", err)
		}
		if resp.Identifier == id {
			return resp.Message, nil
		}
	}
}

func (c *webRconConn) Close() error {
	return c.ws.Close()
}
