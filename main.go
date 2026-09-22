// Command nicon-relay runs NiCon's local relay: a WebSocket<->RCON bridge
// and a Nitrado API proxy for the static NiCon web UI (e.g. hosted on
// GitHub Pages), which can't open raw TCP sockets itself. Stores nothing.
package main

import (
	"flag"
	"log"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"

	"github.com/niKaphalor/NiCon/internal/relay"
)

func main() {
	addr := flag.String("addr", "localhost:8765", "address to listen on")
	allowOrigin := flag.String("allow-origin", "https://nikaphalor.github.io,http://localhost:8765", "comma-separated list of origins allowed to connect")
	flag.Parse()

	logger := log.New(os.Stdout, "", log.LstdFlags)

	rel := relay.New(logger, strings.Split(*allowOrigin, ","))

	server := &http.Server{
		Addr:    *addr,
		Handler: rel.Routes(),
	}

	go func() {
		logger.Printf("NiCon relay listening on %s", *addr)
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
