<?php
// A fixed-window counter, not the token bucket internal/relay/ratelimit.go
// uses — PHP requests are stateless between calls, so there's no
// in-process limiter to keep alive; this trades a small amount of
// precision (up to ~2x the limit right at a window boundary) for living
// entirely in the database. Good enough for its actual job: making it
// impractical to spam registrations or brute-force a recovery code, not
// perfectly smooth traffic shaping.
declare(strict_types=1);
require_once __DIR__ . '/db.php';

// nicon_rate_limit_allow returns true if this (bucket, client IP) is still
// under $limit attempts within the current $windowSeconds window.
function nicon_rate_limit_allow(string $bucket, int $limit, int $windowSeconds): bool
{
    $ip = $_SERVER['REMOTE_ADDR'] ?? 'unknown';
    $key = hash('sha256', $bucket . ':' . $ip);
    $windowStart = intdiv(time(), $windowSeconds) * $windowSeconds;

    $pdo = nicon_db();
    $pdo->prepare('
        INSERT INTO rate_limits (bucket_key, window_start, count)
        VALUES (?, ?, 1)
        ON DUPLICATE KEY UPDATE count = count + 1
    ')->execute([$key, $windowStart]);

    $stmt = $pdo->prepare('SELECT count FROM rate_limits WHERE bucket_key = ? AND window_start = ?');
    $stmt->execute([$key, $windowStart]);
    $count = (int) $stmt->fetchColumn();

    nicon_maybe_cleanup_rate_limits();

    return $count <= $limit;
}

// nicon_maybe_cleanup_rate_limits opportunistically deletes rate_limits
// rows old enough that no window still open could reference them. There's
// no persistent PHP process to run this on a timer the way the Go relay
// does for its own tables (see store.CleanupExpired) — this table is
// PHP-only, so it needs its own housekeeping — so instead a small random
// fraction of requests that already touch this table trigger a sweep:
// frequent enough in aggregate that old rows don't accumulate forever,
// rare enough that it isn't extra database work on every single request.
function nicon_maybe_cleanup_rate_limits(): void
{
    if (random_int(1, 100) !== 1) {
        return;
    }
    $cutoff = time() - 86400; // a full day is well past any window this file uses
    nicon_db()->prepare('DELETE FROM rate_limits WHERE window_start < ?')->execute([$cutoff]);
}
