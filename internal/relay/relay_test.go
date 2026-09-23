package relay

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"log"
	"net/http"
	"net/http/httptest"
	"os"
	"strconv"
	"sync/atomic"
	"testing"
	"time"

	"github.com/niKaphalor/NiCon/internal/auth"
	"github.com/niKaphalor/NiCon/internal/store"
)

// These are integration tests: they exercise the real HTTP handlers wired
// to a real (test) MariaDB, via net/http/httptest — no live network
// listener needed since ServeMux path-pattern matching works the same way
// against a plain ResponseRecorder. WebSocket (/ws/rcon) isn't covered
// here; it's been exercised manually and with throwaway Go clients
// throughout development instead (see the project history), and testing
// it properly would need a real listener and a mock game server on the
// other end — a bigger lift than the rest of this suite.
const testOrigin = "https://nicon.test"

func testDSN(t *testing.T) string {
	t.Helper()
	dsn := os.Getenv("NICON_TEST_DB_DSN")
	if dsn == "" {
		t.Skip("NICON_TEST_DB_DSN not set; skipping relay integration test")
	}
	return dsn
}

// newTestRelay returns a fresh Relay (and its store, for setup that has no
// HTTP path, like granting admin) backed by the test database. Each test
// gets its own instance so rate limiters and in-memory state never leak
// between tests.
func newTestRelay(t *testing.T) (http.Handler, *store.Store) {
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
	return rel.Routes(), st
}

var usernameCounter int64

func uniqueUsername(t *testing.T) string {
	t.Helper()
	n := atomic.AddInt64(&usernameCounter, 1)
	return "relay_t_" + time.Now().Format("150405") + "_" + strconv.FormatInt(n, 10)
}

func doJSON(t *testing.T, handler http.Handler, method, path string, body any, token string) *httptest.ResponseRecorder {
	t.Helper()
	var reader io.Reader
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			t.Fatal(err)
		}
		reader = bytes.NewReader(b)
	}
	req := httptest.NewRequest(method, path, reader)
	req.Header.Set("Origin", testOrigin)
	req.Header.Set("Content-Type", "application/json")
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	return rec
}

func decodeJSON(t *testing.T, rec *httptest.ResponseRecorder, v any) {
	t.Helper()
	if err := json.Unmarshal(rec.Body.Bytes(), v); err != nil {
		t.Fatalf("decode response body %q: %v", rec.Body.String(), err)
	}
}

// registerUser is a test helper that registers a fresh account and returns
// its session token, recovery code, and username.
func registerUser(t *testing.T, handler http.Handler) (token, recoveryCode, username string) {
	t.Helper()
	username = uniqueUsername(t)
	rec := doJSON(t, handler, "POST", "/api/register", map[string]any{
		"username":         username,
		"password":         "test-password-123",
		"consent_accepted": true,
	}, "")
	if rec.Code != http.StatusOK {
		t.Fatalf("register %q: HTTP %d: %s", username, rec.Code, rec.Body.String())
	}
	var resp registerResponse
	decodeJSON(t, rec, &resp)
	return resp.Token, resp.RecoveryCode, username
}

func TestHealthz(t *testing.T) {
	handler, _ := newTestRelay(t)
	rec := doJSON(t, handler, "GET", "/healthz", nil, "")
	if rec.Code != http.StatusOK {
		t.Fatalf("HTTP %d", rec.Code)
	}
	if rec.Body.String() != "ok" {
		t.Errorf("body = %q, want %q", rec.Body.String(), "ok")
	}
}

func TestCORSPreflight(t *testing.T) {
	handler, _ := newTestRelay(t)

	req := httptest.NewRequest("OPTIONS", "/api/register", nil)
	req.Header.Set("Origin", testOrigin)
	req.Header.Set("Access-Control-Request-Method", "POST")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusNoContent {
		t.Errorf("allowed-origin preflight: HTTP %d, want 204", rec.Code)
	}
	if got := rec.Header().Get("Access-Control-Allow-Origin"); got != testOrigin {
		t.Errorf("allowed-origin preflight: Access-Control-Allow-Origin = %q, want %q", got, testOrigin)
	}

	req2 := httptest.NewRequest("OPTIONS", "/api/register", nil)
	req2.Header.Set("Origin", "https://not-allowed.test")
	rec2 := httptest.NewRecorder()
	handler.ServeHTTP(rec2, req2)
	if got := rec2.Header().Get("Access-Control-Allow-Origin"); got != "" {
		t.Errorf("disallowed-origin preflight got an Allow-Origin header (%q); it should get none", got)
	}
}

