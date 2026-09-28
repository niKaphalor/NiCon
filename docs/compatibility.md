# Compatibility matrix

This matrix separates three different kinds of evidence. A green automated
test against a controlled mock proves NiCon's protocol framing and UI flow;
it does **not** prove that a particular game build or hosting configuration
behaves the same way. "Live" is only marked when the project has actually
been exercised against a real service or game server.

Last matrix review: **2026-09-28**.

## Protocol transports

| Protocol | WebSocket-to-protocol E2E | Controlled peer | Real server | Evidence |
| --- | --- | --- | --- | --- |
| Source RCON | Pass | TCP Source RCON server | Not run | `internal/relay/ws_e2e_test.go` (`source-rcon`) |
| Rust WebRCON | Pass | WebSocket WebRCON server | Pass | Automated: `internal/relay/ws_e2e_test.go` (`rust-webrcon`); live: connection, `playerlist`, and `kick` |
| Palworld REST API | Pass | HTTP REST server | Not run | `internal/relay/ws_e2e_test.go` (`palworld-rest`) and `internal/relay/palworld_rest_test.go` |
| BattlEye RCon | Pass | UDP BattlEye server, including framing/reassembly | Not run | `internal/relay/ws_e2e_test.go` (`battleye`) and `internal/relay/battleye_test.go` |

All four E2E rows traverse the same public relay WebSocket flow used by the
browser: session authentication, account-scoped server lookup, game-server
connection, command, and response. A separate ownership test verifies that a
session cannot connect to another account's server.

## Games

| Game | Protocol | Nitrado discovery/catalog live | Console live | Player parsing live | Player actions live | Automated coverage | Current result |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Minecraft | Source RCON | Not recorded | Not run | Not run | Not run | Source transport mock; browser flows | Pending live verification |
| Rust | WebRCON | Pass | Pass | Pass (`playerlist`) | Pass (`kick`) | WebRCON E2E; browser player/action/macro/moderation flows | Supported and live verified for the listed actions |
| ARK: Survival Evolved / Ascended | Source RCON | Not recorded | Not run | Not run | Not run | Source transport mock; parser implementation | Pending live verification |
| Palworld | REST API | Pass (service discovery) | Not run | Not run | Not run | REST client and relay E2E mocks | Discovery verified; commands still need a live server |
| Arma 3 | BattlEye RCon | Not recorded | Not run | Not run | Not run | BattlEye transport mock; parser implementation | Pending live verification |
| DayZ | BattlEye RCon | Not recorded | Not run | Not run | Not run | BattlEye transport mock; parser implementation | Pending live verification |
| Garry's Mod | Source RCON | Not recorded | Not run | Not run | Not run | Source transport mock; parser implementation | Pending live verification |

The live Rust and Nitrado checks predate this matrix; their exact date, game
build, and hosting image were not recorded. They therefore establish observed
compatibility, not a permanent guarantee for every future server version.

## Browser and API coverage

Playwright tests in `tests/browser/command-center.spec.js` cover login,
manual game/protocol selection, server-profile editing, Nitrado sync and icon
rendering, two simultaneously connected consoles, player kick, multi-step
macros, and a chat-triggered moderation rule. API calls and WebSockets are
stateful browser-level test doubles.

`tests/php/api_integration.php` runs the real PHP router against MariaDB and a
mock Nitrado HTTP service. It covers registration/login, account ownership,
manual game persistence, profile/password updates, templates, moderation
rules, Nitrado sync/icons/status/power operations, resource filtering, and
audit entries.

## Recording a live verification

Run against a disposable server owned by the tester, never a production
server with active players. For a game row to change from "Not run" to
"Pass", record in the pull request or commit message:

1. date, game/build, hosting provider, and protocol;
2. connection and a harmless read-only command;
3. raw player-list output and whether the structured list matched it;
4. each supported player action tested with a consenting test account;
5. any required plugin or non-default server setting.

Update only the cells supported by that evidence. A discovery-only Nitrado
test must not be promoted to console or player-action compatibility.
