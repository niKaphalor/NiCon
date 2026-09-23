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
