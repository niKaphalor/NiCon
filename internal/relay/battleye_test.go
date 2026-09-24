package relay

import (
	"net"
	"strconv"
	"strings"
	"testing"
	"time"
)

// fakeBattleyeServer is a minimal BE RCon server: real enough to exercise
// dialBattleye/Execute's framing, CRC32, and reassembly, without needing
// an actual Arma 3/DayZ server. respond, if set, decides what a command
// packet gets back (as a slice of response chunks — more than one chunk
// exercises the multi-packet path); a nil respond means "reply with the
// command echoed back, single packet."
type fakeBattleyeServer struct {
	t        *testing.T
	conn     *net.UDPConn
	password string
	respond  func(command string) [][]byte
	stop     chan struct{}
	acks     chan byte // sequence numbers of received server-message ACKs
}

func newFakeBattleyeServer(t *testing.T, password string) (*fakeBattleyeServer, int) {
	t.Helper()
	udp, err := net.ListenUDP("udp", &net.UDPAddr{IP: net.IPv4(127, 0, 0, 1), Port: 0})
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	s := &fakeBattleyeServer{t: t, conn: udp, password: password, stop: make(chan struct{}), acks: make(chan byte, 8)}
	// run() isn't started yet — the caller may still want to set
	// s.respond first, which run() reads with no synchronization of its
	// own (fine for a single-goroutine-reads-it-after-setup test double,
	// but not if the goroutine could already be running by then). Call
	// start() once s.respond (if any) is set.
	t.Cleanup(func() { close(s.stop); udp.Close() })
	return s, udp.LocalAddr().(*net.UDPAddr).Port
}

// start begins serving. Call it only after setting s.respond, if you're
// going to — run() reads that field with no locking of its own.
func (s *fakeBattleyeServer) start() { go s.run() }

func (s *fakeBattleyeServer) run() {
	buf := make([]byte, 8192)
	for {
		n, addr, err := s.conn.ReadFromUDP(buf)
		if err != nil {
			select {
			case <-s.stop:
				return
			default:
				continue
			}
		}
		typeByte, data, err := parseBattleyePacket(buf[:n])
		if err != nil || len(data) < 1 {
			continue
		}

		switch typeByte {
		case battleyePacketLogin:
			ok := byte(0x00)
			if string(data) == s.password {
				ok = 0x01
			}
			s.conn.WriteToUDP(battleyePacket(battleyePacketLogin, []byte{ok}), addr)

		case battleyePacketCommand:
			seq := data[0]
			command := string(data[1:])
			if command == "" {
				// keepalive: BE replies with an empty response
				s.conn.WriteToUDP(battleyePacket(battleyePacketCommand, []byte{seq}), addr)
				continue
			}
			chunks := [][]byte{[]byte(command)}
			if s.respond != nil {
				chunks = s.respond(command)
			}
			if len(chunks) == 1 {
				s.conn.WriteToUDP(battleyePacket(battleyePacketCommand, append([]byte{seq}, chunks[0]...)), addr)
				continue
			}
			for i, chunk := range chunks {
				header := []byte{seq, 0x00, byte(len(chunks)), byte(i)}
				s.conn.WriteToUDP(battleyePacket(battleyePacketCommand, append(header, chunk...)), addr)
			}

		case battleyePacketServerMessage:
			if len(data) == 1 {
				select {
				case s.acks <- data[0]:
				default:
				}
			}
		}
	}
}

// pushServerMessageAndAwaitAck sends an unsolicited server-message packet
// to addr and waits (briefly) for the client's ACK, returning whether one
// arrived. The ACK itself is picked up by run()'s own read loop (the only
// goroutine allowed to read s.conn) and handed over via s.acks, rather
// than reading s.conn here too — two goroutines racing to read the same
// UDP socket would non-deterministically steal each other's packets.
func (s *fakeBattleyeServer) pushServerMessageAndAwaitAck(addr *net.UDPAddr, seq byte, message string) bool {
	s.conn.WriteToUDP(battleyePacket(battleyePacketServerMessage, append([]byte{seq}, []byte(message)...)), addr)
	select {
	case got := <-s.acks:
		return got == seq
	case <-time.After(2 * time.Second):
		return false
	}
}

