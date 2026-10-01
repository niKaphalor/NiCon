package store

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"sort"
	"strconv"
	"strings"
)

// Secrets at rest (RCON passwords, Nitrado API tokens) are encrypted with
// AES-256-GCM, so a copy of the database alone (e.g. a leaked mysqldump)
// doesn't hand over working credentials — the encryption key is a separate
// secret, never stored in the database itself.
//
// Two on-disk formats exist, and this file (and lib/crypto.php, which must
// stay byte-compatible) reads both:
//
//	v1 (legacy): nonce(12) || ciphertext || tag(16)
//	              always the key with ID 1, no additional authenticated data.
//	v2:           "NC2" || keyID(1) || nonce(12) || ciphertext || tag(16)
//	              the key named by keyID, and an AAD string that binds the
//	              ciphertext to the row it belongs to (see the *AAD helpers).
//
// v2 fixes two weaknesses of v1: there is no way to tell which key
// encrypted a value (so no rotation), and a ciphertext can be copied from one
// row to another and still decrypts (so someone who can write to the database
// but does not hold the key could point an attacker-controlled server at a
// victim's stored password). With the AAD, a transplanted ciphertext fails to
// authenticate.
//
// v2 is only WRITTEN once explicitly enabled (writeV2), so that every
// component that reads these columns can be upgraded first; reading v2 is
// always on.

const (
	// EncryptionKeySize is the required raw key length for AES-256.
	EncryptionKeySize = 32

	v2Magic       = "NC2"
	v2HeaderSize  = len(v2Magic) + 1
	gcmNonceSize  = 12
	gcmTagSize    = 16
	legacyKeyID   = byte(1)
	maxKeyIDValue = 255
)

// CiphertextOverhead is how many bytes v2 adds to a plaintext; the longest
// plaintext that fits VARBINARY(N) is N - CiphertextOverhead (keep in sync
// with NICON_CIPHERTEXT_OVERHEAD_BYTES in webspace/lib/crypto.php).
const CiphertextOverhead = v2HeaderSize + gcmNonceSize + gcmTagSize

// ServerPasswordAAD is the AAD for servers.password_enc.
func ServerPasswordAAD(userID, serverID int64) string {
	return "nicon:v2:servers.password_enc:" + strconv.FormatInt(userID, 10) + ":" + strconv.FormatInt(serverID, 10)
}

// NitradoTokenAAD is the AAD for users.nitrado_token_enc.
func NitradoTokenAAD(userID int64) string {
	return "nicon:v2:users.nitrado_token_enc:" + strconv.FormatInt(userID, 10)
}

// KeyRing holds every key the database may still contain ciphertext for,
// which one is used for new writes, and whether new writes use format v2.
type KeyRing struct {
	aeads   map[byte]cipher.AEAD
	current byte
	writeV2 bool
}

// NewKeyRing builds a ring from raw keys by ID. current must be one of them;
// a current key other than ID 1 requires writeV2 (v1 cannot name its key).
func NewKeyRing(keys map[byte][]byte, current byte, writeV2 bool) (*KeyRing, error) {
	if len(keys) == 0 {
		return nil, errors.New("no encryption key configured")
	}
	ring := &KeyRing{aeads: make(map[byte]cipher.AEAD, len(keys)), current: current, writeV2: writeV2}
	for id, key := range keys {
		if id == 0 {
			return nil, errors.New("encryption key ID must be between 1 and 255")
		}
		if len(key) != EncryptionKeySize {
			return nil, fmt.Errorf("encryption key %d must be %d bytes, got %d", id, EncryptionKeySize, len(key))
		}
		block, err := aes.NewCipher(key)
		if err != nil {
			return nil, fmt.Errorf("init cipher: %w", err)
		}
		gcm, err := cipher.NewGCM(block)
		if err != nil {
			return nil, fmt.Errorf("init GCM: %w", err)
		}
		ring.aeads[id] = gcm
	}
	if _, ok := ring.aeads[current]; !ok {
		return nil, fmt.Errorf("current encryption key %d is not in the key ring", current)
	}
	if current != legacyKeyID && !writeV2 {
		return nil, fmt.Errorf("current encryption key %d needs the v2 format (enable writing it)", current)
	}
	return ring, nil
}

// newSingleKeyRing is the pre-rotation configuration: one key (ID 1), legacy format.
func newSingleKeyRing(key []byte) (*KeyRing, error) {
	return NewKeyRing(map[byte][]byte{legacyKeyID: key}, legacyKeyID, false)
}

