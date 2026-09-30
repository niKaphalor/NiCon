<?php
declare(strict_types=1);

// NICON_MAX_SERVERS_PER_ACCOUNT bounds manual server creation (not Nitrado
// sync, which is inherently bounded by however many services the caller
// actually rents from Nitrado). Without a cap, an account could create an
// unbounded number of rows pointing at arbitrary third-party host:port
// pairs, each of which the relay's public-info loop then probes with UDP
// traffic forever, every five minutes — see internal/relay/publicinfo.go.
// This doesn't eliminate that surface on its own (an on-demand "test
// query" also exists, rate-limited separately by the relay itself), but it
// bounds the standing, automatic part of it to one account's own share,
// the same way NICON_MAX_COMMAND_TEMPLATES bounds command templates.
const NICON_MAX_SERVERS_PER_ACCOUNT = 50;

// The standing NICON_MAX_SERVERS_PER_ACCOUNT cap above bounds how many rows
// can exist at once, but not how fast a scripted client could cycle
// create+delete to churn through many more than that over time — these
// per-account, per-time-window limits close that gap the same way
// nitrado-power's rate limit does for its own endpoint.
const NICON_SERVERS_CREATE_RATE_LIMIT = 20;  // per account, per window
const NICON_SERVERS_UPDATE_RATE_LIMIT = 30;  // per account, per window
const NICON_SERVERS_RATE_WINDOW = 300;       // 5 minutes

function nicon_game_is_allowed(string $game): bool
{
    if ($game === '') return true; // generic console, not a game integration
    return in_array($game, [
        '7 Days to Die', '83', 'ARK: Survival Ascended', 'ARK: Survival Evolved',
        'Arma 2', 'Arma 3', 'Arma Reforger', 'ATLAS', 'BattleBit Remastered',
        'Beyond the Wire', 'Conan Exiles', 'Counter-Strike 2', 'Dark and Light',
        'DayZ', "Garry's Mod", 'Hell Let Loose', 'Hell Let Loose: Vietnam',
        'Insurgency', 'Minecraft', 'MORDHAU', 'Palworld', 'Project Zomboid',
        'Rising Storm 2: Vietnam', 'Rust', 'Squad', 'Squad 44', 'Soulmask',
        'V Rising', 'Valheim', 'WARDOGS',
    ], true);
}

// nicon_query_config returns null (after already sending the 400 itself)
// on invalid input, the same way every other per-field validation in this
// file signals failure — the caller must check for null and return
// immediately, exactly like the nicon_game_is_allowed check right above
// each call site. This used to call exit() directly instead, which works
// (each request is its own process) but was the one place in this file
// that didn't let its caller unwind normally — see git history for why
// that was flagged and changed.
function nicon_query_config(array $req): ?array
{
    $protocol = strtolower(trim((string) ($req['query_protocol'] ?? 'auto')));
    if (!in_array($protocol, ['auto', 'a2s', 'minecraft', 'disabled'], true)) {
        nicon_send_error('unsupported query protocol', 400);
        return null;
    }
    $rawPort = $req['query_port'] ?? null;
    if ($rawPort === null || $rawPort === '') return [$protocol, null];
    $port = filter_var($rawPort, FILTER_VALIDATE_INT, ['options' => ['min_range' => 1, 'max_range' => 65535]]);
    if ($port === false) {
        nicon_send_error('query port must be between 1 and 65535', 400);
        return null;
    }
    return [$protocol, (int) $port];
}

// NICON_HEALTH_HISTORY_CACHE_TTL bounds how stale a served health-history
// response can be — see schema.sql's health_history_cache comment for why
// this exists at all. 120s is comfortably below the 5-minute sampling
// interval, so a cache hit is never showing data that's meaningfully
// behind what a fresh computation would show anyway.
const NICON_HEALTH_HISTORY_CACHE_TTL = 120;

