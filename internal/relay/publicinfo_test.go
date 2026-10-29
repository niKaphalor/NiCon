package relay

import (
	"bufio"
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"strconv"
	"strings"
	"sync/atomic"
	"syscall"
	"testing"
	"time"

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

func TestPublicQueryDue(t *testing.T) {
	port := 27015
	tests := []struct {
		name string
		srv  store.Server
		want bool
	}{
		{"Source auto", store.Server{Protocol: "source", QueryProtocol: "auto"}, true},
		{"Minecraft auto", store.Server{Protocol: "source", Game: "Minecraft", QueryProtocol: "auto"}, true},
		{"explicit disabled", store.Server{Protocol: "source", QueryProtocol: "disabled"}, false},
		{"ARK: Survival Ascended auto resolves to disabled", store.Server{Protocol: "source", Game: "ARK: Survival Ascended", QueryProtocol: "auto"}, false},
		{"Hytale auto resolves to disabled", store.Server{Protocol: "source", Game: "Hytale", QueryProtocol: "auto"}, false},
		{"explicit a2s beside WebRCON", store.Server{Protocol: "webrcon", QueryProtocol: "a2s"}, true},
		{"explicit bedrock", store.Server{Protocol: "source", QueryProtocol: "bedrock"}, true},
		{"7DTD auto without query port is not probed", store.Server{Protocol: "telnet", Game: "7 Days to Die", QueryProtocol: "auto"}, false},
		{"7DTD auto with query port", store.Server{Protocol: "telnet", Game: "7 Days to Die", QueryProtocol: "auto", QueryPort: &port}, true},
		{"Rust auto without query port is not probed", store.Server{Protocol: "webrcon", Game: "Rust", QueryProtocol: "auto"}, false},
		{"Rust auto with query port", store.Server{Protocol: "webrcon", Game: "Rust", QueryProtocol: "auto", QueryPort: &port}, true},
		{"unlisted non-Source game with query port stays disabled", store.Server{Protocol: "battlebit", Game: "BattleBit Remastered", QueryProtocol: "auto", QueryPort: &port}, false},
		{"Palworld with password", store.Server{Protocol: "palworld_rest", Password: "x", QueryProtocol: "auto"}, true},
		{"Palworld without password", store.Server{Protocol: "palworld_rest", QueryProtocol: "auto"}, false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := PublicQueryDue(tt.srv); got != tt.want {
				t.Fatalf("PublicQueryDue() = %v, want %v", got, tt.want)
			}
		})
	}
}

func TestEffectivePublicQueryProtocolBedrockAndPalworld(t *testing.T) {
	if got := EffectivePublicQueryProtocol(store.Server{QueryProtocol: "bedrock"}); got != "bedrock" {
		t.Errorf("explicit bedrock = %q", got)
	}
	if got := EffectivePublicQueryProtocol(store.Server{Protocol: "palworld_rest", Password: "p", QueryProtocol: "auto"}); got != "palworld" {
		t.Errorf("Palworld auto = %q", got)
	}
}

func TestClassifyQueryError(t *testing.T) {
	_, timeoutErr := net.DialTimeout("tcp", "10.255.255.1:81", 1) // 1ns: always a timeout
	refused := &net.OpError{Op: "read", Err: &os.SyscallError{Syscall: "recvfrom", Err: syscall.ECONNREFUSED}}
	for name, tt := range map[string]struct {
		err  error
		want string
	}{
		"nil":      {nil, ""},
		"disabled": {errPublicQueryDisabled, QueryErrDisabled},
		"blocked":  {fmt.Errorf("x: %w", errTargetNotAllowed), QueryErrBlocked},
		"dns":      {&net.DNSError{Err: "no such host", Name: "x"}, QueryErrDNS},
		"timeout":  {fmt.Errorf("a2s: no response: %w", os.ErrDeadlineExceeded), QueryErrTimeout},
		"dial":     {timeoutErr, QueryErrTimeout},
		"refused":  {fmt.Errorf("a2s: %w", refused), QueryErrRefused},
		"auth":     {errors.New("palworld REST API: unauthorized — check the server's admin password"), QueryErrAuth},
		"protocol": {errors.New("a2s: malformed or fragmented response"), QueryErrProtocol},
	} {
		if got := classifyQueryError(tt.err); got != tt.want {
			t.Errorf("%s: classifyQueryError() = %q, want %q", name, got, tt.want)
		}
	}
}

