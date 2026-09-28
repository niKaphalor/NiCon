<?php
declare(strict_types=1);

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

function request_json(string $baseUrl, string $method, string $path, ?array $body = null, string $token = ''): array
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
    if ($body !== null) curl_setopt($ch, CURLOPT_POSTFIELDS, json_encode($body));
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
    [$mockProcess, $mockLog] = start_php_server($root . '/tests/php/nitrado_router.php', $nitradoPort);
    $processes[] = $mockProcess;
    $logs[] = $mockLog;

    $apiPort = free_port();
    $key = base64_encode(str_repeat("\x2a", 32));
    [$apiProcess, $apiLog] = start_php_server($root . '/tests/php/api_router.php', $apiPort, [
        'NICON_CONFIG_FILE' => $root . '/tests/php/config.php',
        'NICON_PHP_TEST_DB_DSN' => $dsn,
        'NICON_PHP_TEST_DB_USER' => getenv('NICON_PHP_TEST_DB_USER') ?: '',
        'NICON_PHP_TEST_DB_PASS' => getenv('NICON_PHP_TEST_DB_PASS') ?: '',
        'NICON_ENCRYPTION_KEY' => $key,
        'NICON_NITRADO_API_BASE_URL' => "http://127.0.0.1:$nitradoPort",
    ]);
    $processes[] = $apiProcess;
    $logs[] = $apiLog;
    $base = "http://127.0.0.1:$apiPort";

    [$status] = request_json($base, 'GET', '/api/healthz');
    assert_test($status === 200, 'health endpoint must return 200');

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

    [$status, $server] = request_json($base, 'POST', '/api/servers', [
        'name' => 'Manual Rust',
        'host' => '127.0.0.1',
        'port' => 28016,
        'password' => 'secret',
        'protocol' => 'webrcon',
        'game' => 'Rust',
    ], $aliceToken);
    assert_test($status === 200 && ($server['game'] ?? '') === 'Rust', 'manual server game was not persisted');
    assert_test(($server['has_password'] ?? false) === true && !array_key_exists('password', $server), 'server response exposed or lost password state');
    $serverId = (int) $server['id'];

    [$status] = request_json($base, 'PUT', "/api/servers/$serverId", [
        'name' => 'Stolen', 'host' => '127.0.0.1', 'port' => 1, 'protocol' => 'source', 'game' => 'Minecraft',
    ], $bobToken);
    assert_test($status === 404, 'cross-account server update must look not found');

    [$status, $updated] = request_json($base, 'PUT', "/api/servers/$serverId", [
        'name' => 'Edited Rust',
        'host' => '127.0.0.2',
        'port' => 28017,
        'protocol' => 'webrcon',
        'game' => 'Rust',
    ], $aliceToken);
    assert_test($status === 200 && ($updated['name'] ?? '') === 'Edited Rust' && ($updated['port'] ?? 0) === 28017, 'profile update failed');

    [$status] = request_json($base, 'PUT', "/api/servers/$serverId/password", ['password' => 'new-secret'], $aliceToken);
    assert_test($status === 204, 'password update failed');

    [$status, $template] = request_json($base, 'POST', '/api/command-templates', ['name' => 'Restart', 'command' => "say soon\n@wait 1\nrestart"], $aliceToken);
    assert_test($status === 201 && ($template['name'] ?? '') === 'Restart', 'command template creation failed');

    [$status, $rule] = request_json($base, 'POST', '/api/moderation-rules', ['pattern' => 'badword', 'action' => 'kick'], $aliceToken);
    assert_test($status === 201 && ($rule['action'] ?? '') === 'kick', 'moderation rule creation failed');

    [$status, $synced] = request_json($base, 'POST', '/api/nitrado/sync', ['token' => 'integration-token'], $aliceToken);
    assert_test($status === 200 && count($synced) === 2, 'Nitrado sync did not add the mock service');
    $nitradoServer = null;
    foreach ($synced as $candidate) if (($candidate['source'] ?? '') === 'nitrado') $nitradoServer = $candidate;
    assert_test(is_array($nitradoServer), 'Nitrado server missing from sync response');
    assert_test(($nitradoServer['game_icon_url'] ?? '') === 'https://assets.nitrado.net/rust-64.png', 'Nitrado icon URL missing');

    [$status, $nitradoStatus] = request_json($base, 'GET', '/api/servers/' . $nitradoServer['id'] . '/nitrado-status', null, $aliceToken);
    assert_test($status === 200 && ($nitradoStatus['players'] ?? null) === 3, 'Nitrado status lookup failed');
    assert_test(!array_key_exists('memory_mb', $nitradoStatus) && !array_key_exists('cpu', $nitradoStatus), 'Rust status must not expose memory or CPU');

    [$status] = request_json($base, 'POST', '/api/servers/' . $nitradoServer['id'] . '/nitrado-power', ['action' => 'restart'], $aliceToken);
    assert_test($status === 200, 'Nitrado restart failed');

    [$status, $editedNitrado] = request_json($base, 'PUT', '/api/servers/' . $nitradoServer['id'], [
        'name' => 'Temporarily edited Nitrado server',
        'host' => $nitradoServer['host'],
        'port' => $nitradoServer['port'],
        'protocol' => 'palworld_rest',
        'game' => 'Palworld',
    ], $aliceToken);
    assert_test($status === 200 && ($editedNitrado['source'] ?? '') === 'nitrado', 'Nitrado profile update failed');
    assert_test(($editedNitrado['game_icon_url'] ?? null) === null, 'changing a Nitrado game must clear its now-stale icon');

    [$status, $audit] = request_json($base, 'GET', '/api/audit-log', null, $aliceToken);
    $actions = array_column($audit ?? [], 'action');
    assert_test($status === 200 && in_array('server_updated', $actions, true), 'server update audit entry missing');
    assert_test(in_array('server_password_changed', $actions, true), 'password update audit entry missing');
    assert_test(in_array('nitrado_server_restarted', $actions, true), 'Nitrado power audit entry missing');

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
