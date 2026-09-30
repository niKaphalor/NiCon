<?php
// Secrets at rest — RCON passwords and Nitrado API tokens — are encrypted with
// AES-256-GCM. This file and internal/store/crypto.go (the Go relay reads the
// same columns) must stay byte-compatible; tests/crypto-vectors.json is
// checked by both test suites.
//
// Two formats exist, and both are always READABLE:
//
//   v1 (legacy): nonce(12) || ciphertext || tag(16)
//                key ID 1, no additional authenticated data.
//   v2:          "NC2" || keyID(1) || nonce(12) || ciphertext || tag(16)
//                the named key, and an AAD string that ties the ciphertext to
//                its row (nicon_aad_* below), so a value copied to another row
//                no longer decrypts.
//
// v2 is only WRITTEN when `encryption_write_v2` is true, so the relay can be
// upgraded to read it first (see the README, "Rotating the encryption key").
// Key ring: `encryption_key_base64` is key ID 1; `encryption_keys` adds more
// (id => base64); `encryption_current_key_id` says which one new values use
// (anything other than 1 requires v2).
//
// Password hashes are unrelated: PHP's password_hash(PASSWORD_BCRYPT) produces
// standard $2y$ bcrypt, which golang.org/x/crypto/bcrypt verifies as is.
declare(strict_types=1);
require_once __DIR__ . '/config.php';

// v2 overhead: 3-byte magic + 1-byte key ID + 12-byte nonce + 16-byte tag. A
// plaintext fits a VARBINARY(N) column only up to N - 32 bytes.
const NICON_CIPHERTEXT_OVERHEAD_BYTES = 32;
const NICON_MAX_SERVER_PASSWORD_BYTES = 512 - NICON_CIPHERTEXT_OVERHEAD_BYTES;   // servers.password_enc
const NICON_MAX_NITRADO_TOKEN_BYTES = 2048 - NICON_CIPHERTEXT_OVERHEAD_BYTES;    // users.nitrado_token_enc
const NICON_MAX_ENCRYPTED_PLAINTEXT_BYTES = NICON_MAX_NITRADO_TOKEN_BYTES;       // absolute ceiling for either

const NICON_V2_MAGIC = 'NC2';

const NICON_RECOVERY_CODE_LENGTH = 20;
const NICON_RECOVERY_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no 0/O/1/I/L

// AAD for servers.password_enc / users.nitrado_token_enc — identical strings
// to store.ServerPasswordAAD / store.NitradoTokenAAD in Go.
function nicon_aad_server_password(int $userId, int $serverId): string
{
    return "nicon:v2:servers.password_enc:$userId:$serverId";
}

function nicon_aad_nitrado_token(int $userId): string
{
    return "nicon:v2:users.nitrado_token_enc:$userId";
}

function nicon_crypto_misconfigured(string $why): never
{
    http_response_code(500);
    header('Content-Type: application/json');
    echo json_encode(['error' => 'server misconfigured: ' . $why]);
    exit;
}

// nicon_key_ring_from_config builds and validates the ring from a config
// array. Returns [keys (id => raw 32-byte key), currentId, writeV2] or a
// string describing what is wrong.
function nicon_key_ring_from_config(array $config): array|string
{
    $keys = [];
    $primary = (string) ($config['encryption_key_base64'] ?? '');
    if ($primary !== '') {
        $raw = base64_decode($primary, true);
        if ($raw === false || strlen($raw) !== 32) return 'invalid encryption key';
        $keys[1] = $raw;
    }
    foreach ((array) ($config['encryption_keys'] ?? []) as $id => $encoded) {
        $id = (int) $id;
        if ($id < 1 || $id > 255) return "invalid encryption key ID $id";
        if (isset($keys[$id])) return "encryption key $id configured twice";
        $raw = base64_decode((string) $encoded, true);
        if ($raw === false || strlen($raw) !== 32) return "invalid encryption key $id";
        $keys[$id] = $raw;
    }
    if (!$keys) return 'invalid encryption key';
    $current = (int) ($config['encryption_current_key_id'] ?? 1);
    $writeV2 = !empty($config['encryption_write_v2']);
    if (!isset($keys[$current])) return "current encryption key $current is not configured";
    if ($current !== 1 && !$writeV2) return "current encryption key $current requires encryption_write_v2";
    return [$keys, $current, $writeV2];
}

