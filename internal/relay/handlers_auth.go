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
	Token string `json:"token"`
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

	token, _, err := rel.auth.Login(r.Context(), req.Username, req.Password)
	if err != nil {
		if errors.Is(err, auth.ErrInvalidCredentials) {
			http.Error(w, "invalid username or password", http.StatusUnauthorized)
			return
		}
		rel.log.Printf("login: %v", err)
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(loginResponse{Token: token})
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

	token, _, err := rel.auth.Register(r.Context(), req.Username, req.Password)
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
	_ = json.NewEncoder(w).Encode(loginResponse{Token: token})
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
