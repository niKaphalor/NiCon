package relay

import (
	"bufio"
	"net"
	"strings"
	"testing"

	"github.com/niKaphalor/NiCon/internal/store"
)

func TestEffectivePublicQueryProtocol(t *testing.T) {
	tests := []struct {
		name string
		srv  store.Server
		want string
	}{
		{"explicit A2S beside WebRCON", store.Server{Protocol: "webrcon", QueryProtocol: "a2s"}, "a2s"},
		{"explicit Minecraft", store.Server{Protocol: "source", QueryProtocol: "minecraft"}, "minecraft"},
		{"disabled", store.Server{Protocol: "source", QueryProtocol: "disabled"}, "disabled"},
		{"legacy Source auto", store.Server{Protocol: "source", QueryProtocol: "auto"}, "a2s"},
		{"legacy Minecraft auto", store.Server{Protocol: "source", Game: "Minecraft", QueryProtocol: "auto"}, "minecraft"},
		{"non-Source auto does not guess", store.Server{Protocol: "battleye", QueryProtocol: "auto"}, "disabled"},
		{"empty database value behaves as auto", store.Server{Protocol: "source"}, "a2s"},
		{"ARK: Survival Ascended auto defaults to disabled", store.Server{Protocol: "source", Game: "ARK: Survival Ascended", QueryProtocol: "auto"}, "disabled"},
		{"ARK: Survival Ascended can still opt in explicitly", store.Server{Protocol: "source", Game: "ARK: Survival Ascended", QueryProtocol: "a2s"}, "a2s"},
		{"ARK: Survival Evolved auto is unaffected", store.Server{Protocol: "source", Game: "ARK: Survival Evolved", QueryProtocol: "auto"}, "a2s"},
		// a2sAutoGames: these games' usual RCON protocol isn't "source", but
		// they're known to also answer A2S — auto must resolve the same way
		// regardless of whether the server was added manually (starts as
		// "auto") or via Nitrado sync (also now always writes "auto", see
		// nicon_nitrado_query_protocol's doc comment in nitrado_sync.php).
		{"Rust auto opts into A2S despite webrcon protocol", store.Server{Protocol: "webrcon", Game: "Rust", QueryProtocol: "auto"}, "a2s"},
		{"Arma 3 auto opts into A2S despite battleye protocol", store.Server{Protocol: "battleye", Game: "Arma 3", QueryProtocol: "auto"}, "a2s"},
		{"DayZ auto opts into A2S despite battleye protocol", store.Server{Protocol: "battleye", Game: "DayZ", QueryProtocol: "auto"}, "a2s"},
		{"7 Days to Die auto opts into A2S despite telnet protocol", store.Server{Protocol: "telnet", Game: "7 Days to Die", QueryProtocol: "auto"}, "a2s"},
		{"a non-Source, non-listed game still doesn't guess", store.Server{Protocol: "battlebit", Game: "BattleBit Remastered", QueryProtocol: "auto"}, "disabled"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := EffectivePublicQueryProtocol(tt.srv); got != tt.want {
				t.Fatalf("EffectivePublicQueryProtocol() = %q, want %q", got, tt.want)
			}
		})
	}
}

// A Minecraft server with enable-query=false (the default) must still report
// player counts, via Server List Ping on the same port number.
func TestPublicInfoCheckMinecraftFallsBackToPing(t *testing.T) {
	port := fakePingServer(t, func(c net.Conn) {
		bufio.NewReader(c).Peek(1)
		c.Write(statusPacket(`{"players":{"max":10,"online":3}}`))
	})
	SetTargetPolicy(TargetPolicy{})
	qp := port
	online, players, maxPlayers, err := PublicInfoCheck(store.Server{
		Host: "127.0.0.1", Port: 25575, Game: "Minecraft", Protocol: "source", QueryProtocol: "auto", QueryPort: &qp,
	})
	if err != nil || !online || players == nil || *players != 3 || *maxPlayers != 10 {
		t.Fatalf("PublicInfoCheck = %v %v %v %v", online, players, maxPlayers, err)
	}
}

// If neither Query nor Ping answers, the original Query error is reported and
// the server counts as offline — exactly as before the fallback existed.
func TestPublicInfoCheckMinecraftDownStaysOffline(t *testing.T) {
	ln, _ := net.Listen("tcp", "127.0.0.1:0")
	port := ln.Addr().(*net.TCPAddr).Port
	ln.Close()
	SetTargetPolicy(TargetPolicy{})
	online, players, _, err := PublicInfoCheck(store.Server{
		Host: "127.0.0.1", Port: port, Game: "Minecraft", Protocol: "source", QueryProtocol: "auto",
	})
	if online || players != nil || err == nil || !strings.HasPrefix(err.Error(), "minecraft query:") {
		t.Fatalf("PublicInfoCheck = %v %v %v", online, players, err)
	}
}
