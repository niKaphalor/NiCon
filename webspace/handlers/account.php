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

// NICON_EXPORT_ACTIVITY_LIMIT bounds nicon_handle_export_account_data's
// activity section — a generous ceiling meant to cover a real account's
// full history within the audit retention window (see lib/audit.php),
// not an artificial "just the recent stuff" cap like GET /audit-log's 100.
const NICON_EXPORT_ACTIVITY_LIMIT = 5000;

// nicon_handle_export_account_data is the self-service Art. 15/20 GDPR
// path: everything this account's own data belongs to, as one JSON
// document a user can download without asking the operator first. Secrets
// are deliberately excluded the same way they're excluded everywhere else
// in this API — no password hash, no recovery-code hash, no RCON
// passwords or Nitrado token, only whether one is set.
function nicon_handle_export_account_data(int $userId): void
{
    $pdo = nicon_db();

    $userStmt = $pdo->prepare('SELECT username, is_admin, created_at, nitrado_token_enc FROM users WHERE id = ?');
    $userStmt->execute([$userId]);
    $user = $userStmt->fetch();
    if (!$user) {
        nicon_send_error('account not found', 404);
        return;
    }

    $serversStmt = $pdo->prepare('
        SELECT id, name, host, port, password_enc, protocol, query_protocol, query_port, game, source,
               health_ok, health_checked_at, health_latency_ms, health_error,
               nitrado_game_code, nitrado_game_icon_url
        FROM servers WHERE user_id = ? ORDER BY name');
    $serversStmt->execute([$userId]);
    $servers = array_map('nicon_server_response', $serversStmt->fetchAll());

    $templatesStmt = $pdo->prepare('SELECT id, name, command FROM command_templates WHERE user_id = ? ORDER BY name');
    $templatesStmt->execute([$userId]);
    $commandTemplates = array_map('nicon_command_template_response', $templatesStmt->fetchAll());

    $rulesStmt = $pdo->prepare('SELECT id, pattern, action, enabled FROM moderation_rules WHERE user_id = ? ORDER BY id');
    $rulesStmt->execute([$userId]);
    $moderationRules = array_map('nicon_moderation_rule_response', $rulesStmt->fetchAll());

    $accountRowsStmt = $pdo->prepare('
        SELECT a.action, a.detail, a.created_at, actor.username AS actor_username, target.username AS target_username
        FROM audit_log a
        LEFT JOIN users actor ON actor.id = a.user_id
        LEFT JOIN users target ON target.id = a.target_user_id
        WHERE a.user_id = ? OR a.target_user_id = ?
        ORDER BY a.created_at DESC
        LIMIT ' . NICON_EXPORT_ACTIVITY_LIMIT
    );
    $accountRowsStmt->execute([$userId, $userId]);
    $accountRows = array_map(static function (array $row): array {
        return [
            'kind' => 'account',
            'action' => $row['action'],
            'detail' => $row['detail'],
            'actor_username' => $row['actor_username'],
            'target_username' => $row['target_username'],
            'created_at' => gmdate('Y-m-d\TH:i:s\Z', strtotime($row['created_at'])),
        ];
    }, $accountRowsStmt->fetchAll());
    $activity = nicon_merge_audit_rows($accountRows, nicon_rcon_audit_rows($userId, NICON_EXPORT_ACTIVITY_LIMIT), NICON_EXPORT_ACTIVITY_LIMIT);

    nicon_send_json([
        'exported_at' => gmdate('Y-m-d\TH:i:s\Z'),
        'account' => [
            'username' => $user['username'],
            'is_admin' => (bool) $user['is_admin'],
            'created_at' => gmdate('Y-m-d\TH:i:s\Z', strtotime($user['created_at'])),
            'has_nitrado_token' => $user['nitrado_token_enc'] !== null,
        ],
        'servers' => $servers,
        'command_templates' => $commandTemplates,
        'moderation_rules' => $moderationRules,
        'activity' => $activity,
    ]);
}

// nicon_handle_delete_nitrado_token: self-service removal of the saved
// Nitrado token, independent of deleting the whole account — Art. 17
// GDPR applies to this stored credential same as to an RCON password.
function nicon_handle_delete_nitrado_token(int $userId): void
{
    $pdo = nicon_db();
    try {
        $token = nicon_nitrado_saved_token($pdo, $userId);
        if ($token !== '') nicon_nitrado_cache_invalidate($token);
    } catch (RuntimeException $e) {
        // A damaged legacy credential must not prevent the user from
        // erasing it. Its cache entries expire after at most 60 seconds.
    }
    $pdo->prepare('UPDATE users SET nitrado_token_enc = NULL WHERE id = ?')->execute([$userId]);
    http_response_code(204);
}

// nicon_handle_delete_account is the self-service "right to erasure" path:
// permanently deletes the authenticated account. sessions and servers
// cascade with it via ON DELETE CASCADE.
function nicon_handle_delete_account(int $userId): void
{
    $pdo = nicon_db();
    $stmt = $pdo->prepare('SELECT username FROM users WHERE id = ?');
    $stmt->execute([$userId]);
    $username = $stmt->fetchColumn();

    try {
        $token = nicon_nitrado_saved_token($pdo, $userId);
        if ($token !== '') nicon_nitrado_cache_invalidate($token);
    } catch (RuntimeException $e) {
        // Account deletion remains possible even if an old encrypted token
        // can no longer be decrypted; any orphaned cache expires quickly.
    }

    // Logged before, not after, deleting the row: audit_log.user_id has a
    // foreign key on users.id, so inserting a row pointing at $userId
    // after that user no longer exists would fail outright. The FK's own
    // ON DELETE SET NULL (see schema.sql) nulls it out the moment the
    // DELETE below commits — detail is what keeps this row readable after
    // that ("someone named X deleted their account"), not user_id.
    nicon_audit_log($userId, 'account_deleted', null, $username !== false ? $username : null);
    $pdo->prepare('DELETE FROM users WHERE id = ?')->execute([$userId]);
    http_response_code(204);
}

// nicon_handle_change_password is the self-service "I know my current
// password and want a new one" path, distinct from reset-password's
// recovery-code flow for when you don't. Requires the current password
// (not just a valid session) so a moment of unattended access to an
// unlocked browser tab can't be used to lock the real owner out.
const NICON_ACCOUNT_CREDENTIAL_RATE_LIMIT = 10;  // per account, per window
const NICON_ACCOUNT_CREDENTIAL_RATE_WINDOW = 900; // 15 minutes

function nicon_handle_change_password(int $userId): void
{
    // Requiring current_password (see the comment above) only protects
    // against unattended access if guessing it is also rate-limited —
    // otherwise a valid session alone gives an attacker unlimited guesses
    // at the one secret this endpoint gates. Scoped per-account, not
    // per-IP: the thing being brute-forced here is this specific user's
    // password, from a session that's already authenticated as them.
    if (!nicon_rate_limit_allow('change-password:' . $userId, NICON_ACCOUNT_CREDENTIAL_RATE_LIMIT, NICON_ACCOUNT_CREDENTIAL_RATE_WINDOW)) {
        header('Retry-After: ' . NICON_ACCOUNT_CREDENTIAL_RATE_WINDOW);
        nicon_send_error('too many attempts — try again later', 429);
        return;
    }

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
    nicon_audit_log($userId, 'password_changed');
    http_response_code(204);
}

// nicon_handle_change_username also requires the current password, for
// the same reason as nicon_handle_change_password — changing the
// identity you log in with is exactly the kind of action a compromised
// unattended session shouldn't be able to take unchallenged.
function nicon_handle_change_username(int $userId): void
{
    // Same reasoning as nicon_handle_change_password's rate limit above —
    // shares its bucket/limits, so guessing the current password via
    // whichever of these two endpoints counts against the same allowance.
    if (!nicon_rate_limit_allow('change-password:' . $userId, NICON_ACCOUNT_CREDENTIAL_RATE_LIMIT, NICON_ACCOUNT_CREDENTIAL_RATE_WINDOW)) {
        header('Retry-After: ' . NICON_ACCOUNT_CREDENTIAL_RATE_WINDOW);
        nicon_send_error('too many attempts — try again later', 429);
        return;
    }

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
    nicon_audit_log($userId, 'username_changed', null, $newUsername);
    nicon_send_json(['username' => $newUsername]);
}
