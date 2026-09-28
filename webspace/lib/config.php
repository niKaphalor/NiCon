<?php
// Loads config.local.php (see config.example.php) if present, otherwise
// falls back to environment variables — useful for local testing with
// `php -S` where env vars are easy to set and a config.local.php is not.
declare(strict_types=1);

function nicon_config(): array
{
    static $config = null;
    if ($config !== null) {
        return $config;
    }

    // Integration tests point at a dedicated, committed config shim so a
    // developer's real config.local.php can never be used accidentally.
    $overrideFile = getenv('NICON_CONFIG_FILE');
    if ($overrideFile && is_file($overrideFile)) {
        $config = require $overrideFile;
        return $config;
    }

    $localFile = __DIR__ . '/../config.local.php';
    if (is_file($localFile)) {
        $config = require $localFile;
        return $config;
    }

    $origins = getenv('NICON_ALLOWED_ORIGINS');
    $config = [
        'db_dsn' => getenv('NICON_DB_DSN') ?: '',
        'db_user' => getenv('NICON_DB_USER') ?: '',
        'db_pass' => getenv('NICON_DB_PASS') ?: '',
        'encryption_key_base64' => getenv('NICON_ENCRYPTION_KEY') ?: '',
        'steam_api_key' => getenv('NICON_STEAM_API_KEY') ?: '',
        // Test-only override used by the HTTP integration suite. Production
        // deployments leave this unset and always use api.nitrado.net.
        'nitrado_api_base_url' => getenv('NICON_NITRADO_API_BASE_URL') ?: 'https://api.nitrado.net',
        'allowed_origins' => $origins ? array_map('trim', explode(',', $origins)) : [],
    ];
    return $config;
}
