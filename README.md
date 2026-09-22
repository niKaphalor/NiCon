# NiCon

A lightweight, self-hosted web UI to send RCON commands to game servers —
including the ones on your Nitrado account, and any other Source-RCON
server added manually.

Single static Go binary, no database server, no Node build step. Runs
locally; there is no built-in authentication, so don't expose it to the
internet as-is.

## Status

Early / untested against a real Nitrado account and real game servers —
built and smoke-tested locally, but not yet run against production
servers. Treat as a working prototype.

## Features

- **Manual servers** — add any Source-RCON server by host, port, and
  password.
- **Nitrado account sync** — paste a Nitrado API token, and NiCon fetches
  your services and adds one entry per server whose current game has RCON
  enabled (`game_specific.features.has_rcon`). Nitrado's API doesn't expose
  the RCON password itself, so that's still entered manually, once, per
  server.
- **Console** — a simple command/response view per server, backed by a
  pooled RCON connection (reconnects once automatically if the connection
  drops).

## Running

```sh
go build -o nicon .
./nicon                       # listens on :8080, data in ./nicon.db
./nicon -addr :9000 -db /path/to/nicon.db
```

Then open `http://localhost:8080`.

## Data & secrets

Everything (server list, RCON passwords, the Nitrado API token) is stored
**unencrypted** in the local `bbolt` database file (`nicon.db` by default).
Anyone with filesystem access to that file, or network access to the web
UI, can read them. This is a known limitation, not a hidden one — don't
run NiCon on a shared or internet-facing host without adding your own
auth/encryption layer in front of it.

## Architecture

- `internal/store` — bbolt-backed persistence (servers, Nitrado token)
- `internal/nitrado` — minimal Nitrado API client (list services, fetch a
  service's live gameserver data including `rcon_port` and `has_rcon`)
- `internal/rconmgr` — one pooled RCON connection per server
  ([gorcon/rcon](https://github.com/gorcon/rcon), Source RCON protocol),
  reconnects once on a failed command before giving up
- `internal/web` — HTTP handlers, `html/template` pages, and a small
  vanilla-JS console (no frontend framework/build step; everything is
  embedded into the binary via `go:embed`)

## Not implemented yet

- Windows binary packaging (`GOOS=windows GOARCH=amd64 go build` works
  today, just not automated/released anywhere yet)
- Any authentication on the web UI itself
- Encryption at rest for stored passwords/token
- Automated tests
