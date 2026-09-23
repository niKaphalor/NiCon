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

func openTestAuth(t *testing.T) *Auth {
	t.Helper()
	dsn := testDSN(t)
	key := make([]byte, store.EncryptionKeySize)
	st, err := store.Open(dsn, key)
	if err != nil {
		t.Fatalf("open test store: %v", err)
	}
	t.Cleanup(func() { st.Close() })
	return New(st)
}

var usernameCounter int64

func uniqueUsername(t *testing.T) string {
	t.Helper()
	n := atomic.AddInt64(&usernameCounter, 1)
	return "auth_t_" + time.Now().Format("150405") + "_" + strconv.FormatInt(n, 10)
}

func TestRegisterAndLogin(t *testing.T) {
	a := openTestAuth(t)
	ctx := context.Background()
	username := uniqueUsername(t)

	token, recoveryCode, userID, err := a.Register(ctx, username, "correct-password-1")
	if err != nil {
		t.Fatalf("Register: %v", err)
	}
	if token == "" || recoveryCode == "" || userID == 0 {
		t.Fatalf("Register returned zero values: token=%q recoveryCode=%q userID=%d", token, recoveryCode, userID)
	}

	loginToken, loginUserID, err := a.Login(ctx, username, "correct-password-1")
	if err != nil {
		t.Fatalf("Login with correct password: %v", err)
	}
	if loginUserID != userID {
		t.Errorf("Login userID = %d, want %d", loginUserID, userID)
	}
	if loginToken == token {
		t.Error("Login returned the same token as Register; each login should mint a fresh one")
	}

	if _, _, err := a.Login(ctx, username, "wrong-password"); !errors.Is(err, ErrInvalidCredentials) {
		t.Errorf("Login with wrong password: err = %v, want ErrInvalidCredentials", err)
	}
	if _, _, err := a.Login(ctx, "no-such-user-"+username, "whatever"); !errors.Is(err, ErrInvalidCredentials) {
		t.Errorf("Login with unknown username: err = %v, want ErrInvalidCredentials", err)
	}
}

func TestRegisterValidation(t *testing.T) {
	a := openTestAuth(t)
	ctx := context.Background()

	if _, _, _, err := a.Register(ctx, "ab", "longenoughpassword"); !errors.Is(err, ErrInvalidUsername) {
		t.Errorf("username too short: err = %v, want ErrInvalidUsername", err)
	}
	if _, _, _, err := a.Register(ctx, "has spaces", "longenoughpassword"); !errors.Is(err, ErrInvalidUsername) {
		t.Errorf("username with spaces: err = %v, want ErrInvalidUsername", err)
	}
	if _, _, _, err := a.Register(ctx, uniqueUsername(t), "short"); !errors.Is(err, ErrPasswordTooShort) {
		t.Errorf("password too short: err = %v, want ErrPasswordTooShort", err)
	}
}

func TestRegisterDuplicateUsername(t *testing.T) {
	a := openTestAuth(t)
	ctx := context.Background()
	username := uniqueUsername(t)

	if _, _, _, err := a.Register(ctx, username, "password-one-123"); err != nil {
		t.Fatalf("first Register: %v", err)
	}
	if _, _, _, err := a.Register(ctx, username, "password-two-456"); !errors.Is(err, ErrUsernameTaken) {
		t.Errorf("duplicate Register: err = %v, want ErrUsernameTaken", err)
	}
}

func TestResetPasswordFlow(t *testing.T) {
	a := openTestAuth(t)
	ctx := context.Background()
	username := uniqueUsername(t)

	_, oldCode, _, err := a.Register(ctx, username, "original-password-1")
	if err != nil {
		t.Fatalf("Register: %v", err)
	}

	newCode, err := a.ResetPassword(ctx, username, oldCode, "brand-new-password-2")
	if err != nil {
		t.Fatalf("ResetPassword: %v", err)
	}
	if newCode == "" || newCode == oldCode {
		t.Fatalf("ResetPassword returned newCode = %q, want a fresh non-empty code", newCode)
	}

	if _, _, err := a.Login(ctx, username, "original-password-1"); !errors.Is(err, ErrInvalidCredentials) {
		t.Errorf("Login with old password after reset: err = %v, want ErrInvalidCredentials", err)
	}
	if _, _, err := a.Login(ctx, username, "brand-new-password-2"); err != nil {
		t.Errorf("Login with new password after reset: %v", err)
	}

	// The old recovery code was single-use — it must not work a second time.
	if _, err := a.ResetPassword(ctx, username, oldCode, "another-password-3"); !errors.Is(err, ErrInvalidRecoveryCode) {
		t.Errorf("reusing the old recovery code: err = %v, want ErrInvalidRecoveryCode", err)
	}

	// The new code, however, should work.
	if _, err := a.ResetPassword(ctx, username, newCode, "yet-another-password-4"); err != nil {
		t.Errorf("ResetPassword with the newly issued code: %v", err)
	}
}

