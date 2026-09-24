<?php
declare(strict_types=1);
require_once __DIR__ . '/config.php';

// nicon_security_headers sets a small set of defense-in-depth headers that
// don't depend on any per-request state, on every response (including
// errors and CORS preflights). This is a JSON API with no HTML templates
// of its own, so a full CSP isn't meaningful here — these three cover the
// headers that still apply: don't let a browser guess a JSON response into
// executable content, don't let this origin be framed, and don't leak the
// full request path (recovery codes, tokens never appear in URLs, but
// session/account paths do) to third-party Referer targets.
function nicon_security_headers(): void
{
    header('X-Content-Type-Options: nosniff');
    header('X-Frame-Options: DENY');
    header('Referrer-Policy: strict-origin-when-cross-origin');
}

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

// NICON_MAX_REQUEST_BODY_BYTES bounds how much of a request body
// nicon_json_body() will read. Every real request here is a small JSON
// object (credentials, a server name/host/port, a command string); this
// only exists so a client can't hold a worker busy streaming an
// unbounded body into memory. 256 KiB is generous headroom over the
// largest legitimate payload (Nitrado sync's stored token) with room to
// spare.
const NICON_MAX_REQUEST_BODY_BYTES = 262144;

// nicon_read_request_body reads at most $maxBytes+1 bytes of the request
// body and returns null if that was exceeded (so the caller can tell "too
// large" apart from "empty"). It doesn't trust Content-Length alone —
// that header can be absent or wrong — but checks it first as a cheap
// short-circuit before touching the stream.
function nicon_read_request_body(int $maxBytes): ?string
{
    $contentLength = $_SERVER['CONTENT_LENGTH'] ?? null;
    if ($contentLength !== null && (int) $contentLength > $maxBytes) {
        return null;
    }
    $stream = fopen('php://input', 'rb');
    if ($stream === false) {
        return '';
    }
    $body = stream_get_contents($stream, $maxBytes + 1);
    fclose($stream);
    if ($body === false) {
        return '';
    }
    if (strlen($body) > $maxBytes) {
        return null;
    }
    return $body;
}

function nicon_json_body(): array
{
    $raw = nicon_read_request_body(NICON_MAX_REQUEST_BODY_BYTES);
    if ($raw === null) {
        nicon_send_error('request body too large', 413);
        exit;
    }
    $data = json_decode($raw ?: '', true);
    return is_array($data) ? $data : [];
}

function nicon_send_json($data, int $status = 200): void
{
    http_response_code($status);
    header('Content-Type: application/json');
    header('Cache-Control: no-store');
    echo json_encode($data);
}

function nicon_send_error(string $message, int $status): void
{
    http_response_code($status);
    header('Content-Type: application/json');
    header('Cache-Control: no-store');
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