func dialTestBattleye(t *testing.T, port int, password string) *battleyeConn {
	t.Helper()
	c, err := dialBattleye("127.0.0.1", port, password)
	if err != nil {
		t.Fatalf("dialBattleye: %v", err)
	}
	t.Cleanup(func() { c.Close() })
	return c
}

func TestBattleyeLoginWrongPassword(t *testing.T) {
	srv, port := newFakeBattleyeServer(t, "correct")
	srv.start()
	if _, err := dialBattleye("127.0.0.1", port, "wrong"); err == nil {
		t.Fatal("expected an error dialing with the wrong password, got nil")
	}
}

func TestBattleyeExecuteSinglePacket(t *testing.T) {
	srv, port := newFakeBattleyeServer(t, "secret")
	srv.respond = func(command string) [][]byte {
		return [][]byte{[]byte("echo:" + command)}
	}
	srv.start()
	c := dialTestBattleye(t, port, "secret")

	out, err := c.Execute("players")
	if err != nil {
		t.Fatalf("Execute: %v", err)
	}
	if out != "echo:players" {
		t.Errorf("got %q, want %q", out, "echo:players")
	}
}

func TestBattleyeExecuteMultiPacketReassembly(t *testing.T) {
	srv, port := newFakeBattleyeServer(t, "secret")
	var want strings.Builder
	var chunks [][]byte
	for i := 0; i < 5; i++ {
		part := "chunk" + strconv.Itoa(i) + ";"
		chunks = append(chunks, []byte(part))
		want.WriteString(part)
	}
	srv.respond = func(command string) [][]byte { return chunks }
	srv.start()
	c := dialTestBattleye(t, port, "secret")

	out, err := c.Execute("players")
	if err != nil {
		t.Fatalf("Execute: %v", err)
	}
	if out != want.String() {
		t.Errorf("got %q, want %q", out, want.String())
	}
}

func TestBattleyeServerMessageIsAckedAndBroadcast(t *testing.T) {
	srv, port := newFakeBattleyeServer(t, "secret")
	srv.start()
	c := dialTestBattleye(t, port, "secret")

	// The client's UDP socket is connected (net.DialUDP), so replies (and
	// this push) go to whatever local address the OS picked for it.
	localAddr := c.conn.LocalAddr().(*net.UDPAddr)
	serverSeesClientAt := &net.UDPAddr{IP: net.IPv4(127, 0, 0, 1), Port: localAddr.Port}

	acked := make(chan bool, 1)
	go func() { acked <- srv.pushServerMessageAndAwaitAck(serverSeesClientAt, 7, "Player joined") }()

	select {
	case msg := <-c.Broadcast:
		if msg != "Player joined" {
			t.Errorf("broadcast message = %q, want %q", msg, "Player joined")
		}
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for the server message on Broadcast")
	}

	if !<-acked {
		t.Error("server never received the client's ACK for the server message")
	}
}

func TestBattleyeLoginTimeoutOnUnresponsivePort(t *testing.T) {
	// Bind a UDP socket just to claim a definitely-free port, then close it
	// immediately — nothing will ever answer there, so login should time
	// out (battleyeLoginTimeout) rather than hang forever.
	probe, err := net.ListenUDP("udp", &net.UDPAddr{IP: net.IPv4(127, 0, 0, 1), Port: 0})
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	port := probe.LocalAddr().(*net.UDPAddr).Port
	probe.Close()

	start := time.Now()
	_, err = dialBattleye("127.0.0.1", port, "secret")
	if err == nil {
		t.Fatal("expected a login timeout error, got nil")
	}
	if elapsed := time.Since(start); elapsed > battleyeLoginTimeout+2*time.Second {
		t.Errorf("login took %v, expected to give up around battleyeLoginTimeout (%v)", elapsed, battleyeLoginTimeout)
	}
}
