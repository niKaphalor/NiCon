// Package auth handles password hashing, recovery codes, and session-token
// authentication on top of internal/store.
//
// Login/registration/password-reset used to live here too, but that whole
// account-management surface moved to the PHP Cloud API (see
// webspace/handlers/) when the project split the relay from account
// management — see README.md's "Cloud API vs. relay" section. What
// remains is what the relay itself still needs directly: hashing/
// generating recovery codes for the `adduser`/`gen-recovery-code` CLI
// commands and the admin panel's regenerate action (main.go), and
// resolving a session token to a user ID for an incoming /ws/rcon
// connection (internal/relay/ws.go) — sessions are created by the PHP API
// now, not here.
package auth

import (
	"context"
	"crypto/rand"
	"errors"
	"fmt"
	"strings"
	"unicode/utf8"

	"golang.org/x/crypto/bcrypt"

	"github.com/niKaphalor/NiCon/internal/store"
)

// RecoveryCodeLength is the number of characters in a generated recovery
// code (before the display formatting adds hyphens every 5 characters).
const RecoveryCodeLength = 20

// recoveryCodeAlphabet excludes characters that are easy to misread or
// confuse with one another (0/O, 1/I/L) since a recovery code has to be
// retyped correctly from a saved copy, often by hand.
const recoveryCodeAlphabet = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"

var ErrUnauthenticated = errors.New("not authenticated")

type Auth struct {
	store *store.Store
}

func New(st *store.Store) *Auth {
	return &Auth{store: st}
}

// Password policy, identical to webspace/lib/auth.php (keep in sync).
//
// MinPasswordLength (characters) is NIST SP 800-63B-4's floor for
// single-factor passwords. MaxPasswordBytes is bcrypt's hard input limit:
// PHP silently truncates longer input while Go's bcrypt refuses it, so the
// two sides used to disagree — one byte limit, enforced wherever a password
// is set, removes that.
const (
	MinPasswordLength = 15
	MaxPasswordBytes  = 72
)

// ValidatePassword reports why password may not be set, or nil if it is fine.
func ValidatePassword(password string) error {
	runes := utf8.RuneCountInString(password)
	if runes < MinPasswordLength {
		return fmt.Errorf("password must be at least %d characters", MinPasswordLength)
	}
	if len(password) > MaxPasswordBytes {
		return fmt.Errorf("password must be at most %d bytes (about 64 characters; non-ASCII characters take more than one byte)", MaxPasswordBytes)
	}
	first, _ := utf8.DecodeRuneInString(password)
	if strings.Count(password, string(first)) == runes {
		return errors.New("password must not be a single repeated character")
	}
	return nil
}

// HashPassword is used by the `adduser` CLI command; it never runs as part
// of a network-facing request.
func HashPassword(password string) (string, error) {
	hash, err := bcrypt.GenerateFromPassword([]byte(password), bcrypt.DefaultCost)
	if err != nil {
		return "", err
	}
	return string(hash), nil
}

// GenerateAndSetRecoveryCode generates a fresh recovery code, stores its
// hash for userID, and returns the plaintext once. Used by the
// `gen-recovery-code` CLI command (bootstrapping a code for an account
// that predates this feature, or replacing a lost one) and by the admin
// panel's "regenerate recovery code" action — both cases where the
// account holder can't run the normal ResetPassword flow themselves
// because they have no recovery code to start from.
func (a *Auth) GenerateAndSetRecoveryCode(ctx context.Context, userID int64) (string, error) {
	code, err := GenerateRecoveryCode()
	if err != nil {
		return "", err
	}
	hash, err := HashPassword(NormalizeRecoveryCode(code))
	if err != nil {
		return "", err
	}
	if err := a.store.SetRecoveryCodeHash(ctx, userID, hash); err != nil {
		return "", err
	}
	return code, nil
}

// GenerateRecoveryCode returns a fresh one-time recovery code formatted in
// groups of 5 characters for readability (e.g. "ABCDE-FGH2J-..."). Callers
// normalize it (NormalizeRecoveryCode) before hashing or comparing, so the
// hyphens and case only matter for display.
func GenerateRecoveryCode() (string, error) {
	raw := make([]byte, RecoveryCodeLength)
	n := len(recoveryCodeAlphabet)
	// Rejection sampling avoids modulo bias: without it, byte values above
	// the largest multiple of n that fits in a byte would be very slightly
	// over-represented once reduced mod n.
	maxByte := 256 - (256 % n)
	buf := make([]byte, 1)
	for i := range raw {
		for {
			if _, err := rand.Read(buf); err != nil {
				return "", err
			}
			if int(buf[0]) < maxByte {
				raw[i] = recoveryCodeAlphabet[int(buf[0])%n]
				break
			}
		}
	}

	var formatted strings.Builder
	for i, c := range raw {
		if i > 0 && i%5 == 0 {
			formatted.WriteByte('-')
		}
		formatted.WriteByte(c)
	}
	return formatted.String(), nil
}

// NormalizeRecoveryCode strips formatting (hyphens, whitespace) and
// uppercases, so "abcde-fgh2j..." and "ABCDEFGH2J..." hash/compare
// identically regardless of how the user retyped it.
func NormalizeRecoveryCode(code string) string {
	var b strings.Builder
	for _, r := range strings.ToUpper(code) {
		if (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9') {
			b.WriteRune(r)
		}
	}
	return b.String()
}

// Authenticate resolves a session token to a user ID, or ErrUnauthenticated
// if the token is missing, unknown, or expired.
func (a *Auth) Authenticate(ctx context.Context, token string) (int64, error) {
	if token == "" {
		return 0, ErrUnauthenticated
	}
	userID, err := a.store.SessionUserID(ctx, token)
	if errors.Is(err, store.ErrNotFound) {
		return 0, ErrUnauthenticated
	}
	if err != nil {
		return 0, err
	}
	return userID, nil
}
