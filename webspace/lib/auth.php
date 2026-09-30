<?php
declare(strict_types=1);
require_once __DIR__ . '/db.php';
require_once __DIR__ . '/http.php';

// How long a login stays valid — same as internal/auth.SessionTTLSeconds.
// There's no "remember me" distinction; every login gets the same lifetime.
const NICON_SESSION_TTL_SECONDS = 7 * 24 * 3600;

// Password policy — main.go's runAddUser applies the same numbers.
//
// Minimum 15 characters: NIST SP 800-63B-4's floor for passwords that are
// the only authentication factor (there is no MFA here). Maximum 72 BYTES:
// bcrypt silently ignores everything past byte 72 in PHP (two different
// long passwords then hash identically) while Go's bcrypt rejects them
// outright, so the two sides disagreed. One byte limit, enforced wherever a
// password is set, removes both problems; 72 bytes still admits 64+
// ASCII characters, the length NIST asks verifiers to accept. Login
// deliberately does NOT enforce the maximum: accounts created before this
// limit existed may have longer passwords and must keep working (PHP
// truncates identically at hash and verify time, so they still match).
const NICON_MIN_PASSWORD_LENGTH = 15;
const NICON_MAX_PASSWORD_BYTES = 72;
// Login-only sanity cap so a 256 KiB "password" can't be fed to bcrypt.
const NICON_MAX_LOGIN_PASSWORD_BYTES = 1024;
const NICON_USERNAME_PATTERN = '/^[a-zA-Z0-9_.-]{3,32}$/';

// Shared by every endpoint that gates on "prove you know the current
// password": guessing it through any of them counts against one allowance.
const NICON_ACCOUNT_CREDENTIAL_RATE_LIMIT = 10;  // per account, per window
const NICON_ACCOUNT_CREDENTIAL_RATE_WINDOW = 900; // 15 minutes

// Admin actions require a session younger than this, regardless of the
// (7-day) lifetime a normal session has: a stolen or forgotten admin
// session is far more dangerous than an ordinary one.
const NICON_ADMIN_SESSION_MAX_AGE_SECONDS = 8 * 3600;

// nicon_password_policy_error returns a client-facing message if
// $password may not be SET (registration, change, reset), or null if it is
// acceptable.
function nicon_password_policy_error(string $password, string $username = ''): ?string
{
    if (nicon_char_length($password) < NICON_MIN_PASSWORD_LENGTH) {
        return 'password must be at least ' . NICON_MIN_PASSWORD_LENGTH . ' characters';
    }
    if (strlen($password) > NICON_MAX_PASSWORD_BYTES) {
        return 'password must be at most ' . NICON_MAX_PASSWORD_BYTES . ' bytes (about 64 characters; non-ASCII characters take more than one byte)';
    }
    if ($username !== '' && strcasecmp($password, $username) === 0) {
        return 'password must not be the same as your username';
    }
    if (strlen(count_chars($password, 3)) === 1) {
        return 'password must not be a single repeated character';
    }
    if (nicon_password_is_breached($password)) {
        return 'this password appears in known data breaches — please choose another one';
    }
    return null;
}

// nicon_password_is_breached checks the Have I Been Pwned range API using
// k-anonymity: only the first 5 hex characters of the password's SHA-1
// ever leave this server, never the password or its full hash. Opt-in
// (config 'password_breach_check' => true) because it makes an outbound
// request to a third party on every password change and must be mentioned
// in the privacy policy. Fails open: an unreachable service never blocks
// registration.
function nicon_password_is_breached(string $password): bool
{
    if (empty(nicon_config()['password_breach_check'])) {
        return false;
    }
    $sha1 = strtoupper(sha1($password));
    $prefix = substr($sha1, 0, 5);
    $suffix = substr($sha1, 5);
    $context = stream_context_create([
        'http' => ['timeout' => 3, 'header' => "Add-Padding: true\r\nUser-Agent: NiCon\r\n"],
    ]);
    $body = @file_get_contents('https://api.pwnedpasswords.com/range/' . $prefix, false, $context);
    if (!is_string($body)) {
        return false;
    }
    foreach (explode("\n", $body) as $line) {
        [$hashSuffix, $count] = array_pad(explode(':', trim($line), 2), 2, '0');
        if (hash_equals($suffix, strtoupper($hashSuffix)) && (int) $count > 0) {
            return true;
        }
    }
    return false;
}