function nicon_key_ring(): array
{
    static $ring = null;
    if ($ring !== null) {
        return $ring;
    }
    $built = nicon_key_ring_from_config(nicon_config());
    if (is_string($built)) {
        nicon_crypto_misconfigured($built);
    }
    return $ring = $built;
}

// The key new values are written with (also scopes the Nitrado response cache).
function nicon_encryption_key(): string
{
    [$keys, $current] = nicon_key_ring();
    return $keys[$current];
}

// True when new values are written as v2 — callers that need a row ID in the
// AAD (a new server) must then insert the row first.
function nicon_writes_v2(): bool
{
    return nicon_key_ring()[2];
}

// nicon_seal_with_ring encrypts with an explicit ring and optional fixed nonce
// (the latter only for test vectors).
function nicon_seal_with_ring(array $ring, string $plaintext, string $aad, ?string $nonce = null): string
{
    [$keys, $current, $writeV2] = $ring;
    $nonce ??= random_bytes(12);
    $tag = '';
    if (!$writeV2) {
        $ciphertext = openssl_encrypt($plaintext, 'aes-256-gcm', $keys[1], OPENSSL_RAW_DATA, $nonce, $tag);
        if ($ciphertext === false) throw new RuntimeException('encrypt failed');
        return $nonce . $ciphertext . $tag;
    }
    $ciphertext = openssl_encrypt($plaintext, 'aes-256-gcm', $keys[$current], OPENSSL_RAW_DATA, $nonce, $tag, $aad);
    if ($ciphertext === false) throw new RuntimeException('encrypt failed');
    return NICON_V2_MAGIC . chr($current) . $nonce . $ciphertext . $tag;
}

// nicon_open_with_ring decrypts either format; throws RuntimeException if the
// value cannot be authenticated with the given keys and AAD.
function nicon_open_with_ring(array $ring, string $blob, string $aad): string
{
    [$keys] = $ring;
    $minV2 = strlen(NICON_V2_MAGIC) + 1 + 12 + 16;
    if (strlen($blob) >= $minV2 && str_starts_with($blob, NICON_V2_MAGIC)) {
        $id = ord($blob[strlen(NICON_V2_MAGIC)]);
        if (isset($keys[$id])) {
            $nonce = substr($blob, 4, 12);
            $tag = substr($blob, -16);
            $ciphertext = substr($blob, 16, -16);
            $plaintext = openssl_decrypt($ciphertext, 'aes-256-gcm', $keys[$id], OPENSSL_RAW_DATA, $nonce, $tag, $aad);
            if ($plaintext !== false) {
                return $plaintext;
            }
        }
        // Not a valid v2 value: a legacy nonce can start with these bytes by
        // chance (2^-24), so try the legacy layout too.
    }
    if (!isset($keys[1])) {
        throw new RuntimeException('value is not readable with the configured keys');
    }
    if (strlen($blob) < 12 + 16) {
        throw new RuntimeException('ciphertext too short');
    }
    $plaintext = openssl_decrypt(substr($blob, 12, -16), 'aes-256-gcm', $keys[1], OPENSSL_RAW_DATA, substr($blob, 0, 12), substr($blob, -16));
    if ($plaintext === false) {
        throw new RuntimeException('decrypt password failed');
    }
    return $plaintext;
}

