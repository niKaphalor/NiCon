package relay

import (
	"context"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/gorcon/rcon"
	"github.com/gorcon/rcon/rcontest"
	"github.com/gorilla/websocket"

	"github.com/niKaphalor/NiCon/internal/auth"
	"github.com/niKaphalor/NiCon/internal/store"
)

func relayE2EStore(t *testing.T) *store.Store {
	t.Helper()
	key := make([]byte, store.EncryptionKeySize)
	st, err := store.Open(testDSN(t), key)
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	t.Cleanup(func() { st.Close() })
	return st
}

func relayE2EAccount(t *testing.T, st *store.Store) (int64, string) {
	t.Helper()
	ctx := context.Background()
	username := fmt.Sprintf("ws_e2e_%d", time.Now().UnixNano())
	userID, err := st.CreateUser(ctx, username, "test-password-hash", "test-recovery-hash")
	if err != nil {
		t.Fatalf("create user: %v", err)
	}
	t.Cleanup(func() { _ = st.DeleteUser(context.Background(), userID) })
	token := fmt.Sprintf("ws-token-%d", time.Now().UnixNano())
	if err := st.CreateSession(ctx, token, userID, 3600); err != nil {
		t.Fatalf("create session: %v", err)
	}
	return userID, token
}

func websocketRoundTrip(t *testing.T, st *store.Store, token string, serverID int64, command, wantOutput string) {
	t.Helper()
	rel := New(log.New(io.Discard, "", 0), []string{testOrigin}, st, auth.New(st))
	httpServer := httptest.NewServer(rel.Routes())
	defer httpServer.Close()

	wsURL := "ws" + strings.TrimPrefix(httpServer.URL, "http") + "/ws/rcon"
	header := http.Header{"Origin": []string{testOrigin}}
	conn, _, err := websocket.DefaultDialer.Dial(wsURL, header)
	if err != nil {
		t.Fatalf("dial relay WebSocket: %v", err)
	}
	defer conn.Close()
	_ = conn.SetReadDeadline(time.Now().Add(5 * time.Second))

	if err := conn.WriteJSON(wsMessage{Type: "auth", Token: token}); err != nil {
		t.Fatalf("write auth: %v", err)
	}
	var response wsMessage
	if err := conn.ReadJSON(&response); err != nil || response.Type != "authenticated" {
		t.Fatalf("auth response = %+v, err=%v", response, err)
	}

	if err := conn.WriteJSON(wsMessage{Type: "connect", ServerID: serverID}); err != nil {
		t.Fatalf("write connect: %v", err)
	}
	response = wsMessage{}
	if err := conn.ReadJSON(&response); err != nil || response.Type != "connected" {
		t.Fatalf("connect response = %+v, err=%v", response, err)
	}

	if err := conn.WriteJSON(wsMessage{Type: "command", Command: command}); err != nil {
		t.Fatalf("write command: %v", err)
	}
	response = wsMessage{}
	if err := conn.ReadJSON(&response); err != nil {
		t.Fatalf("read command response: %v", err)
	}
	if response.Type != "response" || response.Output != wantOutput {
		t.Fatalf("command response = %+v, want output %q", response, wantOutput)
	}
}

func hostPort(t *testing.T, rawURL string) (string, int) {
	t.Helper()
	u, err := url.Parse(rawURL)
	if err != nil {
		t.Fatalf("parse URL: %v", err)
	}
	port, err := strconv.Atoi(u.Port())
	if err != nil {
		t.Fatalf("parse port: %v", err)
	}
	return u.Hostname(), port
}

