package relay

import (
	"context"
	"errors"
	"fmt"
	"net"
	"strings"
	"sync/atomic"
	"time"
)

// TargetPolicy decides which addresses the relay may open outbound
// connections to. It exists because host/port are caller-supplied (the
// "test" and "query_test" WS messages, saved servers), which makes the relay
// an SSRF / port-scan primitive for any account holder.
//
// Some addresses are refused in every mode (cloud metadata endpoints,
// link-local, unspecified, multicast) — they never host a game server.
// Loopback, private (RFC 1918 / ULA), and CGNAT ranges are refused only when
// BlockPrivate is set (hosted mode); a self-hosted relay's primary use case
// is game servers on the operator's own LAN, so that stays the default.
// Allow re-admits specific private ranges in hosted mode.
type TargetPolicy struct {
	BlockPrivate bool
	Allow        []*net.IPNet
}

var errTargetNotAllowed = errors.New("this host is not allowed")

var currentTargetPolicy atomic.Pointer[TargetPolicy]

// SetTargetPolicy installs the process-wide outbound-target policy. Call it
// once at startup, before any connection is made.
func SetTargetPolicy(p TargetPolicy) { currentTargetPolicy.Store(&p) }

func activeTargetPolicy() TargetPolicy {
	if p := currentTargetPolicy.Load(); p != nil {
		return *p
	}
	return TargetPolicy{}
}

// ParseTargetAllowlist parses a comma-separated list of CIDRs and bare IPs.
func ParseTargetAllowlist(list string) ([]*net.IPNet, error) {
	var out []*net.IPNet
	for _, item := range strings.Split(list, ",") {
		item = strings.TrimSpace(item)
		if item == "" {
			continue
		}
		if !strings.Contains(item, "/") {
			ip := net.ParseIP(item)
			if ip == nil {
				return nil, fmt.Errorf("invalid allowlist entry %q", item)
			}
			bits := 128
			if ip.To4() != nil {
				bits = 32
			}
			out = append(out, &net.IPNet{IP: ip, Mask: net.CIDRMask(bits, bits)})
			continue
		}
		_, n, err := net.ParseCIDR(item)
		if err != nil {
			return nil, fmt.Errorf("invalid allowlist entry %q: %w", item, err)
		}
		out = append(out, n)
	}
	return out, nil
}

var cgnatNet = &net.IPNet{IP: net.IPv4(100, 64, 0, 0), Mask: net.CIDRMask(10, 32)}

var blockedMetadataHosts = map[string]bool{
	"metadata.google.internal": true,
}

// blockedMetadataIPs mirror webspace/handlers/servers.php's
// nicon_is_cloud_metadata_host. Most sit in link-local space that is refused
// anyway; the explicit list also covers the ones that don't (Alibaba).
var blockedMetadataIPs = map[string]bool{
	"169.254.169.254": true, // AWS, GCP, Azure, DigitalOcean, Oracle Cloud, ...
	"169.254.170.2":   true, // AWS ECS task metadata
	"fd00:ec2::254":   true, // AWS IMDSv2, IPv6
	"100.100.100.200": true, // Alibaba Cloud
}

func (p TargetPolicy) checkIP(ip net.IP) error {
	if v4 := ip.To4(); v4 != nil {
		ip = v4
	}
	if blockedMetadataIPs[ip.String()] || ip.IsUnspecified() || ip.IsMulticast() ||
		ip.IsLinkLocalUnicast() || ip.IsLinkLocalMulticast() {
		return errTargetNotAllowed
	}
	if !p.BlockPrivate {
		return nil
	}
	if !(ip.IsLoopback() || ip.IsPrivate() || cgnatNet.Contains(ip)) {
		return nil
	}
	for _, n := range p.Allow {
		if n.Contains(ip) {
			return nil
		}
	}
	return errTargetNotAllowed
}

const resolveTimeout = 5 * time.Second

// resolveTarget resolves host exactly once, checks EVERY returned address
// against the policy (a name with one bad record is refused outright), and
// returns one vetted IP literal. Callers must dial that literal instead of
// the original hostname: re-resolving at connect time is what makes DNS
// rebinding possible. None of the supported protocols uses TLS/SNI, so no
// hostname needs to be carried along.
func resolveTarget(host string) (string, error) {
	normalized := strings.ToLower(strings.Trim(host, "[]"))
	if normalized == "" || blockedMetadataHosts[normalized] {
		return "", errTargetNotAllowed
	}
	policy := activeTargetPolicy()
	if ip := net.ParseIP(normalized); ip != nil {
		if err := policy.checkIP(ip); err != nil {
			return "", err
		}
		return ip.String(), nil
	}
	ctx, cancel := context.WithTimeout(context.Background(), resolveTimeout)
	defer cancel()
	addrs, err := net.DefaultResolver.LookupIPAddr(ctx, normalized)
	if err != nil || len(addrs) == 0 {
		return "", fmt.Errorf("cannot resolve host")
	}
	for _, a := range addrs {
		if err := policy.checkIP(a.IP); err != nil {
			return "", err
		}
	}
	return addrs[0].IP.String(), nil
}

// probeSlots bounds concurrent user-triggered outbound probes ("test" and
// "query_test") relay-wide, independent of the per-user rate limits.
var probeSlots = make(chan struct{}, 16)

var errRelayBusy = errors.New("relay is busy — try again shortly")

func acquireProbeSlot() (release func(), err error) {
	select {
	case probeSlots <- struct{}{}:
		return func() { <-probeSlots }, nil
	default:
		return nil, errRelayBusy
	}
}

// validPort reports whether port is a usable TCP/UDP port number.
func validPort(port int) bool { return port >= 1 && port <= 65535 }

// knownProtocols are the RCON transports connectGame implements; the
// "source" default covers an empty value.
var knownProtocols = map[string]bool{
	"": true, "source": true, "webrcon": true, "palworld_rest": true,
	"battleye": true, "telnet": true, "battlebit": true,
}
