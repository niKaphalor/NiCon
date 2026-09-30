<?php
declare(strict_types=1);

const NICON_NOTIFICATION_TYPES = ['info', 'success', 'warning', 'error'];
// A banner shown to every user — a few sentences, well under the TEXT
// column's 64 KiB, so an admin typo can't paste a document into everyone's UI.
const NICON_MAX_NOTIFICATION_CHARS = 2000;

// nicon_notification_response shapes a row the same way for the
// user-facing list and the admin management list — nothing in a
// notification is sensitive, so both see identical data.
function nicon_notification_response(array $row): array
{
    return [
        'id' => (int) $row['id'],
        'type' => $row['type'],
        'message' => $row['message'],
        'created_at' => gmdate('Y-m-d\TH:i:s\Z', strtotime($row['created_at'])),
    ];
}

// nicon_handle_list_notifications: any authenticated user. Dismissal is
// tracked client-side (localStorage), not here, so this always returns
// every notification that still exists — the frontend filters out what
// this browser has already dismissed.
function nicon_handle_list_notifications(int $userId): void
{
    // Everyone's bell needs all active notices, so the default stays the full
    // list; the admin panel asks for pages with ?page=/?per_page=.
    $paging = nicon_page_params(25);
    $limit = '';
    if ($paging !== null) {
        [$page, $perPage] = $paging;
        $limit = ' LIMIT ' . (int) $perPage . ' OFFSET ' . (int) (($page - 1) * $perPage);
    }
    $stmt = nicon_db()->query('SELECT id, type, message, created_at FROM notifications ORDER BY created_at DESC, id DESC' . $limit);
    $items = array_map('nicon_notification_response', $stmt->fetchAll());
    if ($paging === null) {
        nicon_send_json($items);
        return;
    }
    $total = (int) nicon_db()->query('SELECT COUNT(*) FROM notifications')->fetchColumn();
    nicon_send_json(nicon_page_payload($items, $page, $perPage, $total));
}

function nicon_handle_admin_create_notification(int $adminId): void
{
    $req = nicon_json_body();
    $type = nicon_body_string($req, 'type', 'info');
    $message = nicon_body_string($req, 'message');
    if ($type === null || $message === null) return;
    $message = trim($message);

    if ($message === '') {
        nicon_send_error('message is required', 400);
        return;
    }
    if (nicon_char_length($message) > NICON_MAX_NOTIFICATION_CHARS) {
        nicon_send_error('message is too long (max ' . NICON_MAX_NOTIFICATION_CHARS . ' characters)', 400);
        return;
    }
    if (!in_array($type, NICON_NOTIFICATION_TYPES, true)) {
        nicon_send_error('type must be one of: ' . implode(', ', NICON_NOTIFICATION_TYPES), 400);
        return;
    }

    $pdo = nicon_db();
    $pdo->prepare('INSERT INTO notifications (type, message) VALUES (?, ?)')->execute([$type, $message]);
    $id = (int) $pdo->lastInsertId();

    nicon_audit_log($adminId, 'admin_notification_created', null, substr($message, 0, 255));

    $stmt = $pdo->prepare('SELECT id, type, message, created_at FROM notifications WHERE id = ?');
    $stmt->execute([$id]);
    nicon_send_json(nicon_notification_response($stmt->fetch()));
}

function nicon_handle_admin_delete_notification(int $adminId, int $notificationId): void
{
    $pdo = nicon_db();
    $messageStmt = $pdo->prepare('SELECT message FROM notifications WHERE id = ?');
    $messageStmt->execute([$notificationId]);
    $message = $messageStmt->fetchColumn();

    $stmt = $pdo->prepare('DELETE FROM notifications WHERE id = ?');
    $stmt->execute([$notificationId]);
    if ($stmt->rowCount() === 0) {
        nicon_send_error('404 page not found', 404);
        return;
    }
    nicon_audit_log($adminId, 'admin_notification_deleted', null, $message !== false ? substr($message, 0, 255) : null);
    http_response_code(204);
}
