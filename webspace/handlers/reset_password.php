<?php
declare(strict_types=1);

const NICON_RESET_RATE_LIMIT = 2;    // mirrors resetPasswordRateBurst
const NICON_RESET_RATE_WINDOW = 900; // 15 minutes

// nicon_handle_reset_password is the self-service recovery path for a
// forgotten password. Unauthenticated by design — see
// internal/relay/handlers_auth.go's handleResetPassword. A wrong username
// and a wrong recovery code return the identical error AND (via
// NICON_DUMMY_PASSWORD_HASH below) take about the same time to answer, so
// this can't be used to enumerate which usernames exist either by response
// content or by response timing.
function nicon_handle_reset_password(): void
{
    if (!nicon_rate_limit_allow('reset-password', NICON_RESET_RATE_LIMIT, NICON_RESET_RATE_WINDOW)) {
        header('Retry-After: ' . NICON_RESET_RATE_WINDOW);
        nicon_send_error('too many reset attempts from this address — try again later', 429);
        return;
    }

    $req = nicon_json_body();
    $username = (string) ($req['username'] ?? '');
    $recoveryCode = (string) ($req['recovery_code'] ?? '');
    $newPassword = (string) ($req['new_password'] ?? '');

    if ($username === '' || $recoveryCode === '' || $newPassword === '') {
        nicon_send_error('username, recovery_code, and new_password are required', 400);
        return;
    }
    if (strlen($newPassword) < NICON_MIN_PASSWORD_LENGTH) {
        nicon_send_error('password must be at least 8 characters', 400);
        return;
    }

    $pdo = nicon_db();
    $stmt = $pdo->prepare('SELECT id, recovery_code_hash FROM users WHERE username = ?');
    $stmt->execute([$username]);
    $user = $stmt->fetch();

    // Always run the bcrypt compare, even for a username that doesn't
    // exist (against NICON_DUMMY_PASSWORD_HASH, which no code will ever
    // match) — see lib/crypto.php's comment. Skipping it via an early
    // return on `!$user` would make "no such account" answer faster than
    // "found the account, wrong code."
    $hash = ($user && $user['recovery_code_hash']) ? $user['recovery_code_hash'] : NICON_DUMMY_PASSWORD_HASH;
    $validCode = nicon_verify_password(nicon_normalize_recovery_code($recoveryCode), $hash);
    if (!$user || !$user['recovery_code_hash'] || !$validCode) {
        nicon_send_error('invalid username or recovery code', 401);
        return;
    }

    $newHash = nicon_hash_password($newPassword);
    $newRecoveryCode = nicon_generate_recovery_code();
    $newRecoveryCodeHash = nicon_hash_password(nicon_normalize_recovery_code($newRecoveryCode));

    $pdo->beginTransaction();
    try {
        $pdo->prepare('UPDATE users SET password_hash = ?, recovery_code_hash = ? WHERE id = ?')
            ->execute([$newHash, $newRecoveryCodeHash, $user['id']]);
        $pdo->prepare('DELETE FROM sessions WHERE user_id = ?')->execute([$user['id']]);
        $pdo->commit();
    } catch (Throwable $e) {
        $pdo->rollBack();
        throw $e;
    }

    nicon_send_json(['new_recovery_code' => $newRecoveryCode]);
}
