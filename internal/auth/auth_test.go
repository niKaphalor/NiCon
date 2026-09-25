package auth

import (
	"context"
	"errors"
	"os"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"golang.org/x/crypto/bcrypt"

	"github.com/niKaphalor/NiCon/internal/store"
)

// --- pure logic tests: no database needed, always run ---

func TestGenerateRecoveryCodeFormat(t *testing.T) {
	code, err := GenerateRecoveryCode()
	if err != nil {
		t.Fatalf("GenerateRecoveryCode: %v", err)
	}

	// RecoveryCodeLength characters, grouped in 5s with a hyphen between
	// groups: 20 chars + 3 separators = 23.
	wantLen := RecoveryCodeLength + (RecoveryCodeLength/5 - 1)
	if len(code) != wantLen {
		t.Errorf("len(code) = %d, want %d (code was %q)", len(code), wantLen, code)
	}

	for _, forbidden := range []rune{'0', 'O', '1', 'I', 'L'} {
		if strings.ContainsRune(code, forbidden) {
			t.Errorf("code %q contains excluded character %q", code, forbidden)
		}
	}

	parts := strings.Split(code, "-")
	if len(parts) != RecoveryCodeLength/5 {
		t.Errorf("code %q has %d groups, want %d", code, len(parts), RecoveryCodeLength/5)
	}
	for _, p := range parts {
		if len(p) != 5 {
			t.Errorf("group %q has length %d, want 5", p, len(p))
		}
	}
}

func TestGenerateRecoveryCodeIsRandom(t *testing.T) {
	seen := make(map[string]bool)
	for i := 0; i < 20; i++ {
		code, err := GenerateRecoveryCode()
		if err != nil {
			t.Fatal(err)
		}
		if seen[code] {
			t.Fatalf("GenerateRecoveryCode produced a repeat: %q", code)
		}
		seen[code] = true
	}
}

func TestNormalizeRecoveryCode(t *testing.T) {
	cases := []struct {
		input string
		want  string
	}{
		{"ABCDE-FGH2J-KMNPQ-RST3V", "ABCDEFGH2JKMNPQRST3V"},
		{"abcde-fgh2j-kmnpq-rst3v", "ABCDEFGH2JKMNPQRST3V"},
		{"AbCdE fgh2j", "ABCDEFGH2J"},
		{"", ""},
	}
	for _, c := range cases {
		if got := NormalizeRecoveryCode(c.input); got != c.want {
			t.Errorf("NormalizeRecoveryCode(%q) = %q, want %q", c.input, got, c.want)
		}
	}
}

func TestNormalizeRecoveryCodeIsIdempotent(t *testing.T) {
	code, err := GenerateRecoveryCode()
	if err != nil {
		t.Fatal(err)
	}
	once := NormalizeRecoveryCode(code)
	twice := NormalizeRecoveryCode(once)
	if once != twice {
		t.Errorf("normalizing twice changed the result: %q vs %q", once, twice)
	}
}

func TestHashPasswordRoundTrip(t *testing.T) {
	hash, err := HashPassword("correct horse battery staple")
	if err != nil {
		t.Fatalf("HashPassword: %v", err)
	}
	if err := bcrypt.CompareHashAndPassword([]byte(hash), []byte("correct horse battery staple")); err != nil {
		t.Errorf("correct password did not match its own hash: %v", err)
	}
	if err := bcrypt.CompareHashAndPassword([]byte(hash), []byte("wrong password")); err == nil {
		t.Error("wrong password matched the hash; it should not")
	}
}

// --- store-backed tests: require NICON_TEST_DB_DSN ---

func testDSN(t *testing.T) string {
	t.Helper()
	dsn := os.Getenv("NICON_TEST_DB_DSN")
	if dsn == "" {
		t.Skip("NICON_TEST_DB_DSN not set; skipping auth integration test")
	}
	return dsn
}

// openTestAuth also returns the underlying store directly — account
// creation and session issuance both moved to the PHP Cloud API (see this
// file's package comment), so tests below that need a user/session to
// exercise what's left here (recovery-code regeneration, token
// authentication) go straight through the store, the same as
// internal/store's own tests do, rather than through Auth.
func openTestAuth(t *testing.T) (*Auth, *store.Store) {
	t.Helper()
	dsn := testDSN(t)
	key := make([]byte, store.EncryptionKeySize)
	st, err := store.Open(dsn, key)
	if err != nil {
		t.Fatalf("open test store: %v", err)
	}
	t.Cleanup(func() { st.Close() })
	return New(st), st
}

var usernameCounter int64

func uniqueUsername(t *testing.T) string {
	t.Helper()
	n := atomic.AddInt64(&usernameCounter, 1)
	return "auth_t_" + time.Now().Format("150405") + "_" + strconv.FormatInt(n, 10)
}

func mustCreateUser(t *testing.T, st *store.Store, username string) int64 {
	t.Helper()
	id, err := st.CreateUser(context.Background(), username, "unused-password-hash", "unused-recovery-hash")
	if err != nil {
		t.Fatalf("CreateUser(%q): %v", username, err)
	}
	return id
}

func TestGenerateAndSetRecoveryCode(t *testing.T) {
	a, st := openTestAuth(t)
	ctx := context.Background()
	userID := mustCreateUser(t, st, uniqueUsername(t))

	code, err := a.GenerateAndSetRecoveryCode(ctx, userID)
	if err != nil {
		t.Fatalf("GenerateAndSetRecoveryCode: %v", err)
	}
	if code == "" {
		t.Fatal("GenerateAndSetRecoveryCode returned an empty code")
	}

	code2, err := a.GenerateAndSetRecoveryCode(ctx, userID)
	if err != nil {
		t.Fatalf("GenerateAndSetRecoveryCode (second call): %v", err)
	}
	if code2 == code {
		t.Errorf("regenerating gave the same code twice: %q", code)
	}
}

func TestAuthenticate(t *testing.T) {
	a, st := openTestAuth(t)
	ctx := context.Background()
	userID := mustCreateUser(t, st, uniqueUsername(t))

	token := uniqueUsername(t) + "-token" // any unique string; a real one is a random hex string, but Authenticate doesn't care about its shape
	if err := st.CreateSession(ctx, token, userID, 3600); err != nil {
		t.Fatalf("CreateSession: %v", err)
	}

	gotUserID, err := a.Authenticate(ctx, token)
	if err != nil {
		t.Fatalf("Authenticate: %v", err)
	}
	if gotUserID != userID {
		t.Errorf("Authenticate userID = %d, want %d", gotUserID, userID)
	}

	if _, err := a.Authenticate(ctx, ""); !errors.Is(err, ErrUnauthenticated) {
		t.Errorf("Authenticate(\"\"): err = %v, want ErrUnauthenticated", err)
	}
	if _, err := a.Authenticate(ctx, "not-a-real-token"); !errors.Is(err, ErrUnauthenticated) {
		t.Errorf("Authenticate(bogus token): err = %v, want ErrUnauthenticated", err)
	}
}
