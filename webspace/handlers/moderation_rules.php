<?php
declare(strict_types=1);

const NICON_MAX_MODERATION_RULES = 50;

function nicon_moderation_rule_response(array $row): array
{
    return [
        'id' => (int) $row['id'],
        'pattern' => $row['pattern'],
        'action' => $row['action'],
        'enabled' => (bool) $row['enabled'],
    ];
}

function nicon_handle_list_moderation_rules(int $userId): void
{
    $stmt = nicon_db()->prepare('SELECT id, pattern, action, enabled FROM moderation_rules WHERE user_id = ? ORDER BY id');
    $stmt->execute([$userId]);
    nicon_send_json(array_map('nicon_moderation_rule_response', $stmt->fetchAll()));
}

function nicon_handle_create_moderation_rule(int $userId): void
{
    $req = nicon_json_body();
    $pattern = trim((string) ($req['pattern'] ?? ''));
    $action = strtolower((string) ($req['action'] ?? 'highlight'));
    if ($pattern === '' || strlen($pattern) > 128) {
        nicon_send_error('pattern is required and may contain at most 128 characters', 400);
        return;
    }
    if (!in_array($action, ['highlight', 'mute', 'kick'], true)) {
        nicon_send_error('action must be highlight, mute, or kick', 400);
        return;
    }
    $pdo = nicon_db();
    $count = $pdo->prepare('SELECT COUNT(*) FROM moderation_rules WHERE user_id = ?');
    $count->execute([$userId]);
    if ((int) $count->fetchColumn() >= NICON_MAX_MODERATION_RULES) {
        nicon_send_error('maximum number of moderation rules reached', 400);
        return;
    }
    $pdo->prepare('INSERT INTO moderation_rules (user_id, pattern, action) VALUES (?, ?, ?)')
        ->execute([$userId, $pattern, $action]);
    nicon_send_json(['id' => (int) $pdo->lastInsertId(), 'pattern' => $pattern, 'action' => $action, 'enabled' => true], 201);
}

function nicon_handle_delete_moderation_rule(int $userId, int $ruleId): void
{
    $stmt = nicon_db()->prepare('DELETE FROM moderation_rules WHERE id = ? AND user_id = ?');
    $stmt->execute([$ruleId, $userId]);
    if ($stmt->rowCount() === 0) {
        nicon_send_error('404 page not found', 404);
        return;
    }
    http_response_code(204);
}
