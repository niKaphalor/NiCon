package relay

import (
	"context"
	"encoding/json"
	"errors"
	"net"
	"os"
	"strings"
	"syscall"
	"time"

	"github.com/niKaphalor/NiCon/internal/store"
)

// Error kinds recorded with a failed public query (server_health_samples
// .error_kind, servers.query_error). They separate "the server is down" from
// "the query is misconfigured", which look the same as a bare offline sample.
const (
	QueryErrTimeout  = "timeout"  // no answer: server down, wrong query port, or UDP filtered
	QueryErrRefused  = "refused"  // port closed (ICMP unreachable / TCP reset)
	QueryErrDNS      = "dns"      // host name does not resolve
	QueryErrBlocked  = "blocked"  // refused by the relay's target policy
	QueryErrAuth     = "auth"     // credentials rejected (Palworld REST)
	QueryErrProtocol = "protocol" // answered, but not in the expected format
	QueryErrDisabled = "disabled" // no public query configured for this server
)

var errPublicQueryDisabled = errors.New("public query is disabled")

// PublicInfo is the outcome of one passive status probe. The JSON form (see
// InfoJSON) is what servers.query_info stores and the Cloud API serves; the
// fields tagged "-" are stored in their own columns instead.
type PublicInfo struct {
	Online      bool   `json:"-"`
	Players     *int   `json:"-"`
	MaxPlayers  *int   `json:"-"`
	LatencyMs   *int   `json:"-"`
	ErrorKind   string `json:"-"`
	Err         error  `json:"-"`
	Source      string `json:"-"` // server_health_samples.source
	Protocol    string `json:"protocol"`
	Name        string `json:"name,omitempty"`
	Map         string `json:"map,omitempty"`
	Version     string `json:"version,omitempty"`
	Game        string `json:"game,omitempty"`
	Passworded  *bool  `json:"passworded,omitempty"`
	ServerFPS   *int   `json:"server_fps,omitempty"`
	UptimeSec   *int64 `json:"uptime_s,omitempty"`
	GameDays    *int   `json:"days,omitempty"`
	QueryMillis *int   `json:"latency_ms,omitempty"`
}

// InfoJSON is the stored form: only successful probes carry details.
func (p PublicInfo) InfoJSON() string {
	if !p.Online {
		return ""
	}
	p.QueryMillis = p.LatencyMs
	b, err := json.Marshal(p)
	if err != nil {
		return ""
	}
	return string(b)
}

func (p *PublicInfo) fail(err error) {
	p.Online, p.Err, p.ErrorKind = false, err, classifyQueryError(err)
}

func (p *PublicInfo) succeed(players, maxPlayers int) {
	p.Online = true
	p.Players, p.MaxPlayers = &players, &maxPlayers
}

// classifyQueryError maps a probe error to one of the QueryErr* kinds.
func classifyQueryError(err error) string {
	var dnsErr *net.DNSError
	switch {
	case err == nil:
		return ""
	case errors.Is(err, errPublicQueryDisabled):
		return QueryErrDisabled
	case errors.Is(err, errTargetNotAllowed):
		return QueryErrBlocked
	case errors.As(err, &dnsErr):
		return QueryErrDNS
	case isTimeout(err):
		return QueryErrTimeout
	case errors.Is(err, syscall.ECONNREFUSED):
		return QueryErrRefused
	case strings.Contains(strings.ToLower(err.Error()), "unauthorized"):
		return QueryErrAuth
	}
	return QueryErrProtocol
}

func isTimeout(err error) bool {
	var ne net.Error
	return errors.Is(err, os.ErrDeadlineExceeded) || errors.Is(err, context.DeadlineExceeded) ||
		(errors.As(err, &ne) && ne.Timeout())
}

// timed runs one query and reports how long the successful attempt took. UDP
// datagrams get lost, and this runs every few minutes: a single lost packet
// must not read as "server offline", so a timeout is retried once. A refused
// port or a malformed answer is not — retrying cannot change those.
func timed[T any](fn func() (T, error)) (T, int, error) {
	var zero T
	for attempt := 0; ; attempt++ {
		start := time.Now()
		v, err := fn()
		if err == nil {
			return v, int(time.Since(start).Milliseconds()), nil
		}
		if attempt == 1 || !isTimeout(err) {
			return zero, 0, err
		}
	}
}

