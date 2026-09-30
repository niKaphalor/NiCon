<?php
declare(strict_types=1);

function nicon_audit_retention_days(): int
{
    $configured = (int) (nicon_config()['audit_retention_days'] ?? 180);
    return max(30, min(3650, $configured));
}

// Run at most once per request. The created_at index keeps this cheap, and
// invoking it from both writes and reads means low-traffic installations are
// still cleaned as soon as somebody next uses the audit log.
function nicon_audit_cleanup(): void
{
    static $done = false;
    if ($done) return;
    $done = true;
    $days = nicon_audit_retention_days();
    $pdo = nicon_db();
    // Bound parameter, not string-interpolated — $days is always this
    // instance's own clamped config value today, never attacker input, but
    // this was the one place in webspace/ that broke the otherwise
    // consistently-parameterized-query discipline every other handler
    // follows; keeping it that way only by accident isn't worth the risk
    // if this function's input source ever changes.
    $pdo->prepare('DELETE FROM audit_log WHERE created_at < DATE_SUB(UTC_TIMESTAMP(), INTERVAL ? DAY)')->execute([$days]);
    $pdo->prepare('DELETE FROM rcon_audit_log WHERE created_at < DATE_SUB(UTC_TIMESTAMP(), INTERVAL ? DAY)')->execute([$days]);
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
