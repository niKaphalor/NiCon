package relay

import (
	"net"
	"net/http"
	"sync"
	"time"

	"golang.org/x/time/rate"
)

// ipRateLimiter throttles a bursty action (registration) per client IP,
// evicting limiters that haven't been used in a while so memory doesn't
// grow unbounded over the relay's lifetime.
type ipRateLimiter struct {
	mu       sync.Mutex
	limiters map[string]*ipLimiterEntry
	r        rate.Limit
	burst    int
}

type ipLimiterEntry struct {
	limiter  *rate.Limiter
	lastSeen time.Time
}

func newIPRateLimiter(r rate.Limit, burst int) *ipRateLimiter {
	l := &ipRateLimiter{limiters: make(map[string]*ipLimiterEntry), r: r, burst: burst}
	go l.cleanupLoop()
	return l
}

func (l *ipRateLimiter) allow(ip string) bool {
	l.mu.Lock()
	defer l.mu.Unlock()

	entry, ok := l.limiters[ip]
	if !ok {
		entry = &ipLimiterEntry{limiter: rate.NewLimiter(l.r, l.burst)}
		l.limiters[ip] = entry
	}
	entry.lastSeen = time.Now()
	return entry.limiter.Allow()
}

// cleanupLoop evicts limiters for IPs that haven't made a request in over an
// hour, so an idling relay doesn't accumulate one entry per IP forever.
func (l *ipRateLimiter) cleanupLoop() {
	ticker := time.NewTicker(10 * time.Minute)
	defer ticker.Stop()
	for range ticker.C {
		cutoff := time.Now().Add(-1 * time.Hour)
		l.mu.Lock()
		for ip, entry := range l.limiters {
			if entry.lastSeen.Before(cutoff) {
				delete(l.limiters, ip)
			}
		}
		l.mu.Unlock()
	}
}

// clientIP extracts the request's source IP, stripping the port. It trusts
// only the TCP connection's own address — never an X-Forwarded-For or
// similar header, since those are trivially spoofable by the same client
// this limiter exists to throttle. Running the relay behind a reverse proxy
// means every request appears to come from the proxy's IP, defeating
// per-client limiting; that's a known limitation for that setup.
func clientIP(r *http.Request) string {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}
