<?php
declare(strict_types=1);

const NICON_TEST_MAX_SERVER_PASSWORD = 512 - 32; // mirrors NICON_MAX_SERVER_PASSWORD_BYTES

function fail_test(string $message): never
{
    fwrite(STDERR, "FAIL: $message\n");
    exit(1);
}

function assert_test(bool $condition, string $message): void
{
    if (!$condition) fail_test($message);
}

function free_port(): int
{
    $socket = stream_socket_server('tcp://127.0.0.1:0', $errno, $error);
    if ($socket === false) fail_test("could not reserve a test port: $error");
    $name = stream_socket_get_name($socket, false);
    fclose($socket);
    return (int) substr(strrchr((string) $name, ':'), 1);
}

function start_php_server(string $router, int $port, array $extraEnv = []): array
{
    $log = tempnam(sys_get_temp_dir(), 'nicon-php-test-');
    $descriptor = [
        0 => ['file', '/dev/null', 'r'],
        1 => ['file', $log, 'a'],
        2 => ['file', $log, 'a'],
    ];
    $env = array_merge(getenv(), $extraEnv);
    $process = proc_open([PHP_BINARY, '-S', "127.0.0.1:$port", $router], $descriptor, $pipes, dirname(__DIR__, 2), $env);
    if (!is_resource($process)) fail_test('could not start PHP test server');

    $ready = false;
    for ($i = 0; $i < 50; $i++) {
        $socket = @fsockopen('127.0.0.1', $port, $errno, $error, 0.1);
        if ($socket !== false) {
            fclose($socket);
            $ready = true;
            break;
        }
        usleep(100000);
    }
    if (!$ready) {
        $output = is_file($log) ? file_get_contents($log) : '';
        proc_terminate($process);
        fail_test("PHP test server did not start: $output");
    }
    return [$process, $log];
}

// $body may be an array (sent as JSON) or a raw string (sent verbatim, for
// malformed-JSON tests).
function request_json(string $baseUrl, string $method, string $path, array|string|null $body = null, string $token = ''): array
{
    $ch = curl_init($baseUrl . $path);
    $headers = ['Accept: application/json'];
    if ($body !== null) $headers[] = 'Content-Type: application/json';
    if ($token !== '') $headers[] = 'Authorization: Bearer ' . $token;
    curl_setopt_array($ch, [
        CURLOPT_CUSTOMREQUEST => $method,
        CURLOPT_HTTPHEADER => $headers,
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_TIMEOUT => 5,
    ]);
    if ($body !== null) curl_setopt($ch, CURLOPT_POSTFIELDS, is_string($body) ? $body : json_encode($body));
    $raw = curl_exec($ch);
    $status = (int) curl_getinfo($ch, CURLINFO_HTTP_CODE);
    $error = curl_error($ch);
    curl_close($ch);
    if ($raw === false) fail_test("$method $path failed: $error");
    $decoded = $raw === '' ? null : json_decode($raw, true);
    return [$status, $decoded, $raw];
}

function apply_schema(PDO $pdo, string $path): void
{
    $sql = preg_replace('/^\s*--.*$/m', '', (string) file_get_contents($path));
    foreach (preg_split('/;\s*(?:\r?\n|$)/', (string) $sql) as $statement) {
        if (trim($statement) !== '') $pdo->exec($statement);
    }
}

$dsn = getenv('NICON_PHP_TEST_DB_DSN') ?: '';
if ($dsn === '') {
    fwrite(STDOUT, "SKIP: NICON_PHP_TEST_DB_DSN is not set\n");
    exit(0);
}

$root = dirname(__DIR__, 2);
$pdo = new PDO($dsn, getenv('NICON_PHP_TEST_DB_USER') ?: '', getenv('NICON_PHP_TEST_DB_PASS') ?: '', [
    PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
]);
apply_schema($pdo, $root . '/webspace/schema.sql');
$pdo->exec('DELETE FROM rate_limits');

$suffix = bin2hex(random_bytes(4));
$alice = "it_alice_$suffix";
$bob = "it_bob_$suffix";
$createdUsers = [];
$processes = [];
$logs = [];

