# NiCon

A web UI to send RCON commands to game servers — including the ones on
your Nitrado account, and any other Source-RCON server added manually.

The UI is a static page at **https://nikaphalor.github.io/NiCon/** — no
install needed to view it. To actually send RCON commands, you run a small
local relay binary alongside it (see [Relay](#relay) below): browsers can't
open raw TCP sockets, so something has to.

**Your data is stored, scoped to your account only.** Each relay operator
runs their own relay against their own MariaDB database and creates
accounts for whoever should use it (see [User accounts](#user-accounts)).
Server lists and RCON passwords (encrypted at rest) are tied to the
account that added them — a user can only ever see, edit, or connect
through their own servers, enforced server-side on every request, not
just hidden in the UI. Nitrado API tokens are still never stored: each
sync sends the token once and it's forgotten immediately after.

## Status

Early / untested against a real Nitrado account and real game servers —
built and smoke-tested locally (including an end-to-end test against a mock
Source RCON server and against a real local MariaDB with multiple test
accounts), but not yet run against production servers. Treat as a working
prototype.

## Using it

1. Open **https://nikaphalor.github.io/NiCon/**.
2. Run the relay locally (see below), pointed at your MariaDB database.
   The relay pill top-right turns green once it's reachable; open it (or
   the ⚙ next to it) to change the address if you're not using the default.
3. Sign in with an account the relay operator created for you (see
   [User accounts](#user-accounts)).
4. Click **+ Add server**: sync from a Nitrado API token (adds every
   server whose current game has RCON enabled; the RCON password itself
   isn't in Nitrado's API response, so add it inline on the server card
   before connecting), or add one manually. Servers you add belong to your
   account only.
5. Click **Connect** on a server to open its console. Click **Players**
   there for a structured player list, for the games NiCon knows how to
   parse (see [games.js](docs/games.js)).

Most games speak classic Source RCON, but **Rust doesn't** — it uses its
own WebSocket-based "WebRCON" protocol instead. NiCon detects this
automatically for servers found via Nitrado sync; for a manually-added
Rust server, pick "Rust WebRCON" in the protocol dropdown when adding it.

You can have several consoles open at once — connecting to another server
doesn't disconnect the current one, it opens another tab in the console
view. The filter box above the log accepts a regex: matching lines stay,
everything else is hidden, and the match itself is highlighted. For
WebRCON (Rust) servers, chat/log lines the game pushes on its own (not in
response to a command) show up live in the console, styled differently
from command output.

## Relay

The relay needs a MariaDB database and an encryption key (for RCON
passwords at rest) in addition to the binary itself.

```sh
go build -o nicon-relay .

# One-time setup:
mysql -u root -p -e "CREATE DATABASE nicon CHARACTER SET utf8mb4; \
  CREATE USER 'nicon'@'localhost' IDENTIFIED BY '<db-password>'; \
  GRANT ALL PRIVILEGES ON nicon.* TO 'nicon'@'localhost';"
./nicon-relay genkey                             # prints a new base64 encryption key — save it
./nicon-relay adduser alice                      # prompts for a password twice

# Run it:
export NICON_DB_DSN="nicon:<db-password>@tcp(localhost:3306)/nicon?parseTime=true"
export NICON_ENCRYPTION_KEY="<key from genkey>"
./nicon-relay                                    # listens on localhost:8765
./nicon-relay -addr localhost:9000 -allow-origin "https://nikaphalor.github.io,http://localhost:9000"
```

`-db-dsn`/`$NICON_DB_DSN` and `-encryption-key`/`$NICON_ENCRYPTION_KEY` are
required for normal server mode; the relay refuses to start without them.
Tables (`users`, `sessions`, `servers`) are created automatically on first
connect if they don't exist yet. The encryption key is used only to
encrypt/decrypt RCON passwords in the `servers` table — it is never itself
stored in the database, so losing it means every stored RCON password has
to be re-entered (server rows aren't lost, just their password field).

The relay does three things:

- **Auth** (`POST /api/login`, `POST /api/logout`): exchanges a
  username/password (bcrypt-hashed at rest) for a session token, which the
  frontend then sends as `Authorization: Bearer <token>` on every other
  request and as the first WebSocket message. Tokens live 7 days server-side
  (a `sessions` table row with an expiry) and are stored in the browser's
  `sessionStorage`, not `localStorage`, so they don't outlive the tab.
- **Per-user server storage** (`GET/POST /api/servers`,
  `PUT /api/servers/{id}/password`, `DELETE /api/servers/{id}`,
  `POST /api/nitrado/sync`): every query is scoped to the authenticated
  user's `user_id` in SQL — that's the actual access control, not a UI
  filter. Asking for another user's server by ID gets the same "not found"
  response as asking for one that doesn't exist at all, so the API doesn't
  even reveal that it exists. RCON passwords are encrypted with AES-256-GCM
  before being written to the `servers` table and are never sent back to
  the browser once set (`has_password: true/false` only) — the frontend
  only ever supplies a new one to overwrite the old one.
- **WebSocket ↔ RCON bridge** (`/ws/rcon`): the browser first sends
  `{"type":"auth", token}`; once the relay replies `{"type":"authenticated"}`,
  it can send `{"type":"connect", server_id}` then any number of
  `{"type":"command", command}` messages. The relay looks up that server's
  host/port/password/protocol itself (and confirms it belongs to the
  authenticated user) rather than trusting the client, so a compromised
  browser tab can't be pointed at an arbitrary host or reach another user's
  stored credentials by supplying a different ID. Responses come back as
  JSON (`{"type":"response", output}` / `{"type":"error", message}` /
  `{"type":"broadcast", output}` for a WebRCON server's own unsolicited push
  messages). Servers can be `"source"` (classic Source RCON via
  [gorcon/rcon](https://github.com/gorcon/rcon)) or `"webrcon"` (Rust's own
  WebSocket-based RCON, hand-rolled in `internal/relay/webrcon.go` since
  there's no existing Go client for it). The WebRCON connection also sends
  itself a WebSocket ping every 25s — Rust closes WebRCON connections it
  considers idle, and this keeps it alive without sending a bogus command
  to the game.
- **Nitrado API proxy**, as part of `/api/nitrado/sync`: takes
  `{"token": "..."}`, calls the Nitrado API server-side (so the token never
  needs to survive a browser CORS round trip on its own), and upserts each
  RCON-capable service into the caller's own server list (matched on
  Nitrado's service ID, so re-syncing updates rather than duplicates, and
  never touches an already-set password). Rust services are included even
  though Nitrado's `has_rcon` flag apparently doesn't cover WebRCON — any
  service whose game is Rust is treated as eligible on host/port alone. The
  token itself is used for that one request and then forgotten.

Only origins in `-allow-origin` (default: the GitHub Pages URL plus
`localhost:8765`) can call the relay at all — without that check, any other
page open in your browser could otherwise talk to `localhost:8765` directly.
On top of that, everything except `/healthz` and `/api/login` now requires
a valid session token, so a stolen/guessed origin alone isn't enough to
reach anyone's servers or RCON connections.

## User accounts

There's no self-service signup — whoever runs the relay creates accounts
for the people who'll use it:

```sh
./nicon-relay adduser <username>    # prompts for a password (min 8 chars), twice
```

Each account's server list is completely separate; there's no sharing or
admin override built in yet (see [Not implemented yet](#not-implemented-yet)).
Still run the relay only on a machine/network you trust the users of —
authentication protects data between accounts, not the host itself.

## Architecture

- `internal/nitrado` — minimal Nitrado API client (list services, fetch a
  service's live gameserver data including `rcon_port` and `has_rcon`)
- `internal/store` — MariaDB persistence: schema auto-migration, per-user
  CRUD for servers, and AES-256-GCM encryption of RCON passwords at rest
- `internal/auth` — bcrypt password hashing and session-token issuance/
  validation on top of `internal/store`
- `internal/relay` — HTTP API (auth, per-user server CRUD, Nitrado sync)
  and the WebSocket↔RCON bridge described above
- `docs/` — the static frontend (plain HTML/CSS/vanilla JS, no framework,
  no build step), deployed to GitHub Pages by
  `.github/workflows/pages.yml`

## Not implemented yet

- Windows binary packaging for the relay (`GOOS=windows GOARCH=amd64 go
  build` works today, just not automated/released anywhere yet)
- Automated tests (the classic RCON, WebRCON, broadcast-forwarding, and
  auth/storage paths have been exercised manually — including `-race` runs
  and live testing against a real MariaDB with multiple accounts — but
  there's no test suite yet)
- The WebRCON implementation is based on Facepunch's own
  [webrcon](https://github.com/Facepunch/webrcon) tool and third-party
  documentation, not verified against a real Rust server yet
- Structured player-list parsing (`docs/games.js`) covers Minecraft, Rust,
  ARK: Survival Evolved, and Palworld, based on documented command output
  formats rather than verified live responses — see the file for details
- Account self-service (signup, password reset, admin UI) — accounts are
  created one at a time on the relay's command line for now
- Sharing a server between accounts, or any notion of teams/roles — server
  ownership is strictly one account per server today

## Roadmap: becoming a full admin panel

The relay now runs continuously against a real database, with servers and
RCON credentials tied to individual accounts — the "nothing is stored,
anywhere" phase is over. What's still ahead: player profiles/history,
notes, shared ban lists, scheduled/triggered commands, and Discord
webhooks, all of which build on the storage layer that's now in place
rather than requiring another architecture change.
