<?php
declare(strict_types=1);

function nicon_nitrado_base_url(): string
{
    $url = rtrim((string) (nicon_config()['nitrado_api_base_url'] ?? 'https://api.nitrado.net'), '/');
    if (!preg_match('#^https?://#', $url)) {
        throw new RuntimeException('invalid Nitrado API base URL');
    }
    return $url;
}

// NICON_NITRADO_MAX_RESPONSE_BYTES bounds how much of a Nitrado API
// response this reads into memory — Nitrado's own responses are small
// JSON, but nothing stops a misbehaving proxy or a redirected/compromised
// endpoint from streaming an unbounded body at CURLOPT_RETURNTRANSFER.
// Enforced via CURLOPT_WRITEFUNCTION rather than CURLOPT_MAXFILESIZE,
// which curl can only apply upfront when the server sends a Content-Length
// — not guaranteed here.
const NICON_NITRADO_MAX_RESPONSE_BYTES = 5 * 1024 * 1024; // 5 MiB

function nicon_nitrado_cache_ttl(): int
{
    $configured = (int) (nicon_config()['nitrado_cache_ttl_seconds'] ?? 45);
    return max(30, min(60, $configured));
}

function nicon_nitrado_cache_token_hash(string $token): string
{
    // HMAC prevents the cache table from containing a reusable plain hash of
    // the credential. The configured encryption key is installation-specific.
    $key = (string) (nicon_config()['encryption_key_base64'] ?? '');
    return hash_hmac('sha256', $token, $key);
}

function nicon_nitrado_cache_request_key(string $path): string
{
    return hash('sha256', nicon_nitrado_base_url() . $path);
}

