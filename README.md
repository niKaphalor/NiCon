# NiCon

A web UI to send RCON commands to game servers — including the ones on
your Nitrado account, and any other Source-RCON server added manually.

The UI is a static page at **https://nikaphalor.github.io/NiCon/** — no
install needed to view it. Everything behind it is split across two
pieces, because they have opposite hosting requirements:

- **[Cloud API](#cloud-api-webspace)** (`webspace/`, plain PHP) — accounts,
  sign-in, and your server list. Runs on ordinary always-on web hosting
  (shared webspace is enough), so it's reachable whether or not your own
  computer is on.
- **[Relay](#relay)** (Go binary, this repo's root) — the actual
  WebSocket↔RCON bridge. This is the one part that genuinely needs a
  persistent local process (browsers can't open raw TCP or WebRCON sockets
  on their own) and genuinely needs outbound access to arbitrary RCON
  ports (which most shared hosting blocks) — so it has to run somewhere
  you control, typically your own machine.

Both read/write the same MariaDB database and share one encryption key;
see [Cloud API vs. relay](#cloud-api-vs-relay) for exactly how the split
works and why.

**Your data is stored, scoped to your account only.** Server lists and
RCON passwords (encrypted at rest) are tied to the account that added
them — a user can only ever see, edit, or connect through their own
servers, enforced server-side on every request, not just hidden in the
UI. Nitrado API tokens are still never stored: each sync sends the token
once and it's forgotten immediately after.

## Status

Early / untested against a real Nitrado account and real game servers —
built and smoke-tested locally (including an end-to-end test against a mock
Source RCON server and against a real local MariaDB with multiple test
accounts), but not yet run against production servers. Treat as a working
prototype.

## Using it

1. Open **https://nikaphalor.github.io/NiCon/**.
2. Set up the [Cloud API](#cloud-api-webspace) somewhere always-on (once,
   not per session) and the [relay](#relay) locally, both pointed at the
   same MariaDB database. The topbar shows two status pills — **API** and
   **relay** — each green once reachable; open either (or the ⚙ next to
   them) to change its address if you're not using the defaults.
3. Sign in, or create an account yourself (see
   [User accounts](#user-accounts)) — registration asks you to confirm
   you've read the [privacy policy](docs/privacy.html) first. This, and
   everything through step 4, only needs the **API** to be reachable — the
   relay isn't involved yet.
4. Click **+ Add server**: sync from a Nitrado API token (adds every
   server whose current game has RCON enabled; the RCON password itself
   isn't in Nitrado's API response, so add it inline on the server card
   before connecting), or add one manually. Servers you add belong to your
   account only.
5. Click **Connect** on a server to open its console — this is the one
   action that needs the **relay** running. Click **Players** there for a
   structured player list, for the games NiCon knows how to parse (see
   [games.js](docs/games.js)).

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

## Cloud API vs. relay

NiCon used to be one Go binary doing everything. It's now split in two,
because "everything" turned out to need two incompatible hosting
environments at once:

- Accounts, sign-in, and the server list are just CRUD over HTTP — no
  reason they need a process that's always running on hardware you
  personally control. They belong on ordinary web hosting, reachable
  around the clock whether or not your computer is on.
- Actually *speaking RCON* to a game server needs a real, persistent
  process (to hold a WebSocket open and translate it to raw TCP or
  WebRCON) with unrestricted outbound access to arbitrary ports — which
  is exactly what typical shared hosting **doesn't** allow (confirmed by
  testing: a shared webspace can reach normal HTTPS APIs fine, but a raw
  TCP connection to an RCON port gets refused at the host firewall
  instantly). That part has to run somewhere you control — your own
  machine, most likely.

So: **[webspace/](webspace/)**, a small dependency-free PHP API, handles
the first half and is meant to live on exactly the kind of shared hosting
that can't run RCON itself. The **Go relay** (this repo's root) handles
only the second half now. Both talk to the *same* MariaDB database and
must be configured with the *same* `NICON_ENCRYPTION_KEY` — that's the
entire integration between them; neither calls the other directly. A
server's RCON password is encrypted by whichever side writes it (almost
always the PHP API, since that's where `POST /api/servers` and
`PUT /api/servers/{id}/password` live now) and decrypted by the relay
right before it dials the game server. See `webspace/lib/crypto.php`'s
top comment for the exact byte layout that keeps the two sides compatible
(PHP's `openssl_encrypt`/AES-256-GCM output has to line up with Go's
`cipher.AEAD.Seal`, nonce and tag placement included).

If you don't have separate always-on hosting and don't need one, you can
run just the relay pointed at a local MariaDB — everything worked that
way for a while (see the commit history) — but there's no PHP fallback in
that mode; you'd need to also keep the relay running whenever you want to
sign in or manage servers, which somewhat defeats the point of the split.

## Cloud API (`webspace/`)

Plain PHP (no framework, no Composer, no build step — matches `docs/`'s
philosophy) meant to be uploaded as-is via FTP or your host's file
manager. Needs PHP with the `pdo_mysql` and `openssl` extensions (both
essentially universal on PHP hosting) and a MariaDB/MySQL database —
either one your host gives you directly (typical shared webspace) or a
remotely-reachable one elsewhere.

```sh
# One-time setup, once you have DB credentials from your host:
mysql -h <host> -u <user> -p <database> < webspace/schema.sql
cp webspace/config.example.php webspace/config.local.php
# edit config.local.php: db_dsn/db_user/db_pass, encryption_key_base64
# (generate with `nicon-relay genkey` — must match the relay's key
# exactly), and allowed_origins.
```

Then upload the whole `webspace/` directory to your hosting (e.g. into a
`nicon-api` subfolder of your webroot) and point your DNS/domain at it as
usual — whatever your host's normal deployment process is. `webspace/api/`
is the only part that needs to be reachable at a stable URL; everything
under `webspace/lib/` and `webspace/handlers/` is included by
`webspace/api/index.php`, never requested directly (each directory has
its own `.htaccess` denying direct access, as defense in depth — none of
those files execute anything at the top level anyway, so there's nothing
to disclose even without it).

`config.local.php` is gitignored — it holds your database password and
the encryption key, never commit it. `schema.sql` is the same table
definitions `internal/store` creates automatically; running it by hand
here is only needed if you're setting the database up fresh through this
API before the Go relay has ever connected to it (the relay's own
auto-migration is equally fine as a one-time setup step, if you'd rather
do it that way).

**Already had accounts in a local database from before this split?**
Either path works:

- **Fresh start** — leave the old data where it is, run `schema.sql`
  against the new database, and re-create accounts there (`adduser` etc.
  — see [User accounts](#user-accounts)). Simplest if it's just a couple
  of test accounts.
- **Migrate** — dump and restore the existing tables into the new
  database (ordinary `mysqldump`/`mysql`, or your hosting panel's
  import tool if it only takes file uploads):
  ```sh
  mysqldump -h <old-host> -u <old-user> -p <old-database> \
    users sessions servers > nicon-data.sql
  mysql -h <new-host> -u <new-user> -p <new-database> < nicon-data.sql
  ```
  Do this *before* pointing the relay and this API at the new database,
  and use the exact same `NICON_ENCRYPTION_KEY` on both sides afterward —
  the encrypted RCON passwords in `servers.password_enc` only decrypt
  with the key that encrypted them, so an existing account's servers
  would otherwise show as present but undecryptable.

Once deployed, it serves the same JSON API the relay used to (except
`/ws/rcon`, which stays with the relay — see below):

- **Auth** (`POST /login`, `POST /logout`, `POST /register`,
  `POST /reset-password`, `DELETE /account`): login exchanges a
  username/password (bcrypt-hashed at rest) for a session token, which the
  frontend then sends as `Authorization: Bearer <token>` on every other
  API request and as the WebSocket's first message to the relay. Tokens
  live 7 days server-side (a `sessions` row with an expiry) and are stored
  in the browser's `sessionStorage`, not `localStorage`, so they don't
  outlive the tab. Register is the same, minus an existing account — it
  also requires `consent_accepted: true` (the frontend's required
  privacy-policy checkbox) and rejects a taken username with 409.
  Registration also generates a **recovery code** (20 random characters,
  shown to the user exactly once, only its bcrypt hash stored) — with no
  email address on file, it's the only way back into an account whose
  password is forgotten. `POST /reset-password` takes a username, that
  recovery code, and a new password; on success it rotates in a fresh
  recovery code (the old one is single-use, like a 2FA backup code) and
  invalidates every existing session for the account, in case the old
  password had leaked. A wrong username and a wrong recovery code return
  the identical error, so the endpoint can't be used to check which
  usernames exist. `/register` and `/reset-password` are each
  rate-limited per client IP (register: 3 per 15-minute window; reset: 2
  per 15-minute window — a fixed-window counter in the `rate_limits`
  table, not a smooth token bucket like the old in-process Go limiter
  was, since PHP requests are stateless between calls; good enough to
  make spamming accounts or brute-forcing a recovery code impractical, not
  perfectly smooth traffic shaping) — a request over the limit gets 429
  with a `Retry-After` header. The limiter only ever sees
  `$_SERVER['REMOTE_ADDR']`, never an `X-Forwarded-For` header, so it's
  not meaningful if you put this behind a reverse proxy without teaching
  it to trust that header. Account deletion removes the user row;
  `sessions` and `servers` cascade-delete with it at the database level
  (`ON DELETE CASCADE`), so there's nothing left to clean up separately.
- **Per-user server storage** (`GET/POST /servers`,
  `PUT /servers/{id}/password`, `DELETE /servers/{id}`,
  `POST /nitrado/sync`): every query is scoped to the authenticated user's
  `user_id` in SQL — that's the actual access control, not a UI filter.
  Asking for another user's server by ID gets the same "not found"
  response as asking for one that doesn't exist at all, so the API
  doesn't even reveal that it exists. RCON passwords are encrypted with
  AES-256-GCM before being written to the `servers` table and are never
  sent back to the browser once set (`has_password: true/false` only) —
  the frontend only ever supplies a new one to overwrite the old one.
- **Nitrado API proxy**, as part of `/nitrado/sync`: takes
  `{"token": "..."}`, calls the Nitrado API server-side over HTTPS (an
  ordinary outbound web request, which shared hosting handles fine — see
  [Cloud API vs. relay](#cloud-api-vs-relay) above for what it *can't*
  do), and upserts each RCON-capable service into the caller's own server
  list (matched on Nitrado's service ID, so re-syncing updates rather
  than duplicates, and never touches an already-set password). Rust
  services are included even though Nitrado's `has_rcon` flag apparently
  doesn't cover WebRCON — any service whose game is Rust is treated as
  eligible on host/port alone. The token itself is used for that one
  request and then forgotten.
- **Admin** (`GET /admin/users`, `DELETE /admin/users/{id}`,
  `POST /admin/users/{id}/recovery-code`): each checks the authenticated
  caller's own `is_admin` flag before doing anything, on top of the usual
  session check — a regular account gets 403, not just a UI that happens
  to hide the button. Listing returns only username/created-at/role/
  server-count per account, never password or recovery-code hashes, or
  any of that account's server details.

Only origins in `config.local.php`'s `allowed_origins` get
`Access-Control-Allow-Origin` back — without that check, any other page
open in your browser could otherwise talk to this API. On top of that,
everything except `/healthz`, `/login`, and `/register` requires a valid
session token, so a stolen/guessed origin alone isn't enough to reach
anyone's account or servers.

## Relay

The relay's only remaining job is the WebSocket↔RCON bridge — everything
else moved to the [Cloud API](#cloud-api-webspace) above. It needs the
same MariaDB database and encryption key as that API (read-only, in this
case: it only ever looks up a session or a server row, never writes one).

```sh
go build -o nicon-relay .
export NICON_DB_DSN="nicon:<db-password>@tcp(<host>:3306)/nicon?parseTime=true"
export NICON_ENCRYPTION_KEY="<same key as the Cloud API's config.local.php>"
./nicon-relay                                    # listens on localhost:8765
./nicon-relay -addr localhost:9000 -allow-origin "https://nikaphalor.github.io,http://localhost:9000"
```

`GET /ws/rcon` is its only real endpoint (`/healthz` exists too, for the
frontend's relay-status pill). The browser first sends
`{"type":"auth", token}` — the same session token the Cloud API issued;
once the relay replies `{"type":"authenticated"}`, it can send
`{"type":"connect", server_id}` then any number of
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

Only origins in `-allow-origin` (default: the GitHub Pages URL plus
`localhost:8765`) can open that WebSocket at all — without that check, any
other page open in your browser could otherwise talk to `localhost:8765`
directly.

The relay binary is also still how you manage accounts from the command
line — see [User accounts](#user-accounts) and [Admin panel](#admin-panel)
below. Those subcommands talk to the database directly (not through the
Cloud API), so they work the same way regardless of which machine you run
them from, as long as `-db-dsn`/`-encryption-key` point at the right
database.

## User accounts

Anyone who can reach the frontend can create their own account from the
**Create one** link on the sign-in screen — registration is open by
default. Signing up requires a username (3–32 characters), a password (min
8 characters), and checking a box confirming the
[privacy policy](docs/privacy.html) has been read; it logs you in
immediately afterward. An account can delete itself at any time from
**Settings → Delete account** — this permanently removes the account and
every server it added, RCON passwords included (there is no "soft delete"
or recovery).

Whoever operates the Cloud API and relay can also create accounts
directly, from the command line, without going through the registration
page — the relay binary's account subcommands talk to the database
directly, so run them from wherever's convenient as long as they're
pointed at the right database:

```sh
./nicon-relay adduser <username>    # prompts for a password (min 8 chars), twice
```

`adduser` also generates and prints a recovery code, same as self-service
registration does — hand it to whoever the account is for, so they have
the same self-service password-reset path either way. If an existing
account ever needs a new one (lost, or predates this feature —
`recovery_code_hash` starts out `NULL` for accounts created before it
shipped), regenerate it without touching their password:

```sh
./nicon-relay gen-recovery-code <username>
```

Each account's server list is completely separate; there's no sharing
between accounts (see [Not implemented yet](#not-implemented-yet)). Open
registration means anyone who reaches the frontend can create an account
through your Cloud API and store their own RCON credentials in your
database — still only run this for people you're comfortable with that
(see [Legal pages](#legal-pages) below for what to do about the
accompanying imprint/privacy policy before operating this for real
users).

## Admin panel

One or more accounts can be flagged as admin — visible as an **Admin**
link next to their username once logged in, leading to a panel (served by
the Cloud API) listing every account on this NiCon instance (username,
created date, server count, role), with two actions per row:
**regenerate their recovery code** (if they've lost it and can't reach
you to run `gen-recovery-code` yourself) and **delete their account**
(same cascading deletion as the self-service path, just triggered by an
admin instead of the account holder).

There's no HTTP endpoint that can grant admin status — the only way to
create the first admin (or any other) is from the command line, by
someone who already has operator-level access to the database:

```sh
./nicon-relay setadmin <username>            # grant
./nicon-relay setadmin -revoke <username>    # revoke
```

This is deliberate: self-registration is open to anyone who reaches the
frontend, so admin promotion staying CLI-only means a bug in the web API
can't be used to self-promote to admin.

## Legal pages

`docs/imprint.html` and `docs/privacy.html` are included so a self-hosted
NiCon instance has somewhere to point users for German TMG/DSGVO
requirements (legal notice + privacy policy), linked from the footer, the
registration form, and the servers view. Each has a German sibling file
(`imprint.de.html`, `privacy.de.html`) with a small EN/DE switcher at the
top — see [Language](#language) below for how the pair is chosen. **Both
currently contain placeholder data** ("Max Mustermann", `kontakt@example.com`,
etc.), clearly marked as such in the page text — replace them (in both
languages) with your own real details before letting anyone but yourself
register. The privacy policy documents what NiCon actually stores
(username, bcrypt password hash, RCON server data with the password
encrypted at rest, a session token in `sessionStorage`) and how to
exercise the self-service deletion described above; adjust its wording if
you fork NiCon and change what's collected.

## Language

The frontend ships in English and German today, switchable from the `EN
· DE` dropdown in the topbar. There's no build step or server-side
rendering involved — `docs/i18n.js` holds one flat dictionary per
language, applied to the DOM at load (and again on switch) via
`data-i18n`/`-placeholder`/`-aria-label`/`-title` attributes in
`index.html`, and the choice is remembered in `localStorage` (falling back
to the browser's own language on first visit, then English). The legal
pages aren't part of that dictionary — they're long-form prose, so each
one is a separate file per language (`imprint.html`/`imprint.de.html`,
`privacy.html`/`privacy.de.html`) with its own tiny switcher, and the
in-app links to them pick the file matching the active UI language
automatically.

Adding a language means adding one object to the `dict` in
`docs/i18n.js`, one `<option>` to `#lang-select` in `index.html`, and — if
you want the legal pages translated too — an `imprint.<code>.html` /
`privacy.<code>.html` pair. Per-game player-list parsing
(`docs/games.js`) and error messages returned by the Cloud API/relay are
not localized yet; both stay in English regardless of the selected UI
language.

## Architecture

- `internal/nitrado` — minimal Nitrado API client (list services, fetch a
  service's live gameserver data including `rcon_port` and `has_rcon`) —
  used by the Go relay's build only; `webspace/`'s PHP has its own small
  Nitrado client (`handlers/nitrado_sync.php`) rather than sharing this
  one across languages
- `internal/store` — MariaDB persistence: schema auto-migration, per-user
  CRUD for servers, and AES-256-GCM encryption of RCON passwords at rest.
  Still used by the relay's CLI subcommands (`adduser`, `gen-recovery-code`,
  `setadmin`, ...) and by `internal/relay/ws.go`'s two read-only lookups
  (session, server); no longer backs any HTTP write path — those moved to
  `webspace/`
- `internal/auth` — bcrypt password hashing, session-token issuance, and
  recovery-code generation on top of `internal/store`; same scope note as
  above
- `internal/relay` — now just the WebSocket↔RCON bridge (`/ws/rcon`) plus
  `/healthz`; see [Cloud API vs. relay](#cloud-api-vs-relay)
- `webspace/` — the PHP Cloud API: accounts, registration, password
  reset, per-user server CRUD, Nitrado sync, admin panel. See
  [Cloud API (`webspace/`)](#cloud-api-webspace)
- `docs/` — the static frontend (plain HTML/CSS/vanilla JS, no framework,
  no build step), deployed to GitHub Pages by
  `.github/workflows/pages.yml`

## Testing

```sh
go test ./...
```

`internal/store` and `internal/auth` each have a test suite; a handful of
pure-logic tests (recovery code generation/formatting, bcrypt
round-tripping) always run, but most of it is integration tests against a
real MariaDB/MySQL — the schema leans on server-side features
(auto-increment, foreign keys, `ON DUPLICATE KEY UPDATE`) with no
meaningful pure-Go substitute. Those tests read their database from
`$NICON_TEST_DB_DSN` and skip cleanly if it's unset, so `go test ./...`
stays green without one. Point it at a database used for nothing else —
tests create and delete real rows there — never at a database holding
real accounts:

```sh
export NICON_TEST_DB_DSN="nicon:<password>@tcp(localhost:3306)/nicon_test?parseTime=true"
go test ./...
```

`internal/relay` has only two tests left (`/healthz` + CORS) now that its
HTTP surface shrank to that plus `/ws/rcon` — see
[Not implemented yet](#not-implemented-yet) for what still isn't
automated, including `webspace/`'s PHP, which has no test suite at all;
exercise it manually with PHP's built-in server against a test database:

```sh
cd webspace && php -S localhost:8080 -t .
```

CI runs the Go suite against a MariaDB service container
(`.github/workflows/ci.yml`) on every push; it doesn't touch `webspace/`.

## Not implemented yet

- Windows binary packaging for the relay (`GOOS=windows GOARCH=amd64 go
  build` works today, just not automated/released anywhere yet)
- Any automated tests for `webspace/`'s PHP API — it mirrors the
  behavior the old all-in-one relay's Go tests already covered, but
  nothing exercises the PHP itself yet beyond manual testing (see
  [Testing](#testing))
- Automated tests for the WebSocket/RCON bridge itself — classic RCON,
  WebRCON, and broadcast-forwarding have only been exercised manually,
  including `-race` runs, against hand-written mock servers
- The WebRCON implementation is based on Facepunch's own
  [webrcon](https://github.com/Facepunch/webrcon) tool and third-party
  documentation, not verified against a real Rust server yet
- Structured player-list parsing (`docs/games.js`) covers Minecraft, Rust,
  ARK: Survival Evolved, and Palworld, based on documented command output
  formats rather than verified live responses — see the file for details
- The [admin panel](#admin-panel) covers account management (list, delete,
  regenerate a recovery code) but nothing about server data — an admin
  can't see, edit, or connect through another account's servers, same as
  anyone else
- Sharing a server between accounts, or any notion of teams/roles — server
  ownership is strictly one account per server today
- Invite-gating on `/register` — signup is open to anyone who can reach
  the frontend (rate-limited per IP, see
  [Cloud API (`webspace/`)](#cloud-api-webspace) above, but not restricted
  to people you've invited)

## Roadmap

Accounts, servers, and RCON credentials now live in a database reachable
from always-on hosting, with self-service registration, password
recovery, and a basic admin panel on top — the "nothing is stored,
anywhere" phase is long over, and so is the "one Go binary does
everything" phase, now that the account/server API and the RCON bridge
can scale and fail independently. What's still ahead: player
profiles/history, notes, shared ban lists, scheduled/triggered commands,
and Discord webhooks, all of which build on the storage layer that's now
in place rather than requiring another architecture change.