function nicon_health_history_cache_get(int $serverId, string $range): ?array
{
    $stmt = nicon_db()->prepare('
        SELECT response_json FROM health_history_cache
        WHERE server_id = ? AND range_key = ? AND expires_at > UTC_TIMESTAMP()
    ');
    $stmt->execute([$serverId, $range]);
    $json = $stmt->fetchColumn();
    if ($json === false) {
        return null;
    }
    $data = json_decode((string) $json, true);
    return is_array($data) ? $data : null;
}

function nicon_health_history_cache_put(int $serverId, string $range, array $data): void
{
    $pdo = nicon_db();
    // Opportunistic cleanup, same reasoning as nitrado_cache_put in
    // nitrado_sync.php: no persistent PHP process to run this on a timer.
    $pdo->prepare('DELETE FROM health_history_cache WHERE expires_at <= UTC_TIMESTAMP()')->execute();
    $expiresAt = gmdate('Y-m-d H:i:s', time() + NICON_HEALTH_HISTORY_CACHE_TTL);
    $pdo->prepare('
        INSERT INTO health_history_cache (server_id, range_key, response_json, expires_at)
        VALUES (?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE response_json = VALUES(response_json), expires_at = VALUES(expires_at)
    ')->execute([$serverId, $range, json_encode($data), $expiresAt]);
}

function nicon_handle_server_health_history(int $userId, int $serverId): void
{
    $ranges = ['24h' => 1, '7d' => 7, '30d' => 30, '90d' => 90];
    $range = strtolower((string) ($_GET['range'] ?? '24h'));
    if (!isset($ranges[$range])) {
        nicon_send_error('range must be 24h, 7d, 30d, or 90d', 400);
        return;
    }
    $pdo = nicon_db();
    $owner = $pdo->prepare('SELECT id FROM servers WHERE id = ? AND user_id = ?');
    $owner->execute([$serverId, $userId]);
    if (!$owner->fetchColumn()) {
        nicon_send_error('server not found', 404);
        return;
    }

    // The ownership check above still runs on every request regardless of
    // this cache hit — only the (expensive, identical for every caller who
    // owns this server) computed result is reused, never the access check.
    $cached = nicon_health_history_cache_get($serverId, $range);
    if ($cached !== null) {
        nicon_send_json($cached);
        return;
    }

    $days = $ranges[$range];
    $stmt = $pdo->prepare("
        SELECT sampled_at, online, latency_ms, player_current, player_max, source
        FROM server_health_samples
        WHERE server_id = ? AND sampled_at >= DATE_SUB(UTC_TIMESTAMP(), INTERVAL $days DAY)
        ORDER BY sampled_at ASC
    ");
    $stmt->execute([$serverId]);
    $samples = [];
    $availabilityBuckets = [];
    $playerBuckets = [];
    foreach ($stmt as $row) {
        $isOnline = (bool) $row['online'];
        $source = (string) $row['source'];
        $timestamp = strtotime((string) $row['sampled_at']);
        $bucket = (int) floor($timestamp / 300);
        if ($source !== 'client') {
            $priority = $source === 'relay' ? 20 : 10;
            if (!isset($availabilityBuckets[$bucket]) || $priority > $availabilityBuckets[$bucket]['priority']) {
                $availabilityBuckets[$bucket] = ['online' => $isOnline, 'priority' => $priority];
            }
        }
        $current = $row['player_current'] === null ? null : (int) $row['player_current'];
        if ($current !== null) {
            $priority = $source === 'nitrado' ? 40 : (in_array($source, ['a2s', 'mcquery'], true) ? 30 : ($source === 'client' ? 20 : 10));
            if (!isset($playerBuckets[$bucket]) || $priority > $playerBuckets[$bucket]['priority']) {
                $playerBuckets[$bucket] = ['players' => $current, 'priority' => $priority];
            }
        }
        $samples[] = [
            'at' => gmdate('Y-m-d\TH:i:s\Z', strtotime((string) $row['sampled_at'])),
            'online' => $isOnline,
            'latency_ms' => $row['latency_ms'] === null ? null : (int) $row['latency_ms'],
            'players' => $current,
            'players_max' => $row['player_max'] === null ? null : (int) $row['player_max'],
            'source' => $source,
        ];
    }
    $availabilityCount = count($availabilityBuckets);
    $online = count(array_filter($availabilityBuckets, static fn(array $sample): bool => $sample['online']));
    $playerValues = array_column($playerBuckets, 'players');
    $playersCount = count($playerValues);
    $playersTotal = array_sum($playerValues);
    $playersPeak = $playersCount ? max($playerValues) : null;
    $expected = $ranges[$range] * 24 * 12;
    $response = [
        'range' => $range,
        'uptime_percent' => $availabilityCount ? round($online * 100 / $availabilityCount, 2) : null,
        'sample_completeness_percent' => round(min(100, $availabilityCount * 100 / $expected), 2),
        'players_average' => $playersCount ? round($playersTotal / $playersCount, 1) : null,
        'players_peak' => $playersPeak,
        'samples' => $samples,
    ];
    nicon_health_history_cache_put($serverId, $range, $response);
    nicon_send_json($response);
}

function nicon_handle_server_player_sample(int $userId, int $serverId): void
{
    $req = nicon_json_body();
    $current = filter_var($req['players'] ?? null, FILTER_VALIDATE_INT, ['options' => ['min_range' => 0, 'max_range' => 100000]]);
    $maximum = isset($req['players_max'])
        ? filter_var($req['players_max'], FILTER_VALIDATE_INT, ['options' => ['min_range' => 0, 'max_range' => 100000]])
        : null;
    if ($current === false || $maximum === false) {
        nicon_send_error('invalid player count', 400);
        return;
    }
    $pdo = nicon_db();
    $stmt = $pdo->prepare('
        INSERT INTO server_health_samples (server_id, online, player_current, player_max, source)
        SELECT s.id, TRUE, ?, ?, \'client\' FROM servers s
        WHERE s.id = ? AND s.user_id = ? AND NOT EXISTS (
            SELECT 1 FROM server_health_samples h
            WHERE h.server_id = s.id AND h.source = \'client\' AND h.sampled_at >= DATE_SUB(UTC_TIMESTAMP(), INTERVAL 4 MINUTE)
        )
    ');
    $stmt->execute([(int) $current, $maximum === null ? null : (int) $maximum, $serverId, $userId]);
    if ($stmt->rowCount() === 0) {
        $owner = $pdo->prepare('SELECT 1 FROM servers WHERE id = ? AND user_id = ?');
        $owner->execute([$serverId, $userId]);
        if (!$owner->fetchColumn()) {
            nicon_send_error('server not found', 404);
            return;
        }
    }
    http_response_code(204);
}

// nicon_server_response is what a server looks like over the API —
// everything except the actual password. health_* is written only by the
// Go relay's periodic background check (main.go's runHealthChecks — a
// real RCON connect every 5 minutes, not just a TCP reachability check),
// never by this API; health_ok is null until the first check has run.
function nicon_server_response(array $row): array
{
    return [
        'id' => (int) $row['id'],
        'name' => $row['name'],
        'host' => $row['host'],
        'port' => (int) $row['port'],
        'protocol' => $row['protocol'],
        'query_protocol' => $row['query_protocol'] ?? 'auto',
        'query_port' => isset($row['query_port']) ? (int) $row['query_port'] : null,
        'game' => $row['game'],
        'source' => $row['source'],
        'nitrado_game_code' => $row['nitrado_game_code'] ?? '',
        'game_icon_url' => $row['nitrado_game_icon_url'] ?? null,
        'has_password' => $row['password_enc'] !== null,
        'health_ok' => $row['health_ok'] === null ? null : (bool) $row['health_ok'],
        'health_checked_at' => $row['health_checked_at'] !== null ? gmdate('Y-m-d\TH:i:s\Z', strtotime($row['health_checked_at'])) : null,
        'health_latency_ms' => $row['health_latency_ms'] !== null ? (int) $row['health_latency_ms'] : null,
        'health_error' => $row['health_error'],
    ];
}

// nicon_is_cloud_metadata_host reports whether $host is, or resolves to, a
// well-known cloud provider instance-metadata endpoint (AWS, GCP, Azure,
// DigitalOcean, and Oracle Cloud all serve it on 169.254.169.254; Alibaba
// Cloud uses a different address). These endpoints hand out
// unauthenticated, high-privilege data — IAM credentials, instance tokens —
// to whatever can reach them, so a manually-added "RCON server" pointed at
// one would leak that data back through the relay's otherwise-legitimate
// host/port passthrough. This deliberately does NOT block localhost or
// private/LAN addresses — running NiCon against a locally hosted game
// server is the documented primary use case — only the handful of
// addresses that have no legitimate use as an RCON target are denied.
//
// This is a fast-fail convenience check, not the authoritative one: a
// domain resolving safely right now could resolve to a blocked IP by the
// time the relay actually connects to it later (DNS rebinding), since DNS
// is re-resolved fresh in that separate process. internal/relay/ws.go's
// isBlockedMetadataHost enforces the same list immediately before dialing,
// which is the check that gap can't get past — this one exists so a user
// seeing an obviously-bad host gets an immediate error instead of a
// confusing one after they've already saved the server.
function nicon_is_cloud_metadata_host(string $host): bool
{
    $normalized = strtolower(trim($host, '[]'));
    $blockedHosts = ['metadata.google.internal'];
    $blockedIps = [
        '169.254.169.254',   // AWS, GCP, Azure, DigitalOcean, Oracle Cloud, ...
        '169.254.170.2',     // AWS ECS task metadata
        'fd00:ec2::254',     // AWS IMDSv2, IPv6
        '100.100.100.200',   // Alibaba Cloud
    ];
    if (in_array($normalized, $blockedHosts, true) || in_array($normalized, $blockedIps, true)) {
        return true;
    }
    if (filter_var($normalized, FILTER_VALIDATE_IP) !== false) {
        return false; // already checked as a literal IP above
    }

    $records = @dns_get_record($normalized, DNS_A | DNS_AAAA);
    if ($records === false) {
        return false; // unresolvable — the relay's own connection attempt will fail on its own later
    }
    foreach ($records as $record) {
        $ip = $record['ip'] ?? $record['ipv6'] ?? null;
        if ($ip !== null && in_array(strtolower($ip), $blockedIps, true)) {
            return true;
        }
    }
    return false;
}

function nicon_handle_list_servers(int $userId): void
{
    $stmt = nicon_db()->prepare('
        SELECT id, name, host, port, password_enc, protocol, query_protocol, query_port, game, source,
               health_ok, health_checked_at, health_latency_ms, health_error,
               nitrado_game_code, nitrado_game_icon_url
        FROM servers WHERE user_id = ? ORDER BY name');
    $stmt->execute([$userId]);
    $servers = array_map('nicon_server_response', $stmt->fetchAll());
    nicon_send_json($servers);
}

function nicon_handle_create_server(int $userId): void
{
    if (!nicon_rate_limit_allow("servers-create:$userId", NICON_SERVERS_CREATE_RATE_LIMIT, NICON_SERVERS_RATE_WINDOW)) {
        header('Retry-After: ' . NICON_SERVERS_RATE_WINDOW);
        nicon_send_error('too many servers created recently — try again later', 429);
        return;
    }
    $req = nicon_json_body();
    $name = trim((string) ($req['name'] ?? ''));
    $host = trim((string) ($req['host'] ?? ''));
    $port = (int) ($req['port'] ?? 0);
    $password = nicon_body_string($req, 'password');
    if ($password === null) return;
    if (strlen($password) > NICON_MAX_SERVER_PASSWORD_BYTES) {
        nicon_send_error('password is too long (max ' . NICON_MAX_SERVER_PASSWORD_BYTES . ' bytes)', 400);
        return;
    }
    $protocol = (string) ($req['protocol'] ?? '') ?: 'source';
    $queryConfig = nicon_query_config($req);
    if ($queryConfig === null) return; // nicon_query_config already sent the error
    [$queryProtocol, $queryPort] = $queryConfig;
    $game = trim((string) ($req['game'] ?? ''));
    if (!nicon_game_is_allowed($game)) {
        nicon_send_error('unsupported game', 400);
        return;
    }

    if ($name === '' || strlen($name) > 255 || $host === '' || strlen($host) > 255 || $port <= 0 || $port > 65535) {
        nicon_send_error('name, host, and port are required', 400);
        return;
    }
    if (!in_array($protocol, ['source', 'webrcon', 'palworld_rest', 'battleye', 'telnet', 'battlebit'], true)) {
        nicon_send_error('unsupported protocol', 400);
        return;
    }
    if (strlen($game) > 255) {
        nicon_send_error('game is too long', 400);
        return;
    }
    if (nicon_is_cloud_metadata_host($host)) {
        nicon_send_error('this host is not allowed', 400);
        return;
    }

    $pdo = nicon_db();
    // FOR UPDATE inside a transaction, not a plain SELECT before the INSERT:
    // two concurrent requests from the same account could otherwise both
    // read a count under the cap and both insert, exceeding it by however
    // many raced. The locking read takes InnoDB next-key locks covering
    // this user_id's rows (an index exists on it via the FOREIGN KEY), which
    // blocks a second transaction's own locking read until the first
    // commits — closing the race instead of just narrowing it.
    $pdo->beginTransaction();
    try {
        $countStmt = $pdo->prepare('SELECT COUNT(*) FROM servers WHERE user_id = ? FOR UPDATE');
        $countStmt->execute([$userId]);
        if ((int) $countStmt->fetchColumn() >= NICON_MAX_SERVERS_PER_ACCOUNT) {
            $pdo->rollBack();
            nicon_send_error('you already have the maximum of ' . NICON_MAX_SERVERS_PER_ACCOUNT . ' servers — remove one first', 400);
            return;
        }
        $pdo->prepare('
            INSERT INTO servers (user_id, name, host, port, password_enc, protocol, query_protocol, query_port, game, source)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ')->execute([$userId, $name, $host, $port, nicon_encrypt_password($password, NICON_MAX_SERVER_PASSWORD_BYTES), $protocol, $queryProtocol, $queryPort, $game, 'manual']);
        $id = (int) $pdo->lastInsertId();
        $pdo->commit();
    } catch (Throwable $e) {
        $pdo->rollBack();
        throw $e;
    }

    nicon_audit_log($userId, 'server_added', null, $name);

    $stmt = $pdo->prepare('
        SELECT id, name, host, port, password_enc, protocol, query_protocol, query_port, game, source,
               health_ok, health_checked_at, health_latency_ms, health_error,
               nitrado_game_code, nitrado_game_icon_url
        FROM servers WHERE id = ?');
    $stmt->execute([$id]);
    nicon_send_json(nicon_server_response($stmt->fetch()));
}

function nicon_handle_update_server(int $userId, int $serverId): void
{
    if (!nicon_rate_limit_allow("servers-update:$userId", NICON_SERVERS_UPDATE_RATE_LIMIT, NICON_SERVERS_RATE_WINDOW)) {
        header('Retry-After: ' . NICON_SERVERS_RATE_WINDOW);
        nicon_send_error('too many server updates recently — try again later', 429);
        return;
    }
    $req = nicon_json_body();
    $name = trim((string) ($req['name'] ?? ''));
    $host = trim((string) ($req['host'] ?? ''));
    $port = (int) ($req['port'] ?? 0);
    $protocol = strtolower(trim((string) ($req['protocol'] ?? '')));
    $queryConfig = nicon_query_config($req);
    if ($queryConfig === null) return; // nicon_query_config already sent the error
    [$queryProtocol, $queryPort] = $queryConfig;
    $game = trim((string) ($req['game'] ?? ''));
    if (!nicon_game_is_allowed($game)) {
        nicon_send_error('unsupported game', 400);
        return;
    }

    if ($name === '' || strlen($name) > 255 || $host === '' || strlen($host) > 255 || $port <= 0 || $port > 65535) {
        nicon_send_error('valid name, host, and port are required', 400);
        return;
    }
    if (!in_array($protocol, ['source', 'webrcon', 'palworld_rest', 'battleye', 'telnet', 'battlebit'], true)) {
        nicon_send_error('unsupported protocol', 400);
        return;
    }
    if (strlen($game) > 255) {
        nicon_send_error('game is too long', 400);
        return;
    }
    if (nicon_is_cloud_metadata_host($host)) {
        nicon_send_error('this host is not allowed', 400);
        return;
    }

    $pdo = nicon_db();
    $stmt = $pdo->prepare('
        UPDATE servers
        SET name = ?, host = ?, port = ?, protocol = ?, query_protocol = ?, query_port = ?,
            nitrado_game_code = CASE WHEN game <> ? THEN \'\' ELSE nitrado_game_code END,
            nitrado_game_icon_url = CASE WHEN game <> ? THEN NULL ELSE nitrado_game_icon_url END,
            game = ?,
            health_ok = NULL, health_checked_at = NULL,
            health_latency_ms = NULL, health_error = NULL
        WHERE id = ? AND user_id = ?
    ');
    $stmt->execute([$name, $host, $port, $protocol, $queryProtocol, $queryPort, $game, $game, $game, $serverId, $userId]);

    $serverStmt = $pdo->prepare('
        SELECT id, name, host, port, password_enc, protocol, query_protocol, query_port, game, source,
               health_ok, health_checked_at, health_latency_ms, health_error,
               nitrado_game_code, nitrado_game_icon_url
        FROM servers WHERE id = ? AND user_id = ?
    ');
    $serverStmt->execute([$serverId, $userId]);
    $server = $serverStmt->fetch();
    if (!$server) {
        nicon_send_error('server not found', 404);
        return;
    }

    nicon_audit_log($userId, 'server_updated', null, $name);
    nicon_send_json(nicon_server_response($server));
}

function nicon_handle_set_server_password(int $userId, int $serverId): void
{
    $req = nicon_json_body();
    $password = nicon_body_string($req, 'password');
    if ($password === null) return;
    if ($password === '') {
        nicon_send_error('password is required', 400);
        return;
    }
    if (strlen($password) > NICON_MAX_SERVER_PASSWORD_BYTES) {
        nicon_send_error('password is too long (max ' . NICON_MAX_SERVER_PASSWORD_BYTES . ' bytes)', 400);
        return;
    }

    $pdo = nicon_db();
    $nameStmt = $pdo->prepare('SELECT name FROM servers WHERE id = ? AND user_id = ?');
    $nameStmt->execute([$serverId, $userId]);
    $name = $nameStmt->fetchColumn();
    if ($name === false) {
        nicon_send_error('404 page not found', 404);
        return;
    }

    $stmt = $pdo->prepare('UPDATE servers SET password_enc = ?, health_ok = NULL, health_checked_at = NULL, health_latency_ms = NULL, health_error = NULL WHERE id = ? AND user_id = ?');
    $stmt->execute([nicon_encrypt_password($password, NICON_MAX_SERVER_PASSWORD_BYTES), $serverId, $userId]);
    if ($stmt->rowCount() === 0) {
        nicon_send_error('404 page not found', 404);
        return;
    }
    nicon_audit_log($userId, 'server_password_changed', null, (string) $name);
    http_response_code(204);
}

function nicon_handle_delete_server(int $userId, int $serverId): void
{
    $pdo = nicon_db();
    $nameStmt = $pdo->prepare('SELECT name FROM servers WHERE id = ? AND user_id = ?');
    $nameStmt->execute([$serverId, $userId]);
    $name = $nameStmt->fetchColumn();

    $stmt = $pdo->prepare('DELETE FROM servers WHERE id = ? AND user_id = ?');
    $stmt->execute([$serverId, $userId]);
    if ($stmt->rowCount() === 0) {
        nicon_send_error('404 page not found', 404);
        return;
    }
    nicon_audit_log($userId, 'server_deleted', null, $name !== false ? $name : null);
    http_response_code(204);
}
