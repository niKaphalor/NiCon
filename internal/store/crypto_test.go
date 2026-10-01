package store

import (
	"bytes"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"os"
	"strings"
	"testing"
)

func testKey(seed byte) []byte {
	key := make([]byte, EncryptionKeySize)
	for i := range key {
		key[i] = seed + byte(i)
	}
	return key
}

func mustRing(t *testing.T, keys map[byte][]byte, current byte, writeV2 bool) *KeyRing {
	t.Helper()
	ring, err := NewKeyRing(keys, current, writeV2)
	if err != nil {
		t.Fatalf("NewKeyRing: %v", err)
	}
	return ring
}

func TestEncryptDecryptRoundTrip(t *testing.T) {
	for _, writeV2 := range []bool{false, true} {
		ring := mustRing(t, map[byte][]byte{1: testKey(0)}, 1, writeV2)
		plaintext := "super-secret-rcon-password"
		ciphertext, err := ring.Encrypt(plaintext, ServerPasswordAAD(7, 42))
		if err != nil {
			t.Fatalf("Encrypt: %v", err)
		}
		if strings.Contains(string(ciphertext), plaintext) {
			t.Fatal("ciphertext contains the plaintext in the clear")
		}
		got, err := ring.Decrypt(ciphertext, ServerPasswordAAD(7, 42))
		if err != nil || got != plaintext {
			t.Fatalf("writeV2=%v: Decrypt() = %q, %v; want %q", writeV2, got, err, plaintext)
		}
		wantLen := len(plaintext) + gcmNonceSize + gcmTagSize
		if writeV2 {
			wantLen = len(plaintext) + CiphertextOverhead
			if !bytes.HasPrefix(ciphertext, append([]byte(v2Magic), 1)) {
				t.Fatal("v2 value must start with the magic and the key ID")
			}
		}
		if len(ciphertext) != wantLen {
			t.Fatalf("writeV2=%v: length %d, want %d", writeV2, len(ciphertext), wantLen)
		}
	}
}

func TestEncryptIsNonDeterministic(t *testing.T) {
	ring := mustRing(t, map[byte][]byte{1: testKey(0)}, 1, true)
	a, _ := ring.Encrypt("same plaintext", "ctx")
	b, _ := ring.Encrypt("same plaintext", "ctx")
	if bytes.Equal(a, b) {
		t.Fatal("two encryptions of the same plaintext produced identical ciphertext — nonce isn't being randomized")
	}
}

func TestDecryptWithWrongKeyFails(t *testing.T) {
	for _, writeV2 := range []bool{false, true} {
		ring1 := mustRing(t, map[byte][]byte{1: testKey(0)}, 1, writeV2)
		ring2 := mustRing(t, map[byte][]byte{1: testKey(9)}, 1, writeV2)
		ciphertext, err := ring1.Encrypt("secret", "ctx")
		if err != nil {
			t.Fatal(err)
		}
		if _, err := ring2.Decrypt(ciphertext, "ctx"); err == nil {
			t.Fatalf("writeV2=%v: decrypting with a different key must fail", writeV2)
		}
	}
}

// A ciphertext copied into another row must not decrypt: that is what the AAD
// is for.
func TestV2RejectsATransplantedCiphertext(t *testing.T) {
	ring := mustRing(t, map[byte][]byte{1: testKey(0)}, 1, true)
	ciphertext, err := ring.Encrypt("victim-password", ServerPasswordAAD(7, 42))
	if err != nil {
		t.Fatal(err)
	}
	for _, aad := range []string{ServerPasswordAAD(7, 43), ServerPasswordAAD(8, 42), NitradoTokenAAD(7), ""} {
		if _, err := ring.Decrypt(ciphertext, aad); err == nil {
			t.Fatalf("a v2 value moved to another row (%q) must not decrypt", aad)
		}
	}
	if pt, err := ring.Decrypt(ciphertext, ServerPasswordAAD(7, 42)); err != nil || pt != "victim-password" {
		t.Fatalf("its own row must still decrypt: %q, %v", pt, err)
	}
}

