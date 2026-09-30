<?php
declare(strict_types=1);
require_once __DIR__ . '/maintenance.php';

// Retention itself is applied by lib/maintenance.php (cron job, or a small
// random fraction of requests as a fallback) — not inline on every request.
// Kept under this name because the audit handlers call it before reading.
function nicon_audit_cleanup(): void
{
    nicon_maintenance_maybe();
}

// nicon_audit_log records an admin action or a security-relevant account
// action — see schema.sql's audit_log table comment for exactly what
// counts and why. $userId is the actor (null only for a login attempt
// against a username that doesn't exist, where there's no account to
// attribute it to); $targetUserId is set only for an admin action that
// operates on a different account. $detail is short, human-readable
// context (a server name, a notification's message) — never a password,
// token, or recovery code, and kept to what the actor themselves already
// chose to make visible (their own username, a server name they picked),
// not something derived that wouldn't otherwise be shown to them.
function nicon_audit_log(?int $userId, string $action, ?int $targetUserId = null, ?string $detail = null): void
{
    nicon_audit_cleanup();
    nicon_db()->prepare('
        INSERT INTO audit_log (user_id, action, target_user_id, detail, ip_address)
        VALUES (?, ?, ?, ?, ?)
    ')->execute([$userId, $action, $targetUserId, $detail, $_SERVER['REMOTE_ADDR'] ?? null]);
}
