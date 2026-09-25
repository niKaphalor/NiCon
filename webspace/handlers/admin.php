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

    $pdo = nicon_db();
    $stmt = $pdo->prepare('SELECT username, is_admin FROM users WHERE id = ?');
    $stmt->execute([$targetId]);
    $target = $stmt->fetch();
    if (!$target) {
        nicon_send_error('404 page not found', 404);
        return;
    }
    // Deleting the last admin would lock everyone out of this instance's
    // admin panel with no way back in short of a direct database edit.
    if ($target['is_admin']) {
        $adminCount = (int) $pdo->query('SELECT COUNT(*) FROM users WHERE is_admin = 1')->fetchColumn();
        if ($adminCount <= 1) {
            nicon_send_error('cannot delete the only remaining admin account', 400);
            return;
        }
    }

    // Logged before, not after, deleting: audit_log.target_user_id has a
    // foreign key on users.id, same reasoning as account.php's
    // account_deleted — inserting a row pointing at $targetId after that
    // row is gone would fail outright.
    nicon_audit_log($adminId, 'admin_user_deleted', $targetId, $target['username']);
    $stmt = $pdo->prepare('DELETE FROM users WHERE id = ?');
    $stmt->execute([$targetId]);
    if ($stmt->rowCount() === 0) {
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
