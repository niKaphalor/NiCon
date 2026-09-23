<?php
declare(strict_types=1);

// nicon_server_response is what a server looks like over the API —
// everything except the actual password, same as
// internal/relay/handlers_servers.go's serverResponse.
function nicon_server_response(array $row): array
{
    return [
        'id' => (int) $row['id'],
        'name' => $row['name'],
        'host' => $row['host'],
        'port' => (int) $row['port'],
        'protocol' => $row['protocol'],
        'game' => $row['game'],
        'source' => $row['source'],
        'has_password' => $row['password_enc'] !== null,
    ];
}

function nicon_handle_list_servers(int $userId): void
{
    $stmt = nicon_db()->prepare('
        SELECT id, name, host, port, password_enc, protocol, game, source
        FROM servers WHERE user_id = ? ORDER BY name');
    $stmt->execute([$userId]);
    $servers = array_map('nicon_server_response', $stmt->fetchAll());
    nicon_send_json($servers);
}

function nicon_handle_create_server(int $userId): void
{
    $req = nicon_json_body();
    $name = (string) ($req['name'] ?? '');
    $host = (string) ($req['host'] ?? '');
    $port = (int) ($req['port'] ?? 0);
    $password = (string) ($req['password'] ?? '');
    $protocol = (string) ($req['protocol'] ?? '') ?: 'source';

    if ($name === '' || $host === '' || $port <= 0) {
        nicon_send_error('name, host, and port are required', 400);
        return;
    }

    $pdo = nicon_db();
    $pdo->prepare('
        INSERT INTO servers (user_id, name, host, port, password_enc, protocol, source)
        VALUES (?, ?, ?, ?, ?, ?, ?)
    ')->execute([$userId, $name, $host, $port, nicon_encrypt_password($password), $protocol, 'manual']);
    $id = (int) $pdo->lastInsertId();

    $stmt = $pdo->prepare('SELECT id, name, host, port, password_enc, protocol, game, source FROM servers WHERE id = ?');
    $stmt->execute([$id]);
    nicon_send_json(nicon_server_response($stmt->fetch()));
}

function nicon_handle_set_server_password(int $userId, int $serverId): void
{
    $req = nicon_json_body();
    $password = (string) ($req['password'] ?? '');
    if ($password === '') {
        nicon_send_error('password is required', 400);
        return;
    }

    $stmt = nicon_db()->prepare('UPDATE servers SET password_enc = ? WHERE id = ? AND user_id = ?');
    $stmt->execute([nicon_encrypt_password($password), $serverId, $userId]);
    if ($stmt->rowCount() === 0) {
        nicon_send_error('404 page not found', 404);
        return;
    }
    http_response_code(204);
}

function nicon_handle_delete_server(int $userId, int $serverId): void
{
    $stmt = nicon_db()->prepare('DELETE FROM servers WHERE id = ? AND user_id = ?');
    $stmt->execute([$serverId, $userId]);
    if ($stmt->rowCount() === 0) {
        nicon_send_error('404 page not found', 404);
        return;
    }
    http_response_code(204);
}
