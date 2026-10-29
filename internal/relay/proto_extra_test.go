package relay

import (
	"bytes"
	"encoding/binary"
	"encoding/json"
	"math"
	"net"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
)

// newFakeUDPServerMulti is newFakeUDPServer for servers that answer with
// several datagrams (split A2S responses).
func newFakeUDPServerMulti(t *testing.T, handle func(reqBody []byte) [][]byte) int {
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
			for _, resp := range handle(append([]byte(nil), buf[:n]...)) {
				udp.WriteToUDP(resp, addr)
			}
		}
	}()
	return udp.LocalAddr().(*net.UDPAddr).Port
}

func a2sPlayerBody(players []A2SPlayer) []byte {
	var b bytes.Buffer
	b.WriteByte(a2sPlayerResponseHeader)
	b.WriteByte(byte(len(players)))
	for i, p := range players {
		b.WriteByte(byte(i))
		b.WriteString(p.Name)
		b.WriteByte(0)
		binary.Write(&b, binary.LittleEndian, int32(p.Score))
		binary.Write(&b, binary.LittleEndian, math.Float32bits(float32(p.DurationSec)))
	}
	return b.Bytes()
}

func splitA2S(id uint32, body []byte, parts int) [][]byte {
	whole := append([]byte{0xFF, 0xFF, 0xFF, 0xFF}, body...)
	size := (len(whole) + parts - 1) / parts
	var out [][]byte
	for i := 0; i < parts; i++ {
		lo, hi := i*size, (i+1)*size
		if hi > len(whole) {
			hi = len(whole)
		}
		var pkt bytes.Buffer
		pkt.Write(a2sSplitMarker)
		binary.Write(&pkt, binary.LittleEndian, id)
		pkt.WriteByte(byte(parts))
		pkt.WriteByte(byte(i))
		binary.Write(&pkt, binary.LittleEndian, uint16(hi-lo))
		pkt.Write(whole[lo:hi])
		out = append(out, pkt.Bytes())
	}
	return out
}

func TestQueryA2SPlayersWithChallenge(t *testing.T) {
	want := []A2SPlayer{{Name: "Alice", Score: 12, DurationSec: 300}, {Name: "", Score: 0, DurationSec: 4}}
	var challengeSent atomic.Bool
	port := newFakeUDPServer(t, func(req []byte) []byte {
		if req[4] != a2sPlayerRequestHeader {
			t.Errorf("request type = 0x%02x", req[4])
		}
		if !bytes.Equal(req[5:9], []byte{0xFF, 0xFF, 0xFF, 0xFF}) {
			challengeSent.Store(true)
			if !bytes.Equal(req[5:9], []byte{1, 2, 3, 4}) {
				t.Errorf("challenge not echoed: %x", req[5:9])
			}
			return append([]byte{0xFF, 0xFF, 0xFF, 0xFF}, a2sPlayerBody(want)...)
		}
		return []byte{0xFF, 0xFF, 0xFF, 0xFF, a2sChallengeHeader, 1, 2, 3, 4}
	})
	got, err := QueryA2SPlayers("127.0.0.1", port)
	if err != nil {
		t.Fatalf("QueryA2SPlayers: %v", err)
	}
	if !challengeSent.Load() || len(got) != 2 || got[0] != want[0] || got[1] != want[1] {
		t.Fatalf("got %+v (challenge answered: %v)", got, challengeSent.Load())
	}
}

func TestQueryA2SPlayersReassemblesSplitResponse(t *testing.T) {
	var want []A2SPlayer
	for i := 0; i < 40; i++ {
		want = append(want, A2SPlayer{Name: "player-" + strconv.Itoa(i), Score: i, DurationSec: i * 10})
	}
	port := newFakeUDPServerMulti(t, func(req []byte) [][]byte {
		if bytes.Equal(req[5:9], []byte{0xFF, 0xFF, 0xFF, 0xFF}) {
			return [][]byte{{0xFF, 0xFF, 0xFF, 0xFF, a2sChallengeHeader, 9, 9, 9, 9}}
		}
		parts := splitA2S(0x1234, a2sPlayerBody(want), 3)
		return [][]byte{parts[2], parts[0], parts[1]} // out of order
	})
	got, err := QueryA2SPlayers("127.0.0.1", port)
	if err != nil || len(got) != 40 || got[39].Name != "player-39" || got[39].DurationSec != 390 {
		t.Fatalf("got %d players, err %v", len(got), err)
	}
}

