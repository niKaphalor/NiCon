<?php
declare(strict_types=1);

const NICON_REGISTER_RATE_LIMIT = 3;   // per window, mirrors registerRateBurst
const NICON_REGISTER_RATE_WINDOW = 900; // 15 minutes

// nicon_handle_register is the self-service signup. Requires
// consent_accepted — see internal/relay/handlers_auth.go's handleRegister
// for why (not the legal basis for processing, just making sure nobody
// ends up with an account without ever seeing what's stored and why).
function nicon_handle_register(): void
{
    if (!nicon_rate_limit_allow('register', NICON_REGISTER_RATE_LIMIT, NICON_REGISTER_RATE_WINDOW)) {
        header('Retry-After: ' . NICON_REGISTER_RATE_WINDOW);
        nicon_send_error('too many registration attempts from this address — try again later', 429);
        return;
    }

    $req = nicon_json_body();
    $username = trim((string) ($req['username'] ?? ''));
    $password = (string) ($req['password'] ?? '');
    $consent = (bool) ($req['consent_accepted'] ?? false);

    if ($username === '' || $password === '') {
        nicon_send_error('username and password are required', 400);
        return;
    }
    if (!$consent) {
        nicon_send_error('you must accept the privacy policy to register', 400);
        return;
    }
    if (!preg_match(NICON_USERNAME_PATTERN, $username)) {
        nicon_send_error('username must be 3-32 characters: letters, numbers, underscore, hyphen, or dot', 400);
        return;
    }
    if (strlen($password) < NICON_MIN_PASSWORD_LENGTH) {
        nicon_send_error('password must be at least 8 characters', 400);
        return;
    }

    $passwordHash = nicon_hash_password($password);
    $recoveryCode = nicon_generate_recovery_code();
    $recoveryCodeHash = nicon_hash_password(nicon_normalize_recovery_code($recoveryCode));

    $pdo = nicon_db();
    try {
        $pdo->prepare('INSERT INTO users (username, password_hash, recovery_code_hash) VALUES (?, ?, ?)')
            ->execute([$username, $passwordHash, $recoveryCodeHash]);
    } catch (PDOException $e) {
        if ($e->getCode() === '23000') {
            nicon_send_error('username is already taken', 409);
            return;
        }
        throw $e;
    }
    $userId = (int) $pdo->lastInsertId();

    $token = nicon_generate_session_token();
    $pdo->prepare('INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, DATE_ADD(NOW(), INTERVAL ? SECOND))')
        ->execute([nicon_hash_token($token), $userId, NICON_SESSION_TTL_SECONDS]);

    nicon_send_json([
        'token' => $token,
        'recovery_code' => $recoveryCode,
        'is_admin' => false,
    ]);
}