// nicon_encrypt_password seals a secret for the row named by $aad (see
// nicon_aad_*), in the configured write format. Returns null for an empty
// secret ("not set", stored as NULL — same as Go's encryptOrNil).
function nicon_encrypt_password(string $plaintext, int $maxPlaintextBytes = NICON_MAX_ENCRYPTED_PLAINTEXT_BYTES, string $aad = ''): ?string
{
    if ($plaintext === '') {
        return null;
    }
    // servers.password_enc is VARBINARY(512) and users.nitrado_token_enc
    // VARBINARY(2048); handlers validate against the per-column constants
    // first so clients get a 400. This only stops an unchecked caller from
    // hitting a database error (or, in non-strict SQL modes, truncation
    // that would silently corrupt the ciphertext).
    if (strlen($plaintext) > $maxPlaintextBytes) {
        throw new InvalidArgumentException('plaintext too long to store');
    }
    if (nicon_writes_v2() && $aad === '') {
        throw new LogicException('a v2 value needs its row bound as AAD');
    }
    return nicon_seal_with_ring(nicon_key_ring(), $plaintext, $aad);
}

function nicon_decrypt_password(?string $blob, string $aad = ''): string
{
    if ($blob === null || $blob === '') {
        return '';
    }
    return nicon_open_with_ring(nicon_key_ring(), $blob, $aad);
}

function nicon_hash_password(string $password): string
{
    return password_hash($password, PASSWORD_BCRYPT);
}

function nicon_verify_password(string $password, string $hash): bool
{
    return $hash !== '' && password_verify($password, $hash);
}

// A fixed, valid bcrypt hash with no matching input — compare against this
// (instead of skipping the bcrypt call entirely) whenever a lookup by
// username/account finds nothing, on every endpoint that would otherwise
// respond faster for "no such account" than for "found the account, wrong
// credential." Response time itself is otherwise an oracle for which
// usernames exist. Used by both login and password reset.
const NICON_DUMMY_PASSWORD_HASH = '$2y$12$pB.2xa.VMH4BQtvWWpyLBu1tQJ7ai2DpOk6nZX8429cBZrSmiJX/G';

// nicon_generate_recovery_code returns a fresh one-time recovery code
// formatted in groups of 5 (e.g. "ABCDE-FGH2J-KMNPQ-RST3V") — the same
// alphabet and shape as internal/auth.GenerateRecoveryCode, purely for a
// consistent look; nothing requires the two to match bit-for-bit since
// each side only ever hashes+stores codes it generated itself.
function nicon_generate_recovery_code(): string
{
    $alphabetLen = strlen(NICON_RECOVERY_CODE_ALPHABET);
    $maxByte = 256 - (256 % $alphabetLen);
    $raw = '';
    while (strlen($raw) < NICON_RECOVERY_CODE_LENGTH) {
        $byte = ord(random_bytes(1));
        if ($byte < $maxByte) {
            $raw .= NICON_RECOVERY_CODE_ALPHABET[$byte % $alphabetLen];
        }
    }
    $groups = str_split($raw, 5);
    return implode('-', $groups);
}

// nicon_normalize_recovery_code strips formatting and uppercases, so a
// code hashes/compares identically regardless of how it was retyped.
function nicon_normalize_recovery_code(string $code): string
{
    $upper = strtoupper($code);
    return preg_replace('/[^A-Z0-9]/', '', $upper);
}

function nicon_generate_session_token(): string
{
    return bin2hex(random_bytes(32));
}

// nicon_hash_token returns the value actually stored in and looked up
// against sessions.token. The session token itself is a 256-bit random
// value handed to the browser and sent back on every authenticated
// request — functionally a bearer credential — so it's hashed at rest the
// same way a password would be, rather than kept as a plaintext column
// anyone with read access to the database (a backup, a misconfigured
// admin tool, an injection bug elsewhere) could use directly. A fast
// unsalted hash is fine here, unlike a password hash: the input is
// already 256 bits of randomness, not something guessable to speed up an
// offline attack against. Mirrors internal/store/store.go's hashToken —
// both sides must produce the same digest for a token created by one to
// authenticate against the other. SHA-256's 64-character hex digest fits
// the existing `sessions.token CHAR(64)` column exactly, so no schema
// change is needed.
function nicon_hash_token(string $token): string
{
    return hash('sha256', $token);
}
