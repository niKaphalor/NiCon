package relay

import (
	"encoding/json"
	"errors"
	"net/http"

	"github.com/niKaphalor/NiCon/internal/auth"
)

type loginRequest struct {
	Username string `json:"username"`
	Password string `json:"password"`
}

type loginResponse struct {
	Token   string `json:"token"`
	IsAdmin bool   `json:"is_admin"`
}

func (rel *Relay) handleLogin(w http.ResponseWriter, r *http.Request) {
	if !rel.cors(w, r) {
		return
	}

	var req loginRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.Username == "" || req.Password == "" {
		http.Error(w, "username and password are required", http.StatusBadRequest)
		return
	}

	token, userID, err := rel.auth.Login(r.Context(), req.Username, req.Password)
	if err != nil {
		if errors.Is(err, auth.ErrInvalidCredentials) {
			http.Error(w, "invalid username or password", http.StatusUnauthorized)
			return
		}
		rel.log.Printf("login: %v", err)
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}

	// Not fatal to the login itself — worst case the frontend just doesn't
	// show the admin panel for this session.
	var isAdmin bool
	if user, err := rel.store.GetUserByID(r.Context(), userID); err == nil {
		isAdmin = user.IsAdmin
	}

	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(loginResponse{Token: token, IsAdmin: isAdmin})
}

func (rel *Relay) handleLogout(w http.ResponseWriter, r *http.Request) {
	if !rel.cors(w, r) {
		return
	}

	tokenHeader := r.Header.Get("Authorization")
	const prefix = "Bearer "
	if len(tokenHeader) > len(prefix) && tokenHeader[:len(prefix)] == prefix {
		token := tokenHeader[len(prefix):]
		if err := rel.auth.Logout(r.Context(), token); err != nil {
			rel.log.Printf("logout: %v", err)
		}
	}
	w.WriteHeader(http.StatusNoContent)
}

type registerRequest struct {
	Username        string `json:"username"`
	Password        string `json:"password"`
	ConsentAccepted bool   `json:"consent_accepted"`
}

type registerResponse struct {
	Token string `json:"token"`
	// RecoveryCode is returned exactly once, at the moment it's created —
	// the frontend must show it to the user for a deliberate save-it-now
	// step, since neither the plaintext nor any way to recover it exists
	// after this response.
	RecoveryCode string `json:"recovery_code"`
	// IsAdmin is always false here — a self-registered account can never
	// be an admin; that's only ever granted via the `setadmin` CLI command.
	// Included so the frontend can treat login/register responses the same
	// way rather than special-casing one of them.
	IsAdmin bool `json:"is_admin"`
}

// handleRegister is NiCon's self-service signup. It requires
// consent_accepted (the frontend's required "I have read the privacy
// policy" checkbox) — not because account creation itself needs consent as
// its legal basis (it's performance of the usage relationship the account
// exists for), but so a user can't end up with an account without ever
// having been shown what's stored and why.
func (rel *Relay) handleRegister(w http.ResponseWriter, r *http.Request) {
	if !rel.cors(w, r) {
		return
	}
	if !rel.registerLimiter.allow(clientIP(r)) {
		w.Header().Set("Retry-After", "900")
		http.Error(w, "too many registration attempts from this address — try again later", http.StatusTooManyRequests)
		return
	}

	var req registerRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.Username == "" || req.Password == "" {
		http.Error(w, "username and password are required", http.StatusBadRequest)
		return
	}
	if !req.ConsentAccepted {
		http.Error(w, "you must accept the privacy policy to register", http.StatusBadRequest)
		return
	}

	token, recoveryCode, _, err := rel.auth.Register(r.Context(), req.Username, req.Password)
	if err != nil {
		switch {
		case errors.Is(err, auth.ErrUsernameTaken):
			http.Error(w, "username is already taken", http.StatusConflict)
		case errors.Is(err, auth.ErrInvalidUsername), errors.Is(err, auth.ErrPasswordTooShort):
			http.Error(w, err.Error(), http.StatusBadRequest)
		default:
			rel.log.Printf("register: %v", err)
			http.Error(w, "internal error", http.StatusInternalServerError)
		}
		return
	}

	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(registerResponse{Token: token, RecoveryCode: recoveryCode})
}

type resetPasswordRequest struct {
	Username     string `json:"username"`
	RecoveryCode string `json:"recovery_code"`
	NewPassword  string `json:"new_password"`
}

type resetPasswordResponse struct {
	NewRecoveryCode string `json:"new_recovery_code"`
}

// handleResetPassword is the self-service recovery path for a forgotten
// password: username + the one-time recovery code shown at registration
// (or after the last reset) + a new password. It's intentionally
// unauthenticated — that's the whole point — so it's rate-limited
// separately from /api/register to slow down anyone trying to guess a
// recovery code for an account they don't own.
func (rel *Relay) handleResetPassword(w http.ResponseWriter, r *http.Request) {
	if !rel.cors(w, r) {
		return
	}
	if !rel.resetPasswordLimiter.allow(clientIP(r)) {
		w.Header().Set("Retry-After", "900")
		http.Error(w, "too many reset attempts from this address — try again later", http.StatusTooManyRequests)
		return
	}

	var req resetPasswordRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil ||
		req.Username == "" || req.RecoveryCode == "" || req.NewPassword == "" {
		http.Error(w, "username, recovery_code, and new_password are required", http.StatusBadRequest)
		return
	}

	newRecoveryCode, err := rel.auth.ResetPassword(r.Context(), req.Username, req.RecoveryCode, req.NewPassword)
	if err != nil {
		switch {
		case errors.Is(err, auth.ErrInvalidRecoveryCode):
			http.Error(w, "invalid username or recovery code", http.StatusUnauthorized)
		case errors.Is(err, auth.ErrPasswordTooShort):
			http.Error(w, err.Error(), http.StatusBadRequest)
		default:
			rel.log.Printf("reset password: %v", err)
			http.Error(w, "internal error", http.StatusInternalServerError)
		}
		return
	}

	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(resetPasswordResponse{NewRecoveryCode: newRecoveryCode})
}

// handleDeleteAccount is the self-service "right to erasure" endpoint:
// permanently deletes the authenticated account and everything tied to it
// (servers, sessions) — see internal/store.DeleteUser.
func (rel *Relay) handleDeleteAccount(w http.ResponseWriter, r *http.Request) {
	if !rel.cors(w, r) {
		return
	}
	userID, ok := rel.authenticateRequest(w, r)
	if !ok {
		return
	}

	if err := rel.auth.DeleteAccount(r.Context(), userID); err != nil {
		rel.log.Printf("delete account: %v", err)
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
