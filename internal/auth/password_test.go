package auth

import (
	"strings"
	"testing"

	"golang.org/x/crypto/bcrypt"
)

func TestValidatePassword(t *testing.T) {
	cases := []struct {
		name     string
		password string
		ok       bool
	}{
		{"14 characters", strings.Repeat("x1", 7), false},
		{"15 characters", "correct-horse-1", true},
		{"72 bytes", strings.Repeat("ab", 36), true},
		{"73 bytes", strings.Repeat("a", 36) + strings.Repeat("b", 37), false},
		{"single repeated character", strings.Repeat("a", 20), false},
		{"multi-byte counts characters for the minimum", strings.Repeat("ü", 15), false}, // single repeated rune
		{"multi-byte mix, 15 chars", "üöäüöäüöäüöäüöäüöä" + "abc", true},
		{"multi-byte over the byte limit", strings.Repeat("üö", 19), false}, // 76 bytes
		{"empty", "", false},
	}
	for _, c := range cases {
		err := ValidatePassword(c.password)
		if (err == nil) != c.ok {
			t.Errorf("%s: ValidatePassword err=%v, want ok=%v", c.name, err, c.ok)
		}
	}
}

// Everything ValidatePassword accepts must be hashable: bcrypt's 72-byte
// limit is the reason for MaxPasswordBytes.
func TestValidatedPasswordsHash(t *testing.T) {
	p := strings.Repeat("ab", 36)
	if err := ValidatePassword(p); err != nil {
		t.Fatal(err)
	}
	hash, err := HashPassword(p)
	if err != nil {
		t.Fatalf("HashPassword: %v", err)
	}
	if bcrypt.CompareHashAndPassword([]byte(hash), []byte(p)) != nil {
		t.Fatal("hash does not verify")
	}
	if _, err := HashPassword(p + "c"); err == nil {
		t.Fatal("bcrypt should refuse 73 bytes — if this changes, revisit MaxPasswordBytes")
	}
}
