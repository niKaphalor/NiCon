package relay

import (
	"crypto/tls"
	"crypto/x509"
	"net"
	"net/http"
	"strconv"
	"time"

	"github.com/gorilla/websocket"
)

// dialOptions tells a dialer how to reach a target whose address connectGame
// has already vetted and pinned (see netguard.go): the connection goes to a
// literal IP, but the name the user entered still matters for two things.
//
//   - the HTTP Host header (virtual-hosted setups, reverse proxies) — before
//     pinning existed the Host header carried this name too;
//   - TLS: the certificate must be valid for that name (or IP), and
//     verification is never disabled — a server whose certificate does not
//     verify simply cannot be used over TLS.
//
// TLS is opt-in per server (servers.use_tls) and only exists for the
// protocols that are HTTP/WebSocket based (WebRCON, BattleBit, Palworld
// REST). Source RCON, Telnet and BattlEye have no TLS variant.
type dialOptions struct {
	ServerName string // hostname (or IP literal) as entered; may be empty in tests
	TLS        bool
}

// testRootCAs lets tests trust an httptest certificate; nil (production)
// means the system roots.
var testRootCAs *x509.CertPool

func firstDialOptions(opts []dialOptions) dialOptions {
	if len(opts) > 0 {
		return opts[0]
	}
	return dialOptions{}
}

func (o dialOptions) tlsConfig() *tls.Config {
	return &tls.Config{ServerName: o.ServerName, MinVersion: tls.VersionTLS12, RootCAs: testRootCAs}
}

// hostHeader is the Host header value for port, or "" to leave it to the client.
func (o dialOptions) hostHeader(port int) string {
	if o.ServerName == "" {
		return ""
	}
	return net.JoinHostPort(o.ServerName, strconv.Itoa(port))
}

// wsScheme picks ws or wss.
func (o dialOptions) wsScheme() string {
	if o.TLS {
		return "wss"
	}
	return "ws"
}

// wsDialer returns a WebSocket dialer that connects directly (never through
// HTTP_PROXY/HTTPS_PROXY: a proxy would receive the request and resolve the
// pinned IP's name itself, bypassing the target check) and, if o.TLS,
// verifies the server certificate.
func (o dialOptions) wsDialer() *websocket.Dialer {
	d := *websocket.DefaultDialer // keeps its handshake timeout
	d.Proxy = nil
	if o.TLS {
		d.TLSClientConfig = o.tlsConfig()
	}
	return &d
}

// httpClient is the Palworld REST client: direct connections only, no
// redirects (a redirect would let the game server steer the relay to a
// target that was never checked), TLS verified when requested.
func (o dialOptions) httpClient() *http.Client {
	transport := &http.Transport{
		Proxy:               nil,
		DialContext:         (&net.Dialer{Timeout: 5 * time.Second}).DialContext,
		TLSHandshakeTimeout: 5 * time.Second,
		IdleConnTimeout:     30 * time.Second,
	}
	if o.TLS {
		transport.TLSClientConfig = o.tlsConfig()
	}
	return &http.Client{
		Timeout:   10 * time.Second,
		Transport: transport,
		CheckRedirect: func(*http.Request, []*http.Request) error {
			return http.ErrUseLastResponse
		},
	}
}
