package store

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"encoding/base64"
	"fmt"
	"io"
)

// encryptor encrypts RCON passwords at rest with AES-256-GCM, so a copy of
// the database alone (e.g. a leaked mysqldump) doesn't hand over working
// credentials to every stored server — the relay's encryption key is a
// separate secret, never stored in the database itself.
type encryptor struct {
	gcm cipher.AEAD
}

// EncryptionKeySize is the required raw key length for AES-256.
const EncryptionKeySize = 32

func newEncryptor(key []byte) (*encryptor, error) {
	if len(key) != EncryptionKeySize {
		return nil, fmt.Errorf("encryption key must be %d bytes, got %d", EncryptionKeySize, len(key))
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, fmt.Errorf("init cipher: %w", err)
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, fmt.Errorf("init GCM: %w", err)
	}
	return &encryptor{gcm: gcm}, nil
}

func (e *encryptor) Encrypt(plaintext string) ([]byte, error) {
	nonce := make([]byte, e.gcm.NonceSize())
	if _, err := io.ReadFull(rand.Reader, nonce); err != nil {
		return nil, fmt.Errorf("generate nonce: %w", err)
	}
	return e.gcm.Seal(nonce, nonce, []byte(plaintext), nil), nil
}

func (e *encryptor) Decrypt(ciphertext []byte) (string, error) {
	nonceSize := e.gcm.NonceSize()
	if len(ciphertext) < nonceSize {
		return "", fmt.Errorf("ciphertext too short")
	}
	nonce, ct := ciphertext[:nonceSize], ciphertext[nonceSize:]
	plaintext, err := e.gcm.Open(nil, nonce, ct, nil)
	if err != nil {
		return "", fmt.Errorf("decrypt: %w", err)
	}
	return string(plaintext), nil
}

// GenerateEncryptionKey returns a fresh random base64-encoded key suitable
// for -encryption-key / NICON_ENCRYPTION_KEY.
func GenerateEncryptionKey() (string, error) {
	key := make([]byte, EncryptionKeySize)
	if _, err := io.ReadFull(rand.Reader, key); err != nil {
		return "", err
	}
	return base64.StdEncoding.EncodeToString(key), nil
}

// DecodeEncryptionKey parses a base64-encoded key as produced by
// GenerateEncryptionKey.
func DecodeEncryptionKey(encoded string) ([]byte, error) {
	key, err := base64.StdEncoding.DecodeString(encoded)
	if err != nil {
		return nil, fmt.Errorf("invalid encryption key encoding: %w", err)
	}
	if len(key) != EncryptionKeySize {
		return nil, fmt.Errorf("encryption key must decode to %d bytes, got %d", EncryptionKeySize, len(key))
	}
	return key, nil
}
