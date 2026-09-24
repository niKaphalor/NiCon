<?php
// Front controller for the whole API — every request under this directory
// is rewritten here by .htaccess. Mirrors internal/relay/relay.go's
// Routes(): one table of method + path pattern + auth level + handler.
declare(strict_types=1);

require_once __DIR__ . '/../lib/config.php';
require_once __DIR__ . '/../lib/db.php';
require_once __DIR__ . '/../lib/crypto.php';
require_once __DIR__ . '/../lib/http.php';
require_once __DIR__ . '/../lib/auth.php';
require_once __DIR__ . '/../lib/ratelimit.php';
require_once __DIR__ . '/../handlers/login.php';
require_once __DIR__ . '/../handlers/register.php';
require_once __DIR__ . '/../handlers/reset_password.php';
require_once __DIR__ . '/../handlers/account.php';
require_once __DIR__ . '/../handlers/servers.php';
require_once __DIR__ . '/../handlers/nitrado_sync.php';
require_once __DIR__ . '/../handlers/admin.php';
require_once __DIR__ . '/../handlers/notifications.php';

function nicon_handle_healthz(): void
{
    header('Content-Type: text/plain');
    echo 'ok';
}

// Every request — including OPTIONS preflight, which nicon_cors() answers
// itself and returns false for.
if (!nicon_cors()) {
    exit;
}

// Path relative to this script, e.g. a deployment at
// https://example.com/nicon-api/api/index.php receiving a request for
// .../nicon-api/api/servers/5 resolves to "/servers/5".
$scriptDir = rtrim(str_replace('\\', '/', dirname($_SERVER['SCRIPT_NAME'] ?? '')), '/');
$requestPath = parse_url($_SERVER['REQUEST_URI'] ?? '/', PHP_URL_PATH) ?? '/';
$path = substr($requestPath, strlen($scriptDir));
if ($path === false || $path === '') {
    $path = '/';
}
$method = $_SERVER['REQUEST_METHOD'] ?? 'GET';

// [method, path regex, auth level ('none'|'user'|'admin'), handler]
$routes = [
    ['GET', '#^/healthz$#', 'none', 'nicon_handle_healthz'],

    ['POST', '#^/login$#', 'none', 'nicon_handle_login'],
    ['POST', '#^/logout$#', 'none', 'nicon_handle_logout'],
    ['POST', '#^/register$#', 'none', 'nicon_handle_register'],
    ['POST', '#^/reset-password$#', 'none', 'nicon_handle_reset_password'],
    ['DELETE', '#^/account$#', 'user', 'nicon_handle_delete_account'],
    ['PUT', '#^/account/password$#', 'user', 'nicon_handle_change_password'],
    ['PUT', '#^/account/username$#', 'user', 'nicon_handle_change_username'],

    ['GET', '#^/notifications$#', 'user', 'nicon_handle_list_notifications'],

    ['GET', '#^/servers$#', 'user', 'nicon_handle_list_servers'],
    ['POST', '#^/servers$#', 'user', 'nicon_handle_create_server'],
    ['PUT', '#^/servers/(\d+)/password$#', 'user', 'nicon_handle_set_server_password'],
    ['DELETE', '#^/servers/(\d+)$#', 'user', 'nicon_handle_delete_server'],
    ['POST', '#^/nitrado/sync$#', 'user', 'nicon_handle_nitrado_sync'],

    ['GET', '#^/admin/users$#', 'admin', 'nicon_handle_admin_list_users'],
    ['DELETE', '#^/admin/users/(\d+)$#', 'admin', 'nicon_handle_admin_delete_user'],
    ['POST', '#^/admin/users/(\d+)/recovery-code$#', 'admin', 'nicon_handle_admin_regenerate_recovery_code'],

    ['POST', '#^/admin/notifications$#', 'admin', 'nicon_handle_admin_create_notification'],
    ['DELETE', '#^/admin/notifications/(\d+)$#', 'admin', 'nicon_handle_admin_delete_notification'],
];

foreach ($routes as [$routeMethod, $pattern, $authLevel, $handler]) {
    if ($routeMethod !== $method || !preg_match($pattern, $path, $matches)) {
        continue;
    }
    $params = array_map('intval', array_slice($matches, 1));

    if ($authLevel === 'none') {
        $handler(...$params);
    } elseif ($authLevel === 'admin') {
        if (nicon_require_admin() === null) {
            exit; // error already sent
        }
        $handler(...$params);
    } else { // 'user'
        $userId = nicon_authenticate_request();
        if ($userId === null) {
            exit; // error already sent
        }
        $handler($userId, ...$params);
    }
    exit;
}

nicon_send_error('not found', 404);
