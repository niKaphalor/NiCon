# NiCon acceptance criteria

This document records clarified, measurable requirements that supersede less
precise wording in the original product brief.

## Relay latency

The latency objective is **p95 relay overhead at or below 50 milliseconds** at
the intended deployment load. Relay overhead is measured inside the relay from
receipt of a decoded command until the response is ready for the browser,
excluding time spent waiting for the game protocol itself and excluding the
browser/Internet round trip.

Acceptance uses the controlled parallel-load test in
`internal/relay/ws_e2e_test.go`. The test opens eight authenticated WebSocket
connections, executes 20 commands on each connection against a mock game
server, includes durable audit persistence, sorts the 160 reported
`relay_overhead_ms` samples, and fails if p95 exceeds 50 ms.
Recorded runs and their environment are maintained in
[`performance.md`](performance.md).

Internet RTT and game-server processing time are reported separately as they
depend on geography, network conditions, game implementation, and hosting
provider and therefore cannot be guaranteed by NiCon.

## RCON audit

Every operator command except automatic player-list polling is persisted with
the authenticated user, selected server, command/action, optional target
player, origin, success/failure result, timestamp, upstream latency, and relay
overhead. Macro steps and automatic moderation actions identify their origin.
The configured audit retention policy applies to these records.