func TestTimedRetriesTimeoutsOnly(t *testing.T) {
	calls := 0
	_, _, err := timed(func() (int, error) { calls++; return 0, os.ErrDeadlineExceeded })
	if err == nil || calls != 2 {
		t.Fatalf("timeout: calls = %d err = %v, want 2 calls and an error", calls, err)
	}
	calls = 0
	_, _, err = timed(func() (int, error) { calls++; return 0, syscall.ECONNREFUSED })
	if err == nil || calls != 1 {
		t.Fatalf("refused: calls = %d, want exactly 1 (retrying cannot help)", calls)
	}
	calls = 0
	v, _, err := timed(func() (int, error) {
		calls++
		if calls == 1 {
			return 0, os.ErrDeadlineExceeded
		}
		return 7, nil
	})
	if err != nil || v != 7 || calls != 2 {
		t.Fatalf("recovered: v=%d calls=%d err=%v", v, calls, err)
	}
}

func TestQueryPublicInfoA2SRetriesALostPacket(t *testing.T) {
	old := a2sTimeout
	a2sTimeout = 300 * time.Millisecond
	t.Cleanup(func() { a2sTimeout = old })
	SetTargetPolicy(TargetPolicy{})

	var requests atomic.Int32
	resp := buildA2SInfoResponse("Lossy", "de_dust2", "cstrike", "CS", 5, 10, 0, 1, "1.0")
	port := newFakeUDPServer(t, func([]byte) []byte {
		if requests.Add(1) == 1 {
			return nil // the first datagram is "lost"
		}
		return resp
	})
	res := QueryPublicInfo(store.Server{Host: "127.0.0.1", Port: port, Protocol: "source", QueryProtocol: "auto"})
	if !res.Online || res.Players == nil || *res.Players != 5 || res.Name != "Lossy" || res.Map != "de_dust2" ||
		res.Passworded == nil || *res.Passworded || res.LatencyMs == nil || res.Source != "a2s" || res.ErrorKind != "" {
		t.Fatalf("unexpected result after one lost packet: %+v (requests: %d)", res, requests.Load())
	}
}

func TestQueryPublicInfoRecordsErrorKinds(t *testing.T) {
	old := a2sTimeout
	a2sTimeout = 150 * time.Millisecond
	t.Cleanup(func() { a2sTimeout = old })
	SetTargetPolicy(TargetPolicy{})

	// A UDP socket that never answers: timeout.
	silent, _ := net.ListenUDP("udp", &net.UDPAddr{IP: net.IPv4(127, 0, 0, 1)})
	t.Cleanup(func() { silent.Close() })
	res := QueryPublicInfo(store.Server{Host: "127.0.0.1", Port: silent.LocalAddr().(*net.UDPAddr).Port, QueryProtocol: "a2s"})
	if res.Online || res.ErrorKind != QueryErrTimeout || res.InfoJSON() != "" {
		t.Errorf("silent port: %+v", res)
	}
	// A closed UDP port: refused (Linux reports the ICMP error on read).
	gone, _ := net.ListenUDP("udp", &net.UDPAddr{IP: net.IPv4(127, 0, 0, 1)})
	goneAddr := gone.LocalAddr().(*net.UDPAddr)
	gone.Close()
	res = QueryPublicInfo(store.Server{Host: "127.0.0.1", Port: goneAddr.Port, QueryProtocol: "a2s"})
	if res.Online || res.ErrorKind != QueryErrRefused {
		t.Errorf("closed port: %+v", res)
	}
	// Disabled and blocked.
	if res := QueryPublicInfo(store.Server{Host: "127.0.0.1", Port: 1, QueryProtocol: "disabled"}); res.ErrorKind != QueryErrDisabled {
		t.Errorf("disabled: %+v", res)
	}
	SetTargetPolicy(TargetPolicy{BlockPrivate: true})
	t.Cleanup(func() { SetTargetPolicy(TargetPolicy{}) })
	if res := QueryPublicInfo(store.Server{Host: "127.0.0.1", Port: 27015, QueryProtocol: "a2s"}); res.ErrorKind != QueryErrBlocked {
		t.Errorf("blocked: %+v", res)
	}
}