func TestA2SReadRejectsBadSplitResponses(t *testing.T) {
	compressed := splitA2S(0x80001234, []byte{0x44, 0}, 1)
	tooMany := splitA2S(1, []byte{0x44, 0}, 1)
	tooMany[0][8] = 200 // claims 200 fragments
	for name, pkts := range map[string][][]byte{"compressed": compressed, "implausible fragment count": tooMany} {
		t.Run(name, func(t *testing.T) {
			port := newFakeUDPServerMulti(t, func([]byte) [][]byte { return pkts })
			if _, err := QueryA2SPlayers("127.0.0.1", port); err == nil {
				t.Fatal("expected an error")
			}
		})
	}
}

func TestParseA2SInfoPasswordFlag(t *testing.T) {
	// buildA2SInfoResponse leaves the visibility byte at 0; flip it.
	resp := buildA2SInfoResponse("n", "m", "f", "g", 1, 2, 0, 1, "1.0")
	info, err := parseA2SInfo(resp[4:])
	if err != nil || info.Passworded {
		t.Fatalf("unprotected server parsed as %+v (%v)", info, err)
	}
	idx := bytes.Index(resp, []byte("1.0")) - 2 // visibility, VAC, then version
	resp[idx] = 1
	info, err = parseA2SInfo(resp[4:])
	if err != nil || !info.Passworded {
		t.Fatalf("password flag not parsed: %+v (%v)", info, err)
	}
}

func TestQueryMinecraftFullStat(t *testing.T) {
	port := newFakeUDPServer(t, func(req []byte) []byte {
		sid := req[3:7]
		if req[2] == 0x09 {
			return append(append([]byte{0x09}, sid...), []byte("4242\x00")...)
		}
		if len(req) != 15 {
			t.Errorf("full stat request must be padded to 15 bytes, got %d", len(req))
		}
		var b bytes.Buffer
		b.WriteByte(0x00)
		b.Write(sid)
		b.WriteString("splitnum\x00\x80\x00")
		for _, kv := range [][2]string{{"hostname", "NiCon MC"}, {"version", "1.21.4"}, {"map", "world"}, {"numplayers", "2"}, {"maxplayers", "20"}} {
			b.WriteString(kv[0] + "\x00" + kv[1] + "\x00")
		}
		b.WriteByte(0)
		b.WriteString("\x01player_\x00\x00")
		b.WriteString("Steve\x00Alex\x00\x00")
		return b.Bytes()
	})
	st, err := QueryMinecraftFullStat("127.0.0.1", port)
	if err != nil {
		t.Fatalf("QueryMinecraftFullStat: %v", err)
	}
	if st.MOTD != "NiCon MC" || st.Version != "1.21.4" || st.Players != 2 || st.MaxPlayers != 20 ||
		strings.Join(st.PlayerNames, ",") != "Steve,Alex" {
		t.Fatalf("unexpected full stat: %+v", st)
	}
}

func TestParseMinecraftFullStatRejectsGarbage(t *testing.T) {
	if _, err := parseMinecraftFullStat([]byte{0x09, 0, 0, 0, 0, 'x'}); err == nil {
		t.Fatal("expected an error for a non-stat packet")
	}
	trunc := append([]byte{0x00, 1, 2, 3, 4}, []byte("splitnum\x00\x80\x00hostname\x00")...)
	if _, err := parseMinecraftFullStat(trunc); err == nil {
		t.Fatal("expected an error for a truncated response")
	}
}

func TestChatText(t *testing.T) {
	for in, want := range map[string]string{
		`"plain"`: "plain",
		`{"text":"a","extra":[{"text":"b"},"c"]}`: "abc",
		`{"nonsense":1}`: "",
		`12`:             "",
	} {
		if got := chatText(json.RawMessage(in), 0); got != want {
			t.Errorf("chatText(%s) = %q, want %q", in, got, want)
		}
	}
}

func TestQueryMinecraftPingVersionMOTDAndSample(t *testing.T) {
	port := fakePingServer(t, func(c net.Conn) {
		buf := make([]byte, 64)
		c.Read(buf)
		c.Write(statusPacket(`{"version":{"name":"Paper 1.21.4","protocol":769},"description":{"text":"Hi ","extra":[{"text":"there"}]},"players":{"max":20,"online":2,"sample":[{"name":"Steve","id":"x"},{"name":"Alex","id":"y"}]}}`))
	})
	ping, err := QueryMinecraftPing("127.0.0.1", port)
	if err != nil || ping.Version != "Paper 1.21.4" || ping.MOTD != "Hi there" || strings.Join(ping.Sample, ",") != "Steve,Alex" {
		t.Fatalf("unexpected ping: %+v (%v)", ping, err)
	}
}

