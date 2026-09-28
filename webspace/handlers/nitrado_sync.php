<?php
declare(strict_types=1);

const NICON_NITRADO_BASE_URL = 'https://api.nitrado.net';

// NICON_NITRADO_MAX_RESPONSE_BYTES bounds how much of a Nitrado API
// response this reads into memory — Nitrado's own responses are small
// JSON, but nothing stops a misbehaving proxy or a redirected/compromised
// endpoint from streaming an unbounded body at CURLOPT_RETURNTRANSFER.
// Enforced via CURLOPT_WRITEFUNCTION rather than CURLOPT_MAXFILESIZE,
// which curl can only apply upfront when the server sends a Content-Length
// — not guaranteed here.
const NICON_NITRADO_MAX_RESPONSE_BYTES = 5 * 1024 * 1024; // 5 MiB

// nicon_nitrado_request calls the Nitrado API with the caller-supplied
// token and unwraps its {"status":..., "data":...} envelope. Shared
// hosting can make ordinary outbound HTTPS calls like this one just fine
// — it's only raw RCON TCP ports that get blocked (see the README's
// Hetzner section). GET powers sync; POST powers the explicit server
// start/stop/restart actions below.
function nicon_nitrado_request(string $token, string $method, string $path, array $params = []): array
{
    $ch = curl_init(NICON_NITRADO_BASE_URL . $path);
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
        throw new RuntimeException("unexpected status $status from $path");
    }

    $env = json_decode($body, true);
    if (!is_array($env) || ($env['status'] ?? '') !== 'success') {
        throw new RuntimeException("nitrado reported an error for $path");
    }
    $data = $env['data'] ?? [];
    return is_array($data) ? $data : [];
}

function nicon_nitrado_get(string $token, string $path): array
{
    return nicon_nitrado_request($token, 'GET', $path);
}

function nicon_nitrado_post(string $token, string $path, array $params = []): array
{
    return nicon_nitrado_request($token, 'POST', $path, $params);
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
        $code = strtolower((string) ($node['game'] ?? $node['game_code'] ?? $node['id'] ?? $node['short'] ?? $node['folder_short'] ?? ''));
        if ($code !== '' && $code === strtolower($gameCode)) {
            foreach (['icon_url', 'icon', 'image_url', 'image', 'logo'] as $key) {
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
    return $encrypted ? nicon_decrypt_password($encrypted) : '';
}

// nicon_handle_nitrado_sync upserts every RCON-capable service from
// Nitrado into the caller's own server list, and returns the full updated
// list. A token in the request body is saved (encrypted, AES-256-GCM —
// see lib/crypto.php) for next time; omitting it reuses whatever was
// saved from an earlier sync, so entering it once is enough.
function nicon_handle_nitrado_sync(int $userId): void
{
    $req = nicon_json_body();
    $token = (string) ($req['token'] ?? '');
    $pdo = nicon_db();

    if ($token !== '') {
        $pdo->prepare('UPDATE users SET nitrado_token_enc = ? WHERE id = ?')
            ->execute([nicon_encrypt_password($token), $userId]);
    } else {
        $stmt = $pdo->prepare('SELECT nitrado_token_enc FROM users WHERE id = ?');
        $stmt->execute([$userId]);
        $enc = $stmt->fetchColumn();
        $token = $enc ? nicon_decrypt_password($enc) : '';
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
        $isRust = stripos($gameHuman, 'rust') !== false;
        // Palworld's RCON is deprecated (Pocketpair-wide, not a Nitrado
        // choice) — Nitrado may already report has_rcon=false for it, so
        // this game is eligible on its own merits, independent of that
        // flag. Nitrado's API has no dedicated field for the REST API's
        // port; confirmed directly against a real Nitrado Palworld
        // service that it's the reported rcon_port + 1.
        $isPalworld = stripos($gameHuman, 'palworld') !== false;
        // Arma (3 and 2) and DayZ are BattlEye-protected — a different
        // wire protocol from Source RCON entirely (see
        // internal/relay/battleye.go), even though Nitrado reports the
        // same has_rcon/rcon_port fields for them.
        $isBattleye = stripos($gameHuman, 'arma') !== false || stripos($gameHuman, 'dayz') !== false;
        $hasRcon = (bool) ($gs['game_specific']['features']['has_rcon'] ?? false);
        $rconPort = (int) ($gs['rcon_port'] ?? 0);
        $ip = (string) ($gs['ip'] ?? '');
        $hasConnectionInfo = $rconPort !== 0 && $ip !== '';
        $eligible = ($hasRcon || $isRust || $isPalworld || $isBattleye) && $hasConnectionInfo;
        if (!$eligible) {
            continue;
        }

        $protocol = $isRust ? 'webrcon' : ($isPalworld ? 'palworld_rest' : ($isBattleye ? 'battleye' : 'source'));
        $port = $isPalworld ? $rconPort + 1 : $rconPort;
        $name = (string) ($gs['query']['server_name'] ?? '');
        if ($name === '') {
            $name = $gameHuman;
        }

        // Matches internal/store's UpsertNitradoServer: keyed on
        // (user_id, nitrado_service_id), never touches an existing
        // password_enc — Nitrado never gives us one to overwrite it with.
        $pdo->prepare('
            INSERT INTO servers (user_id, name, host, port, protocol, game, source, nitrado_service_id, nitrado_game_code, nitrado_game_icon_url)
            VALUES (?, ?, ?, ?, ?, ?, \'nitrado\', ?, ?, ?)
            ON DUPLICATE KEY UPDATE name = VALUES(name), host = VALUES(host), port = VALUES(port),
              protocol = VALUES(protocol), game = VALUES(game), nitrado_game_code = VALUES(nitrado_game_code),
              nitrado_game_icon_url = COALESCE(VALUES(nitrado_game_icon_url), nitrado_game_icon_url)
        ')->execute([$userId, $name, $ip, $port, $protocol, $gameHuman, $serviceId, $gameCode, $gameIconUrl]);
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
        $token = $encryptedToken ? nicon_decrypt_password($encryptedToken) : '';
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
    $serviceId = (int) $stmt->fetchColumn();
    if ($serviceId <= 0) { nicon_send_error('server not found', 404); return; }
    try {
        $token = nicon_nitrado_saved_token($pdo, $userId);
        if ($token === '') throw new RuntimeException('no saved Nitrado token');
        $data = nicon_nitrado_get($token, "/services/$serviceId/gameservers");
        $gs = $data['gameserver'] ?? [];
        $query = $gs['query'] ?? [];
        $result = [
            'status' => (string) ($gs['status'] ?? 'unknown'),
            'memory_mb' => (int) ($gs['memory_mb'] ?? $gs['memory'] ?? 0),
            'players' => (int) ($query['player_current'] ?? 0),
            'players_max' => (int) ($query['player_max'] ?? $gs['slots'] ?? 0),
            'map' => (string) ($query['map'] ?? ''),
            'version' => (string) ($query['version'] ?? ''),
        ];
        try {
            $stats = nicon_nitrado_get($token, "/services/$serviceId/gameservers/stats?hours=1");
            foreach (['cpuUsage' => 'cpu_percent', 'memoryUsage' => 'memory_percent'] as $source => $target) {
                $values = $stats[$source] ?? [];
                if (is_array($values) && $values) {
                    $last = end($values);
                    $result[$target] = is_array($last) ? (float) end($last) : (float) $last;
                }
            }
        } catch (RuntimeException $e) { /* detail response remains useful */ }
        nicon_send_json($result);
    } catch (RuntimeException $e) {
        nicon_send_error($e->getMessage(), 502);
    }
}
