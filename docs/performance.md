# Relay performance results

## 2026-09-28 controlled parallel-load run

| Metric | Result |
| --- | ---: |
| Concurrent authenticated WebSocket clients | 8 |
| Commands per client | 20 |
| Total samples | 160 |
| p50 relay overhead | 0.906 ms |
| p95 relay overhead | 1.244 ms |
| Maximum relay overhead | 1.588 ms |
| Acceptance limit | p95 ≤ 50 ms |
| Result | Pass |

Environment: local Linux workspace, Go relay, MariaDB 10.11.14, a controlled
Source-RCON peer, and durable RCON audit insertion enabled for every measured
command. The test is `TestRelayOverheadP95UnderParallelLoad` in
`internal/relay/ws_e2e_test.go`.

This result validates relay-local processing under controlled parallel load.
It deliberately does not claim a 50 ms browser/Internet/game-server round trip;
those components are reported independently and depend on the deployment and
the selected game server.
