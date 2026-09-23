<?php
declare(strict_types=1);
require_once __DIR__ . '/config.php';

// nicon_cors mirrors internal/relay/relay.go's cors(): sets
// Access-Control-Allow-* only for allow-listed origins, and answers an
// OPTIONS preflight itself. Returns false if the caller should stop
// (preflight already answered).
function nicon_cors(): bool
{
    $origin = $_SERVER['HTTP_ORIGIN'] ?? '';
    $allowed = nicon_config()['allowed_origins'] ?? [];
    if ($origin !== '' && in_array($origin, $allowed, true)) {
        header('Access-Control-Allow-Origin: ' . $origin);
        header('Access-Control-Allow-Methods: GET, POST, PUT, DELETE, OPTIONS');
        header('Access-Control-Allow-Headers: Content-Type, Authorization');
    }
    if (($_SERVER['REQUEST_METHOD'] ?? '') === 'OPTIONS') {
        http_response_code(204);
        return false;
    }
    return true;
}

function nicon_json_body(): array
{
    $raw = file_get_contents('php://input');
    $data = json_decode($raw ?: '', true);
    return is_array($data) ? $data : [];
}

function nicon_send_json($data, int $status = 200): void
{
    http_response_code($status);
    header('Content-Type: application/json');
    echo json_encode($data);
}

function nicon_send_error(string $message, int $status): void
{
    http_response_code($status);
    header('Content-Type: application/json');
    echo json_encode(['error' => $message]);
}

// nicon_bearer_token extracts the token from "Authorization: Bearer …",
// or "" if the header is missing/malformed.
function nicon_bearer_token(): string
{
    $header = $_SERVER['HTTP_AUTHORIZATION'] ?? '';
    if (str_starts_with($header, 'Bearer ')) {
        return substr($header, 7);
    }
    return '';
}