// QueryPublicInfo performs one passive, unauthenticated status probe against
// srv (Palworld: its REST API with the stored admin password), selected
// independently from the server's RCON transport — see
// EffectivePublicQueryProtocol. A failure is a result, not a Go error: a game
// server not answering its query port is itself a meaningful sample.
func QueryPublicInfo(srv store.Server) PublicInfo {
	mode := EffectivePublicQueryProtocol(srv)
	res := PublicInfo{Protocol: mode, Source: publicInfoSource(mode)}
	if mode == "disabled" {
		res.fail(errPublicQueryDisabled)
		return res
	}
	pinned, err := resolveTarget(srv.Host)
	if err != nil {
		res.fail(err)
		return res
	}
	port := srv.Port
	if srv.QueryPort != nil && mode != "palworld" {
		port = *srv.QueryPort
	}
	if !validPort(port) {
		res.fail(errors.New("invalid port"))
		return res
	}

	switch mode {
	case "minecraft":
		stat, ms, err := timed(func() (MinecraftStat, error) { return QueryMinecraftStat(pinned, port) })
		if err == nil {
			res.Name, res.Map, res.LatencyMs = cleanText(stat.MOTD, 128), cleanText(stat.Map, 64), &ms
			res.succeed(stat.Players, stat.MaxPlayers)
			return res
		}
		// enable-query is off by default. Fall back to the Server List Ping,
		// which every Java server answers, on the same port number (query.port
		// defaults to server-port, so this is the game port unless the
		// operator split them). If that fails too, report the Query error:
		// nothing changes for a server that is down.
		ping, pms, perr := timed(func() (MinecraftPing, error) { return QueryMinecraftPing(pinned, port) })
		if perr != nil {
			res.fail(err)
			return res
		}
		res.Name, res.Version, res.LatencyMs = ping.MOTD, ping.Version, &pms
		res.succeed(ping.Players, ping.MaxPlayers)
	case "bedrock":
		info, ms, err := timed(func() (BedrockInfo, error) { return QueryBedrock(pinned, port) })
		if err != nil {
			res.fail(err)
			return res
		}
		res.Name, res.Version, res.Map, res.Game, res.LatencyMs = info.Name, info.Version, info.Level, info.GameType, &ms
		res.succeed(info.Players, info.MaxPlayers)
	case "palworld":
		opts := dialOptions{ServerName: strings.Trim(srv.Host, "[]"), TLS: srv.UseTLS}
		pw, ms, err := timed(func() (PalworldStatus, error) {
			return QueryPalworldStatus(pinned, port, srv.Password, opts)
		})
		if err != nil {
			res.fail(err)
			return res
		}
		fps, up, days := int(pw.ServerFPS+0.5), pw.UptimeSeconds, pw.Days
		res.Name, res.Version, res.LatencyMs = pw.Name, pw.Version, &ms
		res.ServerFPS, res.UptimeSec, res.GameDays = &fps, &up, &days
		res.succeed(pw.Players, pw.MaxPlayers)
	default: // "a2s"
		info, ms, err := timed(func() (A2SInfo, error) { return QueryA2SInfo(pinned, port) })
		if err != nil {
			res.fail(err)
			return res
		}
		passworded := info.Passworded
		res.Name, res.Map, res.Version, res.Game = cleanText(info.Name, 128), cleanText(info.Map, 64), cleanText(info.Version, 64), cleanText(info.Game, 64)
		res.Passworded, res.LatencyMs = &passworded, &ms
		res.succeed(info.Players, info.MaxPlayers)
	}
	return res
}

func publicInfoSource(mode string) string {
	switch mode {
	case "minecraft":
		return "mcquery"
	case "bedrock":
		return "bedrock"
	case "palworld":
		return "palworld"
	}
	return "a2s"
}