func TestRotationReadsOldAndNewKeys(t *testing.T) {
	legacy := mustRing(t, map[byte][]byte{1: testKey(0)}, 1, false)
	oldV2 := mustRing(t, map[byte][]byte{1: testKey(0)}, 1, true)
	rotated := mustRing(t, map[byte][]byte{1: testKey(0), 2: testKey(50)}, 2, true)

	legacyBlob, _ := legacy.Encrypt("a", "ctx")
	oldV2Blob, _ := oldV2.Encrypt("b", "ctx")
	newBlob, _ := rotated.Encrypt("c", "ctx")

	for name, tc := range map[string]struct {
		blob        []byte
		want        string
		wantCurrent bool
	}{
		"legacy under key 1": {legacyBlob, "a", false},
		"v2 under key 1":     {oldV2Blob, "b", false},
		"v2 under key 2":     {newBlob, "c", true},
	} {
		got, current, err := rotated.decrypt(tc.blob, "ctx")
		if err != nil || got != tc.want || current != tc.wantCurrent {
			t.Errorf("%s: decrypt = %q current=%v err=%v; want %q current=%v", name, got, current, err, tc.want, tc.wantCurrent)
		}
	}
	// Once key 1 is removed, only what was rewritten is still readable.
	only2 := mustRing(t, map[byte][]byte{2: testKey(50)}, 2, true)
	if _, err := only2.Decrypt(newBlob, "ctx"); err != nil {
		t.Errorf("v2 under key 2 must be readable with just key 2: %v", err)
	}
	if _, err := only2.Decrypt(oldV2Blob, "ctx"); err == nil {
		t.Error("a value under a removed key must not be readable")
	}
	if _, err := only2.Decrypt(legacyBlob, "ctx"); err == nil {
		t.Error("a legacy value cannot be read once key 1 is gone")
	}
}

// A legacy value's random nonce can start with the v2 magic; it must still open.
func TestLegacyValueThatLooksLikeV2StillDecrypts(t *testing.T) {
	ring := mustRing(t, map[byte][]byte{1: testKey(0)}, 1, false)
	nonce := append([]byte(v2Magic), bytes.Repeat([]byte{7}, gcmNonceSize-len(v2Magic))...)
	blob, err := ring.seal(nonce, "collision", "")
	if err != nil {
		t.Fatal(err)
	}
	if string(blob[:3]) != v2Magic {
		t.Fatal("test setup: expected a legacy blob starting with the magic")
	}
	got, err := mustRing(t, map[byte][]byte{1: testKey(0)}, 1, true).Decrypt(blob, "ctx")
	if err != nil || got != "collision" {
		t.Fatalf("Decrypt = %q, %v", got, err)
	}
}

func TestKeyRingValidation(t *testing.T) {
	if _, err := NewKeyRing(map[byte][]byte{}, 1, false); err == nil {
		t.Error("an empty ring must be rejected")
	}
	if _, err := NewKeyRing(map[byte][]byte{1: make([]byte, 16)}, 1, false); err == nil {
		t.Error("a 16-byte key must be rejected")
	}
	if _, err := NewKeyRing(map[byte][]byte{1: testKey(0)}, 2, true); err == nil {
		t.Error("a current key that is not in the ring must be rejected")
	}
	if _, err := NewKeyRing(map[byte][]byte{1: testKey(0), 2: testKey(1)}, 2, false); err == nil {
		t.Error("a current key other than 1 needs the v2 format")
	}
	if _, err := NewKeyRing(map[byte][]byte{0: testKey(0)}, 0, true); err == nil {
		t.Error("key ID 0 must be rejected")
	}
}

func TestParseKeyRing(t *testing.T) {
	enc := func(seed byte) string { return base64.StdEncoding.EncodeToString(testKey(seed)) }
	ring, err := ParseKeyRing(enc(0), "2="+enc(50)+", 3="+enc(90), 2, true)
	if err != nil {
		t.Fatalf("ParseKeyRing: %v", err)
	}
	if got := ring.IDs(); len(got) != 3 || got[0] != 1 || got[2] != 3 || !ring.WritesV2() {
		t.Fatalf("unexpected ring: %v v2=%v", got, ring.WritesV2())
	}
	if _, err := ParseKeyRing("", "2="+enc(50), 2, true); err != nil {
		t.Errorf("key 1 may be absent once everything is migrated: %v", err)
	}
	for _, bad := range []string{"x", "0=" + enc(1), "256=" + enc(1), "2=notbase64!", "1=" + enc(0)} {
		if _, err := ParseKeyRing(enc(0), bad, 1, true); err == nil {
			t.Errorf("ParseKeyRing accepted extra keys %q", bad)
		}
	}
}

func TestGenerateAndDecodeEncryptionKeyRoundTrip(t *testing.T) {
	encoded, err := GenerateEncryptionKey()
	if err != nil {
		t.Fatalf("GenerateEncryptionKey: %v", err)
	}
	key, err := DecodeEncryptionKey(encoded)
	if err != nil {
		t.Fatalf("DecodeEncryptionKey: %v", err)
	}
	if len(key) != EncryptionKeySize {
		t.Fatalf("decoded key is %d bytes, want %d", len(key), EncryptionKeySize)
	}
	other, _ := GenerateEncryptionKey()
	if encoded == other {
		t.Fatal("two generated keys are identical")
	}
}

