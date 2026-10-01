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

    // Optional: key rotation and the row-bound v2 storage format (see the
    // README, "Encryption at rest, and rotating the key"). The relay needs the
    // same values as environment variables. Leave these out until both the API
    // and the relay run a version that can READ v2.
    // 'encryption_keys' => [2 => 'BASE64_OF_A_NEW_32_BYTE_KEY'],   // extra keys by ID; key 1 is the one above
    // 'encryption_current_key_id' => 2,                             // key for new values (default 1)
    // 'encryption_write_v2' => true,                                // write v2 (needed when the current key is not 1)

    // Optional. Enables public Steam profile and ban information in the
    // player list. The key is used server-side and is never returned to
    // the browser. Create one in Steam's Web API key administration.
    'steam_api_key' => '',

    // Required for the contact form (POST /contact) to actually deliver
    // anything: the mailbox that receives visitor messages. Left blank,
    // the contact form still accepts submissions but they go nowhere —
    // see handlers/contact.php.
    'contact_recipient' => 'you@example.com',

    // Shared database-backed cache for Nitrado GET responses. Values are
    // clamped to 30-60 seconds; 45 seconds balances freshness and API load.
    'nitrado_cache_ttl_seconds' => 45,

    // Security audit entries older than this are deleted when the audit log
    // is written or viewed. The default policy is six months.
    'audit_retention_days' => 180,

    // Housekeeping (expired audit rows, caches, rate-limit windows) is done
    // by webspace/cron/sample_nitrado.php every time it runs. Installations
    // without that cron fall back to doing a little of it during ordinary
    // requests: this is the chance (0-1) that a request does one small batch.
    // 0 turns the fallback off.
    'maintenance_probability' => 0.02,

    // Reject new passwords found in known data breaches, via the Have I
    // Been Pwned range API (k-anonymity: only the first 5 characters of the
    // password's SHA-1 leave this server, never the password). Off by
    // default because it is an outbound request to a third party on every
    // password change — if you turn it on, mention it in your privacy
    // policy. An unreachable service never blocks a registration.
    'password_breach_check' => false,

    // Origins allowed to call this API — the GitHub Pages URL, plus
    // localhost for local frontend development.
    'allowed_origins' => [
        'https://nikaphalor.github.io',
        'http://localhost:8899',
    ],
];
