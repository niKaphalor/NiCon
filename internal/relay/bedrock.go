package relay

import (
	"bytes"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"strconv"
	"strings"
	"time"
)

const bedrockTimeout = 3 * time.Second

// BedrockInfo is what a Minecraft Bedrock server reports without logging in.
type BedrockInfo struct {
	Name       string
	Version    string
	Level      string
	GameType   string
	Players    int
	MaxPlayers int
}

// raknetMagic is RakNet's 16-byte "offline message" marker.
var raknetMagic = []byte{0x00, 0xFF, 0xFF, 0x00, 0xFE, 0xFE, 0xFE, 0xFE, 0xFD, 0xFD, 0xFD, 0xFD, 0x12, 0x34, 0x56, 0x78}

// QueryBedrockRakNet sends RakNet's Unconnected Ping (UDP) and parses the
// server-list string in the Unconnected Pong:
//
//	MCPE;MOTD;protocol;version;players;max;serverId;level;gamemode;...
//
// Bedrock servers on the RakNet transport answer this on their game port
// (default 19132). Since 26.50 the dedicated server defaults to NetherNet
// instead (see QueryBedrockNetherNet), so a server on the new default will
// not answer this.
func QueryBedrockRakNet(host string, port int) (BedrockInfo, error) {
	addr, err := net.ResolveUDPAddr("udp", net.JoinHostPort(host, strconv.Itoa(port)))
	if err != nil {
		return BedrockInfo{}, fmt.Errorf("bedrock raknet: %w", err)
	}
	conn, err := net.DialUDP("udp", nil, addr)
	if err != nil {
		return BedrockInfo{}, fmt.Errorf("bedrock raknet: %w", err)
	}
	defer conn.Close()
	conn.SetDeadline(time.Now().Add(bedrockTimeout))

	var req bytes.Buffer
	req.WriteByte(0x01) // ID_UNCONNECTED_PING
	binary.Write(&req, binary.BigEndian, uint64(time.Now().UnixMilli()))
	req.Write(raknetMagic)
	binary.Write(&req, binary.BigEndian, uint64(0x4E69436F6E)) // client GUID, arbitrary
	if _, err := conn.Write(req.Bytes()); err != nil {
		return BedrockInfo{}, fmt.Errorf("bedrock raknet: write: %w", err)
	}
	buf := make([]byte, 2048)
	n, err := conn.Read(buf)
	if err != nil {
		return BedrockInfo{}, fmt.Errorf("bedrock raknet: no response: %w", err)
	}
	return parseBedrockPong(buf[:n])
}

func parseBedrockPong(resp []byte) (BedrockInfo, error) {
	// ID(1) time(8) serverGUID(8) magic(16) length(2) string
	if len(resp) < 35 || resp[0] != 0x1C || !bytes.Equal(resp[17:33], raknetMagic) {
		return BedrockInfo{}, fmt.Errorf("bedrock raknet: unexpected response")
	}
	size := int(binary.BigEndian.Uint16(resp[33:35]))
	if size > len(resp)-35 {
		size = len(resp) - 35
	}
	fields := strings.Split(string(resp[35:35+size]), ";")
	if len(fields) < 6 || (fields[0] != "MCPE" && fields[0] != "MCEE") {
		return BedrockInfo{}, fmt.Errorf("bedrock raknet: unexpected server info")
	}
	players, err1 := strconv.Atoi(fields[4])
	maxPlayers, err2 := strconv.Atoi(fields[5])
	if err1 != nil || err2 != nil {
		return BedrockInfo{}, fmt.Errorf("bedrock raknet: parsing player counts")
	}
	info := BedrockInfo{
		Name:       cleanText(fields[1], 128),
		Version:    cleanText(fields[3], 32),
		Players:    players,
		MaxPlayers: maxPlayers,
	}
	if len(fields) > 7 {
		info.Level = cleanText(fields[7], 64)
	}
	if len(fields) > 8 {
		info.GameType = cleanText(fields[8], 32)
	}
	return info, nil
}

// maxNetherNetJSON bounds the signaling server's capability document.
const maxNetherNetJSON = 64 * 1024

// QueryBedrockNetherNet asks a NetherNet-transport Bedrock server for its
// public status through the HTTP signaling endpoint GET /v1/join (documented
// at minecraft.wiki/w/NetherNet), served on the server port over TCP. host
// must already be a vetted, pinned IP literal.
//
// This is implemented from that documentation and has NOT been verified
// against a live 26.50+ server: whether the endpoint answers without
// authentication, and over plain HTTP rather than TLS, is unconfirmed. Any
// non-2xx or non-JSON answer is reported as an error.
func QueryBedrockNetherNet(host string, port int) (BedrockInfo, error) {
	client := &http.Client{
		Timeout:       bedrockTimeout,
		Transport:     &http.Transport{Proxy: nil, DialContext: (&net.Dialer{Timeout: bedrockTimeout}).DialContext},
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
	}
	defer client.CloseIdleConnections()
	req, err := http.NewRequest(http.MethodGet, "http://"+net.JoinHostPort(host, strconv.Itoa(port))+"/v1/join", nil)
	if err != nil {
		return BedrockInfo{}, fmt.Errorf("bedrock nethernet: %w", err)
	}
	req.Header.Set("Accept", "application/json")
	resp, err := client.Do(req)
	if err != nil {
		return BedrockInfo{}, fmt.Errorf("bedrock nethernet: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		return BedrockInfo{}, fmt.Errorf("bedrock nethernet: unexpected HTTP status %d", resp.StatusCode)
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, maxNetherNetJSON))
	if err != nil {
		return BedrockInfo{}, fmt.Errorf("bedrock nethernet: %w", err)
	}
	return parseNetherNetJoin(body)
}

func parseNetherNetJoin(body []byte) (BedrockInfo, error) {
	var doc struct {
		Name       string `json:"name"`
		Version    string `json:"version"`
		Level      string `json:"level"`
		GameType   string `json:"gameType"`
		Players    *int   `json:"players"`
		MaxPlayers *int   `json:"maxPlayers"`
	}
	if err := json.Unmarshal(body, &doc); err != nil || doc.Players == nil || doc.MaxPlayers == nil {
		return BedrockInfo{}, fmt.Errorf("bedrock nethernet: unexpected status JSON")
	}
	return BedrockInfo{
		Name:       cleanText(doc.Name, 128),
		Version:    cleanText(doc.Version, 32),
		Level:      cleanText(doc.Level, 64),
		GameType:   cleanText(doc.GameType, 32),
		Players:    *doc.Players,
		MaxPlayers: *doc.MaxPlayers,
	}, nil
}

// QueryBedrock tries both transports at once and prefers the RakNet answer.
// A server answers on one of them only, so waiting for them one after the
// other would double the time a down server costs.
func QueryBedrock(host string, port int) (BedrockInfo, error) {
	type result struct {
		info BedrockInfo
		err  error
	}
	rak, nether := make(chan result, 1), make(chan result, 1)
	go func() { i, e := QueryBedrockRakNet(host, port); rak <- result{i, e} }()
	go func() { i, e := QueryBedrockNetherNet(host, port); nether <- result{i, e} }()
	r, n := <-rak, <-nether
	if r.err == nil {
		return r.info, nil
	}
	if n.err == nil {
		return n.info, nil
	}
	return BedrockInfo{}, r.err // the RakNet error: a timeout there is the more telling one for UDP
}