func TestWebSocketEndToEndWithMockGameServers(t *testing.T) {
	st := relayE2EStore(t)
	userID, token := relayE2EAccount(t, st)
	ctx := context.Background()

	t.Run("source-rcon", func(t *testing.T) {
		mock := rcontest.NewServer(
			rcontest.SetSettings(rcontest.Settings{Password: "secret"}),
			rcontest.SetCommandHandler(func(c *rcontest.Context) {
				_, _ = rcon.NewPacket(rcon.SERVERDATA_RESPONSE_VALUE, c.Request().ID, "source:"+c.Request().Body()).WriteTo(c.Conn())
			}),
		)
		defer mock.Close()
		host, portText, _ := net.SplitHostPort(mock.Addr())
		port, _ := strconv.Atoi(portText)
		serverID, err := st.CreateServer(ctx, store.Server{UserID: userID, Name: "Source", Host: host, Port: port, Password: "secret", Protocol: "source", Game: "Minecraft", Source: "manual"})
		if err != nil {
			t.Fatalf("create server: %v", err)
		}
		websocketRoundTrip(t, st, token, serverID, "list", "source:list")
	})

	t.Run("rust-webrcon", func(t *testing.T) {
		upgrader := websocket.Upgrader{}
		mock := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.URL.Path != "/secret" {
				http.NotFound(w, r)
				return
			}
			conn, err := upgrader.Upgrade(w, r, nil)
			if err != nil {
				return
			}
			defer conn.Close()
			for {
				var message webRconMessage
				if err := conn.ReadJSON(&message); err != nil {
					return
				}
				message.Message = "webrcon:" + message.Message
				_ = conn.WriteJSON(message)
			}
		}))
		defer mock.Close()
		host, port := hostPort(t, mock.URL)
		serverID, err := st.CreateServer(ctx, store.Server{UserID: userID, Name: "Rust", Host: host, Port: port, Password: "secret", Protocol: "webrcon", Game: "Rust", Source: "manual"})
		if err != nil {
			t.Fatalf("create server: %v", err)
		}
		websocketRoundTrip(t, st, token, serverID, "status", "webrcon:status")
	})

	t.Run("palworld-rest", func(t *testing.T) {
		mock, _ := fakePalworldServer(t, "secret")
		defer mock.Close()
		host, port := hostPort(t, mock.URL)
		serverID, err := st.CreateServer(ctx, store.Server{UserID: userID, Name: "Palworld", Host: host, Port: port, Password: "secret", Protocol: "palworld_rest", Game: "Palworld", Source: "manual"})
		if err != nil {
			t.Fatalf("create server: %v", err)
		}
		want := `{"players":[{"name":"Foxglove","userId":"steam_76561198000112233","ping":34,"level":12}]}`
		websocketRoundTrip(t, st, token, serverID, "players", want)
	})

	t.Run("battleye", func(t *testing.T) {
		mock, port := newFakeBattleyeServer(t, "secret")
		mock.respond = func(command string) [][]byte { return [][]byte{[]byte("battleye:" + command)} }
		mock.start()
		serverID, err := st.CreateServer(ctx, store.Server{UserID: userID, Name: "DayZ", Host: "127.0.0.1", Port: port, Password: "secret", Protocol: "battleye", Game: "DayZ", Source: "manual"})
		if err != nil {
			t.Fatalf("create server: %v", err)
		}
		websocketRoundTrip(t, st, token, serverID, "players", "battleye:players")
	})
}

func TestWebSocketRejectsAnotherUsersServer(t *testing.T) {
	st := relayE2EStore(t)
	ownerID, _ := relayE2EAccount(t, st)
	_, attackerToken := relayE2EAccount(t, st)
	serverID, err := st.CreateServer(context.Background(), store.Server{
		UserID: ownerID, Name: "Private", Host: "127.0.0.1", Port: 27015,
		Password: "secret", Protocol: "source", Source: "manual",
	})
	if err != nil {
		t.Fatalf("create server: %v", err)
	}

	rel := New(log.New(io.Discard, "", 0), []string{testOrigin}, st, auth.New(st))
	httpServer := httptest.NewServer(rel.Routes())
	defer httpServer.Close()
	wsURL := "ws" + strings.TrimPrefix(httpServer.URL, "http") + "/ws/rcon"
	conn, _, err := websocket.DefaultDialer.Dial(wsURL, http.Header{"Origin": []string{testOrigin}})
	if err != nil {
		t.Fatalf("dial relay: %v", err)
	}
	defer conn.Close()
	_ = conn.SetReadDeadline(time.Now().Add(5 * time.Second))
	_ = conn.WriteJSON(wsMessage{Type: "auth", Token: attackerToken})
	var response wsMessage
	if err := conn.ReadJSON(&response); err != nil || response.Type != "authenticated" {
		t.Fatalf("authenticate: response=%+v err=%v", response, err)
	}
	_ = conn.WriteJSON(wsMessage{Type: "connect", ServerID: serverID})
	response = wsMessage{}
	if err := conn.ReadJSON(&response); err != nil {
		t.Fatalf("read ownership response: %v", err)
	}
	if response.Type != "error" || response.Message != "server not found" {
		t.Fatalf("ownership response = %+v", response)
	}
}
