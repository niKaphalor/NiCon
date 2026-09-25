<?php
// Mirrors internal/auth and internal/store/crypto.go closely enough that
// this API and the Go relay can read/write the same database rows
// interchangeably. Two things have to match exactly for that:
//
//   - RCON password encryption: Go's AES-256-GCM Encrypt() produces
//     nonce(12 bytes) || ciphertext || tag(16 bytes) concatenated (that's
//     what cipher.AEAD.Seal appends its tag onto). nicon_encrypt_password
//     below produces the identical layout so the Go relay's Decrypt() can
//     read rows this API writes, and vice versa.
//   - Password hashes: PHP's password_hash(PASSWORD_BCRYPT) produces
//     standard $2y$ bcrypt, which golang.org/x/crypto/bcrypt verifies
//     without any special-casing (bcrypt's prefix variants are
//     interchangeable) — no format bridging needed there.
declare(strict_types=1);
require_once __DIR__ . '/config.php';

const NICON_RECOVERY_CODE_LENGTH = 20;
const NICON_RECOVERY_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no 0/O/1/I/L

function nicon_encryption_key(): string
{
    static $key = null;
    if ($key !== null) {
        return $key;
    }
    $config = nicon_config();
    $key = base64_decode($config['encryption_key_base64'] ?? '', true);
    if ($key === false || strlen($key) !== 32) {
        http_response_code(500);
        header('Content-Type: application/json');
        echo json_encode(['error' => 'server misconfigured: invalid encryption key']);
        exit;
    }
    return $key;
}

// nicon_encrypt_password returns the same wire format Go's encryptor
// produces: nonce || ciphertext || tag. Returns null for an empty
// password (matches Go's store.encryptPasswordOrNil: "not set yet").
function nicon_encrypt_password(string $plaintext): ?string
{
    if ($plaintext === '') {
        return null;
    }
    $nonce = random_bytes(12);
    $tag = '';
    $ciphertext = openssl_encrypt($plaintext, 'aes-256-gcm', nicon_encryption_key(), OPENSSL_RAW_DATA, $nonce, $tag);
    if ($ciphertext === false) {
        throw new RuntimeException('encrypt password failed');
    }
    return $nonce . $ciphertext . $tag;
}

function nicon_decrypt_password(?string $blob): string
{
    if ($blob === null || $blob === '') {
        return '';
    }
    if (strlen($blob) < 12 + 16) {
        throw new RuntimeException('ciphertext too short');
    }
    $nonce = substr($blob, 0, 12);
    $tag = substr($blob, -16);
    $ciphertext = substr($blob, 12, -16);
    $plaintext = openssl_decrypt($ciphertext, 'aes-256-gcm', nicon_encryption_key(), OPENSSL_RAW_DATA, $nonce, $tag);
    if ($plaintext === false) {
        throw new RuntimeException('decrypt password failed');
    }
    return $plaintext;
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
