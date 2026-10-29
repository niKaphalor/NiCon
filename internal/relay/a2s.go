package relay

import (
	"bytes"
	"encoding/binary"
	"fmt"
	"math"
	"net"
	"strconv"
	"strings"
	"time"
	"unicode"
)

// a2sTimeout bounds how long a single A2S round trip (challenge exchange
// included) is allowed to take before giving up. This is a passive,
// best-effort status probe (see main.go's public-info loop), not a
// user-facing action worth a long wait.
var a2sTimeout = 3 * time.Second

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
	Passworded bool
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
// 0xFF "single packet" marker bytes already stripped (split responses are
// reassembled first, see a2sRead).
func a2sRoundTrip(conn *net.UDPConn, challenge []byte) ([]byte, error) {
	req := make([]byte, 0, 5+len(a2sInfoPayload)+len(challenge))
	req = append(req, 0xFF, 0xFF, 0xFF, 0xFF, a2sRequestHeader)
	req = append(req, a2sInfoPayload...)
	req = append(req, challenge...)
	if _, err := conn.Write(req); err != nil {
		return nil, fmt.Errorf("a2s: write: %w", err)
	}
	return a2sRead(conn)
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
	r.readByte()               // server type
	r.readByte()               // environment/OS
	visibility := r.readByte() // 1 = password-protected
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
		Passworded: visibility != 0,
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

// A2S responses larger than one datagram are split: each fragment starts with
// the long -2 (0xFE 0xFF 0xFF 0xFF), a long response ID, the total fragment
// count, this fragment's number and (Source engine) a short fragment size,
// followed by a slice of the payload. The reassembled payload starts with the
// usual 0xFFFFFFFF single-packet marker. GoldSource's different fragment
// header and bzip2-compressed responses (the ID's high bit) are not supported
// and fail with an error instead of being misparsed.
const (
	a2sMaxFragments = 32
	a2sMaxResponse  = 64 * 1024
)

var a2sSplitMarker = []byte{0xFE, 0xFF, 0xFF, 0xFF}

// a2sRead reads one A2S response and returns its payload with the leading
// single-packet marker stripped, reassembling split responses.
func a2sRead(conn *net.UDPConn) ([]byte, error) {
	buf := make([]byte, 4096)
	n, err := conn.Read(buf)
	if err != nil {
		return nil, fmt.Errorf("a2s: no response: %w", err)
	}
	pkt := append([]byte(nil), buf[:n]...)
	if n >= 5 && bytes.HasPrefix(pkt, []byte{0xFF, 0xFF, 0xFF, 0xFF}) {
		return pkt[4:], nil
	}
	if n < 12 || !bytes.HasPrefix(pkt, a2sSplitMarker) {
		return nil, fmt.Errorf("a2s: malformed response")
	}

	var id uint32
	var total int
	frags := map[int][]byte{}
	size := 0
	for {
		if len(pkt) < 12 || !bytes.HasPrefix(pkt, a2sSplitMarker) {
			return nil, fmt.Errorf("a2s: malformed response fragment")
		}
		pktID := binary.LittleEndian.Uint32(pkt[4:8])
		if pktID&0x80000000 != 0 {
			return nil, fmt.Errorf("a2s: compressed multi-packet responses are not supported")
		}
		if len(frags) == 0 {
			id, total = pktID, int(pkt[8])
			if total < 1 || total > a2sMaxFragments {
				return nil, fmt.Errorf("a2s: implausible fragment count %d", total)
			}
		}
		if pktID == id {
			num := int(pkt[9])
			if num >= total {
				return nil, fmt.Errorf("a2s: fragment %d out of range", num)
			}
			if _, dup := frags[num]; !dup {
				frags[num] = append([]byte(nil), pkt[12:]...) // pkt is reused for the next read
				size += len(pkt) - 12
				if size > a2sMaxResponse {
					return nil, fmt.Errorf("a2s: response too large")
				}
			}
		}
		if len(frags) == total {
			break
		}
		n, err := conn.Read(buf)
		if err != nil {
			return nil, fmt.Errorf("a2s: incomplete multi-packet response: %w", err)
		}
		pkt = append(pkt[:0], buf[:n]...)
	}
	var whole bytes.Buffer
	for i := 0; i < total; i++ {
		whole.Write(frags[i])
	}
	out := whole.Bytes()
	if len(out) < 5 || !bytes.HasPrefix(out, []byte{0xFF, 0xFF, 0xFF, 0xFF}) {
		return nil, fmt.Errorf("a2s: malformed reassembled response")
	}
	return out[4:], nil
}

const (
	a2sPlayerRequestHeader  = 0x55 // 'U' — A2S_PLAYER request
	a2sPlayerResponseHeader = 0x44 // 'D' — A2S_PLAYER response
)

// A2SPlayer is one row of an A2S_PLAYER response. Name is empty while a
// player is still connecting.
type A2SPlayer struct {
	Name        string
	Score       int
	DurationSec int
}

// QueryA2SPlayers asks a Source-engine server for its player list (names,
// score, time connected). A2S_PLAYER always requires the challenge exchange:
// the first request carries the challenge placeholder 0xFFFFFFFF.
func QueryA2SPlayers(host string, port int) ([]A2SPlayer, error) {
	addr, err := net.ResolveUDPAddr("udp", net.JoinHostPort(host, strconv.Itoa(port)))
	if err != nil {
		return nil, fmt.Errorf("a2s: %w", err)
	}
	conn, err := net.DialUDP("udp", nil, addr)
	if err != nil {
		return nil, fmt.Errorf("a2s: %w", err)
	}
	defer conn.Close()
	conn.SetDeadline(time.Now().Add(a2sTimeout))

	challenge := []byte{0xFF, 0xFF, 0xFF, 0xFF}
	for attempt := 0; attempt < 2; attempt++ {
		req := append([]byte{0xFF, 0xFF, 0xFF, 0xFF, a2sPlayerRequestHeader}, challenge...)
		if _, err := conn.Write(req); err != nil {
			return nil, fmt.Errorf("a2s: write: %w", err)
		}
		body, err := a2sRead(conn)
		if err != nil {
			return nil, err
		}
		if len(body) >= 5 && body[0] == a2sChallengeHeader {
			challenge = append([]byte(nil), body[1:5]...)
			continue
		}
		return parseA2SPlayers(body)
	}
	return nil, fmt.Errorf("a2s: server kept sending challenges")
}

func parseA2SPlayers(body []byte) ([]A2SPlayer, error) {
	if len(body) < 2 || body[0] != a2sPlayerResponseHeader {
		return nil, fmt.Errorf("a2s: unexpected player response")
	}
	r := &cstringReader{buf: body[1:]}
	count := int(r.readByte())
	players := make([]A2SPlayer, 0, count)
	for i := 0; i < count; i++ {
		r.readByte() // index — always 0 in practice
		name := r.readCString()
		score := int(int32(r.readUint32LE()))
		duration := math.Float32frombits(r.readUint32LE())
		if r.err != nil {
			return nil, fmt.Errorf("a2s: %w", r.err)
		}
		if math.IsNaN(float64(duration)) || duration < 0 || duration > 1e9 {
			duration = 0
		}
		players = append(players, A2SPlayer{Name: cleanText(name, 64), Score: score, DurationSec: int(duration)})
	}
	return players, nil
}

func (r *cstringReader) readUint32LE() uint32 {
	if r.err != nil || len(r.buf) < 4 {
		if r.err == nil {
			r.err = fmt.Errorf("truncated response")
		}
		return 0
	}
	v := binary.LittleEndian.Uint32(r.buf)
	r.buf = r.buf[4:]
	return v
}

// cleanText makes a server-supplied string safe to store and show: invalid
// UTF-8 and control characters are dropped, the length is capped (in runes).
func cleanText(s string, maxRunes int) string {
	out := make([]rune, 0, len(s))
	for _, r := range strings.ToValidUTF8(s, "") {
		if unicode.IsControl(r) {
			continue
		}
		out = append(out, r)
		if len(out) >= maxRunes {
			break
		}
	}
	return strings.TrimSpace(string(out))
}
