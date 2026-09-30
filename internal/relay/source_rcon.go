package relay

import (
	"encoding/binary"
	"fmt"
	"net"

	"github.com/gorcon/rcon"
)

// dialSourceRCON connects to a Valve Source RCON server the same way
// rcon.Dial does, except the raw TCP connection is wrapped in
// sourceRCONSizeGuard first. github.com/gorcon/rcon's own packet parsing
// (both Conn.auth's readHeader and Packet.ReadFrom, used by Conn.read for
// every Execute call) allocates a response buffer sized directly from a
// 32-bit length field the server sends, with no upper bound enforced
// (only a lower one, and only in ReadFrom — auth's own readHeader doesn't
// even check that): a malicious or compromised RCON server can claim a
// size up to ~2GiB and force the relay to attempt an allocation that large
// on every single Execute call, which — in the relay's typically
// memory-constrained container — is far more likely to get the whole
// process OOM-killed than to succeed, dropping every other operator's live
// console session along with it, not just the connection to that one
// server. There's no dependency injection point to fix this from inside
// the library itself without vendoring it wholesale, but rcon.Open
// (added in v1.4.0) accepts an already-established net.Conn, which is
// exactly the seam sourceRCONSizeGuard needs.
func dialSourceRCON(address string, password string) (*rcon.Conn, error) {
	conn, err := net.DialTimeout("tcp", address, rcon.DefaultDialTimeout)
	if err != nil {
		return nil, fmt.Errorf("rcon: %w", err)
	}
	guarded := &sourceRCONSizeGuard{Conn: conn}
	c, err := rcon.Open(guarded, password)
	if err != nil {
		return nil, err
	}
	return c, nil
}

// sourceRCONSizeGuard wraps a net.Conn carrying the Source RCON protocol
// and validates every packet's little-endian, 4-byte Size field as it
// streams past, rejecting the connection outright if a server ever claims
// a size outside the protocol's own documented bounds
// (rcon.MinPacketSize..rcon.MaxPacketSize) instead of letting the
// unbounded value reach whichever library function would otherwise
// allocate a buffer from it.
//
// This doesn't need to understand the rest of the protocol (packet ID,
// type, or body content all pass through unexamined) — every Source RCON
// packet on the wire begins with a Size field whose value is exactly the
// number of bytes remaining in that packet (id + type + body + null
// padding), so a Read-call-counting state machine that flips between
// "collecting a Size field" and "passing through N more body bytes" tracks
// packet boundaries correctly regardless of how many packets a given
// response contains or how the underlying reads happen to be chunked.
type sourceRCONSizeGuard struct {
	net.Conn
	remaining int64  // bytes left before the next packet's Size field is expected
	hdr       []byte // partial bytes of the Size field collected so far
}

func (g *sourceRCONSizeGuard) Read(p []byte) (int, error) {
	if g.remaining > 0 {
		limit := int64(len(p))
		if limit > g.remaining {
			limit = g.remaining
		}
		n, err := g.Conn.Read(p[:limit])
		g.remaining -= int64(n)
		return n, err
	}

	need := 4 - len(g.hdr)
	limit := need
	if limit > len(p) {
		limit = len(p)
	}
	n, err := g.Conn.Read(p[:limit])
	if n > 0 {
		g.hdr = append(g.hdr, p[:n]...)
	}
	if len(g.hdr) == 4 {
		size := int32(binary.LittleEndian.Uint32(g.hdr))
		g.hdr = g.hdr[:0]
		if size < rcon.MinPacketSize || size > rcon.MaxPacketSize {
			return n, fmt.Errorf("rcon: server-reported packet size %d out of bounds", size)
		}
		g.remaining = int64(size)
	}
	return n, err
}
