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

var (
	ErrInvalidCredentials = errors.New("invalid username or password")
	ErrUnauthenticated    = errors.New("not authenticated")
	ErrUsernameTaken      = errors.New("username already taken")
	ErrInvalidUsername    = errors.New("username must be 3-32 characters: letters, numbers, underscore, hyphen, or dot")
	ErrPasswordTooShort   = errors.New("password must be at least 8 characters")
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
// (same as a fresh Login) so a signup doesn't need a second round trip.
func (a *Auth) Register(ctx context.Context, username, password string) (token string, userID int64, err error) {
	username = strings.TrimSpace(username)
	if !usernamePattern.MatchString(username) {
		return "", 0, ErrInvalidUsername
	}
	if len(password) < MinPasswordLength {
		return "", 0, ErrPasswordTooShort
	}

	hash, err := HashPassword(password)
	if err != nil {
		return "", 0, err
	}

	id, err := a.store.CreateUser(ctx, username, hash)
	if err != nil {
		if errors.Is(err, store.ErrUsernameTaken) {
			return "", 0, ErrUsernameTaken
		}
		return "", 0, err
	}

	token, err = generateToken()
	if err != nil {
		return "", 0, err
	}
	if err := a.store.CreateSession(ctx, token, id, SessionTTLSeconds); err != nil {
		return "", 0, err
	}
	return token, id, nil
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
