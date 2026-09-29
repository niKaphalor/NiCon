<?php
declare(strict_types=1);

header('Content-Type: application/json');
$path = parse_url($_SERVER['REQUEST_URI'] ?? '/', PHP_URL_PATH) ?: '/';
$method = $_SERVER['REQUEST_METHOD'] ?? 'GET';

$counterFile = getenv('NICON_NITRADO_MOCK_COUNTER_FILE') ?: '';
if ($counterFile !== '') {
    $handle = fopen($counterFile, 'c+');
    if ($handle !== false && flock($handle, LOCK_EX)) {
        $raw = stream_get_contents($handle);
        $counts = $raw ? json_decode($raw, true) : [];
        if (!is_array($counts)) $counts = [];
        $key = "$method $path";
        $counts[$key] = (int) ($counts[$key] ?? 0) + 1;
        ftruncate($handle, 0);
        rewind($handle);
        fwrite($handle, json_encode($counts));
        fflush($handle);
        flock($handle, LOCK_UN);
    }
    if (is_resource($handle)) fclose($handle);
}

if (($_SERVER['HTTP_AUTHORIZATION'] ?? '') !== 'Bearer integration-token') {
    http_response_code(401);
    echo json_encode(['status' => 'error']);
    exit;
}

$data = null;
if ($method === 'GET' && $path === '/services') {
    $data = ['services' => [['id' => 9001]]];
} elseif ($method === 'GET' && $path === '/services/9001/gameservers') {
    $data = ['gameserver' => [
        'game' => 'gmod',
        'game_human' => "Garry's Mod",
        'ip' => '127.0.0.1',
        'rcon_port' => 28016,
        'query_port' => 27015,
        'status' => 'started',
        'slots' => 50,
        'game_specific' => ['features' => ['has_rcon' => true]],
        'settings' => ['config' => [
            'server_name' => 'Public name',
            'pvp' => true,
            'rcon_password' => 'must-not-leak',
            'api_token' => 'must-not-leak-either',
        ]],
        'query' => [
            'server_name' => 'Integration GMod',
            'player_current' => 3,
            'player_max' => 50,
            'map' => 'Procedural Map',
            'version' => 'test-1',
        ],
    ]];
} elseif ($method === 'GET' && $path === '/services/9001/gameservers/games') {
    $data = ['games' => [[
        'game' => 'gmod',
        'icons' => ['x64' => 'https://assets.nitrado.net/gmod-64.png'],
    ]]];
} elseif ($method === 'POST' && in_array($path, [
    '/services/9001/gameservers/start',
    '/services/9001/gameservers/stop',
    '/services/9001/gameservers/restart',
    '/services/9001/gameservers/games/start',
], true)) {
    $data = ['ok' => true];
}

if ($data === null) {
    http_response_code(404);
    echo json_encode(['status' => 'error', 'message' => "$method $path"]);
    exit;
}

echo json_encode(['status' => 'success', 'data' => $data]);
