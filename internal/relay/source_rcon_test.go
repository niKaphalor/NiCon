package relay

import (
	"bytes"
	"encoding/binary"
	"net"
	"testing"
	"time"

	"github.com/gorcon/rcon"
)

func TestSourceRCONSizeGuardValidRoundTrip(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	go func() {
		conn, acceptErr := listener.Accept()
		if acceptErr != nil {
			return
		}
		defer conn.Close()

		var authPkt rcon.Packet
		if _, readErr := authPkt.ReadFrom(conn); readErr != nil {
			return
		}
		if _, writeErr := rcon.NewPacket(rcon.SERVERDATA_AUTH_RESPONSE, authPkt.ID, "").WriteTo(conn); writeErr != nil {
			return
		}

		var cmdPkt rcon.Packet
		if _, readErr := cmdPkt.ReadFrom(conn); readErr != nil {
			return
		}
		_, _ = rcon.NewPacket(rcon.SERVERDATA_RESPONSE_VALUE, cmdPkt.ID, "pong").WriteTo(conn)
	}()

	addr := listener.Addr().(*net.TCPAddr)
	conn, err := dialSourceRCON(addr.String(), "secret")
	if err != nil {
		t.Fatalf("dialSourceRCON: %v", err)
	}
	defer conn.Close()

	reply, err := conn.Execute("ping")
	if err != nil {
		t.Fatalf("Execute: %v", err)
	}
	if reply != "pong" {
		t.Fatalf("reply = %q, want %q", reply, "pong")
	}
}

// TestSourceRCONSizeGuardRejectsOversizedPacket confirms the guard added in
// source_rcon.go actually closes the gorcon/rcon DoS: a server claiming a
// packet size well past rcon.MaxPacketSize must make dialSourceRCON fail
// fast with an error, not attempt to allocate a buffer that large. 10MB is
// used here (not the ~2GiB an attacker could claim) — big enough to prove
// the bounds check fires without risking a large allocation if it doesn't.
func TestSourceRCONSizeGuardRejectsOversizedPacket(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	go func() {
		conn, acceptErr := listener.Accept()
		if acceptErr != nil {
			return
		}
		defer conn.Close()

		var authPkt rcon.Packet
		if _, readErr := authPkt.ReadFrom(conn); readErr != nil {
			return
		}

		var hdr [12]byte
		binary.LittleEndian.PutUint32(hdr[0:4], 10_000_000) // far past rcon.MaxPacketSize
		binary.LittleEndian.PutUint32(hdr[4:8], uint32(authPkt.ID))
		binary.LittleEndian.PutUint32(hdr[8:12], uint32(rcon.SERVERDATA_AUTH_RESPONSE))
		_, _ = conn.Write(hdr[:])
	}()

	addr := listener.Addr().(*net.TCPAddr)
	start := time.Now()
	c, err := dialSourceRCON(addr.String(), "secret")
	if err == nil {
		c.Close()
		t.Fatal("dialSourceRCON: expected an error for an oversized server-reported packet size, got nil")
	}
	if elapsed := time.Since(start); elapsed > 2*time.Second {
		t.Fatalf("dialSourceRCON took %v to reject an oversized packet size — the guard should fail immediately, not block", elapsed)
	}
}

// TestSourceRCONSizeGuardHandlesFragmentedHeader confirms
// sourceRCONSizeGuard.Read correctly reassembles a Size field even when
// the underlying connection delivers it across more than one Read call —
// the real-world case a slow/fragmenting network path produces.
func TestSourceRCONSizeGuardHandlesFragmentedHeader(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	go func() {
		conn, acceptErr := listener.Accept()
		if acceptErr != nil {
			return
		}
		defer conn.Close()

		var authPkt rcon.Packet
		if _, readErr := authPkt.ReadFrom(conn); readErr != nil {
			return
		}

		var buf bytes.Buffer
		if _, writeErr := rcon.NewPacket(rcon.SERVERDATA_AUTH_RESPONSE, authPkt.ID, "").WriteTo(&buf); writeErr != nil {
			return
		}
		raw := buf.Bytes()
		// Split the response into two writes, straddling the Size field's
		// own 4-byte boundary, to force sourceRCONSizeGuard.Read to
		// reassemble it across two separate Read calls.
		_, _ = conn.Write(raw[:2])
		time.Sleep(20 * time.Millisecond)
		_, _ = conn.Write(raw[2:])
	}()

	addr := listener.Addr().(*net.TCPAddr)
	conn, err := dialSourceRCON(addr.String(), "secret")
	if err != nil {
		t.Fatalf("dialSourceRCON: %v", err)
	}
	defer conn.Close()
}
