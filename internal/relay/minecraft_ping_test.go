package relay

import (
	"bufio"
	"bytes"
	"net"
	"strings"
	"testing"
)

// fakePingServer accepts one connection, verifies the handshake + status
// request, and answers with the given packet payload (status JSON string).
func fakePingServer(t *testing.T, reply func(c net.Conn)) int {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	t.Cleanup(func() { ln.Close() })
	go func() {
		c, err := ln.Accept()
		if err != nil {
			return
		}
		defer c.Close()
		reply(c)
	}()
	return ln.Addr().(*net.TCPAddr).Port
}

func statusPacket(json string) []byte {
	var body bytes.Buffer
	body.WriteByte(0x00)
	writeVarInt(&body, int32(len(json)))
	body.WriteString(json)
	var out bytes.Buffer
	writeVarInt(&out, int32(body.Len()))
	out.Write(body.Bytes())
	return out.Bytes()
}

func TestQueryMinecraftPing(t *testing.T) {
	sawStatusRequest := false
	port := fakePingServer(t, func(c net.Conn) {
		r := bufio.NewReader(c)
		length, _ := readVarInt(r)
		hs := make([]byte, length)
		if _, err := r.Read(hs); err != nil || hs[0] != 0x00 {
			t.Errorf("bad handshake: %x (%v)", hs, err)
		}
		if hs[len(hs)-1] != 0x01 {
			t.Errorf("next state = %d, want 1 (status)", hs[len(hs)-1])
		}
		req := make([]byte, 2)
		if _, err := r.Read(req); err == nil && req[0] == 0x01 && req[1] == 0x00 {
			sawStatusRequest = true
		}
		c.Write(statusPacket(`{"version":{"name":"1.21","protocol":767},"players":{"max":20,"online":7,"sample":[]},"description":"hi"}`))
	})

	ping, err := QueryMinecraftPing("127.0.0.1", port)
	if err != nil {
		t.Fatalf("QueryMinecraftPing: %v", err)
	}
	if !sawStatusRequest {
		t.Error("server never received the status request after the handshake")
	}
	if ping.Players != 7 || ping.MaxPlayers != 20 {
		t.Errorf("unexpected counts: %+v", ping)
	}
}

func TestQueryMinecraftPingRejectsBadResponses(t *testing.T) {
	huge := statusPacket(`{"players":{"online":1,"max":2},"x":"` + strings.Repeat("a", maxMinecraftPingJSON) + `"}`)
	tests := map[string][]byte{
		"not json":          statusPacket(`<html>`),
		"no players object": statusPacket(`{"description":"hi"}`),
		"oversized status":  huge,
		"empty":             nil,
	}
	for name, resp := range tests {
		t.Run(name, func(t *testing.T) {
			port := fakePingServer(t, func(c net.Conn) {
				bufio.NewReader(c).Peek(1)
				if resp != nil {
					c.Write(resp)
				}
			})
			if _, err := QueryMinecraftPing("127.0.0.1", port); err == nil {
				t.Fatal("expected an error, got nil")
			}
		})
	}
}

func TestQueryMinecraftPingConnectionRefused(t *testing.T) {
	ln, _ := net.Listen("tcp", "127.0.0.1:0")
	port := ln.Addr().(*net.TCPAddr).Port
	ln.Close()
	if _, err := QueryMinecraftPing("127.0.0.1", port); err == nil {
		t.Fatal("expected an error for a closed port, got nil")
	}
}

func TestVarIntRoundTrip(t *testing.T) {
	for _, v := range []int32{0, 1, 127, 128, 25565, 2097151, -1} {
		var b bytes.Buffer
		writeVarInt(&b, v)
		got, err := readVarInt(bufio.NewReader(&b))
		if err != nil || got != v {
			t.Errorf("varint %d round-tripped to %d (%v)", v, got, err)
		}
	}
	if _, err := readVarInt(bufio.NewReader(bytes.NewReader([]byte{0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF}))); err == nil {
		t.Error("expected error for an over-long varint")
	}
}