func TestRegisterHandler(t *testing.T) {
	handler, _ := newTestRelay(t)

	// Missing fields.
	rec := doJSON(t, handler, "POST", "/api/register", map[string]any{"username": "", "password": ""}, "")
	if rec.Code != http.StatusBadRequest {
		t.Errorf("empty fields: HTTP %d, want 400", rec.Code)
	}

	// Consent not accepted.
	username := uniqueUsername(t)
	rec = doJSON(t, handler, "POST", "/api/register", map[string]any{
		"username": username, "password": "test-password-123", "consent_accepted": false,
	}, "")
	if rec.Code != http.StatusBadRequest {
		t.Errorf("consent not accepted: HTTP %d, want 400", rec.Code)
	}

	// Success.
	rec = doJSON(t, handler, "POST", "/api/register", map[string]any{
		"username": username, "password": "test-password-123", "consent_accepted": true,
	}, "")
	if rec.Code != http.StatusOK {
		t.Fatalf("valid register: HTTP %d: %s", rec.Code, rec.Body.String())
	}
	var resp registerResponse
	decodeJSON(t, rec, &resp)
	if resp.Token == "" || resp.RecoveryCode == "" {
		t.Errorf("register response missing token/recovery_code: %+v", resp)
	}
	if resp.IsAdmin {
		t.Error("a fresh self-registered account has is_admin = true")
	}

	// Duplicate username — fresh relay so the rate limit from the calls
	// above (which count even validation failures) doesn't shadow this.
	handler2, _ := newTestRelay(t)
	dupUsername := uniqueUsername(t)
	doJSON(t, handler2, "POST", "/api/register", map[string]any{
		"username": dupUsername, "password": "test-password-123", "consent_accepted": true,
	}, "")
	rec = doJSON(t, handler2, "POST", "/api/register", map[string]any{
		"username": dupUsername, "password": "another-password-456", "consent_accepted": true,
	}, "")
	if rec.Code != http.StatusConflict {
		t.Errorf("duplicate username: HTTP %d, want 409", rec.Code)
	}
}

func TestRegisterRateLimit(t *testing.T) {
	handler, _ := newTestRelay(t)

	var lastCode int
	for i := 0; i < registerRateBurst+1; i++ {
		rec := doJSON(t, handler, "POST", "/api/register", map[string]any{
			"username": uniqueUsername(t), "password": "test-password-123", "consent_accepted": true,
		}, "")
		lastCode = rec.Code
		if i < registerRateBurst && rec.Code != http.StatusOK {
			t.Fatalf("attempt %d (within burst): HTTP %d, want 200: %s", i, rec.Code, rec.Body.String())
		}
	}
	if lastCode != http.StatusTooManyRequests {
		t.Errorf("attempt beyond burst: HTTP %d, want 429", lastCode)
	}

	// One more, to confirm the limit stays enforced (not a one-shot fluke).
	rec := doJSON(t, handler, "POST", "/api/register", map[string]any{
		"username": uniqueUsername(t), "password": "test-password-123", "consent_accepted": true,
	}, "")
	if rec.Code != http.StatusTooManyRequests {
		t.Errorf("second attempt beyond burst: HTTP %d, want 429", rec.Code)
	}
	if rec.Header().Get("Retry-After") == "" {
		t.Error("429 response missing Retry-After header")
	}
}

func TestLoginHandler(t *testing.T) {
	handler, _ := newTestRelay(t)
	_, _, username := registerUser(t, handler)

	rec := doJSON(t, handler, "POST", "/api/login", map[string]any{
		"username": username, "password": "test-password-123",
	}, "")
	if rec.Code != http.StatusOK {
		t.Fatalf("correct login: HTTP %d: %s", rec.Code, rec.Body.String())
	}
	var resp loginResponse
	decodeJSON(t, rec, &resp)
	if resp.Token == "" {
		t.Error("login response missing token")
	}

	rec = doJSON(t, handler, "POST", "/api/login", map[string]any{
		"username": username, "password": "wrong-password",
	}, "")
	if rec.Code != http.StatusUnauthorized {
		t.Errorf("wrong password: HTTP %d, want 401", rec.Code)
	}
}

