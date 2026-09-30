package relay

import "testing"

// TestIsBlockedMetadataHost keeps the original metadata-host cases, now
// exercised through resolveTarget (the guard connectGame/PublicInfoCheck use).
func TestIsBlockedMetadataHost(t *testing.T) {
	withPolicy(t, TargetPolicy{})
	cases := []struct {
		host    string
		blocked bool
	}{
		{"169.254.169.254", true},
		{"169.254.170.2", true},
		{"100.100.100.200", true},
		{"metadata.google.internal", true},
		{"METADATA.GOOGLE.INTERNAL", true}, // hostnames are matched case-insensitively
		{"[fd00:ec2::254]", true},          // as it'd arrive bracketed in a host:port pair
		{"fd00:ec2::254", true},

		// Deliberately NOT blocked in the default (self-hosted) policy —
		// localhost/private/LAN game servers are the documented primary use
		// case. Hosted mode blocks these; see netguard_test.go.
		{"127.0.0.1", false},
		{"localhost", false},
		{"192.168.1.50", false},
		{"10.0.0.5", false},
		{"example.com", false},

		// Was "not blocked" when only the exact metadata IPs were denied;
		// all of 169.254.0.0/16 (link-local) is refused now.
		{"169.254.169.253", true},
	}

	for _, c := range cases {
		if c.host == "example.com" {
			continue // needs real DNS; resolution errors are not a "blocked" verdict
		}
		_, err := resolveTarget(c.host)
		if got := err != nil; got != c.blocked {
			t.Errorf("resolveTarget(%q) blocked = %v (err=%v), want %v", c.host, got, err, c.blocked)
		}
	}
}
