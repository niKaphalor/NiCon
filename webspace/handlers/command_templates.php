<?php
declare(strict_types=1);

// Saved commands a user can re-send with one click from the console's
// Templates panel, instead of retyping the same RCON command every time.
// Deliberately simple: no per-game scoping, no placeholders/variables —
// just a name and a literal command string, sent through the exact same
// path (sendConsoleCommand in docs/app.js) as one typed by hand. Editing
// isn't supported, only create/list/delete — renaming or fixing a typo is
// "delete it and add it again", which is little enough friction not to
// warrant a PUT endpoint for a handful of saved rows.

const NICON_COMMAND_TEMPLATE_NAME_MAX = 64;
const NICON_COMMAND_TEMPLATE_COMMAND_MAX = 500;

// Keeps a compromised or scripted client from filling this table
// indefinitely — nobody legitimately needs more than a handful of saved
// commands per account.
const NICON_MAX_COMMAND_TEMPLATES = 50;

// Bounds create *rate*, not just the standing count above — without this a
// scripted client could still cycle create+delete indefinitely at no cost.
const NICON_COMMAND_TEMPLATES_CREATE_RATE_LIMIT = 20; // per account, per window
const NICON_COMMAND_TEMPLATES_RATE_WINDOW = 300;      // 5 minutes

function nicon_command_template_response(array $row): array
{
    return [
        'id' => (int) $row['id'],
        'name' => $row['name'],
        'command' => $row['command'],
    ];
}

function nicon_handle_list_command_templates(int $userId): void
{
    $stmt = nicon_db()->prepare('SELECT id, name, command FROM command_templates WHERE user_id = ? ORDER BY name');
    $stmt->execute([$userId]);
    nicon_send_json(array_map('nicon_command_template_response', $stmt->fetchAll()));
}

function nicon_handle_create_command_template(int $userId): void
{
    if (!nicon_rate_limit_allow("command-templates-create:$userId", NICON_COMMAND_TEMPLATES_CREATE_RATE_LIMIT, NICON_COMMAND_TEMPLATES_RATE_WINDOW)) {
        header('Retry-After: ' . NICON_COMMAND_TEMPLATES_RATE_WINDOW);
        nicon_send_error('too many templates created recently — try again later', 429);
        return;
    }
    $req = nicon_json_body();
    $name = trim((string) ($req['name'] ?? ''));
    $command = trim((string) ($req['command'] ?? ''));

    if ($name === '' || $command === '') {
        nicon_send_error('name and command are required', 400);
        return;
    }
    if (strlen($name) > NICON_COMMAND_TEMPLATE_NAME_MAX) {
        nicon_send_error('name is too long (max ' . NICON_COMMAND_TEMPLATE_NAME_MAX . ' characters)', 400);
        return;
    }
    if (strlen($command) > NICON_COMMAND_TEMPLATE_COMMAND_MAX) {
        nicon_send_error('command is too long (max ' . NICON_COMMAND_TEMPLATE_COMMAND_MAX . ' characters)', 400);
        return;
    }

    $pdo = nicon_db();
    // FOR UPDATE inside a transaction — see servers.php's create handler for
    // why a plain SELECT-then-INSERT here would let two concurrent requests
    // from the same account each exceed the cap by however many raced.
    $pdo->beginTransaction();
    try {
        $countStmt = $pdo->prepare('SELECT COUNT(*) FROM command_templates WHERE user_id = ? FOR UPDATE');
        $countStmt->execute([$userId]);
        if ((int) $countStmt->fetchColumn() >= NICON_MAX_COMMAND_TEMPLATES) {
            $pdo->rollBack();
            nicon_send_error('you already have the maximum of ' . NICON_MAX_COMMAND_TEMPLATES . ' saved commands — delete one first', 400);
            return;
        }

        $pdo->prepare('INSERT INTO command_templates (user_id, name, command) VALUES (?, ?, ?)')
            ->execute([$userId, $name, $command]);
        $id = (int) $pdo->lastInsertId();
        $pdo->commit();
    } catch (Throwable $e) {
        $pdo->rollBack();
        throw $e;
    }

    nicon_send_json(['id' => $id, 'name' => $name, 'command' => $command], 201);
}

// nicon_handle_delete_command_template: a no-op 404 (not a 403) if the
// template doesn't belong to userId — same "looks identical to
// nonexistent" convention as servers.php's delete, so this can't be used
// to probe which template IDs belong to someone else.
function nicon_handle_delete_command_template(int $userId, int $templateId): void
{
    $stmt = nicon_db()->prepare('DELETE FROM command_templates WHERE id = ? AND user_id = ?');
    $stmt->execute([$templateId, $userId]);
    if ($stmt->rowCount() === 0) {
        nicon_send_error('404 page not found', 404);
        return;
    }
    http_response_code(204);
}
