<?php
declare(strict_types=1);

// Mirrors register.php's rate limiting (same fixed-window/IP mechanism —
// see lib/ratelimit.php) — login had none before, unlike every other
// credential-guessing surface here (register, reset-password). Three
// buckets: a coarse per-IP ceiling against broad credential stuffing across
// many usernames, a tighter per-(IP, username) one against brute-forcing a
// single account from one IP, and a per-username-only one (no IP in the
// key) against the same attack spread across many IPs — the first two
// buckets alone give a fresh allowance to every new source IP, so a
// distributed/rotating-IP attacker isn't slowed by them at all.
const NICON_LOGIN_RATE_LIMIT = 20;         // per IP, per window
const NICON_LOGIN_USER_RATE_LIMIT = 10;    // per IP+username, per window
const NICON_LOGIN_ACCOUNT_RATE_LIMIT = 30; // per username regardless of IP, per window
const NICON_LOGIN_RATE_WINDOW = 900;       // 15 minutes

function nicon_handle_login(): void
{
    $req = nicon_json_body();
    $username = nicon_body_string($req, 'username');
    $password = nicon_body_string($req, 'password');
    if ($username === null || $password === null) return;

    $ipLimited = !nicon_rate_limit_allow('login', NICON_LOGIN_RATE_LIMIT, NICON_LOGIN_RATE_WINDOW);
    $userLimited = $username !== ''
        && !nicon_rate_limit_allow('login:' . strtolower($username), NICON_LOGIN_USER_RATE_LIMIT, NICON_LOGIN_RATE_WINDOW);
    $accountLimited = $username !== ''
        && !nicon_rate_limit_allow_global('login-account:' . strtolower($username), NICON_LOGIN_ACCOUNT_RATE_LIMIT, NICON_LOGIN_RATE_WINDOW);
    if ($ipLimited || $userLimited || $accountLimited) {
        header('Retry-After: ' . NICON_LOGIN_RATE_WINDOW);
        nicon_send_error('too many login attempts — try again later', 429);
        return;
    }

    if ($username === '' || $password === '') {
        nicon_send_error('username and password are required', 400);
        return;
    }
    if (strlen($password) > NICON_MAX_LOGIN_PASSWORD_BYTES) {
        nicon_send_error('invalid username or password', 401);
        return;
    }

    $pdo = nicon_db();
    $stmt = $pdo->prepare('SELECT id, password_hash, is_admin FROM users WHERE username = ?');
    $stmt->execute([$username]);
    $user = $stmt->fetch();

    $hash = $user ? $user['password_hash'] : NICON_DUMMY_PASSWORD_HASH;
    $validPassword = nicon_verify_password($password, $hash);
    if (!$user || !$validPassword) {
        nicon_audit_log($user ? (int) $user['id'] : null, 'login_failed', null, $username);
        nicon_send_error('invalid username or password', 401);
        return;
    }

    $token = nicon_generate_session_token();
    $pdo->prepare('INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, DATE_ADD(NOW(), INTERVAL ? SECOND))')
        ->execute([nicon_hash_token($token), $user['id'], NICON_SESSION_TTL_SECONDS]);
    nicon_audit_log((int) $user['id'], 'login_success');

    nicon_send_json(['token' => $token, 'is_admin' => (bool) $user['is_admin']]);
}

function nicon_handle_logout(): void
{
    $token = nicon_bearer_token();
    if ($token !== '') {
        nicon_db()->prepare('DELETE FROM sessions WHERE token = ?')->execute([nicon_hash_token($token)]);
    }
    http_response_code(204);
}
