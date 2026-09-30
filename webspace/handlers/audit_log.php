<?php
declare(strict_types=1);

// ---------------------------------------------------------------------------
// Pagination
//
// Both audit endpoints list two tables (audit_log: account/admin actions,
// rcon_audit_log: console commands) as ONE time-ordered list. Sending
// ?page= and/or ?per_page= switches an endpoint to the paginated response
//
//   {"items": [...], "page": 2, "per_page": 25, "total": 163, "total_pages": 7}
//
// Without either parameter the response is exactly what it used to be: a
// plain array of the newest entries (100 / 200). That keeps a frontend that
// was cached before this change working against the new API.
// ---------------------------------------------------------------------------

const NICON_AUDIT_DEFAULT_PER_PAGE = 25;

// nicon_audit_paging returns [page, perPage] for a paginated request, or
// null for a legacy one (see nicon_page_params in lib/http.php).
function nicon_audit_paging(): ?array
{
    return nicon_page_params(NICON_AUDIT_DEFAULT_PER_PAGE, 100);
}

// nicon_audit_fetch returns [rows, total]: audit_log and rcon_audit_log as
// one list, newest first (ties broken by table and id so a page boundary is
// stable). $userId limits it to one user's own view (their actions, admin
// actions aimed at them, and their console commands); null means everything
// (admin). $server = [id, name] narrows it to one server's console commands.
// LIMIT/OFFSET are validated integers inlined into the SQL — the connection
// uses native prepared statements, which don't accept them as parameters.
function nicon_audit_fetch(?int $userId, ?array $server, int $limit, int $offset, bool $includeIp): array
{
    $pdo = nicon_db();
    $limit = max(1, $limit);
    $offset = max(0, $offset);

    $parts = [];
    $params = [];
    $countParts = [];
    $countParams = [];

    if ($server === null) {
        $accountWhere = $userId === null ? '' : 'WHERE a.user_id = ? OR a.target_user_id = ?';
        $accountParams = $userId === null ? [] : [$userId, $userId];
        $ipColumn = $includeIp ? 'a.ip_address' : 'NULL';
        $parts[] = "
            SELECT 'account' AS kind, a.id AS id, a.action AS action, a.detail AS detail, $ipColumn AS ip_address,
                   actor.username AS actor_username, target.username AS target_username, a.created_at AS created_at,
                   NULL AS server_id, NULL AS server_name, NULL AS command, NULL AS rcon_action, NULL AS target_player,
                   NULL AS origin, NULL AS result, NULL AS success, NULL AS upstream_ms, NULL AS relay_overhead_ms
            FROM audit_log a
            LEFT JOIN users actor ON actor.id = a.user_id
            LEFT JOIN users target ON target.id = a.target_user_id
            $accountWhere";
        $params = array_merge($params, $accountParams);
        $countParts[] = "SELECT COUNT(*) FROM audit_log a $accountWhere";
        $countParams = array_merge($countParams, $accountParams);
    }

    $rconConditions = [];
    $rconParams = [];
    if ($userId !== null) {
        $rconConditions[] = 'r.user_id = ?';
        $rconParams[] = $userId;
    }
    if ($server !== null) {
        // A deleted server keeps its rows with server_id NULL and the name snapshot.
        $rconConditions[] = '(r.server_id = ? OR (r.server_id IS NULL AND r.server_name = ?))';
        $rconParams[] = $server[0];
        $rconParams[] = $server[1];
    }
    $rconWhere = $rconConditions ? 'WHERE ' . implode(' AND ', $rconConditions) : '';
    $parts[] = "
        SELECT 'rcon' AS kind, r.id AS id, 'rcon_command' AS action, NULL AS detail, NULL AS ip_address,
               r.username AS actor_username, NULL AS target_username, r.created_at AS created_at,
               r.server_id AS server_id, r.server_name AS server_name, r.command AS command, r.action AS rcon_action,
               r.target_player AS target_player, r.origin AS origin, r.result AS result, r.success AS success,
               r.upstream_ms AS upstream_ms, r.relay_overhead_ms AS relay_overhead_ms
        FROM rcon_audit_log r
        $rconWhere";
    $params = array_merge($params, $rconParams);
    $countParts[] = "SELECT COUNT(*) FROM rcon_audit_log r $rconWhere";
    $countParams = array_merge($countParams, $rconParams);

    $total = 0;
    foreach ($countParts as $i => $countSql) {
        $countStmt = $pdo->prepare($countSql);
        // Each count has its own parameter slice; rebuild per statement.
        $n = substr_count($countSql, '?');
        $countStmt->execute(array_splice($countParams, 0, $n));
        $total += (int) $countStmt->fetchColumn();
    }

    $sql = 'SELECT * FROM (' . implode(' UNION ALL ', $parts) . ") t ORDER BY created_at DESC, kind DESC, id DESC LIMIT $limit OFFSET $offset";
    $stmt = $pdo->prepare($sql);
    $stmt->execute($params);

    $rows = array_map(static function (array $row) use ($includeIp): array {
        $createdAt = gmdate('Y-m-d\TH:i:s\Z', strtotime($row['created_at']));
        if ($row['kind'] === 'rcon') {
            return [
                'kind' => 'rcon',
                'action' => 'rcon_command',
                'rcon_action' => $row['rcon_action'],
                'origin' => $row['origin'],
                'command' => $row['command'],
                'target_player' => $row['target_player'],
                'result' => $row['result'],
                'success' => (bool) $row['success'],
                'upstream_ms' => $row['upstream_ms'] !== null ? (float) $row['upstream_ms'] : null,
                'relay_overhead_ms' => $row['relay_overhead_ms'] !== null ? (float) $row['relay_overhead_ms'] : null,
                'actor_username' => $row['actor_username'],
                'server_id' => (int) $row['server_id'],
                'server_name' => $row['server_name'],
                'target_username' => null,
                'detail' => null,
                'created_at' => $createdAt,
            ];
        }
        $entry = [
            'kind' => 'account',
            'action' => $row['action'],
            'detail' => $row['detail'],
            'actor_username' => $row['actor_username'],
            'target_username' => $row['target_username'],
            'created_at' => $createdAt,
        ];
        if ($includeIp) {
            $entry['ip_address'] = $row['ip_address'];
        }
        return $entry;
    }, $stmt->fetchAll());

    return [$rows, $total];
}

