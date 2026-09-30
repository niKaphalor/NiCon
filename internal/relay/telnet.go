package relay

import (
	"bytes"
	"fmt"
	"net"
	"strings"
	"sync"
	"time"
)

// maxTelnetResponseBytes bounds readUntilQuiet's accumulator, mirroring
// maxPalworldResponseBytes's reasoning in palworld_rest.go: without a cap, a
// malicious 7 Days to Die server could send arbitrarily much data and force
// unbounded memory growth here.
const maxTelnetResponseBytes = 1 * 1024 * 1024 // 1 MiB

// maxTelnetReadDuration bounds readUntilQuiet's total wall-clock time,
// independent of the rolling "quiet" timeout passed in. That timeout resets
// on every byte received, so a server trickling data continuously (e.g. one
// byte every 100ms) would otherwise never go quiet and Execute would block
// under c.mu forever, wedging that connection.
const maxTelnetReadDuration = 15 * time.Second

// telnetConn is the line-oriented remote console used by 7 Days to Die.
// It handles the small subset of Telnet negotiation used by the dedicated
// server and treats a short period of silence as the end of a command reply.
type telnetConn struct {
	conn net.Conn
	mu   sync.Mutex
}

func dialTelnet(host string, port int, password string) (*telnetConn, error) {
	conn, err := net.DialTimeout("tcp", fmt.Sprintf("%s:%d", host, port), 5*time.Second)
	if err != nil {
		return nil, fmt.Errorf("telnet: %w", err)
	}
	c := &telnetConn{conn: conn}
	banner, err := c.readUntilQuiet(5*time.Second, 250*time.Millisecond)
	if err != nil && len(banner) == 0 {
		conn.Close()
		return nil, fmt.Errorf("telnet: login prompt: %w", err)
	}
	if !strings.Contains(strings.ToLower(banner), "password") {
		conn.Close()
		return nil, fmt.Errorf("telnet: server did not request a password")
	}
	if _, err := fmt.Fprintf(conn, "%s\n", password); err != nil {
		conn.Close()
		return nil, fmt.Errorf("telnet: send password: %w", err)
	}
	reply, err := c.readUntilQuiet(5*time.Second, 350*time.Millisecond)
	_ = conn.SetDeadline(time.Time{})
	if err != nil && len(reply) == 0 {
		conn.Close()
		return nil, fmt.Errorf("telnet: login: %w", err)
	}
	lower := strings.ToLower(reply)
	if strings.Contains(lower, "incorrect") || strings.Contains(lower, "invalid") || strings.Contains(lower, "failed") {
		conn.Close()
		return nil, fmt.Errorf("telnet: invalid password")
	}
	return c, nil
}

func (c *telnetConn) Execute(command string) (string, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if _, err := fmt.Fprintf(c.conn, "%s\n", command); err != nil {
		return "", fmt.Errorf("telnet: write: %w", err)
	}
	reply, err := c.readUntilQuiet(8*time.Second, 400*time.Millisecond)
	_ = c.conn.SetDeadline(time.Time{})
	if err != nil && len(reply) == 0 {
		return "", fmt.Errorf("telnet: read: %w", err)
	}
	return strings.TrimSpace(reply), nil
}

func (c *telnetConn) Close() error { return c.conn.Close() }

func (c *telnetConn) readUntilQuiet(initial, quiet time.Duration) (string, error) {
	var out bytes.Buffer
	buf := make([]byte, 4096)
	deadline := time.Now().Add(maxTelnetReadDuration)
	for {
		wait := quiet
		if out.Len() == 0 {
			wait = initial
		}
		readDeadline := time.Now().Add(wait)
		if readDeadline.After(deadline) {
			readDeadline = deadline
		}
		_ = c.conn.SetReadDeadline(readDeadline)
		n, err := c.conn.Read(buf)
		if n > 0 {
			if out.Len()+n > maxTelnetResponseBytes {
				return out.String(), fmt.Errorf("telnet: response exceeded %d bytes", maxTelnetResponseBytes)
			}
			out.Write(stripTelnetControl(buf[:n]))
		}
		if ne, ok := err.(net.Error); ok && ne.Timeout() && out.Len() > 0 {
			return out.String(), nil
		}
		if err != nil {
			return out.String(), err
		}
		if time.Now().After(deadline) {
			return out.String(), fmt.Errorf("telnet: response exceeded %s", maxTelnetReadDuration)
		}
	}
}

func stripTelnetControl(in []byte) []byte {
	out := make([]byte, 0, len(in))
	for i := 0; i < len(in); i++ {
		if in[i] != 255 { // IAC
			out = append(out, in[i])
			continue
		}
		if i+1 >= len(in) {
			break
		}
		cmd := in[i+1]
		i++
		if cmd >= 251 && cmd <= 254 && i+1 < len(in) {
			i++
		} // WILL/WONT/DO/DONT + option
	}
	return out
}
