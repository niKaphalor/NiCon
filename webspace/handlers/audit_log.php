<?php
declare(strict_types=1);

function nicon_rcon_audit_rows(?int $userId, int $limit): array
{
    $where = $userId === null ? '' : 'WHERE user_id = ?';
    $stmt = nicon_db()->prepare("
        SELECT username, server_name, command, action, target_player, origin,
               result, success, upstream_ms, relay_overhead_ms, created_at
        FROM rcon_audit_log
        $where
        ORDER BY created_at DESC, id DESC
        LIMIT $limit
    ");
    $stmt->execute($userId === null ? [] : [$userId]);
    return array_map(static function (array $row): array {
        return [
            'kind' => 'rcon',
            'action' => 'rcon_command',
            'rcon_action' => $row['action'],
            'origin' => $row['origin'],
            'command' => $row['command'],
            'target_player' => $row['target_player'],
            'result' => $row['result'],
            'success' => (bool) $row['success'],
            'upstream_ms' => $row['upstream_ms'] !== null ? (float) $row['upstream_ms'] : null,
            'relay_overhead_ms' => $row['relay_overhead_ms'] !== null ? (float) $row['relay_overhead_ms'] : null,
            'actor_username' => $row['username'],
            'server_name' => $row['server_name'],
            'target_username' => null,
            'detail' => null,
            'created_at' => gmdate('Y-m-d\TH:i:s\Z', strtotime($row['created_at'])),
        ];
    }, $stmt->fetchAll());
}

function nicon_merge_audit_rows(array $accountRows, array $rconRows, int $limit): array
{
    $rows = array_merge($accountRows, $rconRows);
    usort($rows, static fn(array $a, array $b): int => strcmp($b['created_at'], $a['created_at']));
    return array_slice($rows, 0, $limit);
}

// nicon_handle_list_audit_log: the authenticated user's own activity —
// actions they took (user_id = them) and admin actions that targeted
// their account (target_user_id = them, e.g. an admin regenerating their
// recovery code). ip_address is deliberately left out here even though
// it's the same row an admin can see in full: for an admin-authored
// entry it'd be the admin's IP, not this user's, and there's no reason
// to hand that to them.
function nicon_handle_list_audit_log(int $userId): void
{
    nicon_audit_cleanup();
    $stmt = nicon_db()->prepare('
        SELECT a.action, a.detail, a.created_at, actor.username AS actor_username, target.username AS target_username
        FROM audit_log a
        LEFT JOIN users actor ON actor.id = a.user_id
        LEFT JOIN users target ON target.id = a.target_user_id
        WHERE a.user_id = ? OR a.target_user_id = ?
        ORDER BY a.created_at DESC
        LIMIT 100
    ');
    $stmt->execute([$userId, $userId]);
    $accountRows = array_map(static function (array $row): array {
        return [
            'kind' => 'account',
            'action' => $row['action'],
            'detail' => $row['detail'],
            'actor_username' => $row['actor_username'],
            'target_username' => $row['target_username'],
            'created_at' => gmdate('Y-m-d\TH:i:s\Z', strtotime($row['created_at'])),
        ];
    }, $stmt->fetchAll());
    nicon_send_json(nicon_merge_audit_rows($accountRows, nicon_rcon_audit_rows($userId, 100), 100));
}

// nicon_handle_admin_list_audit_log: everything, for review — the whole
// point of an audit log. LIMIT 200 keeps a single response bounded; older
// entries are still in the table, just not fetched by this endpoint (no
// pagination yet — nothing in this project generates audit_log rows fast
// enough for that to matter in practice).
function nicon_handle_admin_list_audit_log(int $adminId): void
{
    nicon_audit_cleanup();
    $stmt = nicon_db()->query('
        SELECT a.action, a.detail, a.ip_address, a.created_at, actor.username AS actor_username, target.username AS target_username
        FROM audit_log a
        LEFT JOIN users actor ON actor.id = a.user_id
        LEFT JOIN users target ON target.id = a.target_user_id
        ORDER BY a.created_at DESC
        LIMIT 200
    ');
    $accountRows = array_map(static function (array $row): array {
        return [
            'kind' => 'account',
            'action' => $row['action'],
            'detail' => $row['detail'],
            'ip_address' => $row['ip_address'],
            'actor_username' => $row['actor_username'],
            'target_username' => $row['target_username'],
            'created_at' => gmdate('Y-m-d\TH:i:s\Z', strtotime($row['created_at'])),
        ];
    }, $stmt->fetchAll());
    nicon_send_json(nicon_merge_audit_rows($accountRows, nicon_rcon_audit_rows(null, 200), 200));
}
