// Command nicon-relay runs NiCon's local relay: a WebSocket<->RCON bridge
// and a Nitrado API proxy for the static NiCon web UI, plus the MariaDB
// -backed accounts and per-user server list behind it.
package main

import (
	"context"
	"flag"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"

	"golang.org/x/term"

	"github.com/niKaphalor/NiCon/internal/auth"
	"github.com/niKaphalor/NiCon/internal/relay"
	"github.com/niKaphalor/NiCon/internal/store"
)

func main() {
	if len(os.Args) > 1 {
		switch os.Args[1] {
		case "adduser":
			runAddUser(os.Args[2:])
			return
		case "genkey":
			runGenKey()
			return
		}
	}
	runServer()
}

func dbFlags(fs *flag.FlagSet) (dsn *string, encKey *string) {
	dsn = fs.String("db-dsn", os.Getenv("NICON_DB_DSN"),
		"MySQL/MariaDB DSN, e.g. user:pass@tcp(host:3306)/nicon?parseTime=true (default: $NICON_DB_DSN)")
	encKey = fs.String("encryption-key", os.Getenv("NICON_ENCRYPTION_KEY"),
		"base64-encoded 32-byte key used to encrypt stored RCON passwords (default: $NICON_ENCRYPTION_KEY; generate one with 'nicon-relay genkey')")
	return dsn, encKey
}

func openStore(dsn, encKeyB64 string) *store.Store {
	if dsn == "" {
		log.Fatal("missing -db-dsn (or $NICON_DB_DSN)")
	}
	if encKeyB64 == "" {
		log.Fatal("missing -encryption-key (or $NICON_ENCRYPTION_KEY) — generate one with: nicon-relay genkey")
	}
	key, err := store.DecodeEncryptionKey(encKeyB64)
	if err != nil {
		log.Fatalf("encryption key: %v", err)
	}
	st, err := store.Open(dsn, key)
	if err != nil {
		log.Fatalf("open database: %v", err)
	}
	return st
}

func runServer() {
	fs := flag.NewFlagSet("nicon-relay", flag.ExitOnError)
	addr := fs.String("addr", "localhost:8765", "address to listen on")
	allowOrigin := fs.String("allow-origin", "https://nikaphalor.github.io,http://localhost:8765",
		"comma-separated list of origins allowed to connect")
	dsn, encKey := dbFlags(fs)
	fs.Parse(os.Args[1:])

	logger := log.New(os.Stdout, "", log.LstdFlags)

	st := openStore(*dsn, *encKey)
	defer st.Close()

	rel := relay.New(logger, strings.Split(*allowOrigin, ","), st, auth.New(st))

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

func runAddUser(args []string) {
	fs := flag.NewFlagSet("nicon-relay adduser", flag.ExitOnError)
	dsn, encKey := dbFlags(fs)
	fs.Parse(args)

	if fs.NArg() != 1 {
		fmt.Fprintln(os.Stderr, "usage: nicon-relay adduser [-db-dsn ...] [-encryption-key ...] <username>")
		os.Exit(2)
	}
	username := fs.Arg(0)

	st := openStore(*dsn, *encKey)
	defer st.Close()

	fmt.Print("Password: ")
	pw1, err := term.ReadPassword(int(os.Stdin.Fd()))
	fmt.Println()
	if err != nil {
		log.Fatalf("read password: %v", err)
	}
	fmt.Print("Confirm password: ")
	pw2, err := term.ReadPassword(int(os.Stdin.Fd()))
	fmt.Println()
	if err != nil {
		log.Fatalf("read password: %v", err)
	}
	if string(pw1) != string(pw2) {
		log.Fatal("passwords didn't match")
	}
	if len(pw1) < 8 {
		log.Fatal("password must be at least 8 characters")
	}

	hash, err := auth.HashPassword(string(pw1))
	if err != nil {
		log.Fatalf("hash password: %v", err)
	}

	id, err := st.CreateUser(context.Background(), username, hash)
	if err != nil {
		log.Fatalf("create user: %v", err)
	}
	fmt.Printf("Created user %q (id %d)\n", username, id)
}

func runGenKey() {
	key, err := store.GenerateEncryptionKey()
	if err != nil {
		log.Fatalf("generate key: %v", err)
	}
	fmt.Println(key)
}
