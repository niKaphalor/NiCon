<?php
declare(strict_types=1);

function nicon_handle_login(): void
{
    $req = nicon_json_body();
    $username = $req['username'] ?? '';
    $password = $req['password'] ?? '';
    if ($username === '' || $password === '') {
        nicon_send_error('username and password are required', 400);
        return;
    }

    $pdo = nicon_db();
    $stmt = $pdo->prepare('SELECT id, password_hash, is_admin FROM users WHERE username = ?');
    $stmt->execute([$username]);
    $user = $stmt->fetch();

    if (!$user || !nicon_verify_password($password, $user['password_hash'])) {
        nicon_send_error('invalid username or password', 401);
        return;
    }

    $token = nicon_generate_session_token();
    $pdo->prepare('INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, DATE_ADD(NOW(), INTERVAL ? SECOND))')
        ->execute([$token, $user['id'], NICON_SESSION_TTL_SECONDS]);

    nicon_send_json(['token' => $token, 'is_admin' => (bool) $user['is_admin']]);
}

function nicon_handle_logout(): void
{
    $token = nicon_bearer_token();
    if ($token !== '') {
        nicon_db()->prepare('DELETE FROM sessions WHERE token = ?')->execute([$token]);
    }
    http_response_code(204);
}
