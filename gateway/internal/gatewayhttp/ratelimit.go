package gatewayhttp

import (
	"sync"
	"time"

	"golang.org/x/time/rate"
)

// idleLimiterTTL bounds how long an idle per-IP limiter is retained. Without
// eviction the map is an unbounded memory leak on a public endpoint.
const idleLimiterTTL = 10 * time.Minute

type limiterEntry struct {
	limiter *rate.Limiter
	seen    time.Time
}

// ipRateLimiter is a token bucket per client IP.
type ipRateLimiter struct {
	perSecond float64
	burst     int

	mu       sync.Mutex
	entries  map[string]*limiterEntry
	lastSwep time.Time
}

func newIPRateLimiter(perSecond float64, burst int) *ipRateLimiter {
	return &ipRateLimiter{
		perSecond: perSecond,
		burst:     burst,
		entries:   map[string]*limiterEntry{},
		lastSwep:  time.Now(),
	}
}

func (l *ipRateLimiter) allow(ip string) bool {
	l.mu.Lock()
	defer l.mu.Unlock()

	now := time.Now()
	l.sweepLocked(now)

	entry, ok := l.entries[ip]
	if !ok {
		entry = &limiterEntry{limiter: rate.NewLimiter(rate.Limit(l.perSecond), l.burst)}
		l.entries[ip] = entry
	}
	entry.seen = now
	return entry.limiter.Allow()
}

func (l *ipRateLimiter) sweepLocked(now time.Time) {
	if now.Sub(l.lastSwep) < idleLimiterTTL {
		return
	}
	l.lastSwep = now
	for ip, entry := range l.entries {
		if now.Sub(entry.seen) > idleLimiterTTL {
			delete(l.entries, ip)
		}
	}
}
