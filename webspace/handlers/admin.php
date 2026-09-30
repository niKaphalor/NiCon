<?php
declare(strict_types=1);

// nicon_handle_admin_list_users mirrors
// internal/relay/handlers_admin.go's handleAdminListUsers — returns only
// account metadata (never password/recovery-code hashes, never another
// account's server details).
function nicon_handle_admin_list_users(int $adminId): void
{
    $stmt = nicon_db()->query('
        SELECT u.id, u.username, u.created_at, u.is_admin, COUNT(s.id) AS server_count
        FROM users u
        LEFT JOIN servers s ON s.user_id = u.id
        GROUP BY u.id, u.username, u.created_at, u.is_admin
        ORDER BY u.created_at DESC');

    $users = array_map(static function (array $row): array {
        return [
            'id' => (int) $row['id'],
            'username' => $row['username'],
            'created_at' => gmdate('Y-m-d\TH:i:s\Z', strtotime($row['created_at'])),
            'is_admin' => (bool) $row['is_admin'],
            'server_count' => (int) $row['server_count'],
        ];
    }, $stmt->fetchAll());

    nicon_send_json($users);
}

function nicon_handle_admin_delete_user(int $adminId, int $targetId): void
{
    if ($targetId === $adminId) {
        nicon_send_error('use your own account settings to delete your account, not the admin panel', 400);
        return;
    }

    // Step-up: the ADMIN's own password, on top of the (max 8 h old) session.
    if (!nicon_require_current_password($adminId, nicon_json_body())) {
        return;
    }

    // Deleting the last admin would lock everyone out of this instance's
    // admin panel with no way back in short of a direct database edit;
    // nicon_delete_user_guarded makes that check race-free. It also logs
    // before deleting (audit_log.target_user_id has a foreign key on
    // users.id, so an entry pointing at $targetId can't be written once
    // that row is gone).
    $result = nicon_delete_user_guarded($targetId, static function (string $username) use ($adminId, $targetId): void {
        nicon_audit_log($adminId, 'admin_user_deleted', $targetId, $username);
    });
    if ($result === 'last_admin') {
        nicon_send_error('cannot delete the only remaining admin account', 400);
        return;
    }
    if ($result === 'not_found') {
        nicon_send_error('404 page not found', 404);
        return;
    }
    http_response_code(204);
}

// nicon_handle_admin_regenerate_recovery_code is the admin-side
// equivalent of the `gen-recovery-code` CLI command: for when a user has
// lost their code and can't reach the relay operator's terminal. The
// admin is responsible for relaying the new code to that user themselves
// — there's no email address on file to send it to.
function nicon_handle_admin_regenerate_recovery_code(int $adminId, int $targetId): void
{
    // Step-up, same as deleting a user: a fresh recovery code is a full
    // account-takeover primitive for the target account.
    if (!nicon_require_current_password($adminId, nicon_json_body())) {
        return;
    }
    $code = nicon_generate_recovery_code();
    $hash = nicon_hash_password(nicon_normalize_recovery_code($code));

    $stmt = nicon_db()->prepare('UPDATE users SET recovery_code_hash = ? WHERE id = ?');
    $stmt->execute([$hash, $targetId]);
    if ($stmt->rowCount() === 0) {
        nicon_send_error('404 page not found', 404);
        return;
    }
    nicon_audit_log($adminId, 'admin_recovery_code_regenerated', $targetId);
    nicon_send_json(['recovery_code' => $code]);
}
