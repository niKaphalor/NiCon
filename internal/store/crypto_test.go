package store

import (
	"strings"
	"testing"
)

func TestEncryptDecryptRoundTrip(t *testing.T) {
	key := make([]byte, EncryptionKeySize)
	for i := range key {
		key[i] = byte(i)
	}
	enc, err := newEncryptor(key)
	if err != nil {
		t.Fatalf("newEncryptor: %v", err)
	}

	plaintext := "super-secret-rcon-password"
	ciphertext, err := enc.Encrypt(plaintext)
	if err != nil {
		t.Fatalf("Encrypt: %v", err)
	}
	if strings.Contains(string(ciphertext), plaintext) {
		t.Fatal("ciphertext contains the plaintext in the clear")
	}

	got, err := enc.Decrypt(ciphertext)
	if err != nil {
		t.Fatalf("Decrypt: %v", err)
	}
	if got != plaintext {
		t.Fatalf("Decrypt() = %q, want %q", got, plaintext)
	}
}

func TestEncryptIsNonDeterministic(t *testing.T) {
	key := make([]byte, EncryptionKeySize)
	enc, err := newEncryptor(key)
	if err != nil {
		t.Fatalf("newEncryptor: %v", err)
	}

	a, err := enc.Encrypt("same plaintext")
	if err != nil {
		t.Fatal(err)
	}
	b, err := enc.Encrypt("same plaintext")
	if err != nil {
		t.Fatal(err)
	}
	if string(a) == string(b) {
		t.Fatal("two encryptions of the same plaintext produced identical ciphertext — nonce isn't being randomized")
	}
}

func TestDecryptWithWrongKeyFails(t *testing.T) {
	key1 := make([]byte, EncryptionKeySize)
	key2 := make([]byte, EncryptionKeySize)
	key2[0] = 1 // differ from key1

	enc1, err := newEncryptor(key1)
	if err != nil {
		t.Fatal(err)
	}
	enc2, err := newEncryptor(key2)
	if err != nil {
		t.Fatal(err)
	}

	ciphertext, err := enc1.Encrypt("secret")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := enc2.Decrypt(ciphertext); err == nil {
		t.Fatal("Decrypt with the wrong key succeeded; it should fail GCM authentication")
	}
}

func TestDecryptTruncatedCiphertextFails(t *testing.T) {
	key := make([]byte, EncryptionKeySize)
	enc, err := newEncryptor(key)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := enc.Decrypt([]byte("too short")); err == nil {
		t.Fatal("Decrypt of a too-short ciphertext succeeded; it should fail")
	}
}

func TestNewEncryptorRejectsWrongKeySize(t *testing.T) {
	for _, n := range []int{0, 1, 16, 31, 33, 64} {
		if _, err := newEncryptor(make([]byte, n)); err == nil {
			t.Errorf("newEncryptor accepted a %d-byte key; want error", n)
		}
	}
	if _, err := newEncryptor(make([]byte, EncryptionKeySize)); err != nil {
		t.Errorf("newEncryptor rejected a correctly-sized key: %v", err)
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
		t.Fatalf("decoded key length = %d, want %d", len(key), EncryptionKeySize)
	}

	// Two generated keys should essentially never collide.
	encoded2, err := GenerateEncryptionKey()
	if err != nil {
		t.Fatal(err)
	}
	if encoded == encoded2 {
		t.Fatal("two calls to GenerateEncryptionKey produced the same key")
	}
}

func TestDecodeEncryptionKeyRejectsBadInput(t *testing.T) {
	cases := []string{
		"",
		"not-valid-base64!!!",
		"c2hvcnQ=", // valid base64, but decodes to far fewer than 32 bytes
	}
	for _, c := range cases {
		if _, err := DecodeEncryptionKey(c); err == nil {
			t.Errorf("DecodeEncryptionKey(%q) succeeded; want error", c)
		}
	}
}
