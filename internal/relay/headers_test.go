package relay

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestSecurityHeadersAreOnEveryResponse(t *testing.T) {
	handler := securityHeaders(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "boom", http.StatusTeapot) // even error responses
	}))
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, httptest.NewRequest("GET", "/anything", nil))

	want := map[string]string{
		"X-Content-Type-Options":  "nosniff",
		"X-Frame-Options":         "DENY",
		"Referrer-Policy":         "no-referrer",
		"Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
		"Cache-Control":           "no-store",
	}
	for name, value := range want {
		if got := rec.Header().Get(name); got != value {
			t.Errorf("%s = %q, want %q", name, got, value)
		}
	}
}
