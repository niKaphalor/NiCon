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
require_once __DIR__ . '/maintenance.php';

// nicon_rate_limit_allow returns true if this (bucket, client IP) is still
// under $limit attempts within the current $windowSeconds window.
function nicon_rate_limit_allow(string $bucket, int $limit, int $windowSeconds): bool
{
    $ip = $_SERVER['REMOTE_ADDR'] ?? 'unknown';
    return nicon_rate_limit_count($bucket . ':' . $ip, $limit, $windowSeconds);
}

// nicon_rate_limit_allow_global is nicon_rate_limit_allow without the client
// IP folded into the key — every caller sharing $bucket competes for the
// same $limit regardless of where they connect from. Needed specifically
// where the per-IP bucket isn't enough: login.php's per-(IP, username)
// bucket only ever throttles a single source IP guessing one account, so a
// distributed attacker rotating across many IPs gets a fresh allowance from
// each one. This is the backstop for that — one counter per account, no
// matter how many IPs are used against it.
function nicon_rate_limit_allow_global(string $bucket, int $limit, int $windowSeconds): bool
{
    return nicon_rate_limit_count($bucket, $limit, $windowSeconds);
}

function nicon_rate_limit_count(string $key, int $limit, int $windowSeconds): bool
{
    $key = hash('sha256', $key);
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

    nicon_maintenance_maybe();

    return $count <= $limit;
}
