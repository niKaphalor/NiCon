<?php
declare(strict_types=1);

function nicon_faq_response(array $row, bool $admin = false): array
{
    if ($admin) {
        return [
            'id' => (int) $row['id'],
            'question_de' => $row['question_de'],
            'answer_de' => $row['answer_de'],
            'question_en' => $row['question_en'],
            'answer_en' => $row['answer_en'],
            'sort_order' => (int) $row['sort_order'],
            'is_published' => (bool) $row['is_published'],
            'updated_at' => gmdate('Y-m-d\TH:i:s\Z', strtotime($row['updated_at'])),
        ];
    }

    $lang = ($_GET['lang'] ?? 'en') === 'de' ? 'de' : 'en';
    return [
        'id' => (int) $row['id'],
        'question' => $row['question_' . $lang],
        'answer' => $row['answer_' . $lang],
        'sort_order' => (int) $row['sort_order'],
    ];
}

function nicon_handle_list_faq(): void
{
    $stmt = nicon_db()->query('
        SELECT id, question_de, answer_de, question_en, answer_en, sort_order
        FROM faq_entries
        WHERE is_published = TRUE
        ORDER BY sort_order ASC, id ASC
    ');
    nicon_send_json(array_map(static fn(array $row): array => nicon_faq_response($row), $stmt->fetchAll()));
}

function nicon_handle_admin_list_faq(int $adminId): void
{
    $stmt = nicon_db()->query('
        SELECT id, question_de, answer_de, question_en, answer_en, sort_order, is_published, updated_at
        FROM faq_entries
        ORDER BY sort_order ASC, id ASC
    ');
    nicon_send_json(array_map(static fn(array $row): array => nicon_faq_response($row, true), $stmt->fetchAll()));
}

function nicon_faq_text_length(string $value): int
{
    return function_exists('mb_strlen') ? mb_strlen($value, 'UTF-8') : strlen($value);
}

function nicon_faq_detail(string $question): string
{
    return function_exists('mb_substr') ? mb_substr($question, 0, 255, 'UTF-8') : substr($question, 0, 255);
}

function nicon_faq_payload(): ?array
{
    $req = nicon_json_body();
    $payload = [
        'question_de' => trim((string) ($req['question_de'] ?? '')),
        'answer_de' => trim((string) ($req['answer_de'] ?? '')),
        'question_en' => trim((string) ($req['question_en'] ?? '')),
        'answer_en' => trim((string) ($req['answer_en'] ?? '')),
        'sort_order' => (int) ($req['sort_order'] ?? 0),
        'is_published' => filter_var($req['is_published'] ?? false, FILTER_VALIDATE_BOOL),
    ];

    foreach (['question_de', 'answer_de', 'question_en', 'answer_en'] as $field) {
        if ($payload[$field] === '') {
            nicon_send_error($field . ' is required', 400);
            return null;
        }
    }
    if (nicon_faq_text_length($payload['question_de']) > 255 || nicon_faq_text_length($payload['question_en']) > 255) {
        nicon_send_error('questions must not exceed 255 characters', 400);
        return null;
    }
    if (nicon_faq_text_length($payload['answer_de']) > 5000 || nicon_faq_text_length($payload['answer_en']) > 5000) {
        nicon_send_error('answers must not exceed 5000 characters', 400);
        return null;
    }
    if ($payload['sort_order'] < 0 || $payload['sort_order'] > 9999) {
        nicon_send_error('sort_order must be between 0 and 9999', 400);
        return null;
    }
    return $payload;
}

function nicon_handle_admin_create_faq(int $adminId): void
{
    $payload = nicon_faq_payload();
    if ($payload === null) return;

    $pdo = nicon_db();
    $pdo->prepare('
        INSERT INTO faq_entries (question_de, answer_de, question_en, answer_en, sort_order, is_published)
        VALUES (?, ?, ?, ?, ?, ?)
    ')->execute([
        $payload['question_de'], $payload['answer_de'], $payload['question_en'], $payload['answer_en'],
        $payload['sort_order'], $payload['is_published'] ? 1 : 0,
    ]);
    $id = (int) $pdo->lastInsertId();
    nicon_audit_log($adminId, 'admin_faq_created', null, nicon_faq_detail($payload['question_de']));

    $stmt = $pdo->prepare('SELECT * FROM faq_entries WHERE id = ?');
    $stmt->execute([$id]);
    nicon_send_json(nicon_faq_response($stmt->fetch(), true), 201);
}

function nicon_handle_admin_update_faq(int $adminId, int $faqId): void
{
    $payload = nicon_faq_payload();
    if ($payload === null) return;

    $pdo = nicon_db();
    $stmt = $pdo->prepare('
        UPDATE faq_entries
        SET question_de = ?, answer_de = ?, question_en = ?, answer_en = ?, sort_order = ?, is_published = ?
        WHERE id = ?
    ');
    $stmt->execute([
        $payload['question_de'], $payload['answer_de'], $payload['question_en'], $payload['answer_en'],
        $payload['sort_order'], $payload['is_published'] ? 1 : 0, $faqId,
    ]);
    if ($stmt->rowCount() === 0) {
        $exists = $pdo->prepare('SELECT 1 FROM faq_entries WHERE id = ?');
        $exists->execute([$faqId]);
        if (!$exists->fetchColumn()) {
            nicon_send_error('FAQ entry not found', 404);
            return;
        }
    }
    nicon_audit_log($adminId, 'admin_faq_updated', null, nicon_faq_detail($payload['question_de']));
    $select = $pdo->prepare('SELECT * FROM faq_entries WHERE id = ?');
    $select->execute([$faqId]);
    nicon_send_json(nicon_faq_response($select->fetch(), true));
}

function nicon_handle_admin_delete_faq(int $adminId, int $faqId): void
{
    $pdo = nicon_db();
    $question = $pdo->prepare('SELECT question_de FROM faq_entries WHERE id = ?');
    $question->execute([$faqId]);
    $detail = $question->fetchColumn();

    $stmt = $pdo->prepare('DELETE FROM faq_entries WHERE id = ?');
    $stmt->execute([$faqId]);
    if ($stmt->rowCount() === 0) {
        nicon_send_error('FAQ entry not found', 404);
        return;
    }
    nicon_audit_log($adminId, 'admin_faq_deleted', null, $detail !== false ? nicon_faq_detail((string) $detail) : null);
    http_response_code(204);
}
