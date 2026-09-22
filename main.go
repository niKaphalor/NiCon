// Command nicon runs NiCon's web UI: a lightweight RCON control panel for
// Nitrado-hosted (and other) game servers.
package main

import (
	"flag"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"

	"github.com/niKaphalor/NiCon/internal/store"
	"github.com/niKaphalor/NiCon/internal/web"
)

func main() {
	addr := flag.String("addr", ":8080", "address to listen on")
	dbPath := flag.String("db", "nicon.db", "path to the NiCon database file")
	flag.Parse()

	logger := log.New(os.Stdout, "", log.LstdFlags)

	st, err := store.Open(*dbPath)
	if err != nil {
		logger.Fatalf("open store: %v", err)
	}
	defer st.Close()

	app := web.NewApp(st, logger)
	defer app.Close()

	server := &http.Server{
		Addr:    *addr,
		Handler: app.Routes(),
	}

	go func() {
		logger.Printf("NiCon listening on %s", *addr)
		if err := server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			logger.Fatalf("serve: %v", err)
		}
	}()

	stop := make(chan os.Signal, 1)
	signal.Notify(stop, os.Interrupt, syscall.SIGTERM)
	<-stop

	logger.Print("shutting down")
	if err := server.Close(); err != nil {
		logger.Printf("server close: %v", err)
	}
}
