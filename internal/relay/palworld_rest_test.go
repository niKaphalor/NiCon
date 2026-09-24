package relay

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strconv"
	"strings"
	"testing"
)

// fakePalworldServer records every request it receives and replies with a
// fixed body per path, so tests can assert both what dialPalworldRest sent
// and what it did with the response.
func fakePalworldServer(t *testing.T, wantPassword string) (*httptest.Server, *[]*http.Request) {
	t.Helper()
	var requests []*http.Request

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		user, pass, ok := r.BasicAuth()
		if !ok || user != "admin" || pass != wantPassword {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}

		body, _ := io.ReadAll(r.Body)
		reqCopy := r.Clone(r.Context())
		reqCopy.Body = io.NopCloser(strings.NewReader(string(body)))
		requests = append(requests, reqCopy)

		switch r.URL.Path {
		case "/v1/api/info":
			w.Write([]byte(`{"servername":"Test Pal Server"}`))
		case "/v1/api/players":
			w.Write([]byte(`{"players":[{"name":"Foxglove","userId":"steam_76561198000112233","ping":34,"level":12}]}`))
		case "/v1/api/announce", "/v1/api/kick", "/v1/api/ban", "/v1/api/unban", "/v1/api/save", "/v1/api/shutdown", "/v1/api/stop":
			w.WriteHeader(http.StatusOK)
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	return srv, &requests
}

func dialTestPalworld(t *testing.T, srv *httptest.Server, password string) *palworldRestConn {
	t.Helper()
	u, err := url.Parse(srv.URL)
	if err != nil {
		t.Fatalf("parse test server URL: %v", err)
	}
	port, err := strconv.Atoi(u.Port())
	if err != nil {
		t.Fatalf("parse test server port: %v", err)
	}
	c, err := dialPalworldRest(u.Hostname(), port, password)
	if err != nil {
		t.Fatalf("dialPalworldRest: %v", err)
	}
	return c
}

func TestDialPalworldRestWrongPassword(t *testing.T) {
	srv, _ := fakePalworldServer(t, "correct-password")
	defer srv.Close()

	u, _ := url.Parse(srv.URL)
	port, _ := strconv.Atoi(u.Port())
	if _, err := dialPalworldRest(u.Hostname(), port, "wrong-password"); err == nil {
		t.Fatal("expected an error dialing with the wrong password, got nil")
	}
}

func TestPalworldRestPlayers(t *testing.T) {
	srv, reqs := fakePalworldServer(t, "secret")
	defer srv.Close()
	c := dialTestPalworld(t, srv, "secret")

	out, err := c.Execute("players")
	if err != nil {
		t.Fatalf("Execute(players): %v", err)
	}
	if !strings.Contains(out, "Foxglove") {
		t.Errorf("expected player data in output, got %q", out)
	}

	last := (*reqs)[len(*reqs)-1]
	if last.Method != http.MethodGet || last.URL.Path != "/v1/api/players" {
		t.Errorf("got %s %s, want GET /v1/api/players", last.Method, last.URL.Path)
	}
}

func TestPalworldRestKickBanAnnounce(t *testing.T) {
	srv, reqs := fakePalworldServer(t, "secret")
	defer srv.Close()
	c := dialTestPalworld(t, srv, "secret")

	cases := []struct {
		command    string
		wantMethod string
		wantPath   string
		wantBody   map[string]string
	}{
		{"kick steam_123 griefing", http.MethodPost, "/v1/api/kick", map[string]string{"userid": "steam_123", "message": "griefing"}},
		{"ban steam_456", http.MethodPost, "/v1/api/ban", map[string]string{"userid": "steam_456"}},
		{"announce back in 5 minutes", http.MethodPost, "/v1/api/announce", map[string]string{"message": "back in 5 minutes"}},
	}

	for _, tc := range cases {
		if _, err := c.Execute(tc.command); err != nil {
			t.Fatalf("Execute(%q): %v", tc.command, err)
		}
		last := (*reqs)[len(*reqs)-1]
		if last.Method != tc.wantMethod || last.URL.Path != tc.wantPath {
			t.Errorf("Execute(%q): got %s %s, want %s %s", tc.command, last.Method, last.URL.Path, tc.wantMethod, tc.wantPath)
		}
		var body map[string]string
		if err := json.NewDecoder(last.Body).Decode(&body); err != nil {
			t.Fatalf("Execute(%q): decode request body: %v", tc.command, err)
		}
		for k, v := range tc.wantBody {
			if body[k] != v {
				t.Errorf("Execute(%q): body[%q] = %q, want %q", tc.command, k, body[k], v)
			}
		}
	}
}

func TestPalworldRestUnknownCommand(t *testing.T) {
	srv, _ := fakePalworldServer(t, "secret")
	defer srv.Close()
	c := dialTestPalworld(t, srv, "secret")

	if _, err := c.Execute("playerlist"); err == nil {
		t.Fatal("expected an error for an RCON-style command the REST API doesn't understand, got nil")
	}
}

func TestPalworldRestMissingArgs(t *testing.T) {
	srv, _ := fakePalworldServer(t, "secret")
	defer srv.Close()
	c := dialTestPalworld(t, srv, "secret")

	for _, command := range []string{"kick", "ban", "announce"} {
		if _, err := c.Execute(command); err == nil {
			t.Errorf("Execute(%q) with no arguments: expected an error, got nil", command)
		}
	}
}
