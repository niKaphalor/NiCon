# NiCon

A web UI to send RCON commands to game servers — including the ones on
your Nitrado account, and any other Source-RCON server added manually.

The UI is a static page at **https://nikaphalor.github.io/NiCon/** — no
install needed to view it. To actually send RCON commands, you run a small
local relay binary alongside it (see [Relay](#relay) below): browsers can't
open raw TCP sockets, so something has to.

**Nothing is stored, anywhere.** Server list, RCON passwords, and the
Nitrado API token all live only in the page's memory for that session, and
in the relay's memory for that connection. Reload the page and it's gone;
restart the relay and it's gone. This is deliberate, not a missing feature.

## Status

Early / untested against a real Nitrado account and real game servers —
built and smoke-tested locally (including an end-to-end test against a mock
Source RCON server), but not yet run against production servers. Treat as a
working prototype.

## Using it

1. Open **https://nikaphalor.github.io/NiCon/**.
2. Run the relay locally (see below) and confirm its address in the
   "Relay" box — the status pill turns green once it's reachable.
3. Add a server manually, or paste a Nitrado API token and hit "Sync
   servers" (adds every server whose current game has RCON enabled; the
   RCON password itself isn't in Nitrado's API response, so add it
   inline before connecting).
4. Click "Connect" to open the console for that server.

## Relay

```sh
go build -o nicon-relay .
./nicon-relay                                    # listens on localhost:8765
./nicon-relay -addr localhost:9000 -allow-origin "https://nikaphalor.github.io,http://localhost:9000"
```

The relay does two things, and stores neither:

- **WebSocket ↔ RCON bridge** (`/ws/rcon`): the browser sends
  `{"type":"connect", host, port, password}` then any number of
  `{"type":"command", command}` messages; the relay holds one
  [gorcon/rcon](https://github.com/gorcon/rcon) connection for the
  lifetime of that WebSocket and relays responses back as JSON.
- **Nitrado API proxy** (`POST /api/nitrado/sync`): takes `{"token": "..."}`,
  calls the Nitrado API server-side (so the token never needs to survive a
  browser CORS round trip on its own), and returns the RCON-capable
  servers. The token is used for that one request and then forgotten.

Only origins in `-allow-origin` (default: the GitHub Pages URL plus
`localhost:8765`) can open a WebSocket to the relay or call the sync
endpoint — without that check, any other page open in your browser could
otherwise talk to `localhost:8765` and issue RCON commands through it.

There's no authentication beyond the origin check, so don't run the relay
on a shared or otherwise untrusted host.

## Architecture

- `internal/nitrado` — minimal Nitrado API client (list services, fetch a
  service's live gameserver data including `rcon_port` and `has_rcon`)
- `internal/relay` — the WebSocket↔RCON bridge and Nitrado proxy described
  above; holds state only for the duration of one WebSocket connection or
  one HTTP request
- `docs/` — the static frontend (plain HTML/CSS/vanilla JS, no framework,
  no build step), deployed to GitHub Pages by
  `.github/workflows/pages.yml`

## Not implemented yet

- Windows binary packaging for the relay (`GOOS=windows GOARCH=amd64 go
  build` works today, just not automated/released anywhere yet)
- Automated tests (the relay's WebSocket↔RCON path has been exercised
  manually against a mock RCON server, but there's no test suite yet)
