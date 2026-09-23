<?php
declare(strict_types=1);
require_once __DIR__ . '/config.php';

function nicon_db(): PDO
{
    static $pdo = null;
    if ($pdo !== null) {
        return $pdo;
    }

    $config = nicon_config();
    if ($config['db_dsn'] === '') {
        http_response_code(500);
        header('Content-Type: application/json');
        echo json_encode(['error' => 'server misconfigured: no database DSN']);
        exit;
    }

    $pdo = new PDO($config['db_dsn'], $config['db_user'], $config['db_pass'], [
        PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
        PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
        PDO::ATTR_EMULATE_PREPARES => false,
    ]);
    return $pdo;
}
