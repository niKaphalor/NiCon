# Production verification

Last verification: **2026-09-29**  
Verified frontend commit: **9983632e782c924676c601b6b6ffd636e029d617**

## Continuous integration

GitHub Actions run
[`36536971340`](https://github.com/niKaphalor/NiCon/actions/runs/36536971340)
completed successfully for commit `9983632`.

- MariaDB became ready and all Go tests passed against it.
- PHP syntax checks and the PHP API integration suite passed.
- Chromium installation and the complete Playwright browser suite passed.
- The GitHub Pages deployment run `36536971306` completed successfully.

## Production smoke tests

The following checks were executed from an external client against the public
deployment:

| Surface | Check | Result |
| --- | --- | --- |
| GitHub Pages | `https://nikaphalor.github.io/NiCon/` over verified TLS | HTTP 200 |
| PHP API | `https://nicon.mylss.de/api/healthz` | HTTP 200 |
| Relay HTTPS | `https://relay.130.61.8.150.sslip.io/healthz` | HTTP 200 |
| Relay WSS | WebSocket upgrade on `/ws/rcon` | HTTP 101 Switching Protocols |
| Allowed CORS | Origin `https://nikaphalor.github.io` | Allowed on API and relay |
| Rejected CORS | Origin `https://evil.example` | No `Access-Control-Allow-Origin` header |

The WebSocket smoke test validates TLS and the protocol upgrade. It does not
authenticate, connect to a game server, or execute an RCON command.

## Hosting operations (Hetzner control panel)

Confirmed by the operator on 2026-09-29:

- current `webspace/schema.sql` applied to the production MariaDB database;
- current `webspace/` directory deployed;
- `/usr/bin/php …/webspace/cron/sample_nitrado.php` scheduled every five
  minutes via the Hetzner cron job manager;
- `NICON_ENCRYPTION_KEY` (relay `.env`) and `encryption_key_base64`
  (`webspace/config.local.php`) confirmed identical.

## Authenticated smoke tests (real Nitrado server)

Executed by the operator against a live Nitrado-backed server:

| Check | Result |
| --- | --- |
| Nitrado sync (`POST /api/nitrado/sync`) | Passed — re-sync updates existing servers rather than duplicating |
| Status bar with real Nitrado data | Passed — status/players/map/version reflect the live service |
| Audit persistence | Passed — sync and power actions appear in account activity |
| Nitrado power: stop | Passed |
| Nitrado power: restart | Passed |
| Nitrado power: start | **Failed** — `unexpected status 500 from /services/<id>/gameservers/games/start` |

The failing `start` action calls the same endpoint and parameter Nitrado's
own official PHP SDK uses for `startGame($game)`
([source](https://github.com/nitrado/NitrAPI-PHP/blob/master/lib/Nitrapi/Services/Gameservers/Gameserver.php)),
so this is not a request-shape bug on NiCon's side — the 500 originates in
Nitrado's backend for this service/game combination. `nicon_nitrado_request()`
previously discarded the response body on error; it now surfaces Nitrado's
own error message (see `nicon_nitrado_error_detail()` in
`webspace/handlers/nitrado_sync.php`) so the next failure is diagnosable
instead of a bare status code. Re-test `start` once that fix is deployed and
record Nitrado's actual error text here.
