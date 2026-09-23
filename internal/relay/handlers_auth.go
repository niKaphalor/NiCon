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
