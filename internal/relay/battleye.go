package relay

import (
	"encoding/binary"
	"fmt"
	"hash/crc32"
	"net"
	"sync"
	"time"
)

const (
	// battleyeKeepaliveInterval: BE removes a client from its authenticated
	// list if it sees no command packet for 45s; ping well under that.
	battleyeKeepaliveInterval = 30 * time.Second

	// battleyeExecuteTimeout bounds how long Execute waits for a fully
	// reassembled response before giving up. UDP, so there's no guarantee
	// a lost packet ever gets retransmitted by the server.
	battleyeExecuteTimeout = 10 * time.Second
	battleyeLoginTimeout   = 5 * time.Second

	battleyePacketLogin         = 0x00
	battleyePacketCommand       = 0x01
	battleyePacketServerMessage = 0x02
)

// battleyeConn speaks BattlEye's RCon protocol
// (https://www.battleye.com/downloads/BERConProtocol.txt), used by Arma 3
// and DayZ (both BattlEye-protected, unlike the Source-RCON-based games):
// a UDP socket, every packet framed as 'B' 'E' <4-byte little-endian CRC32
// of everything from here on> 0xFF <type-byte> <data...>. CRC32 is the
// standard IEEE/zlib polynomial, computed over the 0xFF marker onward.
//
// Unlike TCP-based RCON, nothing here is guaranteed delivered or ordered —
// Execute retries a command a few times before giving up, and a long
// response arrives as several packets (a 3-byte 0x00/total/index header
// in front of each chunk) that have to be reassembled by sequence number,
// out of order if need be.
//
// The server also pushes "server message" packets unsolicited (player
// connect/disconnect, chat) that the client must ACK immediately; those
// surface on Broadcast rather than being routed to any Execute call.
type battleyeConn struct {
	conn *net.UDPConn

	writeMu sync.Mutex
	seq     byte

	mu      sync.Mutex
	pending map[byte]*battleyePending
	closed  bool

	Broadcast chan string

	stopKeepalive chan struct{}
	closeOnce     sync.Once
}

type battleyePending struct {
	total  byte // 0 until the first chunk (with a multi-part header) arrives
	got    byte
	chunks [][]byte
	done   chan string
}

func dialBattleye(host string, port int, password string) (*battleyeConn, error) {
	addr, err := net.ResolveUDPAddr("udp", fmt.Sprintf("%s:%d", host, port))
	if err != nil {
		return nil, fmt.Errorf("battleye: %w", err)
	}
	udp, err := net.DialUDP("udp", nil, addr)
	if err != nil {
		return nil, fmt.Errorf("battleye: %w", err)
	}

	c := &battleyeConn{
		conn:          udp,
		pending:       make(map[byte]*battleyePending),
		Broadcast:     make(chan string, 64),
		stopKeepalive: make(chan struct{}),
	}

	if err := c.login(password); err != nil {
		udp.Close()
		return nil, err
	}

	go c.readLoop()
	go c.keepaliveLoop()
	return c, nil
}

func battleyePacket(typeByte byte, data []byte) []byte {
	inner := make([]byte, 0, 2+len(data))
	inner = append(inner, 0xFF, typeByte)
	inner = append(inner, data...)

	sum := crc32.ChecksumIEEE(inner)
	pkt := make([]byte, 0, 6+len(inner))
	pkt = append(pkt, 'B', 'E')
	var crcBytes [4]byte
	binary.LittleEndian.PutUint32(crcBytes[:], sum)
	pkt = append(pkt, crcBytes[:]...)
	pkt = append(pkt, inner...)
	return pkt
}

// login blocks until the server accepts (or rejects) the password, reading
// directly off the socket rather than through readLoop (which isn't
// running yet) — there's nothing else this connection could be doing
// before authentication succeeds.
func (c *battleyeConn) login(password string) error {
	if _, err := c.conn.Write(battleyePacket(battleyePacketLogin, []byte(password))); err != nil {
		return fmt.Errorf("battleye: login: %w", err)
	}

	buf := make([]byte, 4096)
	c.conn.SetReadDeadline(time.Now().Add(battleyeLoginTimeout))
	defer c.conn.SetReadDeadline(time.Time{})

	n, err := c.conn.Read(buf)
	if err != nil {
		return fmt.Errorf("battleye: login: no response (%w)", err)
	}
	typeByte, data, err := parseBattleyePacket(buf[:n])
	if err != nil {
		return fmt.Errorf("battleye: login: %w", err)
	}
	if typeByte != battleyePacketLogin || len(data) < 1 || data[0] != 0x01 {
		return fmt.Errorf("battleye: login: invalid password")
	}
	return nil
}