func TestResetPasswordHandler(t *testing.T) {
	handler, _ := newTestRelay(t)
	_, _, username := registerUser(t, handler)

	wrongRec := doJSON(t, handler, "POST", "/api/reset-password", map[string]any{
		"username": username, "recovery_code": "WRONGCODE0000000000", "new_password": "new-password-123",
	}, "")
	unknownRec := doJSON(t, handler, "POST", "/api/reset-password", map[string]any{
		"username": "no-such-user-" + username, "recovery_code": "WRONGCODE0000000000", "new_password": "new-password-123",
	}, "")
	if wrongRec.Code != http.StatusUnauthorized || unknownRec.Code != http.StatusUnauthorized {
		t.Fatalf("wrong code / unknown user: HTTP %d / %d, want 401/401", wrongRec.Code, unknownRec.Code)
	}
	if wrongRec.Body.String() != unknownRec.Body.String() {
		t.Errorf("wrong-code and unknown-user bodies differ (%q vs %q) — can leak which usernames exist",
			wrongRec.Body.String(), unknownRec.Body.String())
	}

	// Fresh relay for the successful case — the two failed attempts above
	// already used up this account's rate-limit budget on the first relay.
	handler2, _ := newTestRelay(t)
	_, code2, username2 := registerUser(t, handler2)
	rec := doJSON(t, handler2, "POST", "/api/reset-password", map[string]any{
		"username": username2, "recovery_code": code2, "new_password": "new-password-123",
	}, "")
	if rec.Code != http.StatusOK {
		t.Fatalf("correct reset: HTTP %d: %s", rec.Code, rec.Body.String())
	}
	var resp resetPasswordResponse
	decodeJSON(t, rec, &resp)
	if resp.NewRecoveryCode == "" || resp.NewRecoveryCode == code2 {
		t.Errorf("NewRecoveryCode = %q, want a fresh non-empty code", resp.NewRecoveryCode)
	}

	loginRec := doJSON(t, handler2, "POST", "/api/login", map[string]any{
		"username": username2, "password": "new-password-123",
	}, "")
	if loginRec.Code != http.StatusOK {
		t.Errorf("login with new password: HTTP %d", loginRec.Code)
	}
}

func TestResetPasswordRateLimit(t *testing.T) {
	handler, _ := newTestRelay(t)
	_, _, username := registerUser(t, handler)

	var lastCode int
	for i := 0; i < resetPasswordRateBurst+1; i++ {
		rec := doJSON(t, handler, "POST", "/api/reset-password", map[string]any{
			"username": username, "recovery_code": "WRONGCODE0000000000", "new_password": "new-password-123",
		}, "")
		lastCode = rec.Code
	}
	if lastCode != http.StatusTooManyRequests {
		t.Errorf("attempt beyond burst: HTTP %d, want 429", lastCode)
	}
}

func TestDeleteAccountHandler(t *testing.T) {
	handler, _ := newTestRelay(t)
	token, _, _ := registerUser(t, handler)

	rec := doJSON(t, handler, "GET", "/api/servers", nil, "")
	if rec.Code != http.StatusUnauthorized {
		t.Errorf("no token: HTTP %d, want 401", rec.Code)
	}

	rec = doJSON(t, handler, "DELETE", "/api/account", nil, token)
	if rec.Code != http.StatusNoContent {
		t.Fatalf("delete account: HTTP %d: %s", rec.Code, rec.Body.String())
	}

	rec = doJSON(t, handler, "GET", "/api/servers", nil, token)
	if rec.Code != http.StatusUnauthorized {
		t.Errorf("token reused after account deletion: HTTP %d, want 401", rec.Code)
	}
}

