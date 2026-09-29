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

## Hosting operations still requiring control-panel access

These checks cannot be inferred from public endpoints and must be confirmed
inside the Hetzner hosting account:

- apply the current `webspace/schema.sql` to the production MariaDB database;
- deploy the current `webspace/` directory;
- configure `/usr/bin/php …/webspace/cron/sample_nitrado.php` to run every
  five minutes and confirm a successful execution in the cron log.