func TestDecodeEncryptionKeyRejectsBadInput(t *testing.T) {
	for _, c := range []string{"", "not base64!!", base64.StdEncoding.EncodeToString(make([]byte, 16))} {
		if _, err := DecodeEncryptionKey(c); err == nil {
			t.Errorf("DecodeEncryptionKey(%q) succeeded; want error", c)
		}
	}
}

// --- test vectors shared with the PHP implementation (tests/php/crypto_test.php)

const vectorsPath = "../../tests/crypto-vectors.json"

type vectorFile struct {
	Keys    map[string]string `json:"keys"`
	Vectors []vector          `json:"vectors"`
}

type vector struct {
	Name      string `json:"name"`
	Version   int    `json:"version"`
	KeyID     int    `json:"key_id"`
	AAD       string `json:"aad"`
	Plaintext string `json:"plaintext"`
	NonceHex  string `json:"nonce_hex"`
	BlobB64   string `json:"blob_base64"`
}

func vectorRing(t *testing.T, v vector) *KeyRing {
	t.Helper()
	keys := map[byte][]byte{1: testKey(0), 2: testKey(32)}
	return mustRing(t, keys, byte(v.KeyID), v.Version == 2)
}

var vectorCases = []vector{
	{Name: "legacy, key 1, no AAD", Version: 1, KeyID: 1, AAD: "", Plaintext: "hunter2", NonceHex: "a0a1a2a3a4a5a6a7a8a9aaab"},
	{Name: "v2, key 1, server password", Version: 2, KeyID: 1, AAD: "nicon:v2:servers.password_enc:7:42", Plaintext: "rcon-pässwörd 🔑", NonceHex: "b0b1b2b3b4b5b6b7b8b9babb"},
	{Name: "v2, key 2, Nitrado token", Version: 2, KeyID: 2, AAD: "nicon:v2:users.nitrado_token_enc:7", Plaintext: strings.Repeat("nitrado-token-", 20), NonceHex: "c0c1c2c3c4c5c6c7c8c9cacb"},
}

// TestWriteVectors regenerates tests/crypto-vectors.json:
//
//	NICON_WRITE_VECTORS=1 go test ./internal/store -run TestWriteVectors
func TestWriteVectors(t *testing.T) {
	if os.Getenv("NICON_WRITE_VECTORS") == "" {
		t.Skip("set NICON_WRITE_VECTORS=1 to regenerate the shared crypto test vectors")
	}
	file := vectorFile{Keys: map[string]string{
		"1": base64.StdEncoding.EncodeToString(testKey(0)),
		"2": base64.StdEncoding.EncodeToString(testKey(32)),
	}}
	for _, v := range vectorCases {
		nonce, _ := hex.DecodeString(v.NonceHex)
		blob, err := vectorRing(t, v).seal(nonce, v.Plaintext, v.AAD)
		if err != nil {
			t.Fatal(err)
		}
		v.BlobB64 = base64.StdEncoding.EncodeToString(blob)
		file.Vectors = append(file.Vectors, v)
	}
	data, _ := json.MarshalIndent(file, "", "  ")
	if err := os.WriteFile(vectorsPath, append(data, '\n'), 0o644); err != nil {
		t.Fatal(err)
	}
}

func TestSharedVectors(t *testing.T) {
	data, err := os.ReadFile(vectorsPath)
	if err != nil {
		t.Fatalf("read vectors: %v", err)
	}
	var file vectorFile
	if err := json.Unmarshal(data, &file); err != nil {
		t.Fatal(err)
	}
	if len(file.Vectors) != len(vectorCases) {
		t.Fatalf("vector file has %d entries, want %d — regenerate it", len(file.Vectors), len(vectorCases))
	}
	for _, v := range file.Vectors {
		blob, _ := base64.StdEncoding.DecodeString(v.BlobB64)
		ring := vectorRing(t, v)
		got, err := ring.Decrypt(blob, v.AAD)
		if err != nil || got != v.Plaintext {
			t.Errorf("%s: Decrypt = %q, %v; want %q", v.Name, got, err, v.Plaintext)
		}
		// The format is bit-exact: sealing again with the same nonce gives the same bytes.
		nonce, _ := hex.DecodeString(v.NonceHex)
		again, _ := ring.seal(nonce, v.Plaintext, v.AAD)
		if !bytes.Equal(again, blob) {
			t.Errorf("%s: re-sealing with the fixed nonce differs from the stored vector", v.Name)
		}
	}
}
