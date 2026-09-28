package relay

import (
	"encoding/json"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strconv"
	"testing"

	"github.com/gorilla/websocket"
)

func TestBattlebitPlayerList(t *testing.T) {
	upgrader := websocket.Upgrader{}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("x-password") != "secret" {
			http.Error(w, "unauthorized", 401)
			return
		}
		ws, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		defer ws.Close()
		var request map[string]any
		if err := ws.ReadJSON(&request); err != nil {
			return
		}
		_ = ws.WriteJSON(map[string]any{
			"command": "playerList", "identifier": request["identifier"],
			"players": []map[string]any{{"name": "Alice", "steamID": "7656119", "ping": 12}},
		})
	}))
	defer server.Close()
	u, _ := url.Parse(server.URL)
	host, portText, _ := net.SplitHostPort(u.Host)
	port, _ := strconv.Atoi(portText)
	conn, err := dialBattlebit(host, port, "secret")
	if err != nil {
		t.Fatalf("dialBattlebit: %v", err)
	}
	defer conn.Close()
	reply, err := conn.Execute("playerlist")
	if err != nil {
		t.Fatalf("Execute: %v", err)
	}
	var response map[string]any
	if err := json.Unmarshal([]byte(reply), &response); err != nil {
		t.Fatal(err)
	}
	if len(response["players"].([]any)) != 1 {
		t.Fatalf("reply = %s", reply)
	}
}
