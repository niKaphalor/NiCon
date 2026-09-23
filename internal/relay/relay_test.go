package relay

import (
	"io"
	"log"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"

	"github.com/niKaphalor/NiCon/internal/auth"
	"github.com/niKaphalor/NiCon/internal/store"
)

// The relay's only remaining HTTP surface is /healthz — everything
// account/server-related moved to webspace/ (see relay.go's package
// comment), which has no Go test coverage of its own; it's plain PHP with
// no framework, meant to be exercised by running it locally with `php -S`
// against a test database (see the README's Testing section for the
// manual steps). /ws/rcon isn't covered here either — it's been exercised
// manually and with throwaway Go clients throughout development instead,
// and testing it properly would need a real listener and a mock game
// server on the other end.
const testOrigin = "https://nicon.test"

func testDSN(t *testing.T) string {
	t.Helper()
	dsn := os.Getenv("NICON_TEST_DB_DSN")
	if dsn == "" {
		t.Skip("NICON_TEST_DB_DSN not set; skipping relay integration test")
	}
	return dsn
}

func newTestRelay(t *testing.T) http.Handler {
	t.Helper()
	dsn := testDSN(t)
	key := make([]byte, store.EncryptionKeySize)
	st, err := store.Open(dsn, key)
	if err != nil {
		t.Fatalf("open test store: %v", err)
	}
	t.Cleanup(func() { st.Close() })

	logger := log.New(io.Discard, "", 0)
	rel := New(logger, []string{testOrigin}, st, auth.New(st))
	return rel.Routes()
}

func TestHealthz(t *testing.T) {
	handler := newTestRelay(t)

	req := httptest.NewRequest("GET", "/healthz", nil)
	req.Header.Set("Origin", testOrigin)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("HTTP %d", rec.Code)
	}
	if rec.Body.String() != "ok" {
		t.Errorf("body = %q, want %q", rec.Body.String(), "ok")
	}
	if got := rec.Header().Get("Access-Control-Allow-Origin"); got != testOrigin {
		t.Errorf("Access-Control-Allow-Origin = %q, want %q", got, testOrigin)
	}
}

func TestCORSPreflight(t *testing.T) {
	handler := newTestRelay(t)

	req := httptest.NewRequest("OPTIONS", "/healthz", nil)
	req.Header.Set("Origin", testOrigin)
	req.Header.Set("Access-Control-Request-Method", "GET")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusNoContent {
		t.Errorf("allowed-origin preflight: HTTP %d, want 204", rec.Code)
	}
	if got := rec.Header().Get("Access-Control-Allow-Origin"); got != testOrigin {
		t.Errorf("allowed-origin preflight: Access-Control-Allow-Origin = %q, want %q", got, testOrigin)
	}

	req2 := httptest.NewRequest("OPTIONS", "/healthz", nil)
	req2.Header.Set("Origin", "https://not-allowed.test")
	rec2 := httptest.NewRecorder()
	handler.ServeHTTP(rec2, req2)
	if got := rec2.Header().Get("Access-Control-Allow-Origin"); got != "" {
		t.Errorf("disallowed-origin preflight got an Allow-Origin header (%q); it should get none", got)
	}
}