try {
    $nitradoPort = free_port();
    $counterFile = tempnam(sys_get_temp_dir(), 'nicon-nitrado-count-');
    [$mockProcess, $mockLog] = start_php_server($root . '/tests/php/nitrado_router.php', $nitradoPort, [
        'NICON_NITRADO_MOCK_COUNTER_FILE' => $counterFile,
    ]);
    $processes[] = $mockProcess;
    $logs[] = $mockLog;
    $logs[] = $counterFile;

    $apiPort = free_port();
    $key = base64_encode(str_repeat("\x2a", 32));
    // The suite runs once per storage format: legacy (default), v2 with the
    // original key, and "rotated" (v2, current key 2, key 1 kept for reading).
    $cryptoMode = getenv('NICON_TEST_CRYPTO_MODE') ?: 'legacy';
    $cryptoEnv = ['NICON_ENCRYPTION_WRITE_V2' => $cryptoMode === 'legacy' ? '0' : '1'];
    if ($cryptoMode === 'rotated') {
        $cryptoEnv['NICON_ENCRYPTION_KEYS'] = '2=' . base64_encode(str_repeat("\x2b", 32));
        $cryptoEnv['NICON_ENCRYPTION_CURRENT_KEY_ID'] = '2';
    }
    foreach ($cryptoEnv as $envName => $envValue) putenv("$envName=$envValue");
    putenv('NICON_ENCRYPTION_KEY=' . $key);
    [$apiProcess, $apiLog] = start_php_server($root . '/tests/php/api_router.php', $apiPort, [
        'NICON_CONFIG_FILE' => $root . '/tests/php/config.php',
        'NICON_PHP_TEST_DB_DSN' => $dsn,
        'NICON_PHP_TEST_DB_USER' => getenv('NICON_PHP_TEST_DB_USER') ?: '',
        'NICON_PHP_TEST_DB_PASS' => getenv('NICON_PHP_TEST_DB_PASS') ?: '',
        'NICON_ENCRYPTION_KEY' => $key,
        ...$cryptoEnv,
        'NICON_NITRADO_API_BASE_URL' => "http://127.0.0.1:$nitradoPort",
        // php -S is single-threaded by default; the last-admin race test
        // below needs genuinely concurrent requests.
        'PHP_CLI_SERVER_WORKERS' => '4',
    ]);
    $processes[] = $apiProcess;
    $logs[] = $apiLog;
    $base = "http://127.0.0.1:$apiPort";

    [$status] = request_json($base, 'GET', '/api/healthz');
    assert_test($status === 200, 'health endpoint must return 200');

    // /readyz: is the database ready for this version of the API?
    require_once $root . '/webspace/lib/schema_version.php';
    [$status, $ready] = request_json($base, 'GET', '/api/readyz');
    assert_test($status === 200 && ($ready['schema'] ?? 0) >= NICON_EXPECTED_SCHEMA_VERSION, 'readyz must be ok after the schema was applied');
    $pdo->exec('DELETE FROM schema_migrations WHERE version = ' . NICON_EXPECTED_SCHEMA_VERSION);
    [$status, $notReady] = request_json($base, 'GET', '/api/readyz');
    assert_test($status === 503 && str_contains($notReady['error'] ?? '', 'schema.sql'), 'readyz must say 503 and what to do when a migration is missing');
    $pdo->exec("INSERT IGNORE INTO schema_migrations (version, name) VALUES (" . NICON_EXPECTED_SCHEMA_VERSION . ", 'baseline')");
    [$status] = request_json($base, 'GET', '/api/readyz');
    assert_test($status === 200, 'readyz recovers once the migration is recorded again');

    [$status, $aliceReg] = request_json($base, 'POST', '/api/register', [
        'username' => $alice,
        'password' => 'integration-password',
        'consent_accepted' => true,
    ]);
    assert_test($status === 200 && is_string($aliceReg['token'] ?? null), 'alice registration failed');
    $aliceToken = $aliceReg['token'];

    [$status, $aliceLogin] = request_json($base, 'POST', '/api/login', [
        'username' => $alice,
        'password' => 'integration-password',
    ]);
    assert_test($status === 200 && is_string($aliceLogin['token'] ?? null), 'alice login failed');
    $aliceToken = $aliceLogin['token'];

    [$status, $bobReg] = request_json($base, 'POST', '/api/register', [
        'username' => $bob,
        'password' => 'integration-password',
        'consent_accepted' => true,
    ]);
    assert_test($status === 200 && is_string($bobReg['token'] ?? null), 'bob registration failed');
    $bobToken = $bobReg['token'];

    $stmt = $pdo->prepare('SELECT id FROM users WHERE username IN (?, ?)');
    $stmt->execute([$alice, $bob]);
    $createdUsers = array_map('intval', $stmt->fetchAll(PDO::FETCH_COLUMN));

    [$status] = request_json($base, 'GET', '/api/admin/faq', null, $bobToken);
    assert_test($status === 403, 'non-admin users must not read FAQ drafts');
    $pdo->prepare('UPDATE users SET is_admin = TRUE WHERE username = ?')->execute([$alice]);
    [$status, $faqEntry] = request_json($base, 'POST', '/api/admin/faq', [
        'question_de' => "Testfrage $suffix",
        'answer_de' => 'Deutsche Testantwort',
        'question_en' => "Test question $suffix",
        'answer_en' => 'English test answer',
        'sort_order' => 9998,
        'is_published' => false,
    ], $aliceToken);
    assert_test($status === 201 && !($faqEntry['is_published'] ?? true), 'admin FAQ draft creation failed');
    $faqId = (int) ($faqEntry['id'] ?? 0);
    [$status, $publicFaq] = request_json($base, 'GET', '/api/faq?lang=de');
    assert_test($status === 200 && !in_array("Testfrage $suffix", array_column($publicFaq ?? [], 'question'), true), 'FAQ drafts must stay private');
    [$status, $faqEntry] = request_json($base, 'PUT', "/api/admin/faq/$faqId", [
        'question_de' => "Testfrage $suffix",
        'answer_de' => 'Aktualisierte deutsche Testantwort',
        'question_en' => "Test question $suffix",
        'answer_en' => 'Updated English test answer',
        'sort_order' => 9998,
        'is_published' => true,
    ], $aliceToken);
    assert_test($status === 200 && ($faqEntry['is_published'] ?? false), 'admin FAQ update failed');
    [$status, $publicFaq] = request_json($base, 'GET', '/api/faq?lang=en');
    assert_test($status === 200 && in_array("Test question $suffix", array_column($publicFaq ?? [], 'question'), true), 'published localized FAQ entry missing');
    [$status] = request_json($base, 'DELETE', "/api/admin/faq/$faqId", null, $aliceToken);
    assert_test($status === 204, 'admin FAQ deletion failed');

    [$status, $server] = request_json($base, 'POST', '/api/servers', [
        'name' => 'Manual GMod',
        'host' => '127.0.0.1',
        'port' => 28016,
        'password' => 'secret',
        'protocol' => 'source',
        'query_protocol' => 'a2s',
        'query_port' => 27015,
        'game' => "Garry's Mod",
    ], $aliceToken);
    assert_test($status === 200 && ($server['game'] ?? '') === "Garry's Mod", 'manual server game was not persisted');

    // ---- storage format of the RCON password (legacy / v2 / rotated key) ----
    require_once $root . '/webspace/lib/crypto.php';
    $ring = nicon_key_ring_from_config(require $root . '/tests/php/config.php');
    assert_test(is_array($ring), 'test crypto configuration must be valid');
    $storedPassword = (string) $pdo->query('SELECT password_enc FROM servers WHERE id = ' . (int) $server['id'])->fetchColumn();
    $aliceUserId = (int) $pdo->query("SELECT id FROM users WHERE username = '$alice'")->fetchColumn();
    $wantV2 = $cryptoMode !== 'legacy';
    assert_test(str_starts_with($storedPassword, 'NC2') === $wantV2, "password format must match the $cryptoMode mode");
    assert_test(nicon_open_with_ring($ring, $storedPassword, nicon_aad_server_password($aliceUserId, (int) $server['id'])) === 'secret', 'the stored password decrypts with its own row as AAD');
    if ($wantV2) {
        assert_test(ord($storedPassword[3]) === ($cryptoMode === 'rotated' ? 2 : 1), 'the value names the current key');
        foreach ([nicon_aad_server_password($aliceUserId, (int) $server['id'] + 1), nicon_aad_server_password($aliceUserId + 1, (int) $server['id']), ''] as $foreignAad) {
            $refused = false;
            try { nicon_open_with_ring($ring, $storedPassword, $foreignAad); } catch (RuntimeException $e) { $refused = true; }
            assert_test($refused, 'a password copied to another server/user must not decrypt');
        }
    }
    assert_test(($server['query_protocol'] ?? '') === 'a2s' && ($server['query_port'] ?? 0) === 27015, 'manual query configuration was not persisted');
    assert_test(($server['has_password'] ?? false) === true && !array_key_exists('password', $server), 'server response exposed or lost password state');
    $serverId = (int) $server['id'];

    [$status] = request_json($base, 'POST', '/api/servers', [
        'name' => 'Not allow-listed', 'host' => '127.0.0.1', 'port' => 25575,
        'password' => 'secret', 'protocol' => 'source', 'game' => 'Definitely Not A Real Game',
    ], $aliceToken);
    assert_test($status === 400, 'games outside NiCon\'s supported-game list must be rejected');

    [$status] = request_json($base, 'POST', '/api/servers', [
        'name' => 'Bad query protocol', 'host' => '127.0.0.1', 'port' => 28098,
        'password' => 'secret', 'protocol' => 'source', 'query_protocol' => 'udp-shotgun', 'game' => '',
    ], $aliceToken);
    assert_test($status === 400, 'an unrecognized query_protocol value must be rejected');

    [$status] = request_json($base, 'POST', '/api/servers', [
        'name' => 'Bad query port', 'host' => '127.0.0.1', 'port' => 28097,
        'password' => 'secret', 'protocol' => 'source', 'query_port' => 70000, 'game' => '',
    ], $aliceToken);
    assert_test($status === 400, 'a query_port outside 1-65535 must be rejected');

    // Per-account server cap (NICON_MAX_SERVERS_PER_ACCOUNT in servers.php):
    // seed directly rather than via 49 real POSTs, then confirm the real
    // API path actually rejects the one that would exceed it.
    $capUserIdStmt = $pdo->prepare('SELECT id FROM users WHERE username = ?');
    $capUserIdStmt->execute([$alice]);
    $capUserId = (int) $capUserIdStmt->fetchColumn();
    $seedStmt = $pdo->prepare("INSERT INTO servers (user_id, name, host, port, protocol, game, source) VALUES (?, 'Seed', '127.0.0.1', 28020, 'source', '', 'manual')");
    for ($i = 0; $i < 49; $i++) { // + the one real server already created above = 50, the cap
        $seedStmt->execute([$capUserId]);
    }
    [$status] = request_json($base, 'POST', '/api/servers', [
        'name' => 'One too many', 'host' => '127.0.0.1', 'port' => 28099,
        'password' => 'secret', 'protocol' => 'source', 'game' => '',
    ], $aliceToken);
    assert_test($status === 400, 'the per-account server cap must be enforced');
    $pdo->prepare("DELETE FROM servers WHERE user_id = ? AND name = 'Seed'")->execute([$capUserId]);

    [$status] = request_json($base, 'PUT', "/api/servers/$serverId", [
        'name' => 'Stolen', 'host' => '127.0.0.1', 'port' => 1, 'protocol' => 'source', 'game' => "Garry's Mod",
    ], $bobToken);
    assert_test($status === 404, 'cross-account server update must look not found');

    [$status, $updated] = request_json($base, 'PUT', "/api/servers/$serverId", [
        'name' => 'Edited GMod',
        'host' => '127.0.0.2',
        'port' => 28017,
        'protocol' => 'source',
        'query_protocol' => 'disabled',
        'query_port' => null,
        'game' => "Garry's Mod",
    ], $aliceToken);
    assert_test($status === 200 && ($updated['name'] ?? '') === 'Edited GMod' && ($updated['port'] ?? 0) === 28017, 'profile update failed');
    // ?? treats an existing-but-null value the same as a missing key, so
    // "$updated['query_port'] ?? 'not-null'" would evaluate to 'not-null'
    // even when the field is correctly null — the exact success case this
    // is meant to verify. array_key_exists + a direct read sidesteps that.
    assert_test(($updated['query_protocol'] ?? '') === 'disabled'
        && array_key_exists('query_port', $updated) && $updated['query_port'] === null,
        'query configuration update failed');

    $pdo->prepare("INSERT INTO server_health_samples (server_id, online, player_current, player_max, source) VALUES (?, TRUE, 2, 20, 'relay'), (?, FALSE, 3, 20, 'a2s')")
        ->execute([$serverId, $serverId]);
    [$status, $deduplicatedHistory] = request_json($base, 'GET', "/api/servers/$serverId/health-history?range=24h", null, $aliceToken);
    assert_test($status === 200 && (float) ($deduplicatedHistory['uptime_percent'] ?? -1) === 100.0, 'RCON and query samples in one interval must not double-count uptime');
    assert_test((float) ($deduplicatedHistory['sample_completeness_percent'] ?? -1) === 0.35, 'sample completeness must count five-minute intervals, not raw sources');
    assert_test((float) ($deduplicatedHistory['players_average'] ?? -1) === 3.0, 'player aggregation must prefer the public query sample in a shared interval');

    [$status] = request_json($base, 'PUT', "/api/servers/$serverId/password", ['password' => 'new-secret'], $aliceToken);
    assert_test($status === 204, 'password update failed');

    [$status, $template] = request_json($base, 'POST', '/api/command-templates', ['name' => 'Restart', 'command' => "say soon\n@wait 1\nrestart"], $aliceToken);
    assert_test($status === 201 && ($template['name'] ?? '') === 'Restart', 'command template creation failed');

    [$status, $rule] = request_json($base, 'POST', '/api/moderation-rules', ['pattern' => 'badword', 'action' => 'kick'], $aliceToken);
    assert_test($status === 201 && ($rule['action'] ?? '') === 'kick', 'moderation rule creation failed');

    [$status, $synced] = request_json($base, 'POST', '/api/nitrado/sync', ['token' => 'integration-token'], $aliceToken);
    assert_test($status === 200 && count($synced) === 2, 'Nitrado sync did not add the mock service');
    $storedToken = (string) $pdo->query("SELECT nitrado_token_enc FROM users WHERE username = '$alice'")->fetchColumn();
    assert_test(str_starts_with($storedToken, 'NC2') === $wantV2, "Nitrado token format must match the $cryptoMode mode");
    assert_test(nicon_open_with_ring($ring, $storedToken, nicon_aad_nitrado_token($aliceUserId)) === 'integration-token', 'the stored Nitrado token decrypts with its own user as AAD');
    $nitradoServer = null;
    foreach ($synced as $candidate) if (($candidate['source'] ?? '') === 'nitrado') $nitradoServer = $candidate;
    assert_test(is_array($nitradoServer), 'Nitrado server missing from sync response');
    assert_test(($nitradoServer['game_icon_url'] ?? '') === 'https://assets.nitrado.net/gmod-64.png', 'Nitrado icon URL missing');
    // 'auto', not 'a2s': the a2s/minecraft/disabled decision now lives in
    // exactly one place (internal/relay's EffectivePublicQueryProtocol),
    // not duplicated in nicon_nitrado_query_protocol() — see that
    // function's doc comment for why. query_port still comes straight from
    // Nitrado's own reported value regardless.
    assert_test(($nitradoServer['query_protocol'] ?? '') === 'auto' && ($nitradoServer['query_port'] ?? 0) === 27015, 'Nitrado query metadata missing');

    [$status, $nitradoStatus] = request_json($base, 'GET', '/api/servers/' . $nitradoServer['id'] . '/nitrado-status', null, $aliceToken);
    assert_test($status === 200 && ($nitradoStatus['players'] ?? null) === 3, 'Nitrado status lookup failed');
    assert_test(!array_key_exists('memory_mb', $nitradoStatus) && !array_key_exists('cpu', $nitradoStatus) && !array_key_exists('settings', $nitradoStatus), 'Nitrado status must expose only the compact status fields');
    [$status, $history] = request_json($base, 'GET', '/api/servers/' . $nitradoServer['id'] . '/health-history?range=24h', null, $aliceToken);
    assert_test($status === 200 && ($history['players_peak'] ?? null) === 3 && count($history['samples'] ?? []) >= 1, 'health history did not include Nitrado player sample');
    $counts = json_decode((string) file_get_contents($counterFile), true);
    assert_test(($counts['GET /services/9001/gameservers'] ?? 0) === 1, 'Nitrado GET responses were not shared through the backend cache');

    [$status] = request_json($base, 'POST', '/api/servers/' . $nitradoServer['id'] . '/nitrado-power', ['action' => 'restart'], $aliceToken);
    assert_test($status === 200, 'Nitrado restart failed');

    [$status] = request_json($base, 'GET', '/api/servers/' . $nitradoServer['id'] . '/nitrado-status', null, $aliceToken);
    assert_test($status === 200, 'Nitrado status lookup after restart failed');
    $counts = json_decode((string) file_get_contents($counterFile), true);
    assert_test(($counts['GET /services/9001/gameservers'] ?? 0) === 2, 'Nitrado mutation did not invalidate the backend cache');

    [$status, $editedNitrado] = request_json($base, 'PUT', '/api/servers/' . $nitradoServer['id'], [
        'name' => 'Temporarily edited Nitrado server',
        'host' => $nitradoServer['host'],
        'port' => $nitradoServer['port'],
        'protocol' => 'telnet',
        'query_protocol' => 'disabled',
        'query_port' => null,
        'game' => '7 Days to Die',
    ], $aliceToken);
    assert_test($status === 200 && ($editedNitrado['source'] ?? '') === 'nitrado', 'Nitrado profile update failed');
    assert_test(($editedNitrado['game_icon_url'] ?? null) === null, 'changing a Nitrado game must clear its now-stale icon');

    assert_test((int) $pdo->query('SELECT COUNT(*) FROM nitrado_cache')->fetchColumn() > 0, 'expected a cached Nitrado response before credential deletion');
    [$status] = request_json($base, 'DELETE', '/api/account/nitrado-token', null, $aliceToken);
    assert_test($status === 204, 'Nitrado token deletion failed');
    assert_test((int) $pdo->query('SELECT COUNT(*) FROM nitrado_cache')->fetchColumn() === 0, 'deleting a Nitrado token did not invalidate its cache');

    $pdo->prepare("INSERT INTO audit_log (user_id, action, detail, created_at) VALUES (?, 'expired_test_entry', 'old', DATE_SUB(UTC_TIMESTAMP(), INTERVAL 181 DAY))")
        ->execute([$createdUsers[0]]);
    $aliceIdStmt = $pdo->prepare('SELECT id FROM users WHERE username = ?');
    $aliceIdStmt->execute([$alice]);
    $aliceId = (int) $aliceIdStmt->fetchColumn();
    $pdo->prepare("INSERT INTO rcon_audit_log
        (user_id, server_id, username, server_name, command, action, target_player, origin, result, success, upstream_ms, relay_overhead_ms)
        VALUES (?, ?, ?, 'Edited GMod', 'kickid 7', 'kick', 'Alice', 'player_action', 'ok', 1, 4.2, 0.8)")
        ->execute([$aliceId, $serverId, $alice]);
    $pdo->prepare("INSERT INTO rcon_audit_log
        (user_id, server_id, username, server_name, command, action, origin, success, created_at)
        VALUES (?, ?, ?, 'Edited GMod', 'old', 'command', 'manual', 1, DATE_SUB(UTC_TIMESTAMP(), INTERVAL 181 DAY))")
        ->execute([$aliceId, $serverId, $alice]);
    [$status, $audit] = request_json($base, 'GET', '/api/audit-log', null, $aliceToken);
    $actions = array_column($audit ?? [], 'action');
    assert_test($status === 200 && in_array('server_updated', $actions, true), 'server update audit entry missing');
    assert_test(in_array('server_password_changed', $actions, true), 'password update audit entry missing');
    assert_test(in_array('nitrado_server_restarted', $actions, true), 'Nitrado power audit entry missing');
    $rconRows = array_values(array_filter($audit ?? [], static fn(array $row): bool => ($row['kind'] ?? '') === 'rcon'));
    assert_test(count($rconRows) === 1 && (int) ($rconRows[0]['server_id'] ?? 0) === $serverId && ($rconRows[0]['target_player'] ?? '') === 'Alice' && ($rconRows[0]['success'] ?? false), 'structured RCON audit entry missing');
    assert_test(!in_array('expired_test_entry', $actions, true), 'expired audit entry was not removed');
    assert_test((int) $pdo->query("SELECT COUNT(*) FROM audit_log WHERE action = 'expired_test_entry'")->fetchColumn() === 0, 'expired audit entry remained in the database');
    assert_test((int) $pdo->query("SELECT COUNT(*) FROM rcon_audit_log WHERE command = 'old'")->fetchColumn() === 0, 'expired RCON audit entry remained in the database');

    // ---- audit-log pagination ---------------------------------------------
    $insertRcon = $pdo->prepare("INSERT INTO rcon_audit_log
        (user_id, server_id, username, server_name, command, action, origin, success)
        VALUES (?, ?, ?, 'Edited GMod', ?, 'command', 'manual', 1)");
    for ($i = 1; $i <= 4; $i++) {
        $insertRcon->execute([$aliceId, $serverId, $alice, "page-test-$i"]);
    }

    [$status, $legacy] = request_json($base, 'GET', '/api/audit-log', null, $aliceToken);
    assert_test($status === 200 && is_array($legacy) && array_is_list($legacy) && count($legacy) >= 6, 'without pagination parameters the audit log stays a plain array');

    [$status, $page1] = request_json($base, 'GET', '/api/audit-log?page=1&per_page=3', null, $aliceToken);
    assert_test($status === 200 && count($page1['items'] ?? []) === 3 && $page1['page'] === 1 && $page1['per_page'] === 3, 'first audit page has the wrong shape');
    $total = (int) $page1['total'];
    assert_test($total === count($legacy), "audit total ($total) must equal the number of entries (" . count($legacy) . ')');
    assert_test($page1['total_pages'] === (int) ceil($total / 3), 'audit total_pages is wrong');

    $collected = [];
    for ($pageNo = 1; $pageNo <= $page1['total_pages']; $pageNo++) {
        [$status, $pageData] = request_json($base, 'GET', "/api/audit-log?page=$pageNo&per_page=3", null, $aliceToken);
        assert_test($status === 200, "audit page $pageNo failed");
        foreach ($pageData['items'] as $item) $collected[] = $item;
    }
    assert_test(json_encode($collected) === json_encode($legacy), 'walking every page must reproduce the full, identically ordered list without gaps or duplicates');

    [$status, $beyond] = request_json($base, 'GET', '/api/audit-log?page=999&per_page=3', null, $aliceToken);
    assert_test($status === 200 && $beyond['items'] === [] && $beyond['total'] === $total, 'a page past the end must be empty, not an error');
    [$status, $clamped] = request_json($base, 'GET', '/api/audit-log?page=0&per_page=100000', null, $aliceToken);
    assert_test($status === 200 && $clamped['page'] === 1 && $clamped['per_page'] === 100, 'page and per_page must be clamped');

    [$status, $perServer] = request_json($base, 'GET', "/api/audit-log?server_id=$serverId&page=1&per_page=100", null, $aliceToken);
    assert_test($status === 200 && $perServer['total'] >= 5, 'the per-server audit filter lost entries');
    foreach ($perServer['items'] as $item) {
        assert_test($item['kind'] === 'rcon' && $item['server_id'] === $serverId, 'the per-server audit filter must only return that server\'s console commands');
    }
    [$status, $foreign] = request_json($base, 'GET', "/api/audit-log?server_id=$serverId&page=1&per_page=100", null, $bobToken);
    assert_test($status === 200 && $foreign['total'] === 0 && $foreign['items'] === [], 'another user must not see a server\'s audit entries');

    [$status, $adminPage] = request_json($base, 'GET', '/api/admin/audit-log?page=1&per_page=2', null, $aliceToken);
    assert_test($status === 200 && count($adminPage['items']) === 2 && $adminPage['total'] >= $total, 'admin audit log pagination failed');
    $accountItems = array_values(array_filter($adminPage['items'], static fn(array $i): bool => $i['kind'] === 'account'));
    assert_test($accountItems === [] || array_key_exists('ip_address', $accountItems[0]), 'the admin view keeps the IP address');
    [$status] = request_json($base, 'GET', '/api/admin/audit-log?page=1', null, $bobToken);
    assert_test($status === 403, 'audit log pagination must not bypass the admin check');
    [$status, $ownPage] = request_json($base, 'GET', '/api/audit-log?page=1&per_page=100', null, $aliceToken);
    foreach ($ownPage['items'] as $item) {
        assert_test(!array_key_exists('ip_address', $item), 'a user\'s own activity must never expose IP addresses');
    }

    // ---- health history: SQL aggregation == the old PHP computation ---------
    $pdo->prepare('DELETE FROM server_health_samples WHERE server_id = ?')->execute([$serverId]);
    $pdo->prepare('DELETE FROM health_history_cache WHERE server_id = ?')->execute([$serverId]);
    $seed = $pdo->prepare('INSERT INTO server_health_samples (server_id, sampled_at, online, latency_ms, player_current, player_max, source) VALUES (?, ?, ?, ?, ?, ?, ?)');
    $slotBase = intdiv(time(), 300) * 300 - 150;
    for ($i = 0; $i < 864; $i++) {                    // three days of 5-minute slots
        $ts = $slotBase - $i * 300;
        $age = time() - $ts;
        if ($age > 86400 - 900 && $age < 86400 + 900) continue;   // stay clear of the 24 h cutoff
        $at = gmdate('Y-m-d H:i:s', $ts);
        $up = ($i % 17) !== 0;                                     // regular outages
        $seed->execute([$serverId, $at, $up ? 1 : 0, $up ? 20 + $i % 30 : null, null, null, 'relay']);
        if ($i % 2 === 0) $seed->execute([$serverId, $at, 1, null, 5 + $i % 11, 20, 'a2s']);
        if ($i % 4 === 0) $seed->execute([$serverId, $at, 1, null, 9 + $i % 7, 24, 'nitrado']);   // beats a2s in the same slot
        if ($i % 9 === 0) $seed->execute([$serverId, $at, 1, null, 30, null, 'client']);           // never counts for availability
    }
    $rawRows = (int) $pdo->query("SELECT COUNT(*) FROM server_health_samples WHERE server_id = $serverId")->fetchColumn();
    assert_test($rawRows > 1500, 'health-history fixture should be large');

    // The previous implementation, verbatim, as the reference.
    $referenceHistory = static function (PDO $pdo, int $serverId, int $days): array {
        $stmt = $pdo->prepare("SELECT sampled_at, online, player_current, source FROM server_health_samples
            WHERE server_id = ? AND sampled_at >= DATE_SUB(UTC_TIMESTAMP(), INTERVAL $days DAY) ORDER BY sampled_at ASC");
        $stmt->execute([$serverId]);
        $availabilityBuckets = [];
        $playerBuckets = [];
        foreach ($stmt as $row) {
            $isOnline = (bool) $row['online'];
            $source = (string) $row['source'];
            $bucket = (int) floor(strtotime((string) $row['sampled_at']) / 300);
            if ($source !== 'client') {
                $priority = $source === 'relay' ? 20 : 10;
                if (!isset($availabilityBuckets[$bucket]) || $priority > $availabilityBuckets[$bucket]['priority']) {
                    $availabilityBuckets[$bucket] = ['online' => $isOnline, 'priority' => $priority];
                }
            }
            $current = $row['player_current'] === null ? null : (int) $row['player_current'];
            if ($current !== null) {
                $priority = $source === 'nitrado' ? 40 : (in_array($source, ['a2s', 'mcquery'], true) ? 30 : ($source === 'client' ? 20 : 10));
                if (!isset($playerBuckets[$bucket]) || $priority > $playerBuckets[$bucket]['priority']) {
                    $playerBuckets[$bucket] = ['players' => $current, 'priority' => $priority];
                }
            }
        }
        $count = count($availabilityBuckets);
        $online = count(array_filter($availabilityBuckets, static fn(array $x): bool => $x['online']));
        $values = array_column($playerBuckets, 'players');
        return [
            'uptime' => $count ? round($online * 100 / $count, 2) : null,
            'completeness' => round(min(100, $count * 100 / ($days * 24 * 12)), 2),
            'average' => $values ? round(array_sum($values) / count($values), 1) : null,
            'peak' => $values ? max($values) : null,
        ];
    };
    foreach (['24h' => 1, '7d' => 7, '30d' => 30, '90d' => 90] as $rangeKey => $daysInRange) {
        [$status, $history] = request_json($base, 'GET', "/api/servers/$serverId/health-history?range=$rangeKey", null, $aliceToken);
        assert_test($status === 200, "health history $rangeKey failed");
        $expectedStats = $referenceHistory($pdo, $serverId, $daysInRange);
        assert_test($history['uptime_percent'] === $expectedStats['uptime'] || abs($history['uptime_percent'] - $expectedStats['uptime']) < 0.005, "uptime differs for $rangeKey: " . json_encode([$history['uptime_percent'], $expectedStats['uptime']]));
        assert_test(abs($history['sample_completeness_percent'] - $expectedStats['completeness']) < 0.005, "completeness differs for $rangeKey");
        assert_test(abs($history['players_average'] - $expectedStats['average']) < 0.05, "average players differ for $rangeKey: " . json_encode([$history['players_average'], $expectedStats['average']]));
        assert_test($history['players_peak'] === $expectedStats['peak'], "peak players differ for $rangeKey");

        if ($rangeKey === '24h') {
            $within = (int) $pdo->query("SELECT COUNT(*) FROM server_health_samples WHERE server_id = $serverId AND sampled_at >= DATE_SUB(UTC_TIMESTAMP(), INTERVAL 1 DAY)")->fetchColumn();
            assert_test(count($history['samples']) === $within && !isset($history['resolution_seconds']), '24 h stays a raw series');
            continue;
        }
        $resolution = $daysInRange > 30 ? 86400 : 3600;
        assert_test(($history['resolution_seconds'] ?? 0) === $resolution, "$rangeKey resolution is $resolution seconds");
        assert_test(count($history['samples']) <= ceil(3 * 86400 / $resolution) + 2, "$rangeKey series must be condensed, got " . count($history['samples']));
        assert_test(count($history['samples']) < $rawRows / 10, "$rangeKey must be far smaller than the raw rows");
        foreach ($history['samples'] as $sample) {
            assert_test(strtotime($sample['at']) % $resolution === 0, 'aggregated samples sit on bucket boundaries');
            assert_test($sample['source'] !== 'client' || $sample['online_ratio'] === 1.0, 'player-only buckets are marked "client"');
            assert_test(isset($sample['online_ratio']) && $sample['online_ratio'] >= 0 && $sample['online_ratio'] <= 1, 'online_ratio out of range');
        }
        assert_test(count(array_filter($history['samples'], static fn(array $x): bool => $x['source'] === 'aggregate' && $x['online_ratio'] < 1)) > 0, 'the regular outages must show up as partial buckets');
    }

    // ---- admin lists: optional pagination -----------------------------------
    [$status, $allUsers] = request_json($base, 'GET', '/api/admin/users', null, $aliceToken);
    assert_test($status === 200 && array_is_list($allUsers) && count($allUsers) >= 2, 'the admin user list stays a plain array without parameters');
    $collectedUsers = [];
    [$status, $usersPage] = request_json($base, 'GET', '/api/admin/users?page=1&per_page=1', null, $aliceToken);
    assert_test($status === 200 && count($usersPage['items']) === 1 && $usersPage['total'] === count($allUsers) && $usersPage['total_pages'] === count($allUsers), 'admin user pagination has the wrong shape');
    for ($pageNo = 1; $pageNo <= $usersPage['total_pages']; $pageNo++) {
        [, $onePage] = request_json($base, 'GET', "/api/admin/users?page=$pageNo&per_page=1", null, $aliceToken);
        foreach ($onePage['items'] as $item) $collectedUsers[] = $item;
    }
    assert_test(json_encode($collectedUsers) === json_encode($allUsers), 'paging through the users must reproduce the full list');
    [$status] = request_json($base, 'GET', '/api/admin/users?page=1', null, $bobToken);
    assert_test($status === 403, 'user pagination must not bypass the admin check');

    [$status, $faqAll] = request_json($base, 'GET', '/api/admin/faq', null, $aliceToken);
    [$status, $faqPage] = request_json($base, 'GET', '/api/admin/faq?page=2&per_page=3', null, $aliceToken);
    assert_test($status === 200 && $faqPage['page'] === 2 && $faqPage['total'] === count($faqAll) && json_encode($faqPage['items']) === json_encode(array_slice($faqAll, 3, 3)), 'admin FAQ pagination is wrong');

    $noticeIds = [];
    foreach (['one', 'two', 'three'] as $text) {
        [$status, $notice] = request_json($base, 'POST', '/api/admin/notifications', ['type' => 'info', 'message' => "page-test $text"], $aliceToken);
        assert_test($status === 200, 'notification creation failed');
        $noticeIds[] = $notice['id'];
    }
    [$status, $noticesAll] = request_json($base, 'GET', '/api/notifications', null, $bobToken);
    assert_test($status === 200 && array_is_list($noticesAll) && count($noticesAll) >= 3, 'notifications stay a plain array for everyone');
    [$status, $noticePage] = request_json($base, 'GET', '/api/notifications?page=1&per_page=2', null, $aliceToken);
    assert_test($status === 200 && count($noticePage['items']) === 2 && $noticePage['total'] === count($noticesAll) && $noticePage['total_pages'] === (int) ceil(count($noticesAll) / 2), 'notification pagination is wrong');
    foreach ($noticeIds as $noticeId) request_json($base, 'DELETE', "/api/admin/notifications/$noticeId", null, $aliceToken);

    // ---- maintenance: batched cleanup --------------------------------------
    $oldRow = $pdo->prepare("INSERT INTO audit_log (user_id, action, detail, created_at) VALUES (?, 'expired_bulk', 'old', DATE_SUB(UTC_TIMESTAMP(), INTERVAL 400 DAY))");
    $pdo->beginTransaction();
    for ($i = 0; $i < 2500; $i++) $oldRow->execute([$aliceId]);
    $pdo->commit();
    $countBulk = static fn(): int => (int) $pdo->query("SELECT COUNT(*) FROM audit_log WHERE action = 'expired_bulk'")->fetchColumn();
    assert_test($countBulk() === 2500, 'maintenance fixture');
    request_json($base, 'GET', '/api/audit-log', null, $aliceToken);
    assert_test($countBulk() === 1500, 'one request deletes at most one batch (1000 rows) per table, got ' . $countBulk());
    putenv('NICON_CONFIG_FILE=' . $root . '/tests/php/config.php');
    putenv('NICON_ENCRYPTION_KEY=' . $key);
    putenv('NICON_PHP_TEST_DB_DSN=' . $dsn);
    $cronOutput = (string) shell_exec(escapeshellarg(PHP_BINARY) . ' ' . escapeshellarg($root . '/webspace/cron/sample_nitrado.php') . ' 2>&1');
    assert_test(str_contains($cronOutput, 'cleaned'), 'the cron job runs the maintenance: ' . $cronOutput);
    assert_test($countBulk() === 0, 'the cron job finishes the backlog');

    // ---- optional TLS for the HTTP/WebSocket based protocols ----------------
    [$status, $plain] = request_json($base, 'POST', '/api/servers', [
        'name' => 'TLS default', 'host' => '127.0.0.1', 'port' => 28016, 'password' => 'secret', 'protocol' => 'webrcon', 'game' => '',
    ], $aliceToken);
    assert_test($status === 200 && $plain['use_tls'] === false, 'TLS is off by default');
    [$status, $tlsServer] = request_json($base, 'POST', '/api/servers', [
        'name' => 'TLS on', 'host' => '127.0.0.1', 'port' => 28016, 'password' => 'secret', 'protocol' => 'palworld_rest', 'use_tls' => true, 'game' => '',
    ], $aliceToken);
    assert_test($status === 200 && $tlsServer['use_tls'] === true, 'TLS can be enabled for a Palworld REST server');
    assert_test((int) $pdo->query('SELECT use_tls FROM servers WHERE id = ' . (int) $tlsServer['id'])->fetchColumn() === 1, 'use_tls is stored');
    [$status, $refused] = request_json($base, 'POST', '/api/servers', [
        'name' => 'TLS on Source', 'host' => '127.0.0.1', 'port' => 28016, 'password' => 'secret', 'protocol' => 'source', 'use_tls' => true, 'game' => '',
    ], $aliceToken);
    assert_test($status === 400 && str_contains($refused['error'] ?? '', 'TLS'), 'TLS must be refused for a protocol without a TLS variant');
    [$status, $updated] = request_json($base, 'PUT', '/api/servers/' . $tlsServer['id'], [
        'name' => 'TLS on', 'host' => '127.0.0.1', 'port' => 28016, 'protocol' => 'webrcon', 'use_tls' => false, 'game' => '',
    ], $aliceToken);
    assert_test($status === 200 && $updated['use_tls'] === false && $updated['protocol'] === 'webrcon', 'TLS can be switched off again');
    [$status] = request_json($base, 'PUT', '/api/servers/' . $tlsServer['id'], [
        'name' => 'TLS on', 'host' => '127.0.0.1', 'port' => 28016, 'protocol' => 'telnet', 'use_tls' => true, 'game' => '',
    ], $aliceToken);
    assert_test($status === 400, 'an update must not enable TLS on a protocol without one');
    [$status, $listed] = request_json($base, 'GET', '/api/servers', null, $aliceToken);
    assert_test(count(array_filter($listed, static fn(array $s): bool => array_key_exists('use_tls', $s))) === count($listed), 'every listed server reports use_tls');
    foreach ([$plain['id'], $tlsServer['id']] as $tlsFixtureId) request_json($base, 'DELETE', "/api/servers/$tlsFixtureId", null, $aliceToken);

    // ---- password policy, input validation --------------------------------
    $pdo->exec('DELETE FROM rate_limits');
    [$status, $body] = request_json($base, 'POST', '/api/register', [
        'username' => "it_short_$suffix", 'password' => str_repeat('x1', 7), 'consent_accepted' => true, // 14 chars
    ]);
    assert_test($status === 400 && str_contains($body['error'] ?? '', '15'), 'a 14-character password must be rejected on registration');
    [$status, $body] = request_json($base, 'POST', '/api/register', [
        'username' => "it_long_$suffix", 'password' => str_repeat('ab', 37), 'consent_accepted' => true, // 74 bytes
    ]);
    assert_test($status === 400 && str_contains($body['error'] ?? '', '72'), 'a password over 72 bytes must be rejected on registration');
    [$status, $body] = request_json($base, 'POST', '/api/register', [
        'username' => "it_same_$suffix", 'password' => str_repeat('a', 20), 'consent_accepted' => true,
    ]);
    assert_test($status === 400, 'a single repeated character must be rejected');
    assert_test((int) $pdo->query("SELECT COUNT(*) FROM users WHERE username LIKE 'it\_%\_$suffix' AND username NOT IN ('$alice', '$bob')")->fetchColumn() === 0, 'rejected registrations must not create users');

    [$status, $body] = request_json($base, 'POST', '/api/login', 'this is not json');
    assert_test($status === 400 && str_contains($body['error'] ?? '', 'JSON'), 'malformed JSON must be a 400');
    [$status] = request_json($base, 'POST', '/api/login', '"just a string"');
    assert_test($status === 400, 'a JSON scalar body must be a 400');
    [$status] = request_json($base, 'POST', '/api/login', ['username' => ['x'], 'password' => 'whatever-whatever']);
    assert_test($status !== 500, 'a non-string field must not crash the API');

    [$status, $body] = request_json($base, 'POST', '/api/servers', [
        'name' => 'Too long password', 'host' => '127.0.0.1', 'port' => 28016, 'protocol' => 'source', 'game' => '',
        'password' => str_repeat('p', NICON_TEST_MAX_SERVER_PASSWORD + 1),
    ], $aliceToken);
    assert_test($status === 400 && str_contains($body['error'] ?? '', 'too long'), 'an over-long RCON password must be a 400, not a database error');
    [$status] = request_json($base, 'PUT', "/api/servers/$serverId/password", ['password' => str_repeat('p', NICON_TEST_MAX_SERVER_PASSWORD + 1)], $aliceToken);
    assert_test($status === 400, 'an over-long replacement RCON password must be a 400');
    [$status] = request_json($base, 'PUT', "/api/servers/$serverId/password", ['password' => str_repeat('p', NICON_TEST_MAX_SERVER_PASSWORD)], $aliceToken);
    assert_test($status === 204, 'a maximum-length RCON password must still fit the column');
    [$status] = request_json($base, 'POST', '/api/nitrado/sync', ['token' => str_repeat('t', 2021)], $aliceToken);
    assert_test($status === 400, 'an over-long Nitrado token must be a 400');
    [$status] = request_json($base, 'POST', '/api/admin/notifications', ['type' => 'info', 'message' => str_repeat('m', 2001)], $aliceToken);
    assert_test($status === 400, 'an over-long notification must be a 400');

    // ---- change password -------------------------------------------------
    $bobPassword = 'integration-password';
    $bobNewPassword = 'a-brand-new-integration-secret';
    [$status] = request_json($base, 'PUT', '/api/account/password', ['current_password' => 'wrong', 'new_password' => $bobNewPassword], $bobToken);
    assert_test($status === 403, 'change password with a wrong current password must be 403');
    [$status] = request_json($base, 'PUT', '/api/account/password', ['current_password' => $bobPassword, 'new_password' => 'short-one'], $bobToken);
    assert_test($status === 400, 'change password must apply the policy');
    [$status] = request_json($base, 'PUT', '/api/account/password', ['current_password' => $bobPassword, 'new_password' => $bobNewPassword], $bobToken);
    assert_test($status === 204, 'valid password change failed');
    $bobPassword = $bobNewPassword;
    [$status] = request_json($base, 'POST', '/api/login', ['username' => $bob, 'password' => 'integration-password']);
    assert_test($status === 401, 'the old password must stop working');
    [$status, $bobLogin] = request_json($base, 'POST', '/api/login', ['username' => $bob, 'password' => $bobPassword]);
    assert_test($status === 200, 'the new password must work');
    $bobToken = $bobLogin['token'];

    // ---- step-up authentication -----------------------------------------
    [$status] = request_json($base, 'DELETE', '/api/account', null, $bobToken);
    assert_test($status === 400, 'account deletion without a password must be refused');
    [$status] = request_json($base, 'DELETE', '/api/account', ['current_password' => 'nope-nope-nope-nope'], $bobToken);
    assert_test($status === 403, 'account deletion with a wrong password must be refused');
    assert_test((int) $pdo->query("SELECT COUNT(*) FROM users WHERE username = '$bob'")->fetchColumn() === 1, 'a refused deletion must not delete');

    $bobIdStmt = $pdo->prepare('SELECT id FROM users WHERE username = ?');
    $bobIdStmt->execute([$bob]);
    $bobId = (int) $bobIdStmt->fetchColumn();
    [$status] = request_json($base, 'DELETE', "/api/admin/users/$bobId", null, $aliceToken);
    assert_test($status === 400, 'admin user deletion without the admin password must be refused');
    [$status] = request_json($base, 'DELETE', "/api/admin/users/$bobId", ['current_password' => 'nope-nope-nope-nope'], $aliceToken);
    assert_test($status === 403, 'admin user deletion with a wrong password must be refused');
    [$status] = request_json($base, 'POST', "/api/admin/users/$bobId/recovery-code", null, $aliceToken);
    assert_test($status === 400, 'recovery-code regeneration without the admin password must be refused');
    [$status, $regen] = request_json($base, 'POST', "/api/admin/users/$bobId/recovery-code", ['current_password' => 'integration-password'], $aliceToken);
    assert_test($status === 200 && is_string($regen['recovery_code'] ?? null), 'recovery-code regeneration with the password failed');

    // ---- admin session age ------------------------------------------------
    $pdo->prepare('UPDATE sessions SET created_at = DATE_SUB(NOW(), INTERVAL 9 HOUR) WHERE token = ?')->execute([hash('sha256', $aliceToken)]);
    [$status] = request_json($base, 'GET', '/api/admin/users', null, $aliceToken);
    assert_test($status === 401, 'an admin session older than 8 hours must be refused');
    [$status] = request_json($base, 'GET', '/api/servers', null, $aliceToken);
    assert_test($status === 200, 'the same old session must keep working for ordinary endpoints');
    [$status, $aliceLogin] = request_json($base, 'POST', '/api/login', ['username' => $alice, 'password' => 'integration-password']);
    assert_test($status === 200, 'alice re-login failed');
    $aliceToken = $aliceLogin['token'];

    // ---- last-admin race ---------------------------------------------------
    // Unlocked, "count the admins, then delete" let two concurrent deletions
    // both see "another admin exists" and remove every admin. Deterministic
    // reproduction: a second connection plays the competing deletion and
    // holds the admin rows locked, mid-transaction. The API request must
    // wait for that transaction instead of deciding on stale data, and once
    // the competitor has removed the other admin it must refuse to remove
    // the last one.
    $pdo->prepare('UPDATE users SET is_admin = 0 WHERE username NOT IN (?, ?)')->execute([$alice, $bob]);
    $pdo->prepare('UPDATE users SET is_admin = 1 WHERE username IN (?, ?)')->execute([$alice, $bob]);
    $aliceIdStmt->execute([$alice]);
    $aliceId = (int) $aliceIdStmt->fetchColumn();

    $competitor = new PDO($dsn, getenv('NICON_PHP_TEST_DB_USER') ?: '', getenv('NICON_PHP_TEST_DB_PASS') ?: '', [
        PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
    ]);
    $competitor->beginTransaction();
    $competitor->query('SELECT id FROM users WHERE is_admin = 1 ORDER BY id FOR UPDATE')->fetchAll();

    $multi = curl_multi_init();
    $ch = curl_init("$base/api/admin/users/$bobId"); // alice deletes bob
    curl_setopt_array($ch, [
        CURLOPT_CUSTOMREQUEST => 'DELETE',
        CURLOPT_HTTPHEADER => ['Content-Type: application/json', 'Authorization: Bearer ' . $aliceToken],
        CURLOPT_POSTFIELDS => json_encode(['current_password' => 'integration-password']),
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_TIMEOUT => 30,
    ]);
    curl_multi_add_handle($multi, $ch);
    $deadline = microtime(true) + 1.5; // give the request ample time to (wrongly) finish
    do {
        curl_multi_exec($multi, $running);
        if ($running) curl_multi_select($multi, 0.1);
    } while ($running && microtime(true) < $deadline);
    assert_test($running > 0, 'the admin delete must wait for the transaction holding the admin rows');
    assert_test((int) $pdo->query("SELECT COUNT(*) FROM users WHERE id = $bobId")->fetchColumn() === 1, 'the admin delete must not have removed anyone yet');

    // The competing deletion removes alice and commits: bob is now the last admin.
    $competitor->exec("DELETE FROM users WHERE id = $aliceId");
    $competitor->commit();
    do {
        curl_multi_exec($multi, $running);
        if ($running) curl_multi_select($multi, 0.1);
    } while ($running);
    $raceStatus = (int) curl_getinfo($ch, CURLINFO_HTTP_CODE);
    curl_multi_remove_handle($multi, $ch);
    curl_multi_close($multi);
    assert_test($raceStatus === 400, "deleting the last remaining admin must be refused (got $raceStatus)");
    assert_test((int) $pdo->query("SELECT COUNT(*) FROM users WHERE id = $bobId AND is_admin = 1")->fetchColumn() === 1, 'the last admin must survive');

    // ... and cannot remove their own account either.
    [$status, $body] = request_json($base, 'DELETE', '/api/account', ['current_password' => $bobPassword], $bobToken);
    assert_test($status === 400 && str_contains($body['error'] ?? '', 'only remaining admin'), 'the last admin must not be able to delete their own account');

    fwrite(STDOUT, "PASS: PHP API integration suite\n");
} finally {
    // Registration can succeed before a later assertion populates
    // $createdUsers. Resolve the unique test names again so an aborted run
    // cannot leave fixtures behind in the CI database.
    $stmt = $pdo->prepare('SELECT id FROM users WHERE username IN (?, ?)');
    $stmt->execute([$alice, $bob]);
    $createdUsers = array_values(array_unique(array_merge(
        $createdUsers,
        array_map('intval', $stmt->fetchAll(PDO::FETCH_COLUMN))
    )));
    if ($createdUsers) {
        $placeholders = implode(',', array_fill(0, count($createdUsers), '?'));
        $cleanup = $pdo->prepare("DELETE FROM users WHERE id IN ($placeholders)");
        $cleanup->execute($createdUsers);
    }
    foreach (array_reverse($processes) as $process) {
        proc_terminate($process);
        proc_close($process);
    }
    foreach ($logs as $log) if (is_file($log)) unlink($log);
}