func TestQueryPublicInfoPalworldAndJSON(t *testing.T) {
	SetTargetPolicy(TargetPolicy{})
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if _, pw, ok := r.BasicAuth(); !ok || pw != "secret" {
			http.Error(w, "no", http.StatusUnauthorized)
			return
		}
		switch r.URL.Path {
		case "/v1/api/info":
			w.Write([]byte(`{"version":"v0.6.2","servername":"Pals"}`))
		case "/v1/api/metrics":
			w.Write([]byte(`{"serverfps":58.7,"currentplayernum":4,"maxplayernum":32,"uptime":7200,"days":9}`))
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(srv.Close)
	host, portStr, _ := net.SplitHostPort(strings.TrimPrefix(srv.URL, "http://"))
	port, _ := strconv.Atoi(portStr)

	res := QueryPublicInfo(store.Server{Host: host, Port: port, Protocol: "palworld_rest", Password: "secret", QueryProtocol: "auto"})
	if !res.Online || *res.Players != 4 || *res.MaxPlayers != 32 || res.Source != "palworld" || *res.ServerFPS != 59 || *res.UptimeSec != 7200 {
		t.Fatalf("unexpected Palworld result: %+v", res)
	}
	var stored map[string]any
	if err := json.Unmarshal([]byte(res.InfoJSON()), &stored); err != nil || stored["name"] != "Pals" || stored["version"] != "v0.6.2" || stored["days"] != float64(9) {
		t.Fatalf("stored JSON = %s (%v)", res.InfoJSON(), err)
	}

	bad := QueryPublicInfo(store.Server{Host: host, Port: port, Protocol: "palworld_rest", Password: "wrong", QueryProtocol: "auto"})
	if bad.Online || bad.ErrorKind != QueryErrAuth {
		t.Fatalf("wrong password: %+v", bad)
	}
}

func TestPublicPlayers(t *testing.T) {
	SetTargetPolicy(TargetPolicy{})
	port := newFakeUDPServer(t, func(req []byte) []byte {
		if bytes.Equal(req[5:9], []byte{0xFF, 0xFF, 0xFF, 0xFF}) {
			return []byte{0xFF, 0xFF, 0xFF, 0xFF, a2sChallengeHeader, 1, 1, 1, 1}
		}
		return append([]byte{0xFF, 0xFF, 0xFF, 0xFF}, a2sPlayerBody([]A2SPlayer{{Name: "Bob", Score: 3, DurationSec: 61}})...)
	})
	got, err := PublicPlayers(store.Server{Host: "127.0.0.1", Port: port, Protocol: "source", QueryProtocol: "auto"})
	if err != nil || len(got) != 1 || got[0].Name != "Bob" || *got[0].Score != 3 || *got[0].DurationSec != 61 {
		t.Fatalf("PublicPlayers = %+v (%v)", got, err)
	}
	if _, err := PublicPlayers(store.Server{Host: "127.0.0.1", Port: 1, QueryProtocol: "bedrock"}); !errors.Is(err, errNoPlayerNames) {
		t.Errorf("bedrock: err = %v, want errNoPlayerNames", err)
	}
	if _, err := PublicPlayers(store.Server{Host: "127.0.0.1", Port: 1, QueryProtocol: "disabled"}); !errors.Is(err, errPublicQueryDisabled) {
		t.Errorf("disabled: err = %v", err)
	}
}
