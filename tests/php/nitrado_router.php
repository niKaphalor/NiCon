<?php
declare(strict_types=1);

header('Content-Type: application/json');
$path = parse_url($_SERVER['REQUEST_URI'] ?? '/', PHP_URL_PATH) ?: '/';
$method = $_SERVER['REQUEST_METHOD'] ?? 'GET';

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
        'game' => 'rust',
        'game_human' => 'Rust',
        'ip' => '127.0.0.1',
        'rcon_port' => 28016,
        'status' => 'started',
        'slots' => 50,
        'game_specific' => ['features' => ['has_rcon' => true]],
        'query' => [
            'server_name' => 'Integration Rust',
            'player_current' => 3,
            'player_max' => 50,
            'map' => 'Procedural Map',
            'version' => 'test-1',
        ],
    ]];
} elseif ($method === 'GET' && $path === '/services/9001/gameservers/games') {
    $data = ['games' => [[
        'game' => 'rust',
        'icons' => ['x64' => 'https://assets.nitrado.net/rust-64.png'],
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
