<?php
declare(strict_types=1);
require_once __DIR__ . '/db.php';
require_once __DIR__ . '/http.php';

// How long a login stays valid — same as internal/auth.SessionTTLSeconds.
// There's no "remember me" distinction; every login gets the same lifetime.
const NICON_SESSION_TTL_SECONDS = 7 * 24 * 3600;

// Same validation internal/auth.go applies.
const NICON_MIN_PASSWORD_LENGTH = 8;
const NICON_USERNAME_PATTERN = '/^[a-zA-Z0-9_.-]{3,32}$/';

// nicon_authenticate_request resolves the Authorization header to a user
// id, or sends a 401 and returns null. Mirrors
// internal/relay/relay.go's authenticateRequest.
function nicon_authenticate_request(): ?int
{
    $token = nicon_bearer_token();
    if ($token === '') {
        nicon_send_error('missing bearer token', 401);
        return null;
    }

    $stmt = nicon_db()->prepare('SELECT user_id FROM sessions WHERE token = ? AND expires_at > NOW()');
    $stmt->execute([$token]);
    $userId = $stmt->fetchColumn();
    if ($userId === false) {
        nicon_send_error('unauthorized', 401);
        return null;
    }
    return (int) $userId;
}

// nicon_require_admin authenticates, then additionally checks is_admin.
// Mirrors internal/relay/handlers_admin.go's requireAdmin.
function nicon_require_admin(): ?int
{
    $userId = nicon_authenticate_request();
    if ($userId === null) {
        return null;
    }
    $stmt = nicon_db()->prepare('SELECT is_admin FROM users WHERE id = ?');
    $stmt->execute([$userId]);
    $isAdmin = $stmt->fetchColumn();
    if ($isAdmin === false) {
        nicon_send_error('internal error', 500);
        return null;
    }
    if (!$isAdmin) {
        nicon_send_error('admin access required', 403);
        return null;
    }
    return $userId;
}
