# NiCon

A browser-based command center for game servers. NiCon combines Source RCON,
WebRCON, BattleBit WebRCON, BattlEye RCon, Palworld REST, and 7 Days to Die Telnet in one interface, imports
allow-listed Nitrado services, monitors connectivity and player history —
including a passive, unauthenticated fallback (Source's own A2S query,
Minecraft's separate Query protocol) for a server that doesn't have its
RCON password saved yet — enriches player lists
with optional Steam data, and provides moderation rules, macros, and
Nitrado power controls.

The UI is a static page at **https://nikaphalor.github.io/NiCon/** — no
install needed to view it. Everything behind it is split across two
pieces, because they have opposite hosting requirements:

- **[Cloud API](#cloud-api-webspace)** (`webspace/`, plain PHP) — accounts,
  server storage, Nitrado/Steam integrations, macros, moderation rules,
  notifications, and audit history. Runs on ordinary always-on web hosting
  (shared webspace is enough).
- **[Relay](#relay)** (Go binary, this repo's root) — the actual
  WebSocket↔RCON bridge. This is the one part that genuinely needs a
  persistent process (browsers can't open raw TCP, UDP, or WebRCON sockets
  on their own) and genuinely needs outbound access to arbitrary RCON
  ports (which most shared hosting blocks) — so it has to run somewhere
  you control, typically a local machine or cloud VM.

Both read/write the same MariaDB database and share one encryption key;
see [Cloud API vs. relay](#cloud-api-vs-relay) for exactly how the split
works and why.

**Your data is stored, scoped to your account only.** Server lists and
RCON passwords (encrypted at rest) are tied to the account that added
them — a user can only ever see, edit, or connect through their own
servers, enforced server-side on every request, not just hidden in the
UI. A Nitrado API token is stored encrypted at rest (AES-256-GCM, same
scheme as RCON passwords) the first time it's entered, so re-syncing later
doesn't require typing it in again — deletable independently of the
account itself from Settings, at any time.

## Status

NiCon is an actively developed, self-hosted application. Its selectable and
Nitrado-importable catalog is a fixed, explicitly maintained list of supported
games; games absent from it are not exposed as new integrations. The automated Go suite covers the
store, authentication, health checks, and protocol clients with test
servers. Compatibility still depends on each game's command/output format,
and the structured parsers other than Rust have not all been validated
against live public servers. The maintained
[compatibility matrix](docs/compatibility.md) separates live verification
from automated mock coverage. Review the limitations under
[Not implemented yet](#not-implemented-yet) before treating it as a
hands-off production control plane.

## Using it

1. Open **https://nikaphalor.github.io/NiCon/**.
2. Set up the [Cloud API](#cloud-api-webspace) somewhere always-on (once,
   not per session) and the [relay](#relay) locally, both pointed at the
   same MariaDB database. The topbar shows two status pills — **API** and
   **relay** — each green once reachable. Their addresses are compiled into
   `docs/app.js` (`API_URL`/`RELAY_URL`) rather than editable at runtime —
   see [Pointing the frontend at your own deployment](#pointing-the-frontend-at-your-own-deployment)
   if you're not using this repo's own hosted instance.
3. Sign in, or create an account yourself (see
   [User accounts](#user-accounts)) — registration asks you to confirm
   you've read the [privacy policy](docs/privacy.html) first. This, and
   everything through step 4, only needs the **API** to be reachable — the
   relay isn't involved yet.
4. Click **+ Add server**: sync from a Nitrado API token (adds every
   server whose current game has RCON enabled; the RCON password itself
   isn't in Nitrado's API response, so add it inline on the server card
   before connecting), or add one manually and select the game so NiCon can
   choose the matching protocol and player parser. Servers you add belong to
   your account only. Their name, address, port, game, protocol, and optional
   replacement RCON password can be edited later from the server header's
   **More actions** menu.
5. Click **Connect** on a server to open its console — this is the one
   action that needs the **relay** running. For recognized games, the
   player list is queried automatically and refreshed every 10 seconds
   (see [games.js](docs/games.js)). Nitrado servers also expose **Start**,
   **Stop**, and **Restart** controls; those go through the always-on Cloud
   API and therefore don't require the RCON relay.

7 Days to Die uses its configured **Telnet Port**, not a Source-RCON port.
Selecting the game chooses NiCon's dedicated Telnet transport automatically.
Several games use proprietary or game-specific protocol variants;
the [compatibility matrix](docs/compatibility.md) marks those as provisional
until NiCon has been tested against a disposable live server.

You can keep several consoles connected at once — selecting another server
doesn't disconnect the current one; its socket and console history remain
alive in the background for the browser session. Dropped connections
reconnect automatically with exponential
backoff; clicking **Disconnect** still keeps a console deliberately
offline. The filter box above the log accepts a regex: matching lines
stay, everything else is hidden, and the match itself is highlighted.
Scrolling upward pauses automatic tail-following until you return to the
bottom or click **Follow output**. For WebRCON (Rust) servers, chat/log
lines the game pushes on its own (not in response to a command) show up
live in the console, styled differently from command output.

The command center includes:

- a focused server header with game backdrop, status, current player count,
  endpoint, primary connection action, and separate **Overview**, **Console**,
  **Players**, and server-filtered **Audit** tabs;
- color-classified chat, warning, and error lines plus literal/regex log
  filtering and pause/resume tail-following;
- per-console shell-style history and autocomplete for known game commands;
- account-wide multi-step macros (`@wait 2` inserts a pause) and per-game
  quick actions;
- a live player list with inline Kick/Ban and a right-click menu for
  Kick/Ban/Mute/Whisper where the selected game exposes a documented
  command (unsupported actions stay disabled rather than being guessed);
- account-wide word filters that highlight matching pushed chat/log lines
  and can automatically mute or kick a matched player, with a per-rule/
  player cooldown;
- balanced, console-wide, stacked, and compact power-user layouts stored in
  `localStorage` and selected from the server action menu;
- compact Nitrado status strip with service status, players, world, and version
  (CPU, memory, and server configuration values are deliberately not shown), plus
  a public-status equivalent for any server — Nitrado-sourced or not — showing
  whatever the relay's passive A2S/Minecraft-Query sampling has recorded even
  before its RCON password is ever entered;
- official per-game icons from Nitrado's games catalog;
- official Steam header art in the supported-games overview plus a game
  backdrop for the selected server (Minecraft isn't on Steam, so it gets
  official key art and wordmark hotlinked from Mojang's and Wikipedia's own
  CDNs instead — see `games.js`); and
- optional public Steam profile, account-age, VAC, community-ban, and
  game-ban data for newly observed SteamID64 players. Steam enrichment is
  disabled unless the Cloud API has a Steam Web API key configured.

The same responsive visual system is used for authentication, server workspaces,
settings, administration, fleet health, dialogs, and every English/German
contact, imprint, and privacy page. The repository keeps the canonical `docs/`
frontend and its GitHub Pages copy in the repository root byte-identical.

Each server's **Overview** tab combines the relay's automatic five-minute
RCON checks with retained 24-hour, 7-day, 30-day, and 90-day uptime/player
graphs, sample completeness, connection time, relay overhead, and recent
client-side errors. The separate **Health** view keeps the cross-server table
for fleet-level comparison.
For uninterrupted Nitrado player history, schedule
`php webspace/cron/sample_nitrado.php` every five minutes in the hosting
control panel; the command reuses the shared 30–60-second Nitrado cache and
removes samples older than 90 days.
On Hetzner Webhosting, open **Settings → Cron Job Manager → Advanced view**
for the hosting account and add (with the actual FTP login/path):

```cron
*/5 * * * * /usr/bin/php /usr/www/users/<FTP_LOGIN>/<DEPLOY_PATH>/webspace/cron/sample_nitrado.php
```
Settings contains account/security controls, recent account activity including
cross-server RCON command outcomes, and
Nitrado-token removal. Admins additionally get account management,
instance-wide notifications, and the latest audit entries.

On browsers that expose PWA installation, **Install app** appears in the
topbar. The service worker caches only the versioned static app shell for an
offline startup; API responses and console traffic are never cached. A newly
deployed worker waits until NiCon offers **Update now**, then activates and
reloads once, so code is not swapped underneath an active console session.

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

The current frontend always needs both services: the PHP API for sign-in
and application data, and the relay for live game-server connections.
Running only the relay is not a supported complete deployment.

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
# exactly), allowed_origins, and optionally steam_api_key for player
# profile/ban enrichment.
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
the encryption key, never commit it. Its `.htaccess` (alongside
`schema.sql`'s own) also denies it direct web access at the server level,
on top of that — a defense-in-depth pairing with `webspace/api/`'s
document root being the only thing your host's vhost/DNS actually needs
to expose. No `config.local.php` on disk at all (e.g. a container image
built from this repo) falls back to reading
`NICON_DB_DSN`/`NICON_DB_USER`/`NICON_DB_PASS`/`NICON_ENCRYPTION_KEY`/
`NICON_ALLOWED_ORIGINS` environment variables instead — meant for local
testing with PHP's built-in server (`php -S`, where env vars are simpler
to set than a file), not a substitute for `config.local.php` on ordinary
shared hosting. `schema.sql` covers the same tables
`internal/store` creates automatically, plus a few PHP-only additions
(`rate_limits`, `notifications`, `command_templates`, `moderation_rules`,
`audit_log`, the short-lived shared `nitrado_cache`, and a
`nitrado_token_enc` column on `users`) that the Go
relay's own auto-migration doesn't know about and never creates. Run it
once regardless of which side connects to this
database first — every statement in it is safe to run again later,
including against a `users`/`sessions`/`servers` set the Go relay already
created (it won't touch existing data, only add what's missing). Skipping
it because "the relay already migrated the schema" leaves the PHP-only
pieces missing, and register/reset-password/contact (needs
`rate_limits`), notifications, and Nitrado sync/account (needs
`nitrado_token_enc`) then fail with a database error until it's run.

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

- **Auth and account** (`POST /login`, `POST /logout`, `POST /register`,
  `POST /reset-password`, `GET/DELETE /account`, `PUT
  /account/password`, `PUT /account/username`, `DELETE
  /account/nitrado-token`): login exchanges a
  username/password (bcrypt-hashed at rest) for a session token, which the
  frontend then sends as `Authorization: Bearer <token>` on every other
  API request and as the WebSocket's first message to the relay. A
  nonexistent username still runs a bcrypt comparison against a fixed
  dummy hash before failing, so a wrong-username response takes about the
  same time as a wrong-password one — timing alone can't be used to probe
  which usernames exist. `/login` is rate-limited two ways at once: 20 per
  15-minute window per client IP (caps how many different accounts one IP
  can try), and separately 10 per 15-minute window per IP+username pair
  (caps repeated guesses against one specific account from that IP). Note
  what this doesn't cover: a slow, distributed guess against one account
  spread across many IPs isn't caught by either counter, since each IP
  gets its own share of both limits. Tokens
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
  it to trust that header. `PUT /account/password` and
  `PUT /account/username` both require the account's *current* password
  in the request body (not just a valid session) before making the
  change, and share one rate limit (10 per 15-minute window per account).
  Account deletion removes the user row;
  `sessions` and `servers` cascade-delete with it at the database level
  (`ON DELETE CASCADE`), so there's nothing left to clean up separately.
- **Per-user server storage** (`GET/POST /servers`, `PUT /servers/{id}`,
  `PUT /servers/{id}/password`, `DELETE /servers/{id}`,
  `POST /servers/{id}/nitrado-power`, `GET
  /servers/{id}/nitrado-status`, `POST /nitrado/sync`,
  `GET /servers/{id}/health-history`, `POST /servers/{id}/player-sample`):
  every query
  is scoped to the authenticated user's
  `user_id` in SQL — that's the actual access control, not a UI filter.
  Asking for another user's server by ID gets the same "not found"
  response as asking for one that doesn't exist at all, so the API
  doesn't even reveal that it exists. RCON passwords are encrypted with
  AES-256-GCM before being written to the `servers` table and are never
  sent back to the browser once set (`has_password: true/false` only) —
  the frontend only ever supplies a new one to overwrite the old one.
  `PUT /servers/{id}` edits name/host/port/protocol/game (not the
  password — that's the dedicated endpoint above); both it and
  `POST /servers` reject a `host` that is, or (via a DNS lookup) resolves
  to, a well-known cloud provider's instance-metadata endpoint —
  `169.254.169.254` (AWS/GCP/Azure/DigitalOcean/Oracle Cloud),
  `169.254.170.2` (AWS ECS tasks), `fd00:ec2::254` (AWS IMDSv2 over IPv6),
  `100.100.100.200` (Alibaba Cloud), or `metadata.google.internal` — an
  SSRF guard against a manually-added "RCON server" leaking those
  endpoints' unauthenticated cloud credentials back through the relay's
  otherwise-legitimate host/port passthrough. This is a convenience
  check, not the authoritative one (a hostname could re-resolve
  differently by the time the relay itself connects later): the relay's
  own `isBlockedMetadataHost` (`internal/relay/ws.go`) re-checks the same
  list immediately before dialing. Deliberately not blocked: localhost
  and private/LAN addresses, since a locally hosted game server is the
  documented primary use case. The game itself must be one of NiCon's
  explicitly allow-listed supported games (empty is allowed, for a plain
  unparsed console). `GET /servers/{id}/health-history` (`range` one of
  `24h`/`7d`/`30d`/`90d`) returns per-sample online/latency/player data
  plus aggregate uptime%, sample completeness%, and average/peak players
  — fed by the relay's own RCON health check, the Nitrado sampling cron,
  the relay's passive A2S/Minecraft-Query loop (see [Relay](#relay)), and
  `POST /servers/{id}/player-sample` itself, which lets the frontend
  report a live client-observed count (rate-limited to once per 4 minutes
  per server) — this is how the Nitrado status strip's polling also feeds
  the same history graphs.
- **Nitrado API proxy**, used by `/nitrado/sync` and the power endpoint:
  sync takes
  `{"token": "..."}`, calls the Nitrado API server-side over HTTPS (an
  ordinary outbound web request, which shared hosting handles fine — see
  [Cloud API vs. relay](#cloud-api-vs-relay) above for what it *can't*
  do), and upserts each RCON-capable service whose current game is on NiCon's
  supported-game list into the caller's own server list (matched on
  Nitrado's service ID, so re-syncing updates rather than duplicates, and
  never touches an already-set password). 7 Days to Die is accepted when
  Nitrado supplies its Telnet port even if the generic `has_rcon` flag is
  false. A token sent in the request body is saved
  encrypted (overwriting whatever was saved before) and reused on any
  later sync that omits one — see [User accounts](#user-accounts) and
  `DELETE /account/nitrado-token` for removing a saved token without
  deleting the account. `POST /servers/{id}/nitrado-power` accepts
  `start`, `stop`, or `restart`, is limited to owned Nitrado-backed
  servers, is rate-limited to ten requests per minute per user/server,
  and records successful actions in the audit log.
  Nitrado GET responses use a database-backed cache shared by every PHP
  worker. It is scoped by a keyed token hash plus request path, defaults to
  45 seconds, is clamped to 30-60 seconds, and is invalidated immediately
  after a successful start/stop/restart, token replacement/removal, or
  account deletion. Set
  `nitrado_cache_ttl_seconds` in `config.local.php` to select another value
  in that range.
- **Command center data** (`GET/POST /command-templates`, `DELETE
  /command-templates/{id}`, `GET/POST /moderation-rules`, `DELETE
  /moderation-rules/{id}`): macros and word-filter actions are stored per
  account, capped at 50 of each. A macro remains a literal, bounded command
  sequence interpreted
  by the frontend; it never executes on the PHP host. A moderation rule's
  match pattern is capped at 128 characters and its action is exactly one
  of `highlight`/`mute`/`kick` — there's no enable/disable toggle, only
  create and delete, so pausing one without losing its pattern isn't
  possible today.
- **Steam enrichment** (`POST /steam/players`): accepts at most 100
  SteamID64 values matching Steam's fixed 64-bit ID format
  (`7656119` + 10 digits), is rate-limited to 30 requests per 60 seconds
  per account, and calls Valve's
  `GetPlayerSummaries` and `GetPlayerBans` endpoints with the server-side
  `steam_api_key` (Valve's own response is capped to 2 MiB read). The key
  is never sent to the browser and returned Steam
  data is not persisted by NiCon.
- **Activity and notifications** (`GET /audit-log`, `GET /notifications`):
  users see their latest relevant security/account actions and active
  instance notices, each typed as exactly one of `info`/`success`/
  `warning`/`error` (styled accordingly in the UI). Notification
  dismissal is browser-local. Admin-only
  endpoints create/delete notices and expose the latest instance-wide
  audit records, including the recorded request IP address, cross-server RCON
  commands, player targets, outcomes, and latency. Automatic player-list
  polling is excluded; manual commands, quick actions, macro steps, player
  actions, and automatic moderation are retained. Entries are
  retained for 180 days by default and deleted on the next audit write/read
  after expiry; `audit_retention_days` can set a policy between 30 and 3650
  days.
- **Admin** (`GET /admin/users`, `DELETE /admin/users/{id}`,
  `POST /admin/users/{id}/recovery-code`): each checks the authenticated
  caller's own `is_admin` flag before doing anything, on top of the usual
  session check — a regular account gets 403, not just a UI that happens
  to hide the button. Listing returns only username/created-at/role/
  server-count per account, never password or recovery-code hashes, or
  any of that account's server details. Deleting the instance's last
  remaining admin account is refused — there's no HTTP way to grant admin
  (see [Admin panel](#admin-panel) below), so losing the last one would
  need command-line database access to recover from.
- **Contact form** (`POST /contact`): no login required — this is the
  page people reach before they have an account, or don't want one. Takes
  `{name, email, message}` and sends it as an email to the operator's own
  address (hardcoded in `handlers/contact.php`, not per-instance
  configurable yet) via PHP's `mail()`, with `Reply-To` set to the
  submitter's address so replying just works. A hidden `website` field is
  a honeypot — a bot that fills it in gets a fake `{"ok": true}` back
  with no email actually sent, so it has no signal to learn from; rate
  limited the same way as `/register` (3 per 15-minute window).

Only origins in `config.local.php`'s `allowed_origins` get
`Access-Control-Allow-Origin` back — without that check, any other page
open in your browser could otherwise talk to this API. On top of that,
all account/application endpoints require a valid session token. The
intentional public exceptions are `/healthz`, `/login`, `/register`,
`/reset-password`, and `/contact`; the mutating public endpoints are
rate-limited.

## Relay

The relay's main job is the WebSocket↔game-server bridge — everything else
moved to the [Cloud API](#cloud-api-webspace) above. It needs the same
MariaDB database and encryption key as that API. Live WebSocket requests
only read sessions and server credentials, while the relay's background
health loop performs a real authenticated connection check every five
minutes and writes `health_*` results back to the server row.

A second, independent loop on the same five-minute interval probes every
server whose separate public-query configuration is enabled — no RCON
password required, so it also covers servers that don't have one saved
yet. `query_protocol` supports `auto`, `a2s`, `minecraft`, and `disabled`;
`query_port` can differ from the RCON port. `auto` preserves the legacy
behaviour (A2S for Source RCON, Minecraft Query for Minecraft) without
guessing support for other transports. Source-engine servers answer Valve's A2S_INFO query
(`internal/relay/a2s.go`) on their game UDP port with no configuration
needed (Steam's server browser depends on it being open); Minecraft
answers its own, unrelated GameSpy4-derived Query protocol instead
(`internal/relay/minecraft_query.go`), which a server operator has to
opt into (`enable-query=true` in `server.properties` — off by default).
Either way, a successful probe's player counts land in the same
`server_health_samples` table (`source` `"a2s"`/`"mcquery"`) the Cloud
API already aggregates into `players_average`/`players_peak` for the
Overview tab. WebRCON and BattlEye profiles can now explicitly use A2S as
well, independently from their authenticated control protocol. The add/edit
forms include a direct query test; Nitrado sync imports an explicitly reported
query/game port when available and never derives one using a port offset.

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
JSON (`{"type":"response", output, upstream_ms, relay_overhead_ms}` /
`{"type":"error", message}` /
`{"type":"broadcast", output}` for a WebRCON/BattlEye server's own
unsolicited push messages). Servers can be `"source"` (classic Source
RCON via [gorcon/rcon](https://github.com/gorcon/rcon)), `"battlebit"`
(BattleBit's Community API WebSocket protocol), `"telnet"`
(7 Days to Die), `"battleye"` (BattlEye-compatible UDP RCon), `"webrcon"`
(Rust), or `"palworld_rest"` (Palworld's supported REST API).
The WebRCON connection also sends itself a WebSocket ping every 25s —
Rust closes WebRCON connections it considers idle, and this keeps it
alive without sending a bogus command to the game.

Every executed command is logged with `upstream_ms` and
`relay_overhead_ms`, and both values are returned to the browser. The
former is time spent waiting inside the selected game protocol; the latter
is relay-local processing from decoded command to response hand-off,
excluding that upstream wait and excluding browser/Internet transit. The
performance objective is **p95 relay overhead ≤50 ms** at the intended
deployment load — not a 50 ms total Internet round trip. The Health view
shows the browser round trip and both available components separately.
The normative definition and controlled parallel-load acceptance test are in
[docs/requirements.md](docs/requirements.md).

**`"palworld_rest"`** exists because Pocketpair deprecated Palworld's RCON
support in favor of a REST API (plain HTTP + JSON, HTTP Basic auth with
username `admin` and the server's admin password, default port `8212`,
enabled in the server's own config with `RESTAPIEnabled=True`). It isn't a
free-text console like the other two protocols, so
`internal/relay/palworld_rest.go` parses the `command` string as
`<verb> [args]` and maps it to one specific endpoint:
`players`, `info`, `announce <message>`, `kick <userid> [message]`,
`ban <userid> [message]`, `unban <userid>`, `save`, `shutdown [seconds]
[message]`, `stop`. Anything else comes back as an error rather than
silently doing nothing. `docs/games.js`'s `palworld` entry sends `players`
and parses the JSON response the same way it parses Rust's WebRCON
`playerlist` JSON. Nitrado sync (`webspace/handlers/nitrado_sync.php`)
assigns this protocol automatically for Palworld services, independent
of Nitrado's `has_rcon` flag (which may already be `false` now that
RCON is being phased out). Nitrado's API has no dedicated field for the
REST API's port, so this uses the reported `rcon_port + 1` — confirmed
against a real Nitrado Palworld service, not officially documented by
Nitrado, so worth double-checking if a sync ever gets it wrong.

**`"battleye"`** speaks [BattlEye's RCon
protocol](https://www.battleye.com/downloads/BERConProtocol.txt), used by
Arma 2, Arma 3, Arma Reforger, and DayZ — a UDP protocol, not TCP, with
CRC32-checked packets and no
delivery guarantee, unlike everything else the relay speaks. Long
responses arrive split across several packets that
`internal/relay/battleye.go` reassembles by sequence number; the server
also pushes unsolicited "server message" packets (player connects,
chat) that must be ACKed immediately or BattlEye drops the client —
those surface as `{"type":"broadcast"}` the same way WebRCON's are. Unit
tests (`internal/relay/battleye_test.go`) exercise the framing,
reassembly, and ACK behavior against a fake UDP server, including under
`-race`, but the implementation hasn't been checked against a live server
for any of these four games yet. Nitrado sync detects their canonical names
and assigns this protocol automatically.

Only origins in `-allow-origin` (default: the GitHub Pages URL plus
`localhost:8765`) can open that WebSocket at all — without that check, any
other page open in your browser could otherwise talk to `localhost:8765`
directly. A single account can also only hold 20 concurrent `/ws/rcon`
connections open at once (across every server and browser tab combined) —
a cap against one compromised or runaway client exhausting the relay's
own connection pool, not a limit anyone doing normal multi-console work
should ever hit.

The relay binary is also still how you manage accounts from the command
line — see [User accounts](#user-accounts) and [Admin panel](#admin-panel)
below. Those subcommands talk to the database directly (not through the
Cloud API), so they work the same way regardless of which machine you run
them from, as long as `-db-dsn`/`-encryption-key` point at the right
database.

### Running the relay in Docker (e.g. on a cloud VM)

The relay doesn't have to run on your own machine — an always-on VM (a
cloud provider's free tier works fine, since the relay is tiny and mostly
idle) is a reasonable place for it too. Two things are different from a
local run, though:

- **It needs TLS.** The frontend is served over `https://`, and a page
  loaded over `https://` may only open a *secure* WebSocket (`wss://`) to
  anything other than `localhost` — browsers block a plain `ws://`
  connection to a public host as mixed content. `docker-compose.yml` runs
  [Caddy](https://caddyserver.com/) in front of the relay for exactly
  this: it gets a Let's Encrypt certificate automatically and proxies
  straight through (WebSocket included, no extra config needed).
- **Its port(s) need to be reachable from the internet** — both `80` and
  `443` (Caddy needs `80` for the ACME HTTP challenge, then serves on
  `443`), through whatever firewall(s) sit in front of the VM. Cloud
  providers commonly filter inbound traffic in *two* places — a
  cloud-level firewall/security-group **and** the VM's own OS firewall
  (`iptables`/`ufw`/`firewalld`) — and both need the rule, not just one.

Setup, once Docker (with the `compose` plugin) is installed and you've
cloned this repo onto the VM:

```sh
cp .env.example .env
# edit .env: NICON_DB_DSN, NICON_ENCRYPTION_KEY (same as the Cloud API's
# config.local.php), and RELAY_DOMAIN — a hostname that resolves to this
# VM's public IP. No domain of your own? relay.<public-ip>.sslip.io
# resolves to <public-ip> for free, no setup, and works fine with Caddy.

docker compose up -d --build
docker compose logs -f caddy   # first run: watch it obtain the certificate
```

Once it's up, `https://<RELAY_DOMAIN>/healthz` should return `ok`. See
[Pointing the frontend at your own deployment](#pointing-the-frontend-at-your-own-deployment)
for wiring that address into the frontend.

## Pointing the frontend at your own deployment

`docs/app.js` compiles in the Cloud API and relay addresses as constants
(`API_URL`, `RELAY_URL` near the top of the file) rather than reading them
from a runtime Settings field — earlier versions of this README described
an editable "Relay address" field in Settings, but the frontend redesign
removed it in favor of these two constants. If you're running your own
Cloud API and/or relay instead of this repo's own hosted instance, edit
those two constants to point at them (`RELAY_URL` should be the plain
`https://` address — `docs/app.js` derives the `wss://` WebSocket URL from
it automatically, same as it always did) and redeploy `docs/` — GitHub
Pages serves whatever's committed there, so there's no way to point one
person's browser at a different backend than another's without a rebuild.
The `Content-Security-Policy` meta tag in `docs/index.html` names both
addresses explicitly in `connect-src`; update it to match if you change
either constant, or the frontend's own requests to your backend will be
blocked by the browser.

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
link once logged in, leading to a panel (served by the Cloud API) listing
every account on this NiCon instance (username, created date, server count,
role), with two actions per row:
**regenerate their recovery code** (if they've lost it and can't reach
you to run `gen-recovery-code` yourself) and **delete their account**
(same cascading deletion as the self-service path, just triggered by an
admin instead of the account holder). The same panel can publish/delete
instance-wide notifications and shows the newest audit entries, including
request IP addresses. It still cannot expose another user's RCON password
or connect through another user's server.

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
register. The privacy policy documents the current account/server data,
encrypted credentials, macros and moderation rules, security audit
records/IP addresses, contact-form delivery, browser-local preferences,
Nitrado and Steam API flows, the short-lived Nitrado cache, Nitrado-hosted
game icons, locally served Inter fonts, PWA app-shell caching, audit
retention, and self-service deletion behavior. Adjust it if a fork changes
any data flow or hosting provider. It is project documentation, not a
substitute for legal review for a specific deployment.

## Language

The frontend ships in English and German today, switchable from the
language dropdown in the topbar. There's no build step or server-side
rendering involved — `docs/i18n.en.js` and `docs/i18n.de.js` contain the
language dictionaries, while `docs/i18n.js` provides lookup, fallback,
and DOM application at load (and again on switch) via
`data-i18n`/`-placeholder`/`-aria-label`/`-title` attributes in
`index.html`, and the choice is remembered in `localStorage` (falling back
to the browser's own language on first visit, then English). The legal
pages aren't part of that dictionary — they're long-form prose, so each
one is a separate file per language (`imprint.html`/`imprint.de.html`,
`privacy.html`/`privacy.de.html`) with its own tiny switcher, and the
in-app links to them pick the file matching the active UI language
automatically.

Adding a language means adding `docs/i18n.<code>.js`, registering it in
`I18N.LANGUAGES` in `docs/i18n.js`, loading it from `index.html`, and — if
you want the legal pages translated too — adding corresponding
`imprint.<code>.html`, `privacy.<code>.html`, and contact-page variants.
Per-game player-list parsing
(`docs/games.js`) and error messages returned by the Cloud API/relay are
not localized yet; both stay in English regardless of the selected UI
language.

## Architecture

- `internal/store` — MariaDB persistence: core schema auto-migration,
  per-user CRUD for servers, and AES-256-GCM encryption of RCON passwords
  at rest. Still used by the relay's CLI subcommands (`adduser`,
  `gen-recovery-code`, `setadmin`, `genkey`) and by `internal/relay`'s
  read-only lookups (session, server) and its two periodic background
  loops' writes (`UpdateServerHealth`, `UpdateServerPlayerSample`); no
  longer backs any HTTP write path — those moved to `webspace/`
- `internal/auth` — bcrypt password hashing, session-token issuance, and
  recovery-code generation on top of `internal/store`; same scope note as
  above
- `internal/relay` — the WebSocket↔RCON/WebRCON/BattlEye/Palworld bridge
  (`/ws/rcon`) plus `/healthz`. `a2s.go` and `minecraft_query.go` are the
  passive, unauthenticated status-query clients, dispatched per-server by
  `publicinfo.go`; the process also runs two independent periodic
  loops — authenticated RCON health checks, and public A2S/Minecraft-Query
  sampling — see [Cloud API vs. relay](#cloud-api-vs-relay) and
  [Relay](#relay)
- `webspace/` — the PHP Cloud API: accounts, registration, password
  reset, per-user server CRUD, Nitrado sync/status/power controls, Steam
  enrichment, macros, moderation rules, activity, notifications, contact
  delivery, and the admin panel. See
  [Cloud API (`webspace/`)](#cloud-api-webspace)
- `docs/` — the static frontend (plain HTML/CSS/vanilla JS, no framework,
  no build step), including a versioned service worker and installable PWA
  manifest, deployed to GitHub Pages by
  `.github/workflows/pages.yml`

## Testing

```sh
go test ./...
php tests/php/api_integration.php
npm ci
npx playwright install chromium
npm run test:browser
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

The relay tests cover its HTTP health/CORS surface, metadata-host blocking,
and a full browser-WebSocket-to-mock-game-server round trip for Source RCON,
Rust WebRCON, Palworld REST, and BattlEye. Protocol-specific tests additionally
cover BattlEye framing/reassembly, Palworld request mapping, and (against a
fake UDP server, the same pattern as BattlEye's) A2S_INFO's challenge round
trip and Minecraft Query's handshake/basic-stat exchange.

The PHP API integration suite requires a disposable MariaDB/MySQL database.
It skips cleanly when `NICON_PHP_TEST_DB_DSN` is unset. Configure all three
variables before running it locally:

```sh
export NICON_PHP_TEST_DB_DSN="mysql:host=127.0.0.1;port=3306;dbname=nicon_test;charset=utf8mb4"
export NICON_PHP_TEST_DB_USER="nicon"
export NICON_PHP_TEST_DB_PASS="<password>"
php tests/php/api_integration.php
```

The Playwright suite serves the unchanged static `docs/` frontend and replaces
the Cloud API and relay only at the browser network boundary. It covers login,
manual creation/profile editing, Nitrado sync/icons, multi-console behavior,
player actions, macros, moderation rules, manifest/install UI,
service-worker registration, local fonts, and offline app-shell startup. CI
runs Go and PHP against a MariaDB service container and runs the Chromium
suite in a separate job. See [the compatibility matrix](docs/compatibility.md)
for the distinction between mock coverage and real-server verification.
The latest recorded CI and public-endpoint smoke-test results are documented in
[`docs/production-verification.md`](docs/production-verification.md).

## Not implemented yet

- Windows binary packaging for the relay (`GOOS=windows GOARCH=amd64 go
  build` works today, just not automated/released anywhere yet)
- The WebRCON implementation is based on Facepunch's own
  [webrcon](https://github.com/Facepunch/webrcon) tool and third-party
  documentation; the `playerlist` command and `kick` have been verified
  against a real Rust server, the rest of it hasn't. The BattlEye
  implementation (Arma 2, Arma 3, Arma Reforger, DayZ) is based on
  BattlEye's own published protocol spec; DayZ's `players` command has been
  verified against a real server, Arma 2/3/Reforger haven't
- Structured player-list parsing (`docs/games.js`) covers Rust,
  ARK: Survival Evolved/Ascended, Minecraft, Palworld (via its REST API, see
  [Relay](#relay)), the BattlEye games, and Garry's Mod, based on documented
  command/API output formats rather than verified live responses — Rust,
  ARK: Survival Ascended, Minecraft, and Palworld have been confirmed
  against real servers; ARK: Survival Evolved, Garry's Mod, and the rest
  have not — see the file for details
- Mute and whisper are intentionally available only where a documented
  base-game/protocol command exists (currently Rust mute and BattlEye
  whisper). NiCon does not assume optional admin plugins such as
  uMod/ULX on other games.
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
- The relay's passive public-status sampling (A2S/Minecraft Query, see
  [Relay](#relay)) is read-only by design: A2S_PLAYER carries no stable player ID, so it can
  never back a kick/ban action the way a real RCON connection can
- A moderation rule has no enable/disable toggle — only create and
  delete (see [Cloud API (`webspace/`)](#cloud-api-webspace) above)
- ARK: Survival Ascended's A2S query port doesn't answer in practice —
  confirmed unreachable on every candidate port, including the one
  Nitrado's own API reports, from two independent networks (RCON itself
  is unaffected). `auto` mode defaults new ARK: Survival Ascended servers
  to `disabled` rather than repeating that dead end; the older ARK:
  Survival Evolved isn't affected

## Roadmap

Phase 1 (accounts, server storage, connectivity/health, Nitrado power
controls, notifications, activity, and responsive console basics) and the
current Phase 2 command-center scope (automatic player lists, contextual
actions, classified logs, moderation rules, autocomplete/history, macros,
Nitrado metadata/icons, optional Steam enrichment, manual game selection,
and server-profile editing) are implemented. Automated API, relay-protocol,
and browser end-to-end coverage is active in CI. Passive player/uptime
history for a server that hasn't had its RCON password entered yet (or
never needs one, being read-only) also now works, via the relay's own
A2S/Minecraft-Query sampling — see [Relay](#relay). Active next steps are
the remaining live game/protocol verification tracked in the
[compatibility matrix](docs/compatibility.md) (Garry's Mod and the
provisional-transport games in particular). Scheduled/triggered commands,
shared ban lists or teams/roles, a visual moderation-rules builder, and
Discord OAuth2/webhook delivery are on the roadmap but currently on hold.
