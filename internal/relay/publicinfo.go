package relay

import (
	"errors"

	"github.com/niKaphalor/NiCon/internal/store"
)

// PublicInfoCheck performs one passive, unauthenticated status probe
// against srv, selected independently from its authenticated RCON
// transport — see EffectivePublicQueryProtocol for exactly how "auto"
// resolves, including for WebRCON/BattlEye games that also answer A2S.
// Used by main.go's periodic public-info loop, independent of
// whether srv has a stored RCON password (see HealthCheck for the
// password-gated, full-RCON-connect equivalent this sits alongside, not
// underneath). A failure returns online=false with nil counts rather than
// an error the caller must special-case — a game server not answering its
// own query port is itself a meaningful (negative) sample, not something
// to silently skip.
func PublicInfoCheck(srv store.Server) (online bool, players, maxPlayers *int, err error) {
	pinned, err := resolveTarget(srv.Host)
	if err != nil {
		return false, nil, nil, err
	}
	srv.Host = pinned
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
// It intentionally does not guess support for every non-Source game: one
// not listed here or given "source" as its RCON protocol must opt into A2S
// explicitly (or be disabled), rather than have it assumed.
func EffectivePublicQueryProtocol(srv store.Server) string {
	switch srv.QueryProtocol {
	case "a2s", "minecraft", "disabled":
		return srv.QueryProtocol
	case "", "auto":
		// Per-game decisions (Minecraft's own query, ARK: Survival Ascended
		// having no reachable query port, Rust/Arma/DayZ answering A2S
		// although their RCON protocol is not "source") live in data/games.json.
		if mode, ok := gameAutoQuery[srv.Game]; ok {
			return mode
		}
		if srv.Protocol == "source" {
			return "a2s"
		}
	}
	return "disabled"
}
