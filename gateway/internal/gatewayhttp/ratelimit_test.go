package gatewayhttp

import (
	"testing"
	"time"
)

func TestIPRateLimiterIsolatesClients(t *testing.T) {
	l := newIPRateLimiter(0.0001, 1)
	if !l.allow("1.1.1.1") {
		t.Fatal("first request from an IP must pass")
	}
	if l.allow("1.1.1.1") {
		t.Fatal("second request should exhaust the burst")
	}
	if !l.allow("2.2.2.2") {
		t.Fatal("a different IP has its own bucket")
	}
}

func TestIPRateLimiterEvictsIdleEntries(t *testing.T) {
	l := newIPRateLimiter(1, 1)
	l.allow("1.1.1.1")

	// Pretend the entry and the last sweep are older than the TTL.
	l.mu.Lock()
	l.entries["1.1.1.1"].seen = time.Now().Add(-2 * idleLimiterTTL)
	l.lastSwep = time.Now().Add(-2 * idleLimiterTTL)
	l.mu.Unlock()

	l.allow("2.2.2.2")

	l.mu.Lock()
	_, stillThere := l.entries["1.1.1.1"]
	count := len(l.entries)
	l.mu.Unlock()

	if stillThere {
		t.Fatal("idle entry should have been swept")
	}
	if count != 1 {
		t.Fatalf("entries = %d, want 1", count)
	}
}
