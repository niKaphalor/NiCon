<?php
declare(strict_types=1);

// Run every five minutes from the hosting control panel/cron. This is CLI
// only so player history does not depend on somebody keeping NiCon open.
if (PHP_SAPI !== 'cli') {
    http_response_code(404);
    exit;
}

require_once dirname(__DIR__) . '/lib/config.php';
require_once dirname(__DIR__) . '/lib/db.php';
require_once dirname(__DIR__) . '/lib/maintenance.php';
require_once dirname(__DIR__) . '/lib/crypto.php';
require_once dirname(__DIR__) . '/handlers/nitrado_sync.php';

$pdo = nicon_db();
$stmt = $pdo->query('
    SELECT s.id, s.nitrado_service_id, u.nitrado_token_enc
    FROM servers s
    JOIN users u ON u.id = s.user_id
    WHERE s.source = \'nitrado\' AND s.nitrado_service_id IS NOT NULL AND u.nitrado_token_enc IS NOT NULL
');
$inserted = 0;
foreach ($stmt as $row) {
    try {
        $token = nicon_decrypt_password($row['nitrado_token_enc']);
        $serviceId = (int) $row['nitrado_service_id'];
        $data = nicon_nitrado_get($token, "/services/$serviceId/gameservers");
        $gs = $data['gameserver'] ?? [];
        $query = is_array($gs['query'] ?? null) ? $gs['query'] : [];
        $online = in_array(strtolower((string) ($gs['status'] ?? '')), ['started', 'running', 'online'], true);
        $insert = $pdo->prepare('
            INSERT INTO server_health_samples (server_id, online, player_current, player_max, source)
            SELECT ?, ?, ?, ?, \'nitrado\'
            WHERE NOT EXISTS (
                SELECT 1 FROM server_health_samples
                WHERE server_id = ? AND source = \'nitrado\' AND sampled_at >= DATE_SUB(UTC_TIMESTAMP(), INTERVAL 4 MINUTE)
            )
        ');
        $insert->execute([
            (int) $row['id'], $online,
            isset($query['player_current']) ? (int) $query['player_current'] : null,
            isset($query['player_max']) ? (int) $query['player_max'] : (isset($gs['slots']) ? (int) $gs['slots'] : null),
            (int) $row['id'],
        ]);
        $inserted += $insert->rowCount();
    } catch (Throwable $e) {
        fwrite(STDERR, 'server ' . (int) $row['id'] . ': ' . $e->getMessage() . PHP_EOL);
    }
}
// Housekeeping (audit retention, expired caches, rate-limit windows, health
// samples past 90 days) runs here, in batches, instead of in web requests.
$cleaned = nicon_run_maintenance(200, true);
fwrite(STDOUT, "sampled $inserted Nitrado server(s); cleaned " . json_encode($cleaned) . "\n");
