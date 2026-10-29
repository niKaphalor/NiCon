-- What the relay's passive public query learns about a server, beyond the
-- player counts that server_health_samples already holds.
--
-- servers.query_info is a small JSON document (name, map, version, password
-- flag, Palworld FPS/uptime/days, the probe's round-trip time) rewritten on
-- every successful probe; servers.query_error is the kind of the last failure
-- (timeout, refused, dns, blocked, auth, protocol) and NULL after a success.
-- server_health_samples.error_kind keeps that kind per failed sample, so
-- "server is down" can be told apart from "wrong query port" in the history.
ALTER TABLE servers ADD COLUMN IF NOT EXISTS query_info TEXT NULL;
ALTER TABLE servers ADD COLUMN IF NOT EXISTS query_checked_at TIMESTAMP NULL;
ALTER TABLE servers ADD COLUMN IF NOT EXISTS query_error VARCHAR(16) NULL;
ALTER TABLE server_health_samples ADD COLUMN IF NOT EXISTS error_kind VARCHAR(16) NULL;
