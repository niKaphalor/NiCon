package main

import (
	"context"
	"io"
	"log"
	"sync"
	"testing"
	"time"

	"github.com/niKaphalor/NiCon/internal/store"
)

type fakeClock struct {
	mu sync.Mutex
	t  time.Time
}

func (c *fakeClock) now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.t
}

func (c *fakeClock) advance(d time.Duration) {
	c.mu.Lock()
	c.t = c.t.Add(d)
	c.mu.Unlock()
}

type schedulerHarness struct {
	*probeScheduler
	clock  *fakeClock
	mu     sync.Mutex
	probes map[int64]int
	lists  int
	result func(id int64) bool

	setServers func(ids ...int64)
}

func newHarness(ids ...int64) *schedulerHarness {
	h := &schedulerHarness{clock: &fakeClock{t: time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)}, probes: map[int64]int{}}
	h.result = func(int64) bool { return true }
	servers := make([]store.Server, len(ids))
	for i, id := range ids {
		servers[i] = store.Server{ID: id}
	}
	list := func(context.Context) ([]store.Server, error) {
		h.mu.Lock()
		defer h.mu.Unlock()
		h.lists++
		return append([]store.Server(nil), servers...), nil
	}
	probe := func(_ context.Context, srv store.Server) bool {
		h.mu.Lock()
		h.probes[srv.ID]++
		fn := h.result
		h.mu.Unlock()
		return fn(srv.ID)
	}
	h.probeScheduler = newProbeScheduler("test", 5*time.Minute, list, probe, make(chan struct{}, 4), log.New(io.Discard, "", 0))
	h.probeScheduler.now = h.clock.now
	h.probeScheduler.backoff.now = h.clock.now
	h.probeScheduler.rnd = func() float64 { return 0.5 } // no jitter: (0.5*2-1)*jitter = 0; warm-up at half
	h.setServers = func(ids ...int64) {
		h.mu.Lock()
		defer h.mu.Unlock()
		servers = servers[:0]
		for _, id := range ids {
			servers = append(servers, store.Server{ID: id})
		}
	}
	return h
}

func (h *schedulerHarness) count(id int64) int {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.probes[id]
}

func (h *schedulerHarness) step(d time.Duration) {
	h.clock.advance(d)
	h.runOnce(context.Background())
	h.wait()
}

func TestFirstProbeIsSpreadOverTheWarmupWindowNotImmediate(t *testing.T) {
	h := newHarness(1)
	h.runOnce(context.Background())
	h.wait()
	if h.count(1) != 0 {
		t.Fatal("an unseen server must be scheduled inside the warm-up window, not probed at once")
	}
	h.step(h.warmup/2 - time.Second)
	if h.count(1) != 0 {
		t.Fatal("probed before its scheduled moment")
	}
	h.step(2 * time.Second)
	if h.count(1) != 1 {
		t.Fatalf("expected the first probe after the warm-up slot, got %d", h.count(1))
	}
}

func TestProbesRepeatEveryIntervalMeasuredFromCompletion(t *testing.T) {
	h := newHarness(1)
	h.runOnce(context.Background())
	h.step(h.warmup) // first probe
	if h.count(1) != 1 {
		t.Fatalf("first probe missing: %d", h.count(1))
	}
	h.step(h.interval - time.Second)
	if h.count(1) != 1 {
		t.Fatal("re-probed before the interval passed")
	}
	h.step(2 * time.Second)
	if h.count(1) != 2 {
		t.Fatalf("expected a second probe after one interval, got %d", h.count(1))
	}
}

func TestJitterKeepsNextProbeWithinBounds(t *testing.T) {
	for _, r := range []float64{0, 0.999999} {
		h := newHarness(1)
		h.rnd = func() float64 { return r }
		h.runOnce(context.Background())
		h.step(h.warmup + time.Second)
		h.probeScheduler.mu.Lock()
		next := h.next[1]
		h.probeScheduler.mu.Unlock()
		low := h.clock.now().Add(time.Duration(float64(h.interval) * (1 - h.jitter - 0.001)))
		high := h.clock.now().Add(time.Duration(float64(h.interval) * (1 + h.jitter + 0.001)))
		if next.Before(low) || next.After(high) {
			t.Fatalf("rnd=%v: next probe %v outside [%v, %v]", r, next, low, high)
		}
	}
}

func TestAServerIsNeverProbedTwiceAtOnceAndASlowOneDoesNotBlockOthers(t *testing.T) {
	h := newHarness(1, 2)
	release := make(chan struct{})
	h.mu.Lock()
	h.result = func(id int64) bool {
		if id == 1 {
			<-release // server 1 hangs
		}
		return true
	}
	h.mu.Unlock()
	h.runOnce(context.Background())
	h.clock.advance(h.warmup)
	h.runOnce(context.Background())
	// Give server 2's goroutine time to finish while server 1 is stuck.
	deadline := time.Now().Add(2 * time.Second)
	for h.count(2) == 0 && time.Now().Before(deadline) {
		time.Sleep(5 * time.Millisecond)
	}
	if h.count(2) != 1 {
		t.Fatal("a hanging server must not stop the others from being probed")
	}
	// Even a whole interval later the stuck server is not probed a second time.
	h.clock.advance(2 * h.interval)
	h.runOnce(context.Background())
	if h.count(1) != 1 {
		t.Fatalf("server 1 must have exactly one probe in flight, got %d", h.count(1))
	}
	close(release)
	h.wait()
}

func TestRepeatedlyFailingServersBackOff(t *testing.T) {
	h := newHarness(1)
	h.mu.Lock()
	h.result = func(int64) bool { return false }
	h.mu.Unlock()
	h.runOnce(context.Background())
	h.step(h.warmup) // failure 1
	// The free failures cost nothing extra: still probed at every regular slot.
	for i := 0; i < backoffFreeFailures-1; i++ {
		h.step(h.interval + time.Second)
	}
	before := h.count(1)
	if before != backoffFreeFailures {
		t.Fatalf("expected %d probes before any backoff, got %d", backoffFreeFailures, before)
	}
	// Failures 4 and 5 are still probed at a regular slot (the first backoff
	// level equals the normal interval) ...
	h.step(h.interval + time.Second)
	h.step(h.interval + time.Second)
	if h.count(1) != before+2 {
		t.Fatalf("expected %d probes, got %d", before+2, h.count(1))
	}
	// ... but after the 5th the wait has doubled: the next regular slot is skipped ...
	h.step(h.interval + time.Second)
	if h.count(1) != before+2 {
		t.Fatalf("a failing server should be skipped at the next regular slot, got %d probes", h.count(1))
	}
	// ... and it is probed again once the longer wait is over.
	h.step(h.interval + time.Second)
	if h.count(1) != before+3 {
		t.Fatalf("expected the server to be probed again after the longer wait, got %d probes", h.count(1))
	}
}

func TestServerListIsReloadedOnlyEveryRefreshAndRemovedServersAreForgotten(t *testing.T) {
	h := newHarness(1, 2)
	h.runOnce(context.Background())
	h.step(10 * time.Second)
	h.step(10 * time.Second)
	if h.lists != 1 {
		t.Fatalf("the list must not be reloaded on every tick, got %d loads", h.lists)
	}
	h.setServers(1)
	h.step(h.refresh)
	if h.lists != 2 {
		t.Fatalf("expected a reload after the refresh interval, got %d", h.lists)
	}
	h.probeScheduler.mu.Lock()
	_, stillThere := h.next[2]
	h.probeScheduler.mu.Unlock()
	if stillThere {
		t.Fatal("state for a removed server should be dropped")
	}
}
