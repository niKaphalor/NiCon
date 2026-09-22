package web

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"html/template"
	"net/http"
	"sort"
	"strconv"
	"time"

	"github.com/niKaphalor/NiCon/internal/nitrado"
	"github.com/niKaphalor/NiCon/internal/store"
)

func newManualID() string {
	buf := make([]byte, 8)
	_, _ = rand.Read(buf)
	return "manual-" + hex.EncodeToString(buf)
}

type indexData struct {
	NitradoServers []store.Server
	ManualServers  []store.Server
}

func (a *App) handleIndex(w http.ResponseWriter, r *http.Request) {
	servers, err := a.store.ListServers()
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	data := indexData{}
	for _, srv := range servers {
		if srv.Source == "nitrado" {
			data.NitradoServers = append(data.NitradoServers, srv)
		} else {
			data.ManualServers = append(data.ManualServers, srv)
		}
	}
	sort.Slice(data.NitradoServers, func(i, j int) bool { return data.NitradoServers[i].Name < data.NitradoServers[j].Name })
	sort.Slice(data.ManualServers, func(i, j int) bool { return data.ManualServers[i].Name < data.ManualServers[j].Name })

	a.render(w, tmplIndex, data)
}

func (a *App) handleNewServerForm(w http.ResponseWriter, r *http.Request) {
	a.render(w, tmplNewServer, nil)
}

func (a *App) handleNewServerSubmit(w http.ResponseWriter, r *http.Request) {
	if err := r.ParseForm(); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}

	port, err := strconv.Atoi(r.FormValue("port"))
	if err != nil {
		http.Error(w, "port must be a number", http.StatusBadRequest)
		return
	}

	srv := store.Server{
		ID:       newManualID(),
		Name:     r.FormValue("name"),
		Host:     r.FormValue("host"),
		Port:     port,
		Password: r.FormValue("password"),
		Source:   "manual",
	}
	if err := a.store.PutServer(srv); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	http.Redirect(w, r, "/", http.StatusSeeOther)
}

func (a *App) handleDeleteServer(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	a.rcon.Close(id)
	if err := a.store.DeleteServer(id); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	http.Redirect(w, r, "/", http.StatusSeeOther)
}

type passwordData struct {
	Server store.Server
}

func (a *App) handlePasswordForm(w http.ResponseWriter, r *http.Request) {
	srv, err := a.store.GetServer(r.PathValue("id"))
	if err != nil {
		a.notFoundOrError(w, r, err)
		return
	}
	a.render(w, tmplPassword, passwordData{Server: srv})
}

func (a *App) handlePasswordSubmit(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	srv, err := a.store.GetServer(id)
	if err != nil {
		a.notFoundOrError(w, r, err)
		return
	}
	if err := r.ParseForm(); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	srv.Password = r.FormValue("password")
	// The old connection, if any, was authenticated with the old password.
	a.rcon.Close(id)
	if err := a.store.PutServer(srv); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	http.Redirect(w, r, "/", http.StatusSeeOther)
}

type consoleData struct {
	Server store.Server
}

func (a *App) handleConsole(w http.ResponseWriter, r *http.Request) {
	srv, err := a.store.GetServer(r.PathValue("id"))
	if err != nil {
		a.notFoundOrError(w, r, err)
		return
	}
	a.render(w, tmplConsole, consoleData{Server: srv})
}

func (a *App) handleRcon(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	srv, err := a.store.GetServer(id)
	if err != nil {
		a.notFoundOrError(w, r, err)
		return
	}
	if err := r.ParseForm(); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	command := r.FormValue("command")
	if command == "" {
		http.Error(w, "command must not be empty", http.StatusBadRequest)
		return
	}

	address := fmt.Sprintf("%s:%d", srv.Host, srv.Port)
	output, err := a.rcon.Execute(id, address, srv.Password, command)
	if err != nil {
		a.log.Printf("rcon command failed for %s: %v", srv.Name, err)
		http.Error(w, err.Error(), http.StatusBadGateway)
		return
	}
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	fmt.Fprint(w, output)
}

type nitradoData struct {
	HasToken bool
}

func (a *App) handleNitrado(w http.ResponseWriter, r *http.Request) {
	token, err := a.store.GetNitradoToken()
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	a.render(w, tmplNitrado, nitradoData{HasToken: token != ""})
}

func (a *App) handleNitradoToken(w http.ResponseWriter, r *http.Request) {
	if err := r.ParseForm(); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	if err := a.store.SetNitradoToken(r.FormValue("token")); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	http.Redirect(w, r, "/nitrado", http.StatusSeeOther)
}

// handleNitradoSync fetches the account's services from the Nitrado API and
// upserts one store.Server per service whose current game has RCON enabled.
// Existing entries (matched by service ID) keep their saved password.
func (a *App) handleNitradoSync(w http.ResponseWriter, r *http.Request) {
	token, err := a.store.GetNitradoToken()
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	if token == "" {
		http.Redirect(w, r, "/nitrado", http.StatusSeeOther)
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
	defer cancel()

	client := nitrado.NewClient(token)
	services, err := client.ListServices(ctx)
	if err != nil {
		a.log.Printf("nitrado sync: list services: %v", err)
		http.Error(w, err.Error(), http.StatusBadGateway)
		return
	}

	for _, svc := range services {
		gs, err := client.GetGameserver(ctx, svc.ID)
		if err != nil {
			a.log.Printf("nitrado sync: gameserver %d: %v", svc.ID, err)
			continue
		}
		if !gs.GameSpecific.Features.HasRcon || gs.RconPort == 0 || gs.IP == "" {
			continue
		}

		id := fmt.Sprintf("nitrado-%d", svc.ID)
		name := gs.Query.ServerName
		if name == "" {
			name = gs.GameHuman
		}

		srv := store.Server{
			ID:               id,
			Name:             name,
			Host:             gs.IP,
			Port:             gs.RconPort,
			Source:           "nitrado",
			Game:             gs.GameHuman,
			NitradoServiceID: svc.ID,
		}
		// Preserve a previously-entered password across re-syncs.
		if existing, err := a.store.GetServer(id); err == nil {
			srv.Password = existing.Password
		}
		if err := a.store.PutServer(srv); err != nil {
			a.log.Printf("nitrado sync: save server %d: %v", svc.ID, err)
		}
	}

	http.Redirect(w, r, "/", http.StatusSeeOther)
}

func (a *App) notFoundOrError(w http.ResponseWriter, r *http.Request, err error) {
	if errors.Is(err, store.ErrNotFound) {
		http.NotFound(w, r)
		return
	}
	http.Error(w, err.Error(), http.StatusInternalServerError)
}

// pageData wraps every page's own data so base.html can always reference
// .Flash without each page's data type needing that field itself.
type pageData struct {
	Flash string
	Data  any
}

func (a *App) render(w http.ResponseWriter, tmpl *template.Template, data any) {
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	if err := tmpl.ExecuteTemplate(w, "base", pageData{Data: data}); err != nil {
		a.log.Printf("render error: %v", err)
	}
}
