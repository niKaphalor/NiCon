package relay

import (
	"errors"

	"github.com/niKaphalor/NiCon/internal/store"
)

// PublicInfoCheck performs one passive, unauthenticated status probe
// against srv, selected independently from its authenticated RCON
// transport. "auto" preserves the old Source/Minecraft behaviour, while
// explicit modes also support A2S beside WebRCON, BattlEye, or Telnet.
// Used by main.go's periodic public-info loop, independent of
// whether srv has a stored RCON password (see HealthCheck for the
// password-gated, full-RCON-connect equivalent this sits alongside, not
// underneath). A failure returns online=false with nil counts rather than
// an error the caller must special-case — a game server not answering its
// own query port is itself a meaningful (negative) sample, not something
// to silently skip.
func PublicInfoCheck(srv store.Server) (online bool, players, maxPlayers *int, err error) {
	if isBlockedMetadataHost(srv.Host) {
		return false, nil, nil, errors.New("this host is not allowed")
	}
	queryProtocol := EffectivePublicQueryProtocol(srv)
	queryPort := srv.Port
	if srv.QueryPort != nil {
		queryPort = *srv.QueryPort
	}
	if queryProtocol == "minecraft" {
		stat, err := QueryMinecraftStat(srv.Host, queryPort)
		if err != nil {
			return false, nil, nil, err
		}
		p, m := stat.Players, stat.MaxPlayers
		return true, &p, &m, nil
	}
	if queryProtocol != "a2s" {
		return false, nil, nil, errors.New("public query is disabled")
	}
	info, err := QueryA2SInfo(srv.Host, queryPort)
	if err != nil {
		return false, nil, nil, err
	}
	p, m := info.Players, info.MaxPlayers
	return true, &p, &m, nil
}

// EffectivePublicQueryProtocol resolves the backwards-compatible auto mode.
// It intentionally does not guess support for non-Source games: those must
// opt into A2S explicitly or be populated from provider metadata.
func EffectivePublicQueryProtocol(srv store.Server) string {
	switch srv.QueryProtocol {
	case "a2s", "minecraft", "disabled":
		return srv.QueryProtocol
	case "", "auto":
		if srv.Game == "Minecraft" {
			return "minecraft"
		}
		if srv.Protocol == "source" {
			return "a2s"
		}
	}
	return "disabled"
}
