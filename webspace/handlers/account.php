<?php
declare(strict_types=1);

// nicon_handle_delete_account is the self-service "right to erasure" path:
// permanently deletes the authenticated account. sessions and servers
// cascade with it via ON DELETE CASCADE.
function nicon_handle_delete_account(int $userId): void
{
    nicon_db()->prepare('DELETE FROM users WHERE id = ?')->execute([$userId]);
    http_response_code(204);
}
