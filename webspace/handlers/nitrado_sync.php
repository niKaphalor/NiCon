<?php
declare(strict_types=1);

const NICON_NITRADO_BASE_URL = 'https://api.nitrado.net';

// nicon_nitrado_get mirrors internal/nitrado/client.go's get(): calls the
// Nitrado API with the caller-supplied token and unwraps its
// {"status":..., "data":...} envelope. Shared hosting can make ordinary
// outbound HTTPS calls like this one just fine — it's only raw RCON TCP
// ports that get blocked (see the README's Hetzner section).
function nicon_nitrado_get(string $token, string $path): array
{
    $ch = curl_init(NICON_NITRADO_BASE_URL . $path);
    curl_setopt_array($ch, [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_HTTPHEADER => ['Authorization: Bearer ' . $token],
        CURLOPT_TIMEOUT => 15,
    ]);
    $body = curl_exec($ch);
    $status = curl_getinfo($ch, CURLINFO_HTTP_CODE);
    curl_close($ch);

    if ($body === false) {
        throw new RuntimeException("request $path failed");
    }
    if ($status === 401 || $status === 403) {
        throw new RuntimeException('nitrado API token is invalid or expired');
    }
    if ($status !== 200) {
        throw new RuntimeException("unexpected status $status from $path");
    }

    $env = json_decode($body, true);
    if (!is_array($env) || ($env['status'] ?? '') !== 'success') {
        throw new RuntimeException("nitrado reported an error for $path");
    }
    return $env['data'] ?? [];
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

    foreach ($services as $svc) {
        $serviceId = (int) ($svc['id'] ?? 0);
        try {
            $data = nicon_nitrado_get($token, "/services/$serviceId/gameservers");
        } catch (RuntimeException $e) {
            continue; // one bad service shouldn't abort the whole sync
        }
        $gs = $data['gameserver'] ?? [];

        $gameHuman = (string) ($gs['game_human'] ?? '');
        $isRust = stripos($gameHuman, 'rust') !== false;
        $hasRcon = (bool) ($gs['game_specific']['features']['has_rcon'] ?? false);
        $rconPort = (int) ($gs['rcon_port'] ?? 0);
        $ip = (string) ($gs['ip'] ?? '');
        $hasConnectionInfo = $rconPort !== 0 && $ip !== '';
        $eligible = ($hasRcon || $isRust) && $hasConnectionInfo;
        if (!$eligible) {
            continue;
        }

        $protocol = $isRust ? 'webrcon' : 'source';
        $name = (string) ($gs['query']['server_name'] ?? '');
        if ($name === '') {
            $name = $gameHuman;
        }

        // Matches internal/store's UpsertNitradoServer: keyed on
        // (user_id, nitrado_service_id), never touches an existing
        // password_enc — Nitrado never gives us one to overwrite it with.
        $pdo->prepare('
            INSERT INTO servers (user_id, name, host, port, protocol, game, source, nitrado_service_id)
            VALUES (?, ?, ?, ?, ?, ?, \'nitrado\', ?)
            ON DUPLICATE KEY UPDATE name = VALUES(name), host = VALUES(host), port = VALUES(port),
              protocol = VALUES(protocol), game = VALUES(game)
        ')->execute([$userId, $name, $ip, $rconPort, $protocol, $gameHuman, $serviceId]);
    }

    nicon_handle_list_servers($userId);
}