// nicon_require_current_password is the "step-up" check for destructive or
// credential-level actions: a valid session alone (a stolen token, an
// unattended unlocked tab) is not enough, the caller must also supply
// `current_password` in the JSON body. Sends the error response and
// returns false on failure. Shares change-password's rate limit bucket.
function nicon_require_current_password(int $userId, array $req): bool
{
    if (!nicon_rate_limit_allow('change-password:' . $userId, NICON_ACCOUNT_CREDENTIAL_RATE_LIMIT, NICON_ACCOUNT_CREDENTIAL_RATE_WINDOW)) {
        header('Retry-After: ' . NICON_ACCOUNT_CREDENTIAL_RATE_WINDOW);
        nicon_send_error('too many attempts — try again later', 429);
        return false;
    }
    $current = (string) ($req['current_password'] ?? '');
    if ($current === '') {
        nicon_send_error('current_password is required', 400);
        return false;
    }
    if (strlen($current) > NICON_MAX_LOGIN_PASSWORD_BYTES) {
        nicon_send_error('current password is incorrect', 403);
        return false;
    }
    $stmt = nicon_db()->prepare('SELECT password_hash FROM users WHERE id = ?');
    $stmt->execute([$userId]);
    $hash = $stmt->fetchColumn();
    if ($hash === false || !nicon_verify_password($current, $hash)) {
        nicon_send_error('current password is incorrect', 403);
        return false;
    }
    return true;
}

// nicon_delete_user_guarded deletes a user without ever removing the last
// admin, safely under concurrency. The count and the delete used to run
// unlocked, so two admins deleting each other (or one admin and a
// self-deleting one) in parallel could both see "another admin still
// exists" and remove every admin. When the target is an admin, the whole
// admin set is locked (in id order, so two such transactions can't
// deadlock) before the count is taken; the second transaction then blocks
// until the first commits and sees the true count.
//
// $beforeDelete(string $username) runs inside the transaction, before the
// DELETE — audit_log has foreign keys on users.id, so the entry has to be
// written while the row still exists (see account.php). Returns 'ok',
// 'not_found' or 'last_admin'.
function nicon_delete_user_guarded(int $targetId, callable $beforeDelete): string
{
    $pdo = nicon_db();
    $peek = $pdo->prepare('SELECT is_admin FROM users WHERE id = ?');
    $peek->execute([$targetId]);
    $peeked = $peek->fetchColumn();
    if ($peeked === false) {
        return 'not_found';
    }

    $pdo->beginTransaction();
    try {
        if ($peeked) {
            $adminIds = $pdo->query('SELECT id FROM users WHERE is_admin = 1 ORDER BY id FOR UPDATE')->fetchAll(PDO::FETCH_COLUMN);
            if (in_array((string) $targetId, array_map('strval', $adminIds), true) && count($adminIds) <= 1) {
                $pdo->rollBack();
                return 'last_admin';
            }
        }
        $row = $pdo->prepare('SELECT username FROM users WHERE id = ? FOR UPDATE');
        $row->execute([$targetId]);
        $username = $row->fetchColumn();
        if ($username === false) {
            $pdo->rollBack();
            return 'not_found';
        }
        $beforeDelete((string) $username);
        $pdo->prepare('DELETE FROM users WHERE id = ?')->execute([$targetId]);
        $pdo->commit();
        return 'ok';
    } catch (Throwable $e) {
        if ($pdo->inTransaction()) {
            $pdo->rollBack();
        }
        throw $e;
    }
}

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
    $stmt->execute([nicon_hash_token($token)]);
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
    $ageStmt = nicon_db()->prepare('SELECT TIMESTAMPDIFF(SECOND, created_at, NOW()) FROM sessions WHERE token = ?');
    $ageStmt->execute([nicon_hash_token(nicon_bearer_token())]);
    $age = $ageStmt->fetchColumn();
    if ($age === false || (int) $age > NICON_ADMIN_SESSION_MAX_AGE_SECONDS) {
        nicon_send_error('admin session expired — please sign in again', 401);
        return null;
    }
    return $userId;
}
