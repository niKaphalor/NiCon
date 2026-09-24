package relay

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"
)

// palworldRestConn speaks Palworld's first-party REST API
// (https://docs.palworldgame.com/api/rest-api/), the replacement for
// Palworld's now-deprecated RCON support. It's plain HTTP + JSON with HTTP
// Basic auth (username always "admin", password the server's AdminPassword
// — the same password RCON used), served on its own port (default 8212,
// distinct from the game's own port and any RCON port).
//
// Unlike RCON, this isn't a free-text console — there's a fixed set of
// endpoints. Execute still takes a text command (so it fits the same
// gameConn interface, and the browser console/games.js stay unchanged in
// shape) but parses it as "<verb> [args]" and maps that to one specific
// REST call; anything else is a clear error rather than a silent no-op.
// maxPalworldResponseBytes bounds how much of a single REST response this
// reads into memory (see the comment at its one use in request(), below).
const maxPalworldResponseBytes = 4 * 1024 * 1024 // 4 MiB

type palworldRestConn struct {
	baseURL  string
	password string
	client   *http.Client
}

func dialPalworldRest(host string, port int, password string) (*palworldRestConn, error) {
	c := &palworldRestConn{
		baseURL:  fmt.Sprintf("http://%s:%d/v1/api", host, port),
		password: password,
		client:   &http.Client{Timeout: 10 * time.Second},
	}
	// Verify the credentials actually work before declaring "connected" —
	// mirrors RCON's dial-time auth check, rather than only discovering a
	// wrong password on the first real command.
	if _, err := c.request(http.MethodGet, "/info", nil); err != nil {
		return nil, err
	}
	return c, nil
}

// Close is a no-op: plain HTTP requests, nothing to keep open.
func (c *palworldRestConn) Close() error { return nil }

func (c *palworldRestConn) Execute(command string) (string, error) {
	fields := strings.Fields(command)
	if len(fields) == 0 {
		return "", errors.New("empty command")
	}
	verb := strings.ToLower(fields[0])
	args := strings.TrimSpace(strings.TrimPrefix(strings.TrimSpace(command), fields[0]))

	switch verb {
	case "players":
		return c.request(http.MethodGet, "/players", nil)
	case "info":
		return c.request(http.MethodGet, "/info", nil)
	case "announce":
		if args == "" {
			return "", errors.New("usage: announce <message>")
		}
		return c.request(http.MethodPost, "/announce", map[string]string{"message": args})
	case "kick":
		return c.userAction("/kick", args)
	case "ban":
		return c.userAction("/ban", args)
	case "unban":
		if args == "" {
			return "", errors.New("usage: unban <userid>")
		}
		return c.request(http.MethodPost, "/unban", map[string]string{"userid": args})
	case "save":
		return c.request(http.MethodPost, "/save", nil)
	case "shutdown":
		return c.shutdown(args)
	case "stop":
		return c.request(http.MethodPost, "/stop", nil)
	default:
		return "", fmt.Errorf("unknown command %q — Palworld's REST API supports: players, info, announce, kick, ban, unban, save, shutdown, stop", fields[0])
	}
}

func (c *palworldRestConn) userAction(path, args string) (string, error) {
	parts := strings.SplitN(args, " ", 2)
	if parts[0] == "" {
		return "", fmt.Errorf("usage: %s <userid> [message]", strings.TrimPrefix(path, "/"))
	}
	body := map[string]string{"userid": parts[0]}
	if len(parts) > 1 {
		body["message"] = strings.TrimSpace(parts[1])
	}
	return c.request(http.MethodPost, path, body)
}

func (c *palworldRestConn) shutdown(args string) (string, error) {
	waittime := 30
	message := ""
	if args != "" {
		parts := strings.SplitN(args, " ", 2)
		if n, err := strconv.Atoi(parts[0]); err == nil {
			waittime = n
			if len(parts) > 1 {
				message = strings.TrimSpace(parts[1])
			}
		} else {
			message = args
		}
	}
	return c.request(http.MethodPost, "/shutdown", map[string]interface{}{"waittime": waittime, "message": message})
}

func (c *palworldRestConn) request(method, path string, body interface{}) (string, error) {
	var reqBody io.Reader
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			return "", err
		}
		reqBody = bytes.NewReader(b)
	}
	req, err := http.NewRequest(method, c.baseURL+path, reqBody)
	if err != nil {
		return "", err
	}
	req.SetBasicAuth("admin", c.password)
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}

	resp, err := c.client.Do(req)
	if err != nil {
		return "", fmt.Errorf("palworld REST API: %w", err)
	}
	defer resp.Body.Close()
	// Bounded, not io.ReadAll(resp.Body) directly: this is trusted server
	// infrastructure (the address/port the account owner configured), but
	// there's no reason a REST response describing players or server info
	// should ever run large, so capping it costs nothing in the normal
	// case and avoids holding an unbounded body in memory in the abnormal
	// one (a misbehaving or compromised endpoint).
	respBody, err := io.ReadAll(io.LimitReader(resp.Body, maxPalworldResponseBytes))
	if err != nil {
		return "", err
	}

	if resp.StatusCode == http.StatusUnauthorized {
		return "", errors.New("palworld REST API: unauthorized — check the server's admin password")
	}
	if resp.StatusCode >= 400 {
		text := strings.TrimSpace(string(respBody))
		if text == "" {
			text = resp.Status
		}
		return "", fmt.Errorf("palworld REST API: %s", text)
	}

	text := strings.TrimSpace(string(respBody))
	if text == "" {
		text = "OK"
	}
	return text, nil
}
