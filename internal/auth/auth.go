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

	"golang.org/x/crypto/bcrypt"

	"github.com/niKaphalor/NiCon/internal/store"
)

// SessionTTLSeconds is how long a login stays valid. There's no "remember
// me" distinction — every login gets the same lifetime.
const SessionTTLSeconds = 7 * 24 * 3600 // 7 days

var (
	ErrInvalidCredentials = errors.New("invalid username or password")
	ErrUnauthenticated    = errors.New("not authenticated")
)

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
