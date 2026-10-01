<?php
declare(strict_types=1);

// No database needed. Checks webspace/lib/crypto.php against the vectors the
// Go implementation (internal/store/crypto_test.go) generates and verifies:
// both sides must read each other's values and produce identical bytes for a
// fixed nonce.

require_once dirname(__DIR__, 2) . '/webspace/lib/crypto.php';

function check(bool $condition, string $message): void
{
    if (!$condition) {
        fwrite(STDERR, "FAIL: $message\n");
        exit(1);
    }
}

function throws(callable $fn): bool
{
    try {
        $fn();
    } catch (Throwable $e) {
        return true;
    }
    return false;
}

$vectors = json_decode((string) file_get_contents(dirname(__DIR__) . '/crypto-vectors.json'), true);
check(is_array($vectors) && count($vectors['vectors']) >= 3, 'vector file missing or too small');
$keys = [];
foreach ($vectors['keys'] as $id => $encoded) {
    $keys[(int) $id] = base64_decode($encoded, true);
}

foreach ($vectors['vectors'] as $v) {
    $ring = [$keys, (int) $v['key_id'], (int) $v['version'] === 2];
    $blob = base64_decode($v['blob_base64'], true);
    check(nicon_open_with_ring($ring, $blob, $v['aad']) === $v['plaintext'], $v['name'] . ': decrypt');
    $again = nicon_seal_with_ring($ring, $v['plaintext'], $v['aad'], hex2bin($v['nonce_hex']));
    check($again === $blob, $v['name'] . ': re-sealing with the fixed nonce must give identical bytes');
    if ((int) $v['version'] === 2) {
        check(throws(fn() => nicon_open_with_ring($ring, $blob, $v['aad'] . 'x')), $v['name'] . ': a different AAD must not decrypt');
        check(throws(fn() => nicon_open_with_ring($ring, $blob, '')), $v['name'] . ': no AAD must not decrypt');
    }
}

// Reading is format-agnostic: a v2-writing ring opens legacy values, a legacy
// ring does not pretend to open v2 ones.
$legacyBlob = base64_decode($vectors['vectors'][0]['blob_base64'], true);
$v2Ring = [$keys, 2, true];
check(nicon_open_with_ring($v2Ring, $legacyBlob, 'anything') === 'hunter2', 'a v2 ring reads legacy values');
$v2Blob = base64_decode($vectors['vectors'][2]['blob_base64'], true);
$onlyKey1 = [[1 => $keys[1]], 1, false];
check(throws(fn() => nicon_open_with_ring($onlyKey1, $v2Blob, $vectors['vectors'][2]['aad'])), 'a value under an unknown key must not decrypt');

// A legacy value whose nonce happens to start with the v2 magic still opens.
$collidingNonce = 'NC2' . str_repeat("\x07", 9);
$colliding = nicon_seal_with_ring([[1 => $keys[1]], 1, false], 'collision', '', $collidingNonce);
check(str_starts_with($colliding, 'NC2'), 'test setup');
check(nicon_open_with_ring([[1 => $keys[1]], 1, true], $colliding, 'ctx') === 'collision', 'legacy value that looks like v2 must open');

// Ring validation.
$b64 = static fn(int $seed): string => base64_encode(str_repeat(chr($seed), 32));
check(is_array(nicon_key_ring_from_config(['encryption_key_base64' => $b64(1)])), 'a single key is a valid ring');
check(is_string(nicon_key_ring_from_config([])), 'no key is invalid');
check(is_string(nicon_key_ring_from_config(['encryption_key_base64' => base64_encode('short')])), 'short key is invalid');
check(is_string(nicon_key_ring_from_config(['encryption_key_base64' => $b64(1), 'encryption_current_key_id' => 2])), 'unknown current key is invalid');
check(is_string(nicon_key_ring_from_config(['encryption_key_base64' => $b64(1), 'encryption_keys' => [2 => $b64(2)], 'encryption_current_key_id' => 2])), 'a current key other than 1 needs v2');
check(is_array(nicon_key_ring_from_config(['encryption_key_base64' => $b64(1), 'encryption_keys' => [2 => $b64(2)], 'encryption_current_key_id' => 2, 'encryption_write_v2' => true])), 'rotation config is valid');
check(is_string(nicon_key_ring_from_config(['encryption_key_base64' => $b64(1), 'encryption_keys' => [1 => $b64(2)]])), 'key 1 configured twice is invalid');
check(is_array(nicon_key_ring_from_config(['encryption_keys' => [2 => $b64(2)], 'encryption_current_key_id' => 2, 'encryption_write_v2' => true])), 'key 1 may be absent once migrated');
check(nicon_parse_key_list('2=abc, 3 = def ,,x') === [2 => 'abc', 3 => 'def'], 'key list parsing');

fwrite(STDOUT, "PASS: PHP crypto vectors\n");
