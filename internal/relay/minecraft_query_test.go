package relay

import (
	"bytes"
	"encoding/binary"
	"net"
	"strconv"
	"testing"
)

func TestQueryMinecraftStat(t *testing.T) {
	const challengeToken = int32(87654321)
	sawStatRequest := false

	port := newFakeUDPServer(t, func(reqBody []byte) []byte {
		if len(reqBody) < 7 || reqBody[0] != 0xFE || reqBody[1] != 0xFD {
			t.Fatalf("unexpected request magic: %x", reqBody)
		}
		sessionID := reqBody[3:7]

		switch reqBody[2] {
		case 0x09: // handshake
			resp := append([]byte{0x09}, sessionID...)
			resp = append(resp, []byte(strconv.Itoa(int(challengeToken)))...)
			resp = append(resp, 0)
			return resp
		case 0x00: // basic stat
			wantChallenge := make([]byte, 4)
			binary.BigEndian.PutUint32(wantChallenge, uint32(challengeToken))
			if len(reqBody) < 11 || !bytes.Equal(reqBody[7:11], wantChallenge) {
				t.Errorf("stat request challenge = %x, want %x", reqBody[7:], wantChallenge)
			}
			sawStatRequest = true
			resp := append([]byte{0x00}, sessionID...)
			for _, field := range []string{"A NiCon test server", "SMP", "world", "7", "20"} {
				resp = append(resp, []byte(field)...)
				resp = append(resp, 0)
			}
			return resp
		default:
			t.Fatalf("unexpected request type: 0x%02x", reqBody[2])
			return nil
		}
	})

	stat, err := QueryMinecraftStat("127.0.0.1", port)
	if err != nil {
		t.Fatalf("QueryMinecraftStat: %v", err)
	}
	if !sawStatRequest {
		t.Error("server never received the stat request after the handshake")
	}
	if stat.MOTD != "A NiCon test server" || stat.GameType != "SMP" || stat.Map != "world" {
		t.Errorf("unexpected identity fields: %+v", stat)
	}
	if stat.Players != 7 || stat.MaxPlayers != 20 {
		t.Errorf("unexpected counts: %+v", stat)
	}
}

func TestQueryMinecraftStatTimesOutOnNoResponse(t *testing.T) {
	probe, err := net.ListenUDP("udp", &net.UDPAddr{IP: net.IPv4(127, 0, 0, 1), Port: 0})
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	port := probe.LocalAddr().(*net.UDPAddr).Port
	probe.Close()

	if _, err := QueryMinecraftStat("127.0.0.1", port); err == nil {
		t.Fatal("expected an error querying an unresponsive port, got nil")
	}
}
