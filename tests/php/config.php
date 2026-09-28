<?php
declare(strict_types=1);

return [
    'db_dsn' => getenv('NICON_PHP_TEST_DB_DSN') ?: '',
    'db_user' => getenv('NICON_PHP_TEST_DB_USER') ?: '',
    'db_pass' => getenv('NICON_PHP_TEST_DB_PASS') ?: '',
    'encryption_key_base64' => getenv('NICON_ENCRYPTION_KEY') ?: '',
    'steam_api_key' => '',
    'nitrado_api_base_url' => getenv('NICON_NITRADO_API_BASE_URL') ?: '',
    'nitrado_cache_ttl_seconds' => 45,
    'audit_retention_days' => 180,
    'allowed_origins' => ['http://127.0.0.1'],
];
