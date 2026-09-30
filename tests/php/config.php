<?php
declare(strict_types=1);

return [
    'db_dsn' => getenv('NICON_PHP_TEST_DB_DSN') ?: '',
    'db_user' => getenv('NICON_PHP_TEST_DB_USER') ?: '',
    'db_pass' => getenv('NICON_PHP_TEST_DB_PASS') ?: '',
    'encryption_key_base64' => getenv('NICON_ENCRYPTION_KEY') ?: '',
    'steam_api_key' => '',
    'contact_recipient' => 'contact-test@example.invalid',
    'nitrado_api_base_url' => getenv('NICON_NITRADO_API_BASE_URL') ?: '',
    'nitrado_cache_ttl_seconds' => 45,
    'audit_retention_days' => 180,
    // NICON_TEST_CRYPTO_MODE (legacy | v2 | rotated) is translated into these
    // by tests/php/api_integration.php.
    'encryption_keys' => nicon_parse_key_list((string) getenv('NICON_ENCRYPTION_KEYS')),
    'encryption_current_key_id' => (int) (getenv('NICON_ENCRYPTION_CURRENT_KEY_ID') ?: 1),
    'encryption_write_v2' => getenv('NICON_ENCRYPTION_WRITE_V2') === '1',
    'maintenance_probability' => 1, // deterministic: every request may clean up
    'allowed_origins' => ['http://127.0.0.1'],
];