// ParseKeyRing builds a ring from configuration strings:
// primary is the base64 key with ID 1 (NICON_ENCRYPTION_KEY, may be empty when
// extra names a key 1); extra is "2=base64,3=base64,...".
func ParseKeyRing(primary, extra string, current int, writeV2 bool) (*KeyRing, error) {
	keys := map[byte][]byte{}
	if primary != "" {
		key, err := DecodeEncryptionKey(primary)
		if err != nil {
			return nil, err
		}
		keys[legacyKeyID] = key
	}
	for _, item := range strings.Split(extra, ",") {
		item = strings.TrimSpace(item)
		if item == "" {
			continue
		}
		idText, encoded, ok := strings.Cut(item, "=")
		id, err := strconv.Atoi(strings.TrimSpace(idText))
		if !ok || err != nil || id < 1 || id > maxKeyIDValue {
			return nil, fmt.Errorf("invalid extra encryption key %q (want ID=base64 with ID 1-255)", idText)
		}
		key, err := DecodeEncryptionKey(strings.TrimSpace(encoded))
		if err != nil {
			return nil, fmt.Errorf("encryption key %d: %w", id, err)
		}
		if _, dup := keys[byte(id)]; dup {
			return nil, fmt.Errorf("encryption key %d configured twice", id)
		}
		keys[byte(id)] = key
	}
	if current < 1 || current > maxKeyIDValue {
		return nil, fmt.Errorf("current encryption key ID must be 1-255, got %d", current)
	}
	return NewKeyRing(keys, byte(current), writeV2)
}

// Encrypt seals plaintext for the row identified by aad, in the ring's write
// format.
func (k *KeyRing) Encrypt(plaintext, aad string) ([]byte, error) {
	return k.seal(nil, plaintext, aad)
}

// seal is Encrypt with an optional fixed nonce (test vectors only).
func (k *KeyRing) seal(fixedNonce []byte, plaintext, aad string) ([]byte, error) {
	nonce := fixedNonce
	if nonce == nil {
		nonce = make([]byte, gcmNonceSize)
		if _, err := io.ReadFull(rand.Reader, nonce); err != nil {
			return nil, fmt.Errorf("generate nonce: %w", err)
		}
	}
	if !k.writeV2 {
		return k.aeads[legacyKeyID].Seal(append([]byte(nil), nonce...), nonce, []byte(plaintext), nil), nil
	}
	header := append([]byte(v2Magic), k.current)
	out := append(header, nonce...)
	return k.aeads[k.current].Seal(out, nonce, []byte(plaintext), []byte(aad)), nil
}

// Decrypt opens either format. aad must be the value the row's writer used.
func (k *KeyRing) Decrypt(blob []byte, aad string) (string, error) {
	plaintext, _, err := k.decrypt(blob, aad)
	return plaintext, err
}

// decrypt also reports whether the blob is in the ring's current format and
// key (false means "should be rewritten").
func (k *KeyRing) decrypt(blob []byte, aad string) (plaintext string, current bool, err error) {
	if len(blob) >= v2HeaderSize+gcmNonceSize+gcmTagSize && string(blob[:len(v2Magic)]) == v2Magic {
		id := blob[len(v2Magic)]
		if gcm, ok := k.aeads[id]; ok {
			nonce := blob[v2HeaderSize : v2HeaderSize+gcmNonceSize]
			if pt, openErr := gcm.Open(nil, nonce, blob[v2HeaderSize+gcmNonceSize:], []byte(aad)); openErr == nil {
				return string(pt), k.writeV2 && id == k.current, nil
			}
		}
		// Not a valid v2 value: a legacy value can begin with these three
		// bytes by chance (2^-24), so fall through to the legacy attempt.
	}
	gcm, ok := k.aeads[legacyKeyID]
	if !ok {
		return "", false, errors.New("decrypt: value is not readable with the configured keys")
	}
	if len(blob) < gcmNonceSize {
		return "", false, errors.New("ciphertext too short")
	}
	pt, openErr := gcm.Open(nil, blob[:gcmNonceSize], blob[gcmNonceSize:], nil)
	if openErr != nil {
		return "", false, fmt.Errorf("decrypt: %w", openErr)
	}
	return string(pt), !k.writeV2 && k.current == legacyKeyID, nil
}

// WritesV2 reports whether new values are written in format v2.
func (k *KeyRing) WritesV2() bool { return k.writeV2 }

// IDs lists the key IDs in the ring, ascending (for status output).
func (k *KeyRing) IDs() []int {
	ids := make([]int, 0, len(k.aeads))
	for id := range k.aeads {
		ids = append(ids, int(id))
	}
	sort.Ints(ids)
	return ids
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
