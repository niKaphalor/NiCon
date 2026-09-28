package relay

import (
	"bufio"
	"fmt"
	"net"
	"strings"
	"testing"
)

func TestTelnetLoginAndExecute(t *testing.T) {
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
		reader := bufio.NewReader(conn)
		fmt.Fprint(conn, "Please enter password:\r\n")
		password, _ := reader.ReadString('\n')
		if strings.TrimSpace(password) != "secret" {
			return
		}
		fmt.Fprint(conn, "Logon successful.\r\n")
		command, _ := reader.ReadString('\n')
		if strings.TrimSpace(command) == "lp" {
			fmt.Fprint(conn, "1. id=7, Player One, steamid=7656119\r\n")
		}
	}()
	addr := listener.Addr().(*net.TCPAddr)
	conn, err := dialTelnet("127.0.0.1", addr.Port, "secret")
	if err != nil {
		t.Fatalf("dialTelnet: %v", err)
	}
	defer conn.Close()
	reply, err := conn.Execute("lp")
	if err != nil {
		t.Fatalf("Execute: %v", err)
	}
	if !strings.Contains(reply, "Player One") {
		t.Fatalf("reply = %q", reply)
	}
}

func TestStripTelnetControl(t *testing.T) {
	got := string(stripTelnetControl([]byte{'A', 255, 251, 1, 'B'}))
	if got != "AB" {
		t.Fatalf("got %q", got)
	}
}
