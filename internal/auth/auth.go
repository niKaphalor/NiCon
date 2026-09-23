// Package auth handles password hashing and session tokens on top of
// internal/store. It never touches passwords in plaintext except to check
// them at login (bcrypt) or hand a freshly-generated random token back to
// the caller.
package auth

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"regexp"
	"strings"

	"golang.org/x/crypto/bcrypt"

	"github.com/niKaphalor/NiCon/internal/store"
)

// SessionTTLSeconds is how long a login stays valid. There's no "remember
// me" distinction — every login gets the same lifetime.
const SessionTTLSeconds = 7 * 24 * 3600 // 7 days

const MinPasswordLength = 8

// RecoveryCodeLength is the number of characters in a generated recovery
// code (before the display formatting adds hyphens every 5 characters).
const RecoveryCodeLength = 20

// recoveryCodeAlphabet excludes characters that are easy to misread or
// confuse with one another (0/O, 1/I/L) since a recovery code has to be
// retyped correctly from a saved copy, often by hand.
const recoveryCodeAlphabet = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"

var (
	ErrInvalidCredentials  = errors.New("invalid username or password")
	ErrUnauthenticated     = errors.New("not authenticated")
	ErrUsernameTaken       = errors.New("username already taken")
	ErrInvalidUsername     = errors.New("username must be 3-32 characters: letters, numbers, underscore, hyphen, or dot")
	ErrPasswordTooShort    = errors.New("password must be at least 8 characters")
	ErrInvalidRecoveryCode = errors.New("invalid username or recovery code")
)

var usernamePattern = regexp.MustCompile(`^[a-zA-Z0-9_.-]{3,32}$`)

type Auth struct {
	store *store.Store
}

func New(st *store.Store) *Auth {
	return &Auth{store: st}
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

// Login verifies username/password and returns a new session token.
func (a *Auth) Login(ctx context.Context, username, password string) (token string, userID int64, err error) {
	user, err := a.store.GetUserByUsername(ctx, username)
	if err != nil {
		if errors.Is(err, store.ErrNotFound) {
			return "", 0, ErrInvalidCredentials
		}
		return "", 0, err
	}
	if err := bcrypt.CompareHashAndPassword([]byte(user.PasswordHash), []byte(password)); err != nil {
		return "", 0, ErrInvalidCredentials
	}

	token, err = generateToken()
	if err != nil {
		return "", 0, err
	}
	if err := a.store.CreateSession(ctx, token, user.ID, SessionTTLSeconds); err != nil {
		return "", 0, err
	}
	return token, user.ID, nil
}

func (a *Auth) Logout(ctx context.Context, token string) error {
	return a.store.DeleteSession(ctx, token)
}

// Register creates a new account and, on success, logs it in immediately
// (same as a fresh Login) so a signup doesn't need a second round trip. It
// also generates a one-time recovery code — the only way back into the
// account if the password is later forgotten — and returns it in plaintext
// exactly once; only its bcrypt hash is stored.
func (a *Auth) Register(ctx context.Context, username, password string) (token, recoveryCode string, userID int64, err error) {
	username = strings.TrimSpace(username)
	if !usernamePattern.MatchString(username) {
		return "", "", 0, ErrInvalidUsername
	}
	if len(password) < MinPasswordLength {
		return "", "", 0, ErrPasswordTooShort
	}

	hash, err := HashPassword(password)
	if err != nil {
		return "", "", 0, err
	}
	recoveryCode, err = GenerateRecoveryCode()
	if err != nil {
		return "", "", 0, err
	}
	recoveryCodeHash, err := HashPassword(NormalizeRecoveryCode(recoveryCode))
	if err != nil {
		return "", "", 0, err
	}

	id, err := a.store.CreateUser(ctx, username, hash, recoveryCodeHash)
	if err != nil {
		if errors.Is(err, store.ErrUsernameTaken) {
			return "", "", 0, ErrUsernameTaken
		}
		return "", "", 0, err
	}

	token, err = generateToken()
	if err != nil {
		return "", "", 0, err
	}
	if err := a.store.CreateSession(ctx, token, id, SessionTTLSeconds); err != nil {
		return "", "", 0, err
	}
	return token, recoveryCode, id, nil
}

// ResetPassword verifies username+recoveryCode and, on success, sets a new
// password and issues a fresh recovery code — the old one is single-use,
// same as a 2FA backup code, so it's rotated on every successful reset and
// returned once, exactly like at registration. Every existing session for
// the account is invalidated as part of the same reset (see
// store.ResetPassword), in case the old password had leaked.
//
// A wrong username and a wrong recovery code return the identical
// ErrInvalidRecoveryCode, so this endpoint can't be used to check which
// usernames exist on the relay.
func (a *Auth) ResetPassword(ctx context.Context, username, recoveryCode, newPassword string) (newRecoveryCode string, err error) {
	if len(newPassword) < MinPasswordLength {
		return "", ErrPasswordTooShort
	}

	user, err := a.store.GetUserByUsername(ctx, username)
	if err != nil {
		if errors.Is(err, store.ErrNotFound) {
			return "", ErrInvalidRecoveryCode
		}
		return "", err
	}
	if user.RecoveryCodeHash == "" {
		return "", ErrInvalidRecoveryCode
	}
	if err := bcrypt.CompareHashAndPassword(
		[]byte(user.RecoveryCodeHash), []byte(NormalizeRecoveryCode(recoveryCode)),
	); err != nil {
		return "", ErrInvalidRecoveryCode
	}

	newHash, err := HashPassword(newPassword)
	if err != nil {
		return "", err
	}
	newRecoveryCode, err = GenerateRecoveryCode()
	if err != nil {
		return "", err
	}
	newRecoveryCodeHash, err := HashPassword(NormalizeRecoveryCode(newRecoveryCode))
	if err != nil {
		return "", err
	}

	if err := a.store.ResetPassword(ctx, user.ID, newHash, newRecoveryCodeHash); err != nil {
		return "", err
	}
	return newRecoveryCode, nil
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

// DeleteAccount permanently removes an account and everything tied to it
// (sessions, servers) — the self-service "right to erasure" path.
func (a *Auth) DeleteAccount(ctx context.Context, userID int64) error {
	return a.store.DeleteUser(ctx, userID)
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

func generateToken() (string, error) {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return hex.EncodeToString(b), nil
}
