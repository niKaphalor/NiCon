<?php
declare(strict_types=1);

const NICON_MAX_MODERATION_RULES = 50;

// Bounds create *rate*, not just the standing count above — without this a
// scripted client could still cycle create+delete indefinitely at no cost.
const NICON_MODERATION_RULES_CREATE_RATE_LIMIT = 20; // per account, per window
const NICON_MODERATION_RULES_RATE_WINDOW = 300;      // 5 minutes

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
    if (!nicon_rate_limit_allow("moderation-rules-create:$userId", NICON_MODERATION_RULES_CREATE_RATE_LIMIT, NICON_MODERATION_RULES_RATE_WINDOW)) {
        header('Retry-After: ' . NICON_MODERATION_RULES_RATE_WINDOW);
        nicon_send_error('too many rules created recently — try again later', 429);
        return;
    }
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
    // FOR UPDATE inside a transaction — see servers.php's create handler for
    // why a plain SELECT-then-INSERT here would let two concurrent requests
    // from the same account each exceed the cap by however many raced.
    $pdo->beginTransaction();
    try {
        $count = $pdo->prepare('SELECT COUNT(*) FROM moderation_rules WHERE user_id = ? FOR UPDATE');
        $count->execute([$userId]);
        if ((int) $count->fetchColumn() >= NICON_MAX_MODERATION_RULES) {
            $pdo->rollBack();
            nicon_send_error('maximum number of moderation rules reached', 400);
            return;
        }
        $pdo->prepare('INSERT INTO moderation_rules (user_id, pattern, action) VALUES (?, ?, ?)')
            ->execute([$userId, $pattern, $action]);
        $id = (int) $pdo->lastInsertId();
        $pdo->commit();
    } catch (Throwable $e) {
        $pdo->rollBack();
        throw $e;
    }
    nicon_send_json(['id' => $id, 'pattern' => $pattern, 'action' => $action, 'enabled' => true], 201);
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
