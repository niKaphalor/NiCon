package relay

import "testing"

func TestIsBlockedMetadataHost(t *testing.T) {
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

		// Deliberately NOT blocked — localhost/private/LAN game servers are
		// the documented primary use case, only the specific metadata
		// endpoints above are denied.
		{"127.0.0.1", false},
		{"localhost", false},
		{"192.168.1.50", false},
		{"10.0.0.5", false},
		{"example.com", false},
		{"169.254.169.253", false}, // one bit off from a real blocked address
	}

	for _, c := range cases {
		if got := isBlockedMetadataHost(c.host); got != c.blocked {
			t.Errorf("isBlockedMetadataHost(%q) = %v, want %v", c.host, got, c.blocked)
		}
	}
}
