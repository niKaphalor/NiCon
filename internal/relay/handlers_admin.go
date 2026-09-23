package relay

import (
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"time"

	"github.com/niKaphalor/NiCon/internal/store"
)

// requireAdmin authenticates the request and additionally checks the
// caller's account is flagged admin (see store.SetAdmin, only ever set via
// the `setadmin` CLI command). Writes 401/403 and returns ok=false on
// failure, same calling convention as authenticateRequest.
func (rel *Relay) requireAdmin(w http.ResponseWriter, r *http.Request) (userID int64, ok bool) {
	userID, ok = rel.authenticateRequest(w, r)
	if !ok {
		return 0, false
	}
	user, err := rel.store.GetUserByID(r.Context(), userID)
	if err != nil {
		rel.log.Printf("require admin: %v", err)
		http.Error(w, "internal error", http.StatusInternalServerError)
		return 0, false
	}
	if !user.IsAdmin {
		http.Error(w, "admin access required", http.StatusForbidden)
		return 0, false
	}
	return userID, true
}

type adminUserResponse struct {
	ID          int64  `json:"id"`
	Username    string `json:"username"`
	CreatedAt   string `json:"created_at"`
	IsAdmin     bool   `json:"is_admin"`
	ServerCount int    `json:"server_count"`
}

func toAdminUserResponse(u store.AdminUserSummary) adminUserResponse {
	return adminUserResponse{
		ID:          u.ID,
		Username:    u.Username,
		CreatedAt:   u.CreatedAt.Format(time.RFC3339),
		IsAdmin:     u.IsAdmin,
		ServerCount: u.ServerCount,
	}
}

func (rel *Relay) handleAdminListUsers(w http.ResponseWriter, r *http.Request) {
	if !rel.cors(w, r) {
		return
	}
	if _, ok := rel.requireAdmin(w, r); !ok {
		return
	}

	users, err := rel.store.ListUsers(r.Context())
	if err != nil {
		rel.log.Printf("admin list users: %v", err)
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}

	resp := make([]adminUserResponse, len(users))
	for i, u := range users {
		resp[i] = toAdminUserResponse(u)
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(resp)
}

// handleAdminDeleteUser lets an admin remove any account (not just their
// own, unlike DELETE /api/account) — same underlying deletion, so servers
// and sessions cascade with it.
func (rel *Relay) handleAdminDeleteUser(w http.ResponseWriter, r *http.Request) {
	if !rel.cors(w, r) {
		return
	}
	if _, ok := rel.requireAdmin(w, r); !ok {
		return
	}

	targetID, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
	if err != nil {
		http.Error(w, "invalid user id", http.StatusBadRequest)
		return
	}

	if err := rel.store.DeleteUser(r.Context(), targetID); err != nil {
		if errors.Is(err, store.ErrNotFound) {
			http.NotFound(w, r)
			return
		}
		rel.log.Printf("admin delete user: %v", err)
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

type adminRecoveryCodeResponse struct {
	RecoveryCode string `json:"recovery_code"`
}

// handleAdminRegenerateRecoveryCode issues a fresh recovery code for any
// account — the admin-side equivalent of GenerateAndSetRecoveryCode via the
// CLI, for when a user has lost their code and can't reach the operator's
// terminal (or the operator would rather not touch the database directly).
// The admin is responsible for relaying the code to that user out of band;
// the relay never has an email address to send it to itself.
func (rel *Relay) handleAdminRegenerateRecoveryCode(w http.ResponseWriter, r *http.Request) {
	if !rel.cors(w, r) {
		return
	}
	if _, ok := rel.requireAdmin(w, r); !ok {
		return
	}

	targetID, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
	if err != nil {
		http.Error(w, "invalid user id", http.StatusBadRequest)
		return
	}

	code, err := rel.auth.GenerateAndSetRecoveryCode(r.Context(), targetID)
	if err != nil {
		if errors.Is(err, store.ErrNotFound) {
			http.NotFound(w, r)
			return
		}
		rel.log.Printf("admin regenerate recovery code: %v", err)
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(adminRecoveryCodeResponse{RecoveryCode: code})
}
