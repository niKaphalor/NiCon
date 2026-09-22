// Package web implements NiCon's browser UI and JSON/form endpoints.
package web

import (
	"log"
	"net/http"

	"github.com/niKaphalor/NiCon/internal/rconmgr"
	"github.com/niKaphalor/NiCon/internal/store"
)

type App struct {
	store *store.Store
	rcon  *rconmgr.Manager
	log   *log.Logger
}

func NewApp(st *store.Store, logger *log.Logger) *App {
	return &App{store: st, rcon: rconmgr.New(), log: logger}
}

// Close releases resources held by the app (pooled RCON connections).
func (a *App) Close() {
	a.rcon.CloseAll()
}

func (a *App) Routes() http.Handler {
	mux := http.NewServeMux()

	mux.Handle("GET /static/", http.FileServerFS(staticFS))

	mux.HandleFunc("GET /{$}", a.handleIndex)

	mux.HandleFunc("GET /servers/new", a.handleNewServerForm)
	mux.HandleFunc("POST /servers/new", a.handleNewServerSubmit)
	mux.HandleFunc("POST /servers/{id}/delete", a.handleDeleteServer)
	mux.HandleFunc("GET /servers/{id}/password", a.handlePasswordForm)
	mux.HandleFunc("POST /servers/{id}/password", a.handlePasswordSubmit)
	mux.HandleFunc("GET /servers/{id}/console", a.handleConsole)
	mux.HandleFunc("POST /servers/{id}/rcon", a.handleRcon)

	mux.HandleFunc("GET /nitrado", a.handleNitrado)
	mux.HandleFunc("POST /nitrado/token", a.handleNitradoToken)
	mux.HandleFunc("POST /nitrado/sync", a.handleNitradoSync)

	return mux
}
