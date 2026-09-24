<?php
declare(strict_types=1);

// Mirrors register.php's rate limiting (same fixed-window/IP mechanism —
// see lib/ratelimit.php) — login had none before, unlike every other
// credential-guessing surface here (register, reset-password). Two
// buckets: a coarse per-IP ceiling against broad credential stuffing
// across many usernames, and a tighter per-(IP, username) one against
// brute-forcing a single account.
const NICON_LOGIN_RATE_LIMIT = 20;      // per IP, per window
const NICON_LOGIN_USER_RATE_LIMIT = 10; // per IP+username, per window
const NICON_LOGIN_RATE_WINDOW = 900;    // 15 minutes

// A fixed bcrypt hash of a string nobody's password will ever be,
// compared against when the username doesn't exist. bcrypt's compare is
// what dominates this request's latency, so skipping it for an unknown
// username (as returning early on `!$user` alone would) makes "wrong
// password" and "no such account" distinguishable by response time — this
// keeps both paths doing the same amount of work.
const NICON_DUMMY_PASSWORD_HASH = '$2y$12$pB.2xa.VMH4BQtvWWpyLBu1tQJ7ai2DpOk6nZX8429cBZrSmiJX/G';

function nicon_handle_login(): void
{
    $req = nicon_json_body();
    $username = (string) ($req['username'] ?? '');
    $password = (string) ($req['password'] ?? '');

    $ipLimited = !nicon_rate_limit_allow('login', NICON_LOGIN_RATE_LIMIT, NICON_LOGIN_RATE_WINDOW);
    $userLimited = $username !== ''
        && !nicon_rate_limit_allow('login:' . strtolower($username), NICON_LOGIN_USER_RATE_LIMIT, NICON_LOGIN_RATE_WINDOW);
    if ($ipLimited || $userLimited) {
        header('Retry-After: ' . NICON_LOGIN_RATE_WINDOW);
        nicon_send_error('too many login attempts — try again later', 429);
        return;
    }

    if ($username === '' || $password === '') {
        nicon_send_error('username and password are required', 400);
        return;
    }

    $pdo = nicon_db();
    $stmt = $pdo->prepare('SELECT id, password_hash, is_admin FROM users WHERE username = ?');
    $stmt->execute([$username]);
    $user = $stmt->fetch();

    $hash = $user ? $user['password_hash'] : NICON_DUMMY_PASSWORD_HASH;
    $validPassword = nicon_verify_password($password, $hash);
    if (!$user || !$validPassword) {
        nicon_send_error('invalid username or password', 401);
        return;
    }

    $token = nicon_generate_session_token();
    $pdo->prepare('INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, DATE_ADD(NOW(), INTERVAL ? SECOND))')
        ->execute([nicon_hash_token($token), $user['id'], NICON_SESSION_TTL_SECONDS]);

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
