package relay

import (
	"bytes"
	"fmt"
	"net"
	"strconv"
	"time"
)

// a2sTimeout bounds how long a single A2S round trip (challenge exchange
// included) is allowed to take before giving up. This is a passive,
// best-effort status probe (see main.go's public-info loop), not a
// user-facing action worth a long wait.
const a2sTimeout = 3 * time.Second

const (
	a2sRequestHeader   = 0x54 // 'T' — A2S_INFO request
	a2sResponseHeader  = 0x49 // 'I' — A2S_INFO response
	a2sChallengeHeader = 0x41 // 'A' — "here's your challenge, resend with it"
)

// a2sInfoPayload is A2S_INFO's fixed request payload: the string
// "Source Engine Query", null-terminated. Every Source-engine (and
// Source-RCON-compatible — this includes Minecraft's own RCON, though
// Minecraft answers its own separate Query protocol instead, see
// minecraft_query.go) dedicated server answers this on its game UDP port
// with no authentication, since Steam's server browser depends on it.
var a2sInfoPayload = append([]byte("Source Engine Query"), 0x00)

// A2SInfo is the subset of A2S_INFO's response fields NiCon actually uses
// — current/max player counts for server_health_samples (see
// internal/store's UpdateServerPlayerSample), plus enough identifying
// data to be useful in logs. The optional EDF-gated fields (port,
// SteamID, SourceTV, tags, 64-bit game ID) are deliberately not parsed:
// nothing here needs them yet.
type A2SInfo struct {
	Name       string
	Map        string
	Game       string
	Players    int
	MaxPlayers int
	Bots       int
	VACEnabled bool
	Version    string
}

// QueryA2SInfo sends an A2S_INFO query to host:port and returns the
// parsed response. Source games have required a challenge round trip
// since a 2020 protocol change (closing a DDoS-reflection hole): the
// first request often gets back a 4-byte challenge instead of the real
// answer, which must be echoed back, verbatim, in a second, otherwise
// identical request. A2S_INFO responses are effectively always
// single-packet in practice (they're small) — the rarer multi-packet
// framing used by very long A2S_RULES/A2S_PLAYER responses isn't handled
// here.
func QueryA2SInfo(host string, port int) (A2SInfo, error) {
	addr, err := net.ResolveUDPAddr("udp", net.JoinHostPort(host, strconv.Itoa(port)))
	if err != nil {
		return A2SInfo{}, fmt.Errorf("a2s: %w", err)
	}
	conn, err := net.DialUDP("udp", nil, addr)
	if err != nil {
		return A2SInfo{}, fmt.Errorf("a2s: %w", err)
	}
	defer conn.Close()
	conn.SetDeadline(time.Now().Add(a2sTimeout))

	body, err := a2sRoundTrip(conn, nil)
	if err != nil {
		return A2SInfo{}, err
	}
	if len(body) >= 5 && body[0] == a2sChallengeHeader {
		body, err = a2sRoundTrip(conn, body[1:5])
		if err != nil {
			return A2SInfo{}, err
		}
	}
	return parseA2SInfo(body)
}

// a2sRoundTrip sends one A2S_INFO request (optionally with a challenge
// appended) and returns the response payload with the leading four
// 0xFF "single packet" marker bytes already stripped.
func a2sRoundTrip(conn *net.UDPConn, challenge []byte) ([]byte, error) {
	req := make([]byte, 0, 5+len(a2sInfoPayload)+len(challenge))
	req = append(req, 0xFF, 0xFF, 0xFF, 0xFF, a2sRequestHeader)
	req = append(req, a2sInfoPayload...)
	req = append(req, challenge...)
	if _, err := conn.Write(req); err != nil {
		return nil, fmt.Errorf("a2s: write: %w", err)
	}
	buf := make([]byte, 4096)
	n, err := conn.Read(buf)
	if err != nil {
		return nil, fmt.Errorf("a2s: no response: %w", err)
	}
	if n < 5 || buf[0] != 0xFF || buf[1] != 0xFF || buf[2] != 0xFF || buf[3] != 0xFF {
		return nil, fmt.Errorf("a2s: malformed or fragmented response")
	}
	return buf[4:n], nil
}

func parseA2SInfo(body []byte) (A2SInfo, error) {
	if len(body) < 1 || body[0] != a2sResponseHeader {
		var got byte
		if len(body) > 0 {
			got = body[0]
		}
		return A2SInfo{}, fmt.Errorf("a2s: unexpected response type 0x%02x", got)
	}
	r := &cstringReader{buf: body[1:]}
	r.readByte() // protocol version — not needed
	name := r.readCString()
	mapName := r.readCString()
	r.readCString() // folder — not needed
	game := r.readCString()
	r.skip(2) // Steam AppID
	players := r.readByte()
	maxPlayers := r.readByte()
	bots := r.readByte()
	r.readByte() // server type
	r.readByte() // environment/OS
	r.readByte() // visibility (password-protected) — not surfaced yet
	vac := r.readByte()
	version := r.readCString()
	if r.err != nil {
		return A2SInfo{}, fmt.Errorf("a2s: %w", r.err)
	}
	return A2SInfo{
		Name:       name,
		Map:        mapName,
		Game:       game,
		Players:    int(players),
		MaxPlayers: int(maxPlayers),
		Bots:       int(bots),
		VACEnabled: vac != 0,
		Version:    version,
	}, nil
}

// cstringReader is a tiny cursor over a null-terminated-string-and-fixed-
// field response body, shared by A2S_INFO (this file) and Minecraft's
// Query protocol (minecraft_query.go) — both mix C strings with raw
// binary fields in the same response. Once err is set, every further read
// is a no-op returning a zero value; callers check err once at the end
// instead of after every field.
type cstringReader struct {
	buf []byte
	err error
}

func (r *cstringReader) readByte() byte {
	if r.err != nil || len(r.buf) < 1 {
		if r.err == nil {
			r.err = fmt.Errorf("truncated response")
		}
		return 0
	}
	b := r.buf[0]
	r.buf = r.buf[1:]
	return b
}

func (r *cstringReader) skip(n int) {
	if r.err != nil || len(r.buf) < n {
		if r.err == nil {
			r.err = fmt.Errorf("truncated response")
		}
		return
	}
	r.buf = r.buf[n:]
}

func (r *cstringReader) readCString() string {
	if r.err != nil {
		return ""
	}
	idx := bytes.IndexByte(r.buf, 0)
	if idx < 0 {
		r.err = fmt.Errorf("unterminated string in response")
		return ""
	}
	s := string(r.buf[:idx])
	r.buf = r.buf[idx+1:]
	return s
}
