package relay

import (
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"strings"

	"github.com/niKaphalor/NiCon/internal/nitrado"
	"github.com/niKaphalor/NiCon/internal/store"
)

// serverResponse is what a server looks like over the API: everything
// except the actual password, which never needs to travel back to the
// browser once saved (the WS "connect" message references a server by ID
// and the relay decrypts its password server-side).
type serverResponse struct {
	ID          int64  `json:"id"`
	Name        string `json:"name"`
	Host        string `json:"host"`
	Port        int    `json:"port"`
	Protocol    string `json:"protocol"`
	Game        string `json:"game"`
	Source      string `json:"source"`
	HasPassword bool   `json:"has_password"`
}

func toServerResponse(srv store.Server) serverResponse {
	return serverResponse{
		ID:          srv.ID,
		Name:        srv.Name,
		Host:        srv.Host,
		Port:        srv.Port,
		Protocol:    srv.Protocol,
		Game:        srv.Game,
		Source:      srv.Source,
		HasPassword: srv.Password != "",
	}
}

func (rel *Relay) handleListServers(w http.ResponseWriter, r *http.Request) {
	if !rel.cors(w, r) {
		return
	}
	userID, ok := rel.authenticateRequest(w, r)
	if !ok {
		return
	}

	servers, err := rel.store.ListServers(r.Context(), userID)
	if err != nil {
		rel.log.Printf("list servers: %v", err)
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}

	resp := make([]serverResponse, len(servers))
	for i, srv := range servers {
		resp[i] = toServerResponse(srv)
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(resp)
}

type createServerRequest struct {
	Name     string `json:"name"`
	Host     string `json:"host"`
	Port     int    `json:"port"`
	Password string `json:"password"`
	Protocol string `json:"protocol"`
}

func (rel *Relay) handleCreateServer(w http.ResponseWriter, r *http.Request) {
	if !rel.cors(w, r) {
		return
	}
	userID, ok := rel.authenticateRequest(w, r)
	if !ok {
		return
	}

	var req createServerRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "invalid request body", http.StatusBadRequest)
		return
	}
	if req.Name == "" || req.Host == "" || req.Port <= 0 {
		http.Error(w, "name, host, and port are required", http.StatusBadRequest)
		return
	}
	protocol := req.Protocol
	if protocol == "" {
		protocol = "source"
	}

	id, err := rel.store.CreateServer(r.Context(), store.Server{
		UserID:   userID,
		Name:     req.Name,
		Host:     req.Host,
		Port:     req.Port,
		Password: req.Password,
		Protocol: protocol,
		Source:   "manual",
	})
	if err != nil {
		rel.log.Printf("create server: %v", err)
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}

	srv, err := rel.store.GetServer(r.Context(), userID, id)
	if err != nil {
		rel.log.Printf("get created server: %v", err)
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(toServerResponse(*srv))
}

type setPasswordRequest struct {
	Password string `json:"password"`
}

func (rel *Relay) handleSetServerPassword(w http.ResponseWriter, r *http.Request) {
	if !rel.cors(w, r) {
		return
	}
	userID, ok := rel.authenticateRequest(w, r)
	if !ok {
		return
	}

	id, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
	if err != nil {
		http.Error(w, "invalid server id", http.StatusBadRequest)
		return
	}

	var req setPasswordRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.Password == "" {
		http.Error(w, "password is required", http.StatusBadRequest)
		return
	}

	if err := rel.store.UpdateServerPassword(r.Context(), userID, id, req.Password); err != nil {
		if errors.Is(err, store.ErrNotFound) {
			http.NotFound(w, r)
			return
		}
		rel.log.Printf("set server password: %v", err)
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (rel *Relay) handleDeleteServer(w http.ResponseWriter, r *http.Request) {
	userID, ok := rel.authenticateRequest(w, r)
	if !ok {
		return
	}

	id, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
	if err != nil {
		http.Error(w, "invalid server id", http.StatusBadRequest)
		return
	}

	if err := rel.store.DeleteServer(r.Context(), userID, id); err != nil {
		if errors.Is(err, store.ErrNotFound) {
			http.NotFound(w, r)
			return
		}
		rel.log.Printf("delete server: %v", err)
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// --- Nitrado sync: authenticated, upserts results into the caller's own
// server list instead of just returning them for the browser to hold. ---

type nitradoSyncRequest struct {
	Token string `json:"token"`
}

func (rel *Relay) handleNitradoSync(w http.ResponseWriter, r *http.Request) {
	if !rel.cors(w, r) {
		return
	}
	userID, ok := rel.authenticateRequest(w, r)
	if !ok {
		return
	}

	var req nitradoSyncRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.Token == "" {
		http.Error(w, "token is required", http.StatusBadRequest)
		return
	}

	ctx := r.Context()
	client := nitrado.NewClient(req.Token)
	services, err := client.ListServices(ctx)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadGateway)
		return
	}

	for _, svc := range services {
		gs, err := client.GetGameserver(ctx, svc.ID)
		if err != nil {
			rel.log.Printf("nitrado sync: gameserver %d: %v", svc.ID, err)
			continue
		}
		// Rust doesn't use classic RCON at all - it has its own WebSocket-based
		// "WebRCON" protocol, so Nitrado's has_rcon flag likely doesn't (and
		// isn't expected to) cover it. Treat any Rust service as eligible on
		// host/port alone, and use the webrcon transport for it.
		isRust := strings.Contains(strings.ToLower(gs.GameHuman), "rust")
		hasConnectionInfo := gs.RconPort != 0 && gs.IP != ""
		eligible := (gs.GameSpecific.Features.HasRcon || isRust) && hasConnectionInfo

		if !eligible {
			rel.log.Printf(
				"nitrado sync: skipping service %d (%s, status=%s): has_rcon=%v rcon_port=%d ip=%q",
				svc.ID, gs.GameHuman, gs.Status, gs.GameSpecific.Features.HasRcon, gs.RconPort, gs.IP,
			)
			continue
		}

		protocol := "source"
		if isRust {
			protocol = "webrcon"
		}

		name := gs.Query.ServerName
		if name == "" {
			name = gs.GameHuman
		}

		serviceID := int64(svc.ID)
		err = rel.store.UpsertNitradoServer(ctx, store.Server{
			UserID:           userID,
			Name:             name,
			Host:             gs.IP,
			Port:             gs.RconPort,
			Protocol:         protocol,
			Game:             gs.GameHuman,
			NitradoServiceID: &serviceID,
		})
		if err != nil {
			rel.log.Printf("nitrado sync: save service %d: %v", svc.ID, err)
		}
	}

	servers, err := rel.store.ListServers(ctx, userID)
	if err != nil {
		rel.log.Printf("nitrado sync: list servers: %v", err)
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}
	resp := make([]serverResponse, len(servers))
	for i, srv := range servers {
		resp[i] = toServerResponse(srv)
	}

	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(resp)
}
