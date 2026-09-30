package relay

import (
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
