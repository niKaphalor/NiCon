package relay

import (
	"bufio"
	"bytes"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"strconv"
	"time"
)

// minecraftPingTimeout mirrors minecraftQueryTimeout — a passive probe.
const minecraftPingTimeout = 3 * time.Second

// maxMinecraftPingJSON bounds the status JSON a server may send. Real
// responses are a few hundred bytes up to a few KiB (a favicon is what makes
// them large); the protocol itself allows 32 KiB of string.
const maxMinecraftPingJSON = 64 * 1024

// MinecraftPing is the subset of the Server List Ping status NiCon uses.
type MinecraftPing struct {
	Players    int
	MaxPlayers int
}

// QueryMinecraftPing speaks Minecraft Java's Server List Ping (the protocol
// behind the multiplayer menu) over the game's TCP port. Unlike the UDP Query
// protocol (minecraft_query.go) it needs no server.properties opt-in, so it is
// the fallback for servers with enable-query=false. host must already be a
// vetted, pinned IP literal (see resolveTarget).
func QueryMinecraftPing(host string, port int) (MinecraftPing, error) {
	conn, err := net.DialTimeout("tcp", net.JoinHostPort(host, strconv.Itoa(port)), minecraftPingTimeout)
	if err != nil {
		return MinecraftPing{}, fmt.Errorf("minecraft ping: %w", err)
	}
	defer conn.Close()
	conn.SetDeadline(time.Now().Add(minecraftPingTimeout))

	// Handshake (id 0x00): protocol version -1 ("unknown, just give me the
	// status"), server address, port, next state 1 (status). Then the empty
	// status request (id 0x00).
	var body bytes.Buffer
	body.WriteByte(0x00)
	writeVarInt(&body, -1)
	writeVarInt(&body, int32(len(host)))
	body.WriteString(host)
	binary.Write(&body, binary.BigEndian, uint16(port))
	writeVarInt(&body, 1)

	var req bytes.Buffer
	writeVarInt(&req, int32(body.Len()))
	req.Write(body.Bytes())
	req.Write([]byte{0x01, 0x00})
	if _, err := conn.Write(req.Bytes()); err != nil {
		return MinecraftPing{}, fmt.Errorf("minecraft ping: write: %w", err)
	}

	r := bufio.NewReader(io.LimitReader(conn, maxMinecraftPingJSON+16))
	if _, err := readVarInt(r); err != nil { // packet length — the JSON length below is what we bound
		return MinecraftPing{}, fmt.Errorf("minecraft ping: no response: %w", err)
	}
	if id, err := readVarInt(r); err != nil || id != 0x00 {
		return MinecraftPing{}, fmt.Errorf("minecraft ping: unexpected response packet")
	}
	n, err := readVarInt(r)
	if err != nil || n <= 0 || n > maxMinecraftPingJSON {
		return MinecraftPing{}, fmt.Errorf("minecraft ping: invalid status length")
	}
	raw := make([]byte, n)
	if _, err := io.ReadFull(r, raw); err != nil {
		return MinecraftPing{}, fmt.Errorf("minecraft ping: truncated status: %w", err)
	}
	var status struct {
		Players *struct {
			Online int `json:"online"`
			Max    int `json:"max"`
		} `json:"players"`
	}
	if err := json.Unmarshal(raw, &status); err != nil || status.Players == nil {
		return MinecraftPing{}, fmt.Errorf("minecraft ping: unexpected status JSON")
	}
	return MinecraftPing{Players: status.Players.Online, MaxPlayers: status.Players.Max}, nil
}

func writeVarInt(buf *bytes.Buffer, v int32) {
	u := uint32(v)
	for {
		if u&^0x7F == 0 {
			buf.WriteByte(byte(u))
			return
		}
		buf.WriteByte(byte(u&0x7F) | 0x80)
		u >>= 7
	}
}

func readVarInt(r io.ByteReader) (int32, error) {
	var result uint32
	for shift := uint(0); shift < 35; shift += 7 {
		b, err := r.ReadByte()
		if err != nil {
			return 0, err
		}
		result |= uint32(b&0x7F) << shift
		if b&0x80 == 0 {
			return int32(result), nil
		}
	}
	return 0, fmt.Errorf("varint too long")
}
