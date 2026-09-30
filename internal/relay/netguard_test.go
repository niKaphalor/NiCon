package relay

import (
	"testing"

	"github.com/niKaphalor/NiCon/internal/store"
)

func storeServer(host string, port int, protocol string) store.Server {
	return store.Server{Host: host, Port: port, Protocol: protocol}
}

func withPolicy(t *testing.T, p TargetPolicy) {
	t.Helper()
	prev := activeTargetPolicy()
	SetTargetPolicy(p)
	t.Cleanup(func() { SetTargetPolicy(prev) })
}

func TestResolveTargetSelfHosted(t *testing.T) {
	withPolicy(t, TargetPolicy{})
	cases := []struct {
		host    string
		allowed bool
	}{
		// Always refused: metadata, link-local, unspecified, multicast.
		{"169.254.169.254", false},
		{"169.254.170.2", false},
		{"100.100.100.200", false},
		{"metadata.google.internal", false},
		{"METADATA.GOOGLE.INTERNAL", false}, // case-insensitive
		{"[fd00:ec2::254]", false},          // bracketed, as in host:port
		{"fd00:ec2::254", false},
		{"169.254.1.1", false},
		{"fe80::1", false},
		{"0.0.0.0", false},
		{"224.0.0.1", false},
		{"::ffff:169.254.169.254", false}, // IPv4-mapped form
		{"", false},

		// Self-hosted default: LAN and loopback game servers are fine.
		{"127.0.0.1", true},
		{"localhost", true},
		{"192.168.1.50", true},
		{"10.0.0.5", true},
		{"169.254.169.253", false}, // link-local, refused too
	}
	for _, c := range cases {
		_, err := resolveTarget(c.host)
		if (err == nil) != c.allowed {
			t.Errorf("resolveTarget(%q) err=%v, want allowed=%v", c.host, err, c.allowed)
		}
	}
}

func TestResolveTargetHostedBlocksPrivate(t *testing.T) {
	allow, err := ParseTargetAllowlist("192.168.1.0/24, 10.9.9.9")
	if err != nil {
		t.Fatal(err)
	}
	withPolicy(t, TargetPolicy{BlockPrivate: true, Allow: allow})
	cases := []struct {
		host    string
		allowed bool
	}{
		{"127.0.0.1", false},
		{"localhost", false},
		{"::1", false},
		{"10.0.0.5", false},
		{"172.16.0.1", false},
		{"192.168.2.1", false},
		{"100.64.0.1", false}, // CGNAT
		{"fd12::1", false},    // ULA
		{"::ffff:10.0.0.5", false},

		{"192.168.1.50", true}, // allowlisted range
		{"10.9.9.9", true},     // allowlisted single IP
		{"8.8.8.8", true},
		{"2001:4860:4860::8888", true},

		// The allowlist never re-admits the always-blocked set.
		{"169.254.169.254", false},
	}
	for _, c := range cases {
		_, err := resolveTarget(c.host)
		if (err == nil) != c.allowed {
			t.Errorf("resolveTarget(%q) err=%v, want allowed=%v", c.host, err, c.allowed)
		}
	}
}

func TestResolveTargetReturnsPinnedLiteral(t *testing.T) {
	withPolicy(t, TargetPolicy{})
	got, err := resolveTarget("[::1]")
	if err != nil || got != "::1" {
		t.Fatalf("resolveTarget([::1]) = %q, %v; want ::1", got, err)
	}
	got, err = resolveTarget("localhost")
	if err != nil {
		t.Fatal(err)
	}
	if got != "127.0.0.1" && got != "::1" {
		t.Fatalf("resolveTarget(localhost) = %q, want a loopback literal", got)
	}
}

func TestParseTargetAllowlistRejectsGarbage(t *testing.T) {
	for _, bad := range []string{"nope", "10.0.0.0/33", "1.2.3"} {
		if _, err := ParseTargetAllowlist(bad); err == nil {
			t.Errorf("ParseTargetAllowlist(%q) succeeded, want error", bad)
		}
	}
	if n, err := ParseTargetAllowlist(""); err != nil || len(n) != 0 {
		t.Errorf("empty list: %v, %v", n, err)
	}
}

func TestConnectGameRejectsBadInput(t *testing.T) {
	withPolicy(t, TargetPolicy{})
	for _, srv := range []struct {
		host, proto string
		port        int
	}{
		{"127.0.0.1", "source", 0},
		{"127.0.0.1", "source", 70000},
		{"127.0.0.1", "gopher", 27015},
		{"169.254.169.254", "source", 80},
	} {
		if _, err := connectGame(storeServer(srv.host, srv.port, srv.proto)); err == nil {
			t.Errorf("connectGame(%+v) succeeded, want error", srv)
		}
	}
}

func TestProbeSlotsAreBounded(t *testing.T) {
	var releases []func()
	for i := 0; i < cap(probeSlots); i++ {
		rel, err := acquireProbeSlot()
		if err != nil {
			t.Fatalf("slot %d: %v", i, err)
		}
		releases = append(releases, rel)
	}
	if _, err := acquireProbeSlot(); err == nil {
		t.Fatal("expected error once all probe slots are taken")
	}
	for _, r := range releases {
		r()
	}
	rel, err := acquireProbeSlot()
	if err != nil {
		t.Fatalf("slot should be free again: %v", err)
	}
	rel()
}

func TestTestAllowedRateLimits(t *testing.T) {
	rel := &Relay{}
	for i := 0; i < testLimit; i++ {
		if !rel.testAllowed(1) {
			t.Fatalf("test %d denied, want allowed", i+1)
		}
	}
	if rel.testAllowed(1) {
		t.Fatal("expected request beyond testLimit to be denied")
	}
	if !rel.testAllowed(2) {
		t.Fatal("another user's budget must be independent")
	}
}
