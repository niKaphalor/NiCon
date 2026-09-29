package relay

import (
	"errors"

	"github.com/niKaphalor/NiCon/internal/store"
)

// PublicInfoCheck performs one passive, unauthenticated status probe
// against srv — A2S for a Source-RCON-protocol server, or Minecraft's own
// separate Query protocol when srv.Game is Minecraft (Minecraft's RCON
// also reports protocol "source", but its status query is a different
// wire protocol entirely, see minecraft_query.go) — and reports the
// outcome. Used by main.go's periodic public-info loop, independent of
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
	if srv.Game == "Minecraft" {
		stat, err := QueryMinecraftStat(srv.Host, srv.Port)
		if err != nil {
			return false, nil, nil, err
		}
		p, m := stat.Players, stat.MaxPlayers
		return true, &p, &m, nil
	}
	info, err := QueryA2SInfo(srv.Host, srv.Port)
	if err != nil {
		return false, nil, nil, err
	}
	p, m := info.Players, info.MaxPlayers
	return true, &p, &m, nil
}
