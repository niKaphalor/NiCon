// Command nicon-relay runs NiCon's local relay: a WebSocket<->RCON bridge
// for the static NiCon web UI, reading server credentials from the same
// MariaDB database the webspace/ PHP API manages. See the README's "Cloud
// API vs. relay" section — accounts, registration, and per-user server
// CRUD live in that PHP API now, not here.
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
	"time"

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
		case "gen-recovery-code":
			runGenRecoveryCode(os.Args[2:])
			return
		case "setadmin":
			runSetAdmin(os.Args[2:])
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
		"comma-separated list of origins allowed to open a WebSocket (or call /healthz)")
	dsn, encKey := dbFlags(fs)
	fs.Parse(os.Args[1:])

	logger := log.New(os.Stdout, "", log.LstdFlags)

	st := openStore(*dsn, *encKey)
	defer st.Close()

	rel := relay.New(logger, strings.Split(*allowOrigin, ","), st, auth.New(st))

	server := &http.Server{
		Addr:    *addr,
		Handler: rel.Routes(),
		// These only bound the plain-HTTP request/idle phase — once
		// /ws/rcon upgrades a connection, gorilla/websocket hijacks it and
		// net/http stops managing its deadlines, so an open console isn't
		// affected. ReadHeaderTimeout guards against a client that opens a
		// connection and trickles headers in slowly (a slowloris-style
		// resource hold); IdleTimeout reclaims a keep-alive connection that
		// never sends another request (e.g. only ever hit /healthz once).
		ReadHeaderTimeout: 10 * time.Second,
		IdleTimeout:       120 * time.Second,
	}

	go func() {
		logger.Printf("NiCon relay listening on %s", *addr)
		if err := server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			logger.Fatalf("serve: %v", err)
		}
	}()

	// sessionCleanupInterval paces store.CleanupExpired: not needed for
	// correctness (every session query already checks expires_at > NOW()),
	// just housekeeping so the table doesn't grow unbounded from tokens
	// nobody ever explicitly logged out of. The goroutine is intentionally
	// not joined on shutdown — it exits along with the rest of the process.
	const sessionCleanupInterval = 1 * time.Hour
	cleanupTicker := time.NewTicker(sessionCleanupInterval)
	defer cleanupTicker.Stop()
	go func() {
		for range cleanupTicker.C {
			if n, err := st.CleanupExpired(context.Background()); err != nil {
				logger.Printf("cleanup expired sessions: %v", err)
			} else if n > 0 {
				logger.Printf("cleaned up %d expired session(s)", n)
			}
		}
	}()

	stop := make(chan os.Signal, 1)
	signal.Notify(stop, os.Interrupt, syscall.SIGTERM)
	<-stop

	logger.Print("shutting down")
	// Shutdown (not Close): lets an in-flight plain HTTP request (a
	// /healthz check) finish instead of severing it mid-response. This
	// makes no difference to an already-open /ws/rcon connection either
	// way — net/http stops tracking a connection entirely once it's
	// hijacked (which the WebSocket upgrade does), so neither Shutdown
	// nor Close reaches those; they close only when the process exits.
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := server.Shutdown(ctx); err != nil {
		logger.Printf("server shutdown: %v", err)
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

	recoveryCode, err := auth.GenerateRecoveryCode()
	if err != nil {
		log.Fatalf("generate recovery code: %v", err)
	}
	recoveryCodeHash, err := auth.HashPassword(auth.NormalizeRecoveryCode(recoveryCode))
	if err != nil {
		log.Fatalf("hash recovery code: %v", err)
	}

	id, err := st.CreateUser(context.Background(), username, hash, recoveryCodeHash)
	if err != nil {
		log.Fatalf("create user: %v", err)
	}
	fmt.Printf("Created user %q (id %d)\n", username, id)
	fmt.Println()
	fmt.Println("Recovery code (save this somewhere safe and give it to the user — it's the only")
	fmt.Println("way to reset this account's password without your help, and won't be shown again):")
	fmt.Println()
	fmt.Println("  " + recoveryCode)
}

func runGenKey() {
	key, err := store.GenerateEncryptionKey()
	if err != nil {
		log.Fatalf("generate key: %v", err)
	}
	fmt.Println(key)
}

// runGenRecoveryCode issues a fresh recovery code for an existing account
// — bootstrapping one for an account that predates this feature, or
// replacing a lost code, without needing that account's password.
func runGenRecoveryCode(args []string) {
	fs := flag.NewFlagSet("nicon-relay gen-recovery-code", flag.ExitOnError)
	dsn, encKey := dbFlags(fs)
	fs.Parse(args)

	if fs.NArg() != 1 {
		fmt.Fprintln(os.Stderr, "usage: nicon-relay gen-recovery-code [-db-dsn ...] [-encryption-key ...] <username>")
		os.Exit(2)
	}
	username := fs.Arg(0)

	st := openStore(*dsn, *encKey)
	defer st.Close()

	user, err := st.GetUserByUsername(context.Background(), username)
	if err != nil {
		log.Fatalf("find user %q: %v", username, err)
	}

	code, err := auth.New(st).GenerateAndSetRecoveryCode(context.Background(), user.ID)
	if err != nil {
		log.Fatalf("generate recovery code: %v", err)
	}
	fmt.Printf("New recovery code for %q (any previous code no longer works):\n\n", username)
	fmt.Println("  " + code)
}

// runSetAdmin grants (or, with -revoke, removes) admin status. This is
// deliberately CLI-only — there is no HTTP endpoint that can promote an
// account to admin, so the only path to creating the first admin (or any
// other) is someone who already has command-line/database access to the
// relay.
func runSetAdmin(args []string) {
	fs := flag.NewFlagSet("nicon-relay setadmin", flag.ExitOnError)
	revoke := fs.Bool("revoke", false, "remove admin status instead of granting it")
	dsn, encKey := dbFlags(fs)
	fs.Parse(args)

	if fs.NArg() != 1 {
		fmt.Fprintln(os.Stderr, "usage: nicon-relay setadmin [-revoke] [-db-dsn ...] [-encryption-key ...] <username>")
		os.Exit(2)
	}
	username := fs.Arg(0)

	st := openStore(*dsn, *encKey)
	defer st.Close()

	user, err := st.GetUserByUsername(context.Background(), username)
	if err != nil {
		log.Fatalf("find user %q: %v", username, err)
	}

	if err := st.SetAdmin(context.Background(), user.ID, !*revoke); err != nil {
		log.Fatalf("set admin: %v", err)
	}
	if *revoke {
		fmt.Printf("%q is no longer an admin\n", username)
	} else {
		fmt.Printf("%q is now an admin\n", username)
	}
}