func bedrockPong(info string) []byte {
	var b bytes.Buffer
	b.WriteByte(0x1C)
	binary.Write(&b, binary.BigEndian, uint64(1))
	binary.Write(&b, binary.BigEndian, uint64(2))
	b.Write(raknetMagic)
	binary.Write(&b, binary.BigEndian, uint16(len(info)))
	b.WriteString(info)
	return b.Bytes()
}

func TestQueryBedrockRakNet(t *testing.T) {
	port := newFakeUDPServer(t, func(req []byte) []byte {
		if req[0] != 0x01 || !bytes.Equal(req[9:25], raknetMagic) {
			t.Errorf("not an unconnected ping: %x", req)
		}
		return bedrockPong("MCPE;My Bedrock;818;1.21.50;3;10;123456;World;Survival;1;19132;19133;")
	})
	info, err := QueryBedrockRakNet("127.0.0.1", port)
	if err != nil || info.Name != "My Bedrock" || info.Version != "1.21.50" || info.Players != 3 || info.MaxPlayers != 10 ||
		info.Level != "World" || info.GameType != "Survival" {
		t.Fatalf("unexpected info: %+v (%v)", info, err)
	}
}

func TestParseBedrockPongRejectsGarbage(t *testing.T) {
	for name, resp := range map[string][]byte{
		"short":       {0x1C, 1, 2},
		"wrong id":    append([]byte{0x19}, bedrockPong("MCPE;a;1;1;1;1")[1:]...),
		"bad counts":  bedrockPong("MCPE;a;1;1.0;x;y;1"),
		"wrong game":  bedrockPong("OTHER;a;1;1.0;1;2;1"),
		"few fields":  bedrockPong("MCPE;a"),
		"length lies": append(bedrockPong("MCPE;a;1;1.0;1;2")[:33], 0xFF, 0xFF, 'M'),
	} {
		if _, err := parseBedrockPong(resp); err == nil {
			t.Errorf("%s: expected an error", name)
		}
	}
}

func TestParseNetherNetJoin(t *testing.T) {
	info, err := parseNetherNetJoin([]byte(`{"name":"NN","protocol":944,"version":"26.50","level":"W","players":4,"maxPlayers":12,"gameType":"creative"}`))
	if err != nil || info.Name != "NN" || info.Players != 4 || info.MaxPlayers != 12 || info.GameType != "creative" {
		t.Fatalf("unexpected info: %+v (%v)", info, err)
	}
	for _, bad := range []string{`{}`, `<html>`, `{"players":1}`} {
		if _, err := parseNetherNetJoin([]byte(bad)); err == nil {
			t.Errorf("%q: expected an error", bad)
		}
	}
}

func TestParsePalworldStatus(t *testing.T) {
	st, err := parsePalworldStatus(
		`{"version":"v0.6.2","servername":"Pal","description":"x"}`,
		`{"serverfps":59,"currentplayernum":3,"serverframetime":16.6,"maxplayernum":32,"uptime":3600,"days":12}`)
	if err != nil || st.Name != "Pal" || st.Version != "v0.6.2" || st.Players != 3 || st.MaxPlayers != 32 ||
		st.ServerFPS != 59 || st.UptimeSeconds != 3600 || st.Days != 12 {
		t.Fatalf("unexpected status: %+v (%v)", st, err)
	}
	if _, err := parsePalworldStatus(`{}`, `{"maxplayernum":2}`); err == nil {
		t.Fatal("metrics without currentplayernum must be rejected")
	}
	if _, err := parsePalworldStatus(`oops`, `{}`); err == nil {
		t.Fatal("garbage info must be rejected")
	}
}

func TestCleanText(t *testing.T) {
	if got := cleanText("  a\x00b\x1b[0m\xffc  ", 64); got != "ab[0mc" {
		t.Errorf("cleanText = %q", got)
	}
	if got := cleanText(strings.Repeat("ä", 100), 10); len([]rune(got)) != 10 {
		t.Errorf("cleanText did not cap at 10 runes: %d", len([]rune(got)))
	}
}
