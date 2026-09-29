package relay

import (
	"bytes"
	"encoding/binary"
	"net"
	"testing"
)

// newFakeUDPServer starts a minimal UDP echo-style server: handle is
// called with a copy of each received datagram and its return value (if
// non-nil) is sent back to the sender. Shared by a2s_test.go and
// minecraft_query_test.go — both protocols are a plain "one datagram in,
// one datagram out" request/response, unlike BattlEye's persistent,
// multi-packet session (see battleye_test.go's fakeBattleyeServer).
func newFakeUDPServer(t *testing.T, handle func(reqBody []byte) []byte) int {
	t.Helper()
	udp, err := net.ListenUDP("udp", &net.UDPAddr{IP: net.IPv4(127, 0, 0, 1), Port: 0})
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	t.Cleanup(func() { udp.Close() })
	go func() {
		buf := make([]byte, 4096)
		for {
			n, addr, err := udp.ReadFromUDP(buf)
			if err != nil {
				return
			}
			resp := handle(append([]byte(nil), buf[:n]...))
			if resp != nil {
				udp.WriteToUDP(resp, addr)
			}
		}
	}()
	return udp.LocalAddr().(*net.UDPAddr).Port
}

func buildA2SInfoResponse(name, mapName, folder, game string, players, maxPlayers, bots, vac byte, version string) []byte {
	var buf bytes.Buffer
	buf.Write([]byte{0xFF, 0xFF, 0xFF, 0xFF, a2sResponseHeader})
	buf.WriteByte(0x11) // protocol version, arbitrary
	buf.WriteString(name)
	buf.WriteByte(0)
	buf.WriteString(mapName)
	buf.WriteByte(0)
	buf.WriteString(folder)
	buf.WriteByte(0)
	buf.WriteString(game)
	buf.WriteByte(0)
	appID := make([]byte, 2)
	binary.LittleEndian.PutUint16(appID, 4000)
	buf.Write(appID)
	buf.WriteByte(players)
	buf.WriteByte(maxPlayers)
	buf.WriteByte(bots)
	buf.WriteByte('d') // dedicated
	buf.WriteByte('l') // linux
	buf.WriteByte(0)   // not password protected
	buf.WriteByte(vac)
	buf.WriteString(version)
	buf.WriteByte(0)
	return buf.Bytes()
}

func TestQueryA2SInfoDirect(t *testing.T) {
	resp := buildA2SInfoResponse("Test Server", "de_dust2", "cstrike", "Counter-Strike 2", 5, 10, 1, 1, "1.0")
	port := newFakeUDPServer(t, func(reqBody []byte) []byte {
		return resp
	})

	info, err := QueryA2SInfo("127.0.0.1", port)
	if err != nil {
		t.Fatalf("QueryA2SInfo: %v", err)
	}
	if info.Name != "Test Server" || info.Map != "de_dust2" || info.Game != "Counter-Strike 2" {
		t.Errorf("unexpected identity fields: %+v", info)
	}
	if info.Players != 5 || info.MaxPlayers != 10 || info.Bots != 1 {
		t.Errorf("unexpected counts: %+v", info)
	}
	if !info.VACEnabled {
		t.Error("expected VACEnabled to be true")
	}
	if info.Version != "1.0" {
		t.Errorf("version = %q, want %q", info.Version, "1.0")
	}
}

// TestQueryA2SInfoChallengeRoundTrip exercises the post-2020 challenge
// mechanism: the first request gets back a challenge instead of the real
// answer, and the client must resend with it appended, verbatim.
func TestQueryA2SInfoChallengeRoundTrip(t *testing.T) {
	resp := buildA2SInfoResponse("Challenged Server", "islands", "ark", "ARK: Survival Ascended", 2, 20, 0, 0, "2.0")
	challenge := []byte{0x12, 0x34, 0x56, 0x78}
	sawFollowUp := false

	port := newFakeUDPServer(t, func(reqBody []byte) []byte {
		prefixLen := 5 + len(a2sInfoPayload)
		if len(reqBody) < prefixLen {
			t.Fatalf("request too short: %x", reqBody)
		}
		suffix := reqBody[prefixLen:]
		if len(suffix) == 0 {
			return append([]byte{0xFF, 0xFF, 0xFF, 0xFF, a2sChallengeHeader}, challenge...)
		}
		if !bytes.Equal(suffix, challenge) {
			t.Errorf("follow-up request's challenge = %x, want %x", suffix, challenge)
		}
		sawFollowUp = true
		return resp
	})

	info, err := QueryA2SInfo("127.0.0.1", port)
	if err != nil {
		t.Fatalf("QueryA2SInfo: %v", err)
	}
	if !sawFollowUp {
		t.Error("server never received the follow-up request with the challenge appended")
	}
	if info.Name != "Challenged Server" || info.Players != 2 || info.MaxPlayers != 20 {
		t.Errorf("unexpected info: %+v", info)
	}
}

func TestQueryA2SInfoTimesOutOnNoResponse(t *testing.T) {
	// Bind a UDP socket just to claim a definitely-free port, then close it
	// immediately — nothing will ever answer there, so the query should
	// give up (a2sTimeout) rather than hang forever.
	probe, err := net.ListenUDP("udp", &net.UDPAddr{IP: net.IPv4(127, 0, 0, 1), Port: 0})
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	port := probe.LocalAddr().(*net.UDPAddr).Port
	probe.Close()

	if _, err := QueryA2SInfo("127.0.0.1", port); err == nil {
		t.Fatal("expected an error querying an unresponsive port, got nil")
	}
}

func TestQueryA2SInfoRejectsWrongResponseType(t *testing.T) {
	port := newFakeUDPServer(t, func(reqBody []byte) []byte {
		return []byte{0xFF, 0xFF, 0xFF, 0xFF, 0x44} // some other, unrelated response type
	})
	if _, err := QueryA2SInfo("127.0.0.1", port); err == nil {
		t.Fatal("expected an error for an unexpected response type, got nil")
	}
}