func TestServerCrossUserIsolationHTTP(t *testing.T) {
	handler, _ := newTestRelay(t)
	token1, _, _ := registerUser(t, handler)
	token2, _, _ := registerUser(t, handler)

	rec := doJSON(t, handler, "POST", "/api/servers", map[string]any{
		"name": "my-server", "host": "1.2.3.4", "port": 27015, "password": "rcon-pw", "protocol": "source",
	}, token1)
	if rec.Code != http.StatusOK {
		t.Fatalf("create server: HTTP %d: %s", rec.Code, rec.Body.String())
	}
	var srv serverResponse
	decodeJSON(t, rec, &srv)

	rec = doJSON(t, handler, "DELETE", "/api/servers/"+strconv.FormatInt(srv.ID, 10), nil, token2)
	if rec.Code != http.StatusNotFound {
		t.Errorf("user2 deletes user1's server: HTTP %d, want 404", rec.Code)
	}

	rec = doJSON(t, handler, "GET", "/api/servers", nil, token1)
	if rec.Code != http.StatusOK {
		t.Fatalf("list servers: HTTP %d", rec.Code)
	}
	var servers []serverResponse
	decodeJSON(t, rec, &servers)
	if len(servers) != 1 || servers[0].ID != srv.ID {
		t.Errorf("user1's server missing after user2's failed delete attempt: %+v", servers)
	}

	rec = doJSON(t, handler, "DELETE", "/api/servers/"+strconv.FormatInt(srv.ID, 10), nil, token1)
	if rec.Code != http.StatusNoContent {
		t.Errorf("owner deletes their own server: HTTP %d, want 204", rec.Code)
	}
}

func TestAdminEndpoints(t *testing.T) {
	handler, st := newTestRelay(t)
	adminToken, _, adminUsername := registerUser(t, handler)
	plainToken, _, plainUsername := registerUser(t, handler)

	ctx := context.Background()
	adminUser, err := st.GetUserByUsername(ctx, adminUsername)
	if err != nil {
		t.Fatal(err)
	}
	if err := st.SetAdmin(ctx, adminUser.ID, true); err != nil {
		t.Fatalf("SetAdmin: %v", err)
	}

	// Non-admin denied.
	rec := doJSON(t, handler, "GET", "/api/admin/users", nil, plainToken)
	if rec.Code != http.StatusForbidden {
		t.Errorf("non-admin list: HTTP %d, want 403", rec.Code)
	}
	// No token at all.
	rec = doJSON(t, handler, "GET", "/api/admin/users", nil, "")
	if rec.Code != http.StatusUnauthorized {
		t.Errorf("no token list: HTTP %d, want 401", rec.Code)
	}

	// Admin can list, and it includes both accounts.
	rec = doJSON(t, handler, "GET", "/api/admin/users", nil, adminToken)
	if rec.Code != http.StatusOK {
		t.Fatalf("admin list: HTTP %d: %s", rec.Code, rec.Body.String())
	}
	var users []adminUserResponse
	decodeJSON(t, rec, &users)
	var plainUser *adminUserResponse
	for i := range users {
		if users[i].Username == plainUsername {
			plainUser = &users[i]
		}
	}
	if plainUser == nil {
		t.Fatalf("admin list did not include %q: %+v", plainUsername, users)
	}

	// Admin regenerates the other user's recovery code.
	rec = doJSON(t, handler, "POST", "/api/admin/users/"+strconv.FormatInt(plainUser.ID, 10)+"/recovery-code", nil, adminToken)
	if rec.Code != http.StatusOK {
		t.Fatalf("admin regenerate code: HTTP %d: %s", rec.Code, rec.Body.String())
	}
	var codeResp adminRecoveryCodeResponse
	decodeJSON(t, rec, &codeResp)
	if codeResp.RecoveryCode == "" {
		t.Error("admin regenerate code returned an empty code")
	}

	// Non-admin can't do that either.
	rec = doJSON(t, handler, "POST", "/api/admin/users/"+strconv.FormatInt(plainUser.ID, 10)+"/recovery-code", nil, plainToken)
	if rec.Code != http.StatusForbidden {
		t.Errorf("non-admin regenerate code: HTTP %d, want 403", rec.Code)
	}

	// Admin deletes the other account; its session stops working.
	rec = doJSON(t, handler, "DELETE", "/api/admin/users/"+strconv.FormatInt(plainUser.ID, 10), nil, adminToken)
	if rec.Code != http.StatusNoContent {
		t.Fatalf("admin delete user: HTTP %d: %s", rec.Code, rec.Body.String())
	}
	rec = doJSON(t, handler, "GET", "/api/servers", nil, plainToken)
	if rec.Code != http.StatusUnauthorized {
		t.Errorf("deleted user's token still works: HTTP %d, want 401", rec.Code)
	}

	// Deleting an unknown id 404s.
	rec = doJSON(t, handler, "DELETE", "/api/admin/users/99999999", nil, adminToken)
	if rec.Code != http.StatusNotFound {
		t.Errorf("delete unknown user id: HTTP %d, want 404", rec.Code)
	}
}
