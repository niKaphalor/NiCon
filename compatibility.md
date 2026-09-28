# Compatibility matrix

NiCon's selectable/importable game catalog is an explicitly maintained list.
Games absent from that list are not offered as new integrations. Existing
database records are left intact so an update never destroys user data.

Last matrix review: **2026-09-28**.

## Protocol transports

| Protocol | Automated controlled-peer test | Real server | Notes |
| --- | --- | --- | --- |
| Source RCON | Pass | Not run for every game | TCP framing via `gorcon/rcon` |
| WebRCON | Pass | Rust test passed | Active Rust transport |
| Palworld REST API | Pass | Palworld test passed | HTTP Basic auth and documented `/v1/api` endpoints |
| BattleBit WebRCON | Pass | Not run | Published `x-password`/JSON protocol |
| BattlEye RCon | Pass | Not run | Used for Arma 2, Arma 3, Arma Reforger, and DayZ |
| Telnet | Pass | Not run | 7 Days to Die password login, command, response, and negotiation stripping |

## Supported games

| Game | NiCon transport | Player command/parser | Live verification |
| --- | --- | --- | --- |
| 7 Days to Die | Telnet | `lp`, conservative line parser | Pending |
| 83 | Provisional Source transport | `status`, conservative line parser | Pending |
| ARK: Survival Ascended | Source RCON | `ListPlayers`, ARK parser | Pending |
| ARK: Survival Evolved | Source RCON | `ListPlayers`, ARK parser | Pending |
| Arma 2 | BattlEye | `players`, BattlEye parser | Pending |
| Arma 3 | BattlEye | `players`, BattlEye parser | Pending |
| Arma Reforger | BattlEye | `players` | Pending |
| ATLAS | Source RCON | `ListPlayers` | Pending |
| BattleBit Remastered | BattleBit WebRCON | `playerList` JSON | Pending |
| Beyond the Wire | Source RCON | `ListPlayers` | Pending |
| Conan Exiles | Source RCON | `listplayers` | Pending |
| Counter-Strike 2 | Source RCON | `status` | Pending |
| Dark and Light | Source RCON | `ListPlayers` | Pending |
| DayZ | BattlEye | `players`, BattlEye parser | Pending |
| Garry's Mod | Source RCON | `status`, structured Source parser | Pending |
| Hell Let Loose | Provisional Source transport | `get playerids` | Pending |
| Hell Let Loose: Vietnam | Provisional Source transport | `get playerids` | Pending |
| Insurgency | Source RCON | `status` | Pending |
| MORDHAU | Source RCON | `playerlist` | Pending |
| Palworld | Palworld REST API | `players` JSON | Passed on a real Nitrado service |
| Project Zomboid | Source RCON | `players` | Pending |
| Rising Storm 2: Vietnam | Provisional Source transport | `get playerlist` | Pending |
| Rust | WebRCON | `playerlist` JSON | Passed on a real server |
| Squad | Source-style RCON | `ListPlayers` | Pending |
| Squad 44 | Source-style RCON | `ListPlayers` | Pending |
| Soulmask | Provisional Source transport | `listplayers` | Pending |
| V Rising | Provisional Source transport | `status` | Pending |
| WARDOGS | Provisional Source transport | `status` | Pending |

“Provisional” is intentional: a listed game may require a proprietary or
undocumented protocol rather than the public Source-RCON wire format. NiCon does not mark these games live-compatible
until tested against a disposable server.

## Health and API coverage

The relay stores a five-minute authenticated connectivity sample for every
server and retains raw samples for 90 days. Nitrado status reads add current
and maximum player counts at most once every four minutes. The API exposes
24-hour, 7-day, 30-day, and 90-day histories with uptime, sample completeness,
average players, and peak players. Missing samples are reported through
completeness and are not silently counted as downtime.

Nitrado settings are read-only and allow-listed. Keys resembling passwords,
tokens, API keys, FTP credentials, RCON credentials, or other secrets are
discarded in PHP before the response reaches the browser.

## Verification rule

A game may be marked live only after recording the date, build, hosting
provider, protocol, harmless read command, raw player-list output, and every
tested moderation action. Mock-server coverage proves NiCon framing and UI
flow, not compatibility with a particular game release.
