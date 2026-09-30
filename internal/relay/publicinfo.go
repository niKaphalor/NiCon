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

// a2sAutoGames lists games whose usual RCON protocol isn't "source" but
// that are known to also answer A2S_INFO on their game port. This is the
// single source of truth for that list — webspace/handlers/nitrado_sync.php
// used to hardcode the same list to assign query_protocol="a2s" directly at
// sync time, bypassing "auto" entirely, so a Nitrado-synced Rust/Arma/DayZ
// server got A2S sampling while a manually-added one of the same game,
// left on "auto", silently didn't (same game, different outcome purely by
// add path). Nitrado sync now always writes "auto" and leaves this list as
// the only place the decision is made, for every server regardless of how
// it was added.
var a2sAutoGames = map[string]bool{
	"Rust":          true,
	"Arma 2":        true,
	"Arma 3":        true,
	"Arma Reforger": true,
	"DayZ":          true,
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
		if srv.Game == "Minecraft" {
			return "minecraft"
		}
		// ARK: Survival Ascended does not reliably expose a working
		// Steam/A2S query port in practice, unlike the older Evolved —
		// confirmed unreachable on every candidate port, including the one
		// Nitrado's own API reports, from two independent networks. Auto
		// mode shouldn't repeat that dead end for every server of this
		// specific game.
		if srv.Game == "ARK: Survival Ascended" {
			return "disabled"
		}
		if srv.Protocol == "source" || a2sAutoGames[srv.Game] {
			return "a2s"
		}
	}
	return "disabled"
}
