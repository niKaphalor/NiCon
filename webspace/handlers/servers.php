<?php
declare(strict_types=1);

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
        'V Rising', 'WARDOGS',
    ], true);
}

function nicon_query_config(array $req): array
{
    $protocol = strtolower(trim((string) ($req['query_protocol'] ?? 'auto')));
    if (!in_array($protocol, ['auto', 'a2s', 'minecraft', 'disabled'], true)) {
        nicon_send_error('unsupported query protocol', 400);
        exit;
    }
    $rawPort = $req['query_port'] ?? null;
    if ($rawPort === null || $rawPort === '') return [$protocol, null];
    $port = filter_var($rawPort, FILTER_VALIDATE_INT, ['options' => ['min_range' => 1, 'max_range' => 65535]]);
    if ($port === false) {
        nicon_send_error('query port must be between 1 and 65535', 400);
        exit;
    }
    return [$protocol, (int) $port];
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
    nicon_send_json([
        'range' => $range,
        'uptime_percent' => $availabilityCount ? round($online * 100 / $availabilityCount, 2) : null,
        'sample_completeness_percent' => round(min(100, $availabilityCount * 100 / $expected), 2),
        'players_average' => $playersCount ? round($playersTotal / $playersCount, 1) : null,
        'players_peak' => $playersPeak,
        'samples' => $samples,
    ]);
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
    $req = nicon_json_body();
    $name = trim((string) ($req['name'] ?? ''));
    $host = trim((string) ($req['host'] ?? ''));
    $port = (int) ($req['port'] ?? 0);
    $password = (string) ($req['password'] ?? '');
    $protocol = (string) ($req['protocol'] ?? '') ?: 'source';
    [$queryProtocol, $queryPort] = nicon_query_config($req);
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
    $pdo->prepare('
        INSERT INTO servers (user_id, name, host, port, password_enc, protocol, query_protocol, query_port, game, source)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ')->execute([$userId, $name, $host, $port, nicon_encrypt_password($password), $protocol, $queryProtocol, $queryPort, $game, 'manual']);
    $id = (int) $pdo->lastInsertId();

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
    $req = nicon_json_body();
    $name = trim((string) ($req['name'] ?? ''));
    $host = trim((string) ($req['host'] ?? ''));
    $port = (int) ($req['port'] ?? 0);
    $protocol = strtolower(trim((string) ($req['protocol'] ?? '')));
    [$queryProtocol, $queryPort] = nicon_query_config($req);
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
    $password = (string) ($req['password'] ?? '');
    if ($password === '') {
        nicon_send_error('password is required', 400);
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
    $stmt->execute([nicon_encrypt_password($password), $serverId, $userId]);
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
