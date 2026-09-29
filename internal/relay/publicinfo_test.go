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
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := EffectivePublicQueryProtocol(tt.srv); got != tt.want {
				t.Fatalf("EffectivePublicQueryProtocol() = %q, want %q", got, tt.want)
			}
		})
	}
}
