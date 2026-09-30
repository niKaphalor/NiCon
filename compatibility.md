# Compatibility matrix

NiCon's selectable/importable game catalog is an explicitly maintained list.
Games absent from that list are not offered as new integrations. Existing
database records are left intact so an update never destroys user data.

Last matrix review: **2026-09-30**.

## Protocol transports

| Protocol | Automated controlled-peer test | Real server | Notes |
| --- | --- | --- | --- |
| Source RCON | Pass | ARK: Survival Ascended and Minecraft tests passed; not run for every game | TCP framing via `gorcon/rcon` |
| WebRCON | Pass | Rust test passed | Active Rust transport |
| Palworld REST API | Pass | Palworld test passed | HTTP Basic auth and documented `/v1/api` endpoints |
| BattleBit WebRCON | Pass | Not run | Published `x-password`/JSON protocol |
| BattlEye RCon | Pass | DayZ test passed | Used for Arma 2, Arma 3, Arma Reforger, and DayZ |
| Telnet | Pass | 7 Days to Die test passed | 7 Days to Die password login, command, response, and negotiation stripping |

## Supported games

| Game | NiCon transport | Player command/parser | Live verification |
| --- | --- | --- | --- |
| 7 Days to Die | Telnet | `lp`, conservative line parser | ✅ Passed — user-confirmed live on 2026-09-29 |
| 83 | Provisional Source transport | `status`, conservative line parser | Pending |
| ARK: Survival Ascended | Source RCON | `ListPlayers`, ARK parser | ✅ Passed — user-confirmed live on 2026-09-29 |
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
| DayZ | BattlEye | `players`, BattlEye parser | ✅ Passed — user-confirmed live on 2026-09-29 |
| Garry's Mod | Source RCON | `status`, structured Source parser | Pending |
| Hell Let Loose | Provisional Source transport | `get playerids` | Pending |
| Hell Let Loose: Vietnam | Provisional Source transport | `get playerids` | Pending |
| Insurgency | Source RCON | `status` | Pending |
| Minecraft | Source RCON | `list`, dedicated parser | ✅ Passed — user-confirmed live on 2026-09-29 |
| MORDHAU | Source RCON | `playerlist` | Pending |
| Palworld | Palworld REST API | `players` JSON | Passed on a real Nitrado service |
| Project Zomboid | Source RCON | `players` | Pending |
| Rising Storm 2: Vietnam | Provisional Source transport | `get playerlist` | Pending |
| Rust | WebRCON | `playerlist` JSON | Passed on a real server |
| Squad | Source-style RCON | `ListPlayers` | Pending |
| Squad 44 | Source-style RCON | `ListPlayers` | Pending |
| Soulmask | Provisional Source transport | `listplayers` | Pending |
| V Rising | Provisional Source transport | `status` | Pending |
| Valheim | Source RCON via a server-side BepInEx plugin | `players`, conservative line parser | Pending — vanilla server has no RCON endpoint |
| WARDOGS | Provisional Source transport | `status` | Pending |

“Provisional” is intentional: a listed game may require a proprietary or
undocumented protocol rather than the public Source-RCON wire format. NiCon does not mark these games live-compatible
until tested against a disposable server.

The UI separately marks whether a game works with the dedicated server as
shipped, uses another built-in administration protocol, needs a server-side
mod, or still has a provisional transport. Valheim is the only current entry
that requires a server mod; the player clients do not need that plugin.

## Health and API coverage

The relay stores a five-minute authenticated connectivity sample for every
server and retains raw samples for 90 days. Nitrado status reads add current
and maximum player counts at most once every four minutes. The API exposes
24-hour, 7-day, 30-day, and 90-day histories with uptime, sample completeness,
average players, and peak players. Missing samples are reported through
completeness and are not silently counted as downtime.

A separate, unauthenticated five-minute sample runs independently from RCON.
Each profile can select `auto`, `a2s`, `minecraft`, or `disabled` and can use
a dedicated query port. `auto` keeps the previous Source/Minecraft behaviour;
WebRCON and BattlEye profiles can explicitly opt into A2S. Minecraft Query
must be enabled server-side. See the
[README's Relay section](https://github.com/niKaphalor/NiCon#relay) for details.

ARK: Survival Ascended's A2S query port doesn't answer in practice — confirmed
unreachable on every candidate port, including the one Nitrado's own API
reports, from two independent networks (RCON itself is unaffected). `auto`
mode defaults new ARK: Survival Ascended servers to `disabled` rather than
repeating that dead end.

The Nitrado status endpoint deliberately exposes only service status, current
and maximum players, world/map, and version. CPU, memory, and server
configuration values are not returned to the browser.

## Verification rule

A game may be marked live only after recording the date, build, hosting
provider, protocol, harmless read command, raw player-list output, and every
tested moderation action. Mock-server coverage proves NiCon framing and UI
flow, not compatibility with a particular game release.

The 7 Days to Die, DayZ, ARK: Survival Ascended, and Minecraft results were
confirmed directly by the operator on 2026-09-29. The tested build, hosting
provider, raw player-list output, and tested moderation actions were not
retained during those live checks and should be added when the servers are
next available.
