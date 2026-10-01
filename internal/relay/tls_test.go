package relay

import (
	"crypto/x509"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"testing"

	"github.com/gorilla/websocket"
)

// trustServer makes dialers trust an httptest TLS server's certificate for
// the duration of the test.
func trustServer(t *testing.T, srv *httptest.Server) {
	t.Helper()
	pool := x509.NewCertPool()
	pool.AddCert(srv.Certificate())
	testRootCAs = pool
	t.Cleanup(func() { testRootCAs = nil })
}

func serverHostPort(t *testing.T, srv *httptest.Server) (string, int) {
	t.Helper()
	u, err := url.Parse(srv.URL)
	if err != nil {
		t.Fatal(err)
	}
	port, err := strconv.Atoi(u.Port())
	if err != nil {
		t.Fatal(err)
	}
	return u.Hostname(), port
}

func palworldOK() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if _, pass, ok := r.BasicAuth(); !ok || pass != "pw" {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		w.Write([]byte(`{"servername":"tls"}`))
	})
}

func TestPalworldOverTLSVerifiesTheCertificate(t *testing.T) {
	srv := httptest.NewTLSServer(palworldOK())
	defer srv.Close()
	host, port := serverHostPort(t, srv)

	// Certificate trusted, name matches (the httptest certificate covers 127.0.0.1).
	trustServer(t, srv)
	c, err := dialPalworldRest(host, port, "pw", dialOptions{ServerName: host, TLS: true})
	if err != nil {
		t.Fatalf("TLS dial with a trusted certificate: %v", err)
	}
	c.Close()

	// The name we verify is the one the user entered, not the pinned IP.
	if _, err := dialPalworldRest(host, port, "pw", dialOptions{ServerName: "someone-else.example", TLS: true}); err == nil {
		t.Fatal("a certificate that is not valid for the entered name must be rejected")
	}

	// An untrusted certificate is never accepted (no InsecureSkipVerify anywhere).
	testRootCAs = nil
	if _, err := dialPalworldRest(host, port, "pw", dialOptions{ServerName: host, TLS: true}); err == nil {
		t.Fatal("an untrusted certificate must be rejected")
	}

	// Plain HTTP against a TLS-only server fails rather than downgrading silently.
	if _, err := dialPalworldRest(host, port, "pw", dialOptions{ServerName: host}); err == nil {
		t.Fatal("plain HTTP to a TLS server should fail")
	}
}

func TestPalworldSendsTheEnteredNameAsHostHeader(t *testing.T) {
	var mu sync.Mutex
	var seen string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		seen = r.Host
		mu.Unlock()
		w.Write([]byte(`{}`))
	}))
	defer srv.Close()
	host, port := serverHostPort(t, srv)
	c, err := dialPalworldRest(host, port, "pw", dialOptions{ServerName: "game.example.com"})
	if err != nil {
		t.Fatal(err)
	}
	c.Close()
	mu.Lock()
	defer mu.Unlock()
	if want := "game.example.com:" + strconv.Itoa(port); seen != want {
		t.Fatalf("Host header = %q, want %q", seen, want)
	}
}

// A game server must not be able to redirect the relay to a target that was
// never checked (metadata endpoints, internal services).
func TestPalworldDoesNotFollowRedirects(t *testing.T) {
	var mu sync.Mutex
	hits := 0
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		hits++
		mu.Unlock()
		w.Write([]byte(`secret`))
	}))
	defer target.Close()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, target.URL+"/internal", http.StatusFound)
	}))
	defer srv.Close()
	host, port := serverHostPort(t, srv)

	_, err := dialPalworldRest(host, port, "pw")
	if err == nil || !strings.Contains(err.Error(), "redirect") {
		t.Fatalf("expected a redirect error, got %v", err)
	}
	mu.Lock()
	defer mu.Unlock()
	if hits != 0 {
		t.Fatalf("the redirect target was contacted %d time(s)", hits)
	}
}

func TestWebRconAndBattlebitOverTLS(t *testing.T) {
	upgrader := websocket.Upgrader{}
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ws, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		defer ws.Close()
		for {
			if _, _, err := ws.ReadMessage(); err != nil {
				return
			}
		}
	})
	srv := httptest.NewTLSServer(handler)
	defer srv.Close()
	host, port := serverHostPort(t, srv)

	// Untrusted: rejected, for both transports.
	if _, err := dialWebRcon(host, port, "pw", dialOptions{ServerName: host, TLS: true}); err == nil {
		t.Fatal("WebRCON over TLS with an untrusted certificate must fail")
	}
	if _, err := dialBattlebit(host, port, "pw", dialOptions{ServerName: host, TLS: true}); err == nil {
		t.Fatal("BattleBit over TLS with an untrusted certificate must fail")
	}

	trustServer(t, srv)
	w, err := dialWebRcon(host, port, "pw", dialOptions{ServerName: host, TLS: true})
	if err != nil {
		t.Fatalf("WebRCON over TLS: %v", err)
	}
	w.Close()
	b, err := dialBattlebit(host, port, "pw", dialOptions{ServerName: host, TLS: true})
	if err != nil {
		t.Fatalf("BattleBit over TLS: %v", err)
	}
	b.Close()

	// wss to a name the certificate is not valid for.
	if _, err := dialWebRcon(host, port, "pw", dialOptions{ServerName: "someone-else.example", TLS: true}); err == nil {
		t.Fatal("WebRCON over TLS must verify the entered name")
	}
}

func TestOnlyHTTPBasedProtocolsCanUseTLS(t *testing.T) {
	for protocol, want := range map[string]bool{
		"webrcon": true, "battlebit": true, "palworld_rest": true,
		"source": false, "telnet": false, "battleye": false, "": false,
	} {
		if tlsCapableProtocols[protocol] != want {
			t.Errorf("tlsCapableProtocols[%q] = %v, want %v", protocol, tlsCapableProtocols[protocol], want)
		}
	}
}
