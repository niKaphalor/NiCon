<?php
declare(strict_types=1);

$path = parse_url($_SERVER['REQUEST_URI'] ?? '/', PHP_URL_PATH) ?: '/';
if (!str_starts_with($path, '/api/')) {
    http_response_code(404);
    exit;
}

$_SERVER['SCRIPT_NAME'] = '/api/index.php';
require dirname(__DIR__, 2) . '/webspace/api/index.php';