// PublicInfoCheck is QueryPublicInfo reduced to the player counts the "Test
// query" button reports.
func PublicInfoCheck(srv store.Server) (online bool, players, maxPlayers *int, err error) {
	res := QueryPublicInfo(srv)
	return res.Online, res.Players, res.MaxPlayers, res.Err
}

// PublicPlayer is one entry of an on-demand player list.
type PublicPlayer struct {
	Name        string `json:"name"`
	Score       *int   `json:"score,omitempty"`
	DurationSec *int   `json:"duration_s,omitempty"`
}

var errNoPlayerNames = errors.New("this query type does not provide player names")

// PublicPlayers fetches the names of the players currently online through the
// public query: A2S_PLAYER for Source games, Query Full Stat (falling back to
// the Server List Ping's sample) for Minecraft Java. Not part of the periodic
// probe — names change constantly and are only wanted when someone looks.
func PublicPlayers(srv store.Server) ([]PublicPlayer, error) {
	mode := EffectivePublicQueryProtocol(srv)
	if mode != "a2s" && mode != "minecraft" {
		if mode == "disabled" {
			return nil, errPublicQueryDisabled
		}
		return nil, errNoPlayerNames
	}
	pinned, err := resolveTarget(srv.Host)
	if err != nil {
		return nil, err
	}
	port := srv.Port
	if srv.QueryPort != nil {
		port = *srv.QueryPort
	}
	if !validPort(port) {
		return nil, errors.New("invalid port")
	}

	if mode == "a2s" {
		rows, _, err := timed(func() ([]A2SPlayer, error) { return QueryA2SPlayers(pinned, port) })
		if err != nil {
			return nil, err
		}
		out := make([]PublicPlayer, 0, len(rows))
		for _, r := range rows {
			score, dur := r.Score, r.DurationSec
			out = append(out, PublicPlayer{Name: r.Name, Score: &score, DurationSec: &dur})
		}
		return out, nil
	}

	full, _, err := timed(func() (MinecraftFullStat, error) { return QueryMinecraftFullStat(pinned, port) })
	if err == nil {
		out := make([]PublicPlayer, 0, len(full.PlayerNames))
		for _, n := range full.PlayerNames {
			out = append(out, PublicPlayer{Name: n})
		}
		return out, nil
	}
	ping, _, perr := timed(func() (MinecraftPing, error) { return QueryMinecraftPing(pinned, port) })
	if perr != nil {
		return nil, err
	}
	out := make([]PublicPlayer, 0, len(ping.Sample))
	for _, n := range ping.Sample {
		out = append(out, PublicPlayer{Name: n})
	}
	return out, nil
}

// PublicQueryDue reports whether the periodic public-info loop should probe
// srv. Beyond "the query is not disabled" it keeps probes from pointing at the
// wrong port: a game whose RCON port is not its game port (7 Days to Die's
// Telnet, Rust's WebRCON, Arma's BattlEye) is only probed on "auto" once a
// query port is stored — probing the RCON port would just record a false
// offline sample. Servers whose query is explicitly configured, Source-RCON
// servers and Minecraft keep their historical behaviour.
func PublicQueryDue(srv store.Server) bool {
	mode := EffectivePublicQueryProtocol(srv)
	if mode == "disabled" {
		return false
	}
	switch srv.QueryProtocol {
	case "a2s", "minecraft", "bedrock":
		return true
	}
	if mode == "palworld" || srv.Protocol == "source" || srv.Game == "Minecraft" {
		return true
	}
	return srv.QueryPort != nil
}

// EffectivePublicQueryProtocol resolves the backwards-compatible auto mode.
// It intentionally does not guess support for every non-Source game: one
// not listed here or given "source" as its RCON protocol must opt into A2S
// explicitly (or be disabled), rather than have it assumed.
func EffectivePublicQueryProtocol(srv store.Server) string {
	switch srv.QueryProtocol {
	case "a2s", "minecraft", "bedrock", "disabled":
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
		// Palworld has no UDP query; its REST API is the status source, and
		// needs the (already stored) admin password.
		if srv.Protocol == "palworld_rest" && srv.Password != "" {
			return "palworld"
		}
	}
	return "disabled"
}
