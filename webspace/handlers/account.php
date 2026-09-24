<?php
declare(strict_types=1);

// nicon_handle_get_account is small, deliberately: just the one bit of
// account state the frontend needs to decide how to present the Nitrado
// sync form (token field required vs. optional-with-a-saved-one).
function nicon_handle_get_account(int $userId): void
{
    $stmt = nicon_db()->prepare('SELECT nitrado_token_enc FROM users WHERE id = ?');
    $stmt->execute([$userId]);
    nicon_send_json(['has_nitrado_token' => $stmt->fetchColumn() !== null]);
}

// nicon_handle_delete_nitrado_token: self-service removal of the saved
// Nitrado token, independent of deleting the whole account — Art. 17
// GDPR applies to this stored credential same as to an RCON password.
function nicon_handle_delete_nitrado_token(int $userId): void
{
    nicon_db()->prepare('UPDATE users SET nitrado_token_enc = NULL WHERE id = ?')->execute([$userId]);
    http_response_code(204);
}

// nicon_handle_delete_account is the self-service "right to erasure" path:
// permanently deletes the authenticated account. sessions and servers
// cascade with it via ON DELETE CASCADE.
function nicon_handle_delete_account(int $userId): void
{
    nicon_db()->prepare('DELETE FROM users WHERE id = ?')->execute([$userId]);
    http_response_code(204);
}

// nicon_handle_change_password is the self-service "I know my current
// password and want a new one" path, distinct from reset-password's
// recovery-code flow for when you don't. Requires the current password
// (not just a valid session) so a moment of unattended access to an
// unlocked browser tab can't be used to lock the real owner out.
function nicon_handle_change_password(int $userId): void
{
    $req = nicon_json_body();
    $currentPassword = (string) ($req['current_password'] ?? '');
    $newPassword = (string) ($req['new_password'] ?? '');

    if ($currentPassword === '' || $newPassword === '') {
        nicon_send_error('current_password and new_password are required', 400);
        return;
    }
    if (strlen($newPassword) < NICON_MIN_PASSWORD_LENGTH) {
        nicon_send_error('password must be at least 8 characters', 400);
        return;
    }

    $pdo = nicon_db();
    $stmt = $pdo->prepare('SELECT password_hash FROM users WHERE id = ?');
    $stmt->execute([$userId]);
    $hash = $stmt->fetchColumn();
    if ($hash === false || !nicon_verify_password($currentPassword, $hash)) {
        nicon_send_error('current password is incorrect', 401);
        return;
    }

    $newHash = nicon_hash_password($newPassword);
    $currentTokenHash = nicon_hash_token(nicon_bearer_token());

    $pdo->beginTransaction();
    try {
        $pdo->prepare('UPDATE users SET password_hash = ? WHERE id = ?')->execute([$newHash, $userId]);
        // Signs out every other session — the recovery-code reset does the
        // same, just without keeping the session making this request alive.
        $pdo->prepare('DELETE FROM sessions WHERE user_id = ? AND token != ?')->execute([$userId, $currentTokenHash]);
        $pdo->commit();
    } catch (Throwable $e) {
        $pdo->rollBack();
        throw $e;
    }
    http_response_code(204);
}

// nicon_handle_change_username also requires the current password, for
// the same reason as nicon_handle_change_password — changing the
// identity you log in with is exactly the kind of action a compromised
// unattended session shouldn't be able to take unchallenged.
function nicon_handle_change_username(int $userId): void
{
    $req = nicon_json_body();
    $currentPassword = (string) ($req['current_password'] ?? '');
    $newUsername = trim((string) ($req['new_username'] ?? ''));

    if ($currentPassword === '' || $newUsername === '') {
        nicon_send_error('current_password and new_username are required', 400);
        return;
    }
    if (!preg_match(NICON_USERNAME_PATTERN, $newUsername)) {
        nicon_send_error('username must be 3-32 characters: letters, numbers, underscore, hyphen, or dot', 400);
        return;
    }

    $pdo = nicon_db();
    $stmt = $pdo->prepare('SELECT password_hash FROM users WHERE id = ?');
    $stmt->execute([$userId]);
    $hash = $stmt->fetchColumn();
    if ($hash === false || !nicon_verify_password($currentPassword, $hash)) {
        nicon_send_error('current password is incorrect', 401);
        return;
    }

    try {
        $pdo->prepare('UPDATE users SET username = ? WHERE id = ?')->execute([$newUsername, $userId]);
    } catch (PDOException $e) {
        if ($e->getCode() === '23000') {
            nicon_send_error('username is already taken', 409);
            return;
        }
        throw $e;
    }
    nicon_send_json(['username' => $newUsername]);
}