// parseBattleyePacket verifies the header and CRC32, returning the
// packet's type byte and whatever data follows it.
func parseBattleyePacket(raw []byte) (byte, []byte, error) {
	if len(raw) < 8 || raw[0] != 'B' || raw[1] != 'E' {
		return 0, nil, fmt.Errorf("malformed packet")
	}
	inner := raw[6:] // 0xFF, type, data...
	gotCRC := binary.LittleEndian.Uint32(raw[2:6])
	if crc32.ChecksumIEEE(inner) != gotCRC {
		return 0, nil, fmt.Errorf("CRC32 mismatch")
	}
	if len(inner) < 2 || inner[0] != 0xFF {
		return 0, nil, fmt.Errorf("missing 0xFF marker")
	}
	return inner[1], inner[2:], nil
}

func (c *battleyeConn) readLoop() {
	defer close(c.Broadcast)
	buf := make([]byte, 8192)
	for {
		n, err := c.conn.Read(buf)
		if err != nil {
			c.mu.Lock()
			c.closed = true
			for _, p := range c.pending {
				close(p.done)
			}
			c.pending = nil
			c.mu.Unlock()
			return
		}

		typeByte, data, err := parseBattleyePacket(buf[:n])
		if err != nil || len(data) < 1 {
			continue // corrupt/short packet — UDP, just drop it
		}
		seq := data[0]
		rest := data[1:]

		switch typeByte {
		case battleyePacketCommand:
			c.handleCommandResponse(seq, rest)
		case battleyePacketServerMessage:
			// Must ACK immediately, whether or not anyone's listening —
			// otherwise BE retries for 10s and then drops us.
			c.writeMu.Lock()
			c.conn.Write(battleyePacket(battleyePacketServerMessage, []byte{seq}))
			c.writeMu.Unlock()
			select {
			case c.Broadcast <- string(rest):
			default:
			}
		}
	}
}

func (c *battleyeConn) handleCommandResponse(seq byte, rest []byte) {
	c.mu.Lock()
	p, ok := c.pending[seq]
	c.mu.Unlock()
	if !ok {
		return // a keepalive's response, or one we already gave up on
	}

	chunk := rest
	total := byte(1)
	index := byte(0)
	if len(rest) >= 3 && rest[0] == 0x00 {
		total, index, chunk = rest[1], rest[2], rest[3:]
	}

	c.mu.Lock()
	if p.chunks == nil {
		p.total = total
		p.chunks = make([][]byte, total)
	}
	if int(index) < len(p.chunks) && p.chunks[index] == nil {
		// readLoop reuses one buffer across every Read; chunk (and rest,
		// and data) are slices into it, not copies. Without copying here,
		// every earlier chunk gets silently overwritten by the next
		// packet that arrives before Execute reads them back out.
		p.chunks[index] = append([]byte(nil), chunk...)
		p.got++
	}
	complete := p.got >= p.total
	if complete {
		delete(c.pending, seq)
	}
	c.mu.Unlock()

	if complete {
		full := make([]byte, 0, 256)
		for _, part := range p.chunks {
			full = append(full, part...)
		}
		select {
		case p.done <- string(full):
		default:
		}
		close(p.done)
	}
}

func (c *battleyeConn) keepaliveLoop() {
	ticker := time.NewTicker(battleyeKeepaliveInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ticker.C:
			c.writeMu.Lock()
			seq := c.seq
			c.seq++
			_, err := c.conn.Write(battleyePacket(battleyePacketCommand, []byte{seq}))
			c.writeMu.Unlock()
			if err != nil {
				return
			}
		case <-c.stopKeepalive:
			return
		}
	}
}

func (c *battleyeConn) Execute(command string) (string, error) {
	c.mu.Lock()
	if c.closed {
		c.mu.Unlock()
		return "", fmt.Errorf("battleye: connection closed")
	}
	c.mu.Unlock()

	c.writeMu.Lock()
	seq := c.seq
	c.seq++
	done := make(chan string, 1)
	c.mu.Lock()
	c.pending[seq] = &battleyePending{done: done}
	c.mu.Unlock()
	_, err := c.conn.Write(battleyePacket(battleyePacketCommand, append([]byte{seq}, []byte(command)...)))
	c.writeMu.Unlock()
	if err != nil {
		c.mu.Lock()
		delete(c.pending, seq)
		c.mu.Unlock()
		return "", fmt.Errorf("battleye: write: %w", err)
	}

	select {
	case resp, ok := <-done:
		if !ok {
			return "", fmt.Errorf("battleye: connection closed while waiting for response")
		}
		return resp, nil
	case <-time.After(battleyeExecuteTimeout):
		c.mu.Lock()
		delete(c.pending, seq)
		c.mu.Unlock()
		return "", fmt.Errorf("battleye: timed out waiting for response")
	}
}

func (c *battleyeConn) Close() error {
	c.closeOnce.Do(func() { close(c.stopKeepalive) })
	return c.conn.Close()
}
