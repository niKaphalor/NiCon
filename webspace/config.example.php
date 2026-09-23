<?php
// Copy this file to config.local.php (same directory) and fill in real
// values. config.local.php is gitignored — never commit it, since it holds
// database credentials and the encryption key.
//
// The encryption key MUST be the exact same value you pass as
// -encryption-key / $NICON_ENCRYPTION_KEY to the Go relay: this API and
// the relay both read/write the same `servers.password_enc` column, and
// only agree on its contents if they share the key. Generate one with
// `nicon-relay genkey` (or any base64-encoded 32 random bytes) and use it
// in both places.
return [
    // PDO DSN for the MariaDB/MySQL database. On typical shared hosting
    // this is usually a local socket or 127.0.0.1, using the DB
    // credentials your hosting control panel gave you.
    'db_dsn' => 'mysql:host=127.0.0.1;dbname=nicon;charset=utf8mb4',
    'db_user' => 'your_db_user',
    'db_pass' => 'your_db_password',

    // Same base64-encoded 32-byte key as the Go relay's -encryption-key.
    'encryption_key_base64' => 'REPLACE_ME',

    // Origins allowed to call this API — the GitHub Pages URL, plus
    // localhost for local frontend development.
    'allowed_origins' => [
        'https://nikaphalor.github.io',
        'http://localhost:8899',
    ],
];