func TestResetPasswordWrongCodeOrUnknownUserGivesSameError(t *testing.T) {
	a := openTestAuth(t)
	ctx := context.Background()
	username := uniqueUsername(t)

	if _, _, _, err := a.Register(ctx, username, "some-password-123"); err != nil {
		t.Fatal(err)
	}

	_, err1 := a.ResetPassword(ctx, username, "WRONGCODE0000000000", "new-password-123")
	if !errors.Is(err1, ErrInvalidRecoveryCode) {
		t.Errorf("wrong code: err = %v, want ErrInvalidRecoveryCode", err1)
	}

	_, err2 := a.ResetPassword(ctx, "no-such-user-"+username, "WRONGCODE0000000000", "new-password-123")
	if !errors.Is(err2, ErrInvalidRecoveryCode) {
		t.Errorf("unknown username: err = %v, want ErrInvalidRecoveryCode", err2)
	}

	if err1.Error() != err2.Error() {
		t.Errorf("wrong-code and unknown-username errors differ (%q vs %q); this can leak which usernames exist", err1, err2)
	}
}

func TestResetPasswordRejectsShortNewPassword(t *testing.T) {
	a := openTestAuth(t)
	ctx := context.Background()
	username := uniqueUsername(t)

	_, code, _, err := a.Register(ctx, username, "some-password-123")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := a.ResetPassword(ctx, username, code, "short"); !errors.Is(err, ErrPasswordTooShort) {
		t.Errorf("ResetPassword with a short new password: err = %v, want ErrPasswordTooShort", err)
	}
}

func TestResetPasswordInvalidatesExistingSessions(t *testing.T) {
	a := openTestAuth(t)
	ctx := context.Background()
	username := uniqueUsername(t)

	regToken, code, userID, err := a.Register(ctx, username, "original-password-1")
	if err != nil {
		t.Fatal(err)
	}
	loginToken, _, err := a.Login(ctx, username, "original-password-1")
	if err != nil {
		t.Fatal(err)
	}

	if _, err := a.ResetPassword(ctx, username, code, "new-password-999"); err != nil {
		t.Fatalf("ResetPassword: %v", err)
	}

	if _, err := a.Authenticate(ctx, regToken); !errors.Is(err, ErrUnauthenticated) {
		t.Errorf("Authenticate(register token) after reset: err = %v, want ErrUnauthenticated", err)
	}
	if _, err := a.Authenticate(ctx, loginToken); !errors.Is(err, ErrUnauthenticated) {
		t.Errorf("Authenticate(login token) after reset: err = %v, want ErrUnauthenticated", err)
	}
	_ = userID
}

func TestGenerateAndSetRecoveryCode(t *testing.T) {
	a := openTestAuth(t)
	ctx := context.Background()
	username := uniqueUsername(t)

	_, oldCode, userID, err := a.Register(ctx, username, "some-password-123")
	if err != nil {
		t.Fatal(err)
	}

	newCode, err := a.GenerateAndSetRecoveryCode(ctx, userID)
	if err != nil {
		t.Fatalf("GenerateAndSetRecoveryCode: %v", err)
	}
	if newCode == "" || newCode == oldCode {
		t.Fatalf("GenerateAndSetRecoveryCode returned %q, want a fresh non-empty code", newCode)
	}

	// The password is untouched — logging in still works with it.
	if _, _, err := a.Login(ctx, username, "some-password-123"); err != nil {
		t.Errorf("Login after regenerating recovery code: %v", err)
	}

	if _, err := a.ResetPassword(ctx, username, oldCode, "irrelevant-password-1"); !errors.Is(err, ErrInvalidRecoveryCode) {
		t.Errorf("ResetPassword with the superseded old code: err = %v, want ErrInvalidRecoveryCode", err)
	}
	if _, err := a.ResetPassword(ctx, username, newCode, "final-password-999"); err != nil {
		t.Errorf("ResetPassword with the newly generated code: %v", err)
	}
}

func TestDeleteAccount(t *testing.T) {
	a := openTestAuth(t)
	ctx := context.Background()
	username := uniqueUsername(t)

	_, _, userID, err := a.Register(ctx, username, "some-password-123")
	if err != nil {
		t.Fatal(err)
	}

	if err := a.DeleteAccount(ctx, userID); err != nil {
		t.Fatalf("DeleteAccount: %v", err)
	}

	if _, _, err := a.Login(ctx, username, "some-password-123"); !errors.Is(err, ErrInvalidCredentials) {
		t.Errorf("Login after DeleteAccount: err = %v, want ErrInvalidCredentials", err)
	}
}

func TestAuthenticate(t *testing.T) {
	a := openTestAuth(t)
	ctx := context.Background()
	username := uniqueUsername(t)

	token, _, userID, err := a.Register(ctx, username, "some-password-123")
	if err != nil {
		t.Fatal(err)
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
