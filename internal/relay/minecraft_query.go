package relay

import (
	"encoding/binary"
	"fmt"
	"net"
	"strconv"
	"time"
)

// minecraftQueryTimeout mirrors a2sTimeout — this is a passive status
// probe (see main.go's public-info loop), not a user-facing action.
const minecraftQueryTimeout = 3 * time.Second

// minecraftQuerySessionID is an arbitrary, fixed session identifier sent
// with every request. On a UDP socket already dedicated to one
// QueryMinecraftStat call, the server only ever needs it echoed back so a
// response can be told apart from noise — any fixed value works.
var minecraftQuerySessionID = [4]byte{0x01, 0x02, 0x03, 0x04}

// MinecraftStat is Basic Stat's fields — enough for a player-count/uptime
// sample (see internal/store's UpdateServerPlayerSample). Full Stat's
// extra fields (plugin list, per-player names) aren't parsed: nothing
// here needs them yet.
type MinecraftStat struct {
	MOTD       string
	GameType   string
	Map        string
	Players    int
	MaxPlayers int
}

// QueryMinecraftStat speaks the GameSpy4-derived Query protocol Minecraft
// exposes on its own UDP query.port when a server operator has opted in
// (server.properties: enable-query=true) — off by default, unlike
// Source's A2S. Every query needs a fresh handshake first: the server
// hands out a numeric "challenge" token, sent as a null-terminated
// decimal string, that must be echoed back — packed as big-endian binary,
// not as text — in the actual stat request, or the server silently
// ignores it.
func QueryMinecraftStat(host string, port int) (MinecraftStat, error) {
	addr, err := net.ResolveUDPAddr("udp", net.JoinHostPort(host, strconv.Itoa(port)))
	if err != nil {
		return MinecraftStat{}, fmt.Errorf("minecraft query: %w", err)
	}
	conn, err := net.DialUDP("udp", nil, addr)
	if err != nil {
		return MinecraftStat{}, fmt.Errorf("minecraft query: %w", err)
	}
	defer conn.Close()
	conn.SetDeadline(time.Now().Add(minecraftQueryTimeout))

	challenge, err := minecraftQueryHandshake(conn)
	if err != nil {
		return MinecraftStat{}, err
	}
	return minecraftQueryBasicStat(conn, challenge)
}

func minecraftQueryHandshake(conn *net.UDPConn) ([4]byte, error) {
	var challenge [4]byte
	req := append([]byte{0xFE, 0xFD, 0x09}, minecraftQuerySessionID[:]...)
	if _, err := conn.Write(req); err != nil {
		return challenge, fmt.Errorf("minecraft query: handshake write: %w", err)
	}
	buf := make([]byte, 256)
	n, err := conn.Read(buf)
	if err != nil {
		return challenge, fmt.Errorf("minecraft query: handshake: no response: %w", err)
	}
	if n < 5 || buf[0] != 0x09 {
		return challenge, fmt.Errorf("minecraft query: unexpected handshake response")
	}
	r := &cstringReader{buf: buf[5:n]}
	tokenStr := r.readCString()
	if r.err != nil {
		return challenge, fmt.Errorf("minecraft query: %w", r.err)
	}
	token, err := strconv.ParseInt(tokenStr, 10, 64)
	if err != nil {
		return challenge, fmt.Errorf("minecraft query: parsing challenge token: %w", err)
	}
	binary.BigEndian.PutUint32(challenge[:], uint32(token))
	return challenge, nil
}

func minecraftQueryBasicStat(conn *net.UDPConn, challenge [4]byte) (MinecraftStat, error) {
	req := append([]byte{0xFE, 0xFD, 0x00}, minecraftQuerySessionID[:]...)
	req = append(req, challenge[:]...)
	if _, err := conn.Write(req); err != nil {
		return MinecraftStat{}, fmt.Errorf("minecraft query: stat write: %w", err)
	}
	buf := make([]byte, 4096)
	n, err := conn.Read(buf)
	if err != nil {
		return MinecraftStat{}, fmt.Errorf("minecraft query: stat: no response: %w", err)
	}
	if n < 5 || buf[0] != 0x00 {
		return MinecraftStat{}, fmt.Errorf("minecraft query: unexpected stat response")
	}
	r := &cstringReader{buf: buf[5:n]}
	motd := r.readCString()
	gametype := r.readCString()
	mapName := r.readCString()
	playersStr := r.readCString()
	maxPlayersStr := r.readCString()
	if r.err != nil {
		return MinecraftStat{}, fmt.Errorf("minecraft query: %w", r.err)
	}
	players, err := strconv.Atoi(playersStr)
	if err != nil {
		return MinecraftStat{}, fmt.Errorf("minecraft query: parsing player count: %w", err)
	}
	maxPlayers, err := strconv.Atoi(maxPlayersStr)
	if err != nil {
		return MinecraftStat{}, fmt.Errorf("minecraft query: parsing max players: %w", err)
	}
	return MinecraftStat{MOTD: motd, GameType: gametype, Map: mapName, Players: players, MaxPlayers: maxPlayers}, nil
}
