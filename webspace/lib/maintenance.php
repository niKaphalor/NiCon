<?php
declare(strict_types=1);
require_once __DIR__ . '/config.php';
require_once __DIR__ . '/db.php';

// Housekeeping for tables that only grow: audit logs past their retention,
// expired cache rows, old rate-limit windows and, in the full run, health
// samples past 90 days.
//
// It used to run inline — the audit cleanup once per audit-touching request,
// the cache cleanups on every cache write — so a busy moment paid for
// several DELETEs (and their table locks) in the request path.
//
// Now there are two entry points:
//   nicon_run_maintenance()   the real job. webspace/cron/sample_nitrado.php
//                             calls it every five minutes, so cleanup does not
//                             depend on anybody using the site.
//   nicon_maintenance_maybe() a cheap fallback for installations without that
//                             cron: a small random fraction of requests does a
//                             SMALL amount of cleanup (one batch per table).
//
// Deletes are batched (LIMIT) so no single statement holds locks on a large
// backlog for long.

const NICON_MAINTENANCE_BATCH = 1000;
const NICON_MAINTENANCE_DEFAULT_PROBABILITY = 0.02;

// nicon_delete_batched runs `$sql LIMIT n` repeatedly, at most $maxBatches
// times, stopping as soon as a batch deletes less than a full batch. $sql
// must be a DELETE ... WHERE ... without its own LIMIT/ORDER BY.
function nicon_delete_batched(string $sql, array $params, int $maxBatches): int
{
    $total = 0;
    for ($i = 0; $i < $maxBatches; $i++) {
        $stmt = nicon_db()->prepare($sql . ' LIMIT ' . NICON_MAINTENANCE_BATCH);
        $stmt->execute($params);
        $deleted = $stmt->rowCount();
        $total += $deleted;
        if ($deleted < NICON_MAINTENANCE_BATCH) {
            break;
        }
    }
    return $total;
}

function nicon_maintenance_audit_retention_days(): int
{
    $configured = (int) (nicon_config()['audit_retention_days'] ?? 180);
    return max(30, min(3650, $configured));
}

// nicon_run_maintenance returns how many rows were deleted per table.
// $full = true additionally trims health samples (the relay and the cron job
// also do this on their own schedule; it is harmless twice).
function nicon_run_maintenance(int $maxBatchesPerTable = 20, bool $full = false): array
{
    $days = nicon_maintenance_audit_retention_days();
    $deleted = [
        'audit_log' => nicon_delete_batched('DELETE FROM audit_log WHERE created_at < DATE_SUB(UTC_TIMESTAMP(), INTERVAL ? DAY)', [$days], $maxBatchesPerTable),
        'rcon_audit_log' => nicon_delete_batched('DELETE FROM rcon_audit_log WHERE created_at < DATE_SUB(UTC_TIMESTAMP(), INTERVAL ? DAY)', [$days], $maxBatchesPerTable),
        'health_history_cache' => nicon_delete_batched('DELETE FROM health_history_cache WHERE expires_at <= UTC_TIMESTAMP()', [], $maxBatchesPerTable),
        'nitrado_cache' => nicon_delete_batched('DELETE FROM nitrado_cache WHERE expires_at <= UTC_TIMESTAMP()', [], $maxBatchesPerTable),
        // A full day is well past any rate-limit window in use.
        'rate_limits' => nicon_delete_batched('DELETE FROM rate_limits WHERE window_start < ?', [time() - 86400], $maxBatchesPerTable),
    ];
    if ($full) {
        $deleted['server_health_samples'] = nicon_delete_batched('DELETE FROM server_health_samples WHERE sampled_at < DATE_SUB(UTC_TIMESTAMP(), INTERVAL 90 DAY)', [], $maxBatchesPerTable);
    }
    return $deleted;
}

// nicon_maintenance_maybe is the in-request fallback: at most once per request,
// with probability `maintenance_probability` (config; default 2 %), and only
// one batch per table so the request is never noticeably slower.
function nicon_maintenance_maybe(): void
{
    static $decided = false;
    if ($decided) {
        return;
    }
    $decided = true;
    $probability = (float) (nicon_config()['maintenance_probability'] ?? NICON_MAINTENANCE_DEFAULT_PROBABILITY);
    if ($probability <= 0) {
        return;
    }
    if ($probability < 1 && random_int(1, 1000000) > (int) round($probability * 1000000)) {
        return;
    }
    try {
        nicon_run_maintenance(1);
    } catch (Throwable $e) {
        // Housekeeping must never turn a working request into an error.
    }
}