function nicon_nitrado_cache_get(string $token, string $path): ?array
{
    $stmt = nicon_db()->prepare('
        SELECT response_json
        FROM nitrado_cache
        WHERE token_hash = ? AND request_key = ? AND expires_at > UTC_TIMESTAMP()
    ');
    $stmt->execute([
        nicon_nitrado_cache_token_hash($token),
        nicon_nitrado_cache_request_key($path),
    ]);
    $json = $stmt->fetchColumn();
    if ($json === false) return null;
    $decoded = json_decode((string) $json, true);
    return is_array($decoded) ? $decoded : null;
}

function nicon_nitrado_cache_put(string $token, string $path, array $data): void
{
    $pdo = nicon_db();
    $json = json_encode($data, JSON_UNESCAPED_SLASHES | JSON_THROW_ON_ERROR);
    $expiresAt = gmdate('Y-m-d H:i:s', time() + nicon_nitrado_cache_ttl());
    $pdo->prepare('
        INSERT INTO nitrado_cache (token_hash, request_key, response_json, expires_at)
        VALUES (?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE response_json = VALUES(response_json), expires_at = VALUES(expires_at)
    ')->execute([
        nicon_nitrado_cache_token_hash($token),
        nicon_nitrado_cache_request_key($path),
        $json,
        $expiresAt,
    ]);
}

function nicon_nitrado_cache_invalidate(string $token): void
{
    nicon_db()->prepare('DELETE FROM nitrado_cache WHERE token_hash = ?')
        ->execute([nicon_nitrado_cache_token_hash($token)]);
}

// nicon_nitrado_request calls the Nitrado API with the caller-supplied
// token and unwraps its {"status":..., "data":...} envelope. Shared
// hosting can make ordinary outbound HTTPS calls like this one just fine
// — it's only raw RCON TCP ports that get blocked (see the README's
// Hetzner section). GET powers sync; POST powers the explicit server
// start/stop/restart actions below.
// Nitrado's error envelope usually carries a human-readable reason under
// "message" (sometimes nested as message.message/message.error_id); surface
// it instead of just the bare HTTP status, or the raw body as a fallback,
// so a failure like the games/start 500 actually says why.
function nicon_nitrado_error_detail(string $body): string
{
    $decoded = json_decode($body, true);
    $message = is_array($decoded) ? ($decoded['message'] ?? null) : null;
    if (is_array($message)) {
        $message = $message['message'] ?? $message['error_id'] ?? json_encode($message);
    }
    if (!is_string($message) || $message === '') {
        $message = substr(trim($body), 0, 200);
    }
    return $message !== '' ? " ($message)" : '';
}

function nicon_nitrado_request(string $token, string $method, string $path, array $params = []): array
{
    $ch = curl_init(nicon_nitrado_base_url() . $path);
    $body = '';
    $tooLarge = false;
    $headers = ['Authorization: Bearer ' . $token];
    $options = [
        CURLOPT_HTTPHEADER => $headers,
        CURLOPT_TIMEOUT => 15,
        CURLOPT_WRITEFUNCTION => function ($ch, string $chunk) use (&$body, &$tooLarge): int {
            if (strlen($body) + strlen($chunk) > NICON_NITRADO_MAX_RESPONSE_BYTES) {
                $tooLarge = true;
                return -1; // abort the transfer
            }
            $body .= $chunk;
            return strlen($chunk);
        },
    ];
    if (strtoupper($method) === 'POST') {
        $headers[] = 'Content-Type: application/x-www-form-urlencoded';
        $options[CURLOPT_HTTPHEADER] = $headers;
        $options[CURLOPT_POST] = true;
        $options[CURLOPT_POSTFIELDS] = http_build_query($params);
    }
    curl_setopt_array($ch, $options);
    $ok = curl_exec($ch);
    $status = curl_getinfo($ch, CURLINFO_HTTP_CODE);
    curl_close($ch);

    if ($tooLarge) {
        throw new RuntimeException("response from $path exceeded the size limit");
    }
    if ($ok === false) {
        throw new RuntimeException("request $path failed");
    }
    if ($status === 401 || $status === 403) {
        throw new RuntimeException('nitrado API token is invalid or expired');
    }
    if ($status < 200 || $status >= 300) {
        throw new RuntimeException("unexpected status $status from $path" . nicon_nitrado_error_detail($body));
    }

    $env = json_decode($body, true);
    if (!is_array($env) || ($env['status'] ?? '') !== 'success') {
        throw new RuntimeException("nitrado reported an error for $path" . nicon_nitrado_error_detail($body));
    }
    $data = $env['data'] ?? [];
    return is_array($data) ? $data : [];
}

function nicon_nitrado_get(string $token, string $path): array
{
    $cached = nicon_nitrado_cache_get($token, $path);
    if ($cached !== null) return $cached;
    $data = nicon_nitrado_request($token, 'GET', $path);
    nicon_nitrado_cache_put($token, $path, $data);
    return $data;
}

function nicon_nitrado_post(string $token, string $path, array $params = []): array
{
    $data = nicon_nitrado_request($token, 'POST', $path, $params);
    nicon_nitrado_cache_invalidate($token);
    return $data;
}

// Nitrado's games catalog varies slightly between products. Walk it for
// the current game code and accept only an HTTPS image hosted by Nitrado.
function nicon_nitrado_icon_url(array $data, string $gameCode): ?string
{
    $found = null;
    $walk = function ($node) use (&$walk, &$found, $gameCode): void {
        if ($found !== null || !is_array($node)) return;
        foreach ($node as $key => $value) {
            if (is_string($key) && strtolower($key) === strtolower($gameCode) && is_array($value)) {
                $value['game_code'] = $gameCode;
                $walk($value);
                if ($found !== null) return;
            }
        }
        $code = strtolower((string) ($node['game'] ?? $node['game_code'] ?? $node['portlist_short'] ?? $node['short'] ?? $node['folder_short'] ?? $node['id'] ?? ''));
        if ($code !== '' && $code === strtolower($gameCode)) {
            if (!empty($node['icons']) && is_array($node['icons'])) {
                foreach (['x64', 'x120', 'x32', 'x256', 'x16'] as $size) {
                    if (!empty($node['icons'][$size]) && is_string($node['icons'][$size])) {
                        $found = $node['icons'][$size];
                        break;
                    }
                }
            }
            foreach (['icon_url', 'icon', 'image_url', 'image', 'logo'] as $key) {
                if ($found !== null) break;
                $candidate = $node[$key] ?? null;
                if (is_array($candidate)) $candidate = $candidate['url'] ?? $candidate['src'] ?? null;
                if (!empty($candidate) && is_string($candidate)) { $found = $candidate; break; }
            }
        }
        foreach ($node as $child) if (is_array($child)) $walk($child);
    };
    $walk($data);
    if ($found === null || filter_var($found, FILTER_VALIDATE_URL) === false) return null;
    $parts = parse_url($found);
    $host = strtolower((string) ($parts['host'] ?? ''));
    if (($parts['scheme'] ?? '') !== 'https' || !($host === 'nitrado.net' || str_ends_with($host, '.nitrado.net'))) return null;
    return $found;
}

function nicon_nitrado_saved_token(PDO $pdo, int $userId): string
{
    $stmt = $pdo->prepare('SELECT nitrado_token_enc FROM users WHERE id = ?');
    $stmt->execute([$userId]);
    $encrypted = $stmt->fetchColumn();
    return $encrypted ? nicon_decrypt_password($encrypted, nicon_aad_nitrado_token($userId)) : '';
}

function nicon_supported_game(string $label): ?array
{
    $games = [
        ['7 Days to Die', 'telnet', ['7 days to die', '7dtd']],
        ['83', 'source', ['83']],
        ['ARK: Survival Ascended', 'source', ['ark: survival ascended', 'ark survival ascended', 'arksa']],
        ['ARK: Survival Evolved', 'source', ['ark: survival evolved', 'ark survival evolved', 'arkse']],
        ['Arma 2', 'battleye', ['arma 2', 'arma2']],
        ['Arma 3', 'battleye', ['arma 3', 'arma3']],
        ['Arma Reforger', 'battleye', ['arma reforger', 'reforger']],
        ['ATLAS', 'source', ['atlas']],
        ['BattleBit Remastered', 'battlebit', ['battlebit']],
        ['Beyond the Wire', 'source', ['beyond the wire']],
        ['Conan Exiles', 'source', ['conan exiles']],
        ['Counter-Strike 2', 'source', ['counter-strike 2', 'counter strike 2', 'cs2']],
        ['Dark and Light', 'source', ['dark and light']],
        ['DayZ', 'battleye', ['dayz', 'day z']],
        ["Garry's Mod", 'source', ["garry's mod", 'garrys mod', 'gmod']],
        ['Hell Let Loose: Vietnam', 'source', ['hell let loose: vietnam', 'hell let loose vietnam']],
        ['Hell Let Loose', 'source', ['hell let loose']],
        ['Insurgency', 'source', ['insurgency']],
        // Minecraft's remote console is the same wire protocol as Source
        // RCON (just a different command set — see games.js), so it's
        // eligible the same way any other 'source' entry here is.
        ['Minecraft', 'source', ['minecraft']],
        ['MORDHAU', 'source', ['mordhau']],
        ['Palworld', 'palworld_rest', ['palworld']],
        ['Project Zomboid', 'source', ['project zomboid']],
        ['Rising Storm 2: Vietnam', 'source', ['rising storm 2', 'rising storm ii']],
        ['Rust', 'webrcon', ['rust']],
        ['Squad 44', 'source', ['squad 44', 'post scriptum']],
        ['Squad', 'source', ['squad']],
        ['Soulmask', 'source', ['soulmask']],
        ['V Rising', 'source', ['v rising', 'vrising']],
        // Valheim needs a server-side BepInEx RCON plugin; the service is
        // still importable once its operator has installed/configured one.
        ['Valheim', 'source', ['valheim']],
        ['WARDOGS', 'source', ['wardogs', 'war dogs']],
    ];
    $lower = strtolower($label);
    foreach ($games as [$name, $protocol, $aliases]) {
        foreach ($aliases as $alias) {
            $matches = $alias === '83'
                ? preg_match('/(?:^|[^0-9])83(?:[^0-9]|$)/', $lower) === 1
                : str_contains($lower, $alias);
            if ($matches) return ['name' => $name, 'protocol' => $protocol];
        }
    }
    return null;
}

// nicon_nitrado_query_protocol always returns 'auto': the actual
// a2s/minecraft/disabled decision (including the Minecraft and ARK:
// Survival Ascended special cases) is made in exactly one place now,
// internal/relay/publicinfo.go's EffectivePublicQueryProtocol — kept there,
// not duplicated here, after an earlier version of this function hardcoded
// its own copy of that same game list and the two silently drifted apart
// (a Nitrado-synced Rust/Arma/DayZ server got A2S sampling this way while a
// manually-added one of the same game, left on "auto", didn't). Writing
// 'auto' unconditionally means every server gets the same answer
// regardless of how it was added.
function nicon_nitrado_query_protocol(array $game): string
{
    return 'auto';
}

function nicon_nitrado_query_port(array $gameserver): ?int
{
    // Consume only ports actually reported by the provider; never derive a
    // query port by adding a guessed offset to the RCON port.
    $candidates = [
        $gameserver['query_port'] ?? null,
        $gameserver['game_specific']['query_port'] ?? null,
        $gameserver['ports']['query'] ?? null,
        $gameserver['query']['port'] ?? null,
        $gameserver['game_port'] ?? null,
    ];
    foreach ($candidates as $candidate) {
        $port = filter_var($candidate, FILTER_VALIDATE_INT, ['options' => ['min_range' => 1, 'max_range' => 65535]]);
        if ($port !== false) return (int) $port;
    }
    return null;
}

// nicon_handle_nitrado_sync upserts every RCON-capable service from
// Nitrado into the caller's own server list, and returns the full updated
// list. A token in the request body is saved (encrypted, AES-256-GCM —
// see lib/crypto.php) for next time; omitting it reuses whatever was
// saved from an earlier sync, so entering it once is enough.
function nicon_handle_nitrado_sync(int $userId): void
{
    $req = nicon_json_body();
    $token = nicon_body_string($req, 'token');
    if ($token === null) return;
    if (strlen($token) > NICON_MAX_NITRADO_TOKEN_BYTES) {
        nicon_send_error('token is too long (max ' . NICON_MAX_NITRADO_TOKEN_BYTES . ' bytes)', 400);
        return;
    }
    $pdo = nicon_db();

    if ($token !== '') {
        try {
            $previousToken = nicon_nitrado_saved_token($pdo, $userId);
            if ($previousToken !== '' && !hash_equals($previousToken, $token)) {
                nicon_nitrado_cache_invalidate($previousToken);
            }
        } catch (RuntimeException $e) {
            // Replacing an unreadable old credential must remain possible.
            // Its cache entries have a hard maximum lifetime of 60 seconds.
        }
        $pdo->prepare('UPDATE users SET nitrado_token_enc = ? WHERE id = ?')
            ->execute([nicon_encrypt_password($token, NICON_MAX_NITRADO_TOKEN_BYTES, nicon_aad_nitrado_token($userId)), $userId]);
    } else {
        $stmt = $pdo->prepare('SELECT nitrado_token_enc FROM users WHERE id = ?');
        $stmt->execute([$userId]);
        $enc = $stmt->fetchColumn();
        $token = $enc ? nicon_decrypt_password($enc, nicon_aad_nitrado_token($userId)) : '';
        if ($token === '') {
            nicon_send_error('no saved Nitrado token — enter one to sync', 400);
            return;
        }
    }

    try {
        $services = nicon_nitrado_get($token, '/services')['services'] ?? [];
    } catch (RuntimeException $e) {
        nicon_send_error($e->getMessage(), 502);
        return;
    }

    $gamesMetadata = [];
    foreach ($services as $svc) {
        $serviceId = (int) ($svc['id'] ?? 0);
        try {
            $data = nicon_nitrado_get($token, "/services/$serviceId/gameservers");
        } catch (RuntimeException $e) {
            continue; // one bad service shouldn't abort the whole sync
        }
        $gs = $data['gameserver'] ?? [];
        $gameCode = (string) ($gs['game'] ?? '');
        $gameIconUrl = null;
        if ($gameCode !== '') {
            try {
                if (!$gamesMetadata) $gamesMetadata = nicon_nitrado_get($token, "/services/$serviceId/gameservers/games");
                $gameIconUrl = nicon_nitrado_icon_url($gamesMetadata, $gameCode);
            } catch (RuntimeException $e) { /* icon metadata is optional */ }
        }

        $gameHuman = (string) ($gs['game_human'] ?? '');
        $supported = nicon_supported_game($gameHuman . ' ' . $gameCode);
        if ($supported === null) continue;
        $hasRcon = (bool) ($gs['game_specific']['features']['has_rcon'] ?? false);
        $rconPort = (int) ($gs['rcon_port'] ?? 0);
        $ip = (string) ($gs['ip'] ?? '');
        $hasConnectionInfo = $rconPort !== 0 && $ip !== '';
        $protocol = $supported['protocol'];
        $queryProtocol = nicon_nitrado_query_protocol($supported);
        $queryPort = nicon_nitrado_query_port($gs);
        $eligibleWithoutRconFlag = in_array($protocol, ['telnet', 'palworld_rest', 'webrcon', 'battleye'], true);
        $eligible = ($hasRcon || $eligibleWithoutRconFlag) && $hasConnectionInfo;
        if (!$eligible) {
            continue;
        }

        // Nitrado currently reports Palworld's former RCON port, while its
        // replacement REST API is conventionally exposed on the next port.
        $port = $protocol === 'palworld_rest' ? $rconPort + 1 : $rconPort;
        $name = (string) ($gs['query']['server_name'] ?? '');
        if ($name === '') {
            $name = $supported['name'];
        }

        // Matches internal/store's UpsertNitradoServer: keyed on
        // (user_id, nitrado_service_id), never touches an existing
        // password_enc — Nitrado never gives us one to overwrite it with.
        $pdo->prepare('
            INSERT INTO servers (user_id, name, host, port, protocol, query_protocol, query_port, game, source, nitrado_service_id, nitrado_game_code, nitrado_game_icon_url)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, \'nitrado\', ?, ?, ?)
            ON DUPLICATE KEY UPDATE name = VALUES(name), host = VALUES(host), port = VALUES(port),
              protocol = VALUES(protocol), query_protocol = VALUES(query_protocol), query_port = VALUES(query_port),
              game = VALUES(game), nitrado_game_code = VALUES(nitrado_game_code),
              nitrado_game_icon_url = COALESCE(VALUES(nitrado_game_icon_url), nitrado_game_icon_url)
        ')->execute([$userId, $name, $ip, $port, $protocol, $queryProtocol, $queryPort, $supported['name'], $serviceId, $gameCode, $gameIconUrl]);
    }

    nicon_handle_list_servers($userId);
}

// Starts, stops, or restarts one Nitrado-backed server owned by the
// authenticated user. Start targets the currently selected game through
// Nitrado's games/start operation; stop and restart act on the whole
// gameserver service.
function nicon_handle_nitrado_power(int $userId, int $serverId): void
{
    $req = nicon_json_body();
    $action = strtolower((string) ($req['action'] ?? ''));
    if (!in_array($action, ['start', 'stop', 'restart'], true)) {
        nicon_send_error('action must be start, stop, or restart', 400);
        return;
    }

    if (!nicon_rate_limit_allow("nitrado-power:$userId:$serverId", 10, 60)) {
        header('Retry-After: 60');
        nicon_send_error('too many Nitrado power requests — try again shortly', 429);
        return;
    }

    $pdo = nicon_db();
    $serverStmt = $pdo->prepare('SELECT name, nitrado_service_id FROM servers WHERE id = ? AND user_id = ? AND source = \'nitrado\'');
    $serverStmt->execute([$serverId, $userId]);
    $server = $serverStmt->fetch();
    if (!$server || (int) ($server['nitrado_service_id'] ?? 0) <= 0) {
        nicon_send_error('server not found', 404);
        return;
    }

    $tokenStmt = $pdo->prepare('SELECT nitrado_token_enc FROM users WHERE id = ?');
    $tokenStmt->execute([$userId]);
    $encryptedToken = $tokenStmt->fetchColumn();
    try {
        $token = $encryptedToken ? nicon_decrypt_password($encryptedToken, nicon_aad_nitrado_token($userId)) : '';
    } catch (RuntimeException $e) {
        nicon_send_error('saved Nitrado token could not be read', 500);
        return;
    }
    if ($token === '') {
        nicon_send_error('no saved Nitrado token — sync again with a token first', 400);
        return;
    }

    $serviceId = (int) $server['nitrado_service_id'];
    try {
        if ($action === 'start') {
            $gameserverData = nicon_nitrado_get($token, "/services/$serviceId/gameservers");
            $game = (string) ($gameserverData['gameserver']['game'] ?? '');
            if ($game === '') {
                throw new RuntimeException('nitrado did not report a current game to start');
            }
            nicon_nitrado_post($token, "/services/$serviceId/gameservers/games/start", ['game' => $game]);
        } else {
            nicon_nitrado_post($token, "/services/$serviceId/gameservers/$action");
        }
    } catch (RuntimeException $e) {
        nicon_send_error($e->getMessage(), 502);
        return;
    }

    $auditActions = [
        'start' => 'nitrado_server_started',
        'stop' => 'nitrado_server_stopped',
        'restart' => 'nitrado_server_restarted',
    ];
    nicon_audit_log($userId, $auditActions[$action], null, (string) $server['name']);
    nicon_send_json(['ok' => true, 'action' => $action]);
}

function nicon_handle_nitrado_status(int $userId, int $serverId): void
{
    $pdo = nicon_db();
    $stmt = $pdo->prepare('SELECT nitrado_service_id FROM servers WHERE id = ? AND user_id = ? AND source = \'nitrado\'');
    $stmt->execute([$serverId, $userId]);
    $server = $stmt->fetch();
    $serviceId = (int) ($server['nitrado_service_id'] ?? 0);
    if ($serviceId <= 0) { nicon_send_error('server not found', 404); return; }
    try {
        $token = nicon_nitrado_saved_token($pdo, $userId);
        if ($token === '') throw new RuntimeException('no saved Nitrado token');
        $data = nicon_nitrado_get($token, "/services/$serviceId/gameservers");
        $gs = $data['gameserver'] ?? [];
        $query = $gs['query'] ?? [];
        $result = [
            'status' => (string) ($gs['status'] ?? 'unknown'),
            'players' => (int) ($query['player_current'] ?? 0),
            'players_max' => (int) ($query['player_max'] ?? $gs['slots'] ?? 0),
            'map' => (string) ($query['map'] ?? ''),
            'version' => (string) ($query['version'] ?? ''),
        ];
        $online = in_array(strtolower((string) ($gs['status'] ?? '')), ['started', 'running', 'online'], true);
        $pdo->prepare('
            INSERT INTO server_health_samples (server_id, online, player_current, player_max, source)
            SELECT ?, ?, ?, ?, \'nitrado\'
            WHERE NOT EXISTS (
                SELECT 1 FROM server_health_samples
                WHERE server_id = ? AND source = \'nitrado\' AND sampled_at >= DATE_SUB(UTC_TIMESTAMP(), INTERVAL 4 MINUTE)
            )
        ')->execute([$serverId, $online, $result['players'], $result['players_max'], $serverId]);
        nicon_send_json($result);
    } catch (RuntimeException $e) {
        nicon_send_error($e->getMessage(), 502);
    }
}