// nicon_send_audit_response sends either the legacy array or the paginated
// object, depending on whether the client asked for pagination.
function nicon_send_audit_response(?int $userId, ?array $server, bool $includeIp, int $legacyLimit): void
{
    $paging = nicon_audit_paging();
    if ($paging === null) {
        [$rows] = nicon_audit_fetch($userId, $server, $legacyLimit, 0, $includeIp);
        nicon_send_json($rows);
        return;
    }
    [$page, $perPage] = $paging;
    [$rows, $total] = nicon_audit_fetch($userId, $server, $perPage, ($page - 1) * $perPage, $includeIp);
    nicon_send_json(nicon_page_payload($rows, $page, $perPage, $total));
}

// nicon_handle_list_audit_log: the authenticated user's own activity —
// actions they took (user_id = them), admin actions that targeted their
// account (target_user_id = them, e.g. an admin regenerating their recovery
// code) and their console commands. ip_address is deliberately left out
// here even though it's the same row an admin can see in full: for an
// admin-authored entry it'd be the admin's IP, not this user's, and there's
// no reason to hand that to them.
//
// ?server_id= narrows the list to that server's console commands (only for
// a server the caller owns; anything else is simply an empty list).
function nicon_handle_list_audit_log(int $userId): void
{
    nicon_audit_cleanup();
    $server = null;
    if (isset($_GET['server_id'])) {
        $stmt = nicon_db()->prepare('SELECT id, name FROM servers WHERE id = ? AND user_id = ?');
        $stmt->execute([(int) $_GET['server_id'], $userId]);
        $row = $stmt->fetch();
        // -1 never matches a real id, and the name is a value no server row can have.
        $server = $row ? [(int) $row['id'], (string) $row['name']] : [-1, "\0"];
    }
    nicon_send_audit_response($userId, $server, false, 100);
}

// nicon_handle_admin_list_audit_log: everything, for review — the whole
// point of an audit log. Without pagination parameters a single response is
// still bounded (the newest 200 entries).
function nicon_handle_admin_list_audit_log(int $adminId): void
{
    nicon_audit_cleanup();
    nicon_send_audit_response(null, null, true, 200);
}
