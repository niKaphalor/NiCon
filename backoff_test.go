package main

import (
	"testing"
	"time"
)

func TestProbeBackoff(t *testing.T) {
	clock := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	b := newProbeBackoff()
	b.now = func() time.Time { return clock }
	const base = 5 * time.Minute

	for i := 0; i < backoffFreeFailures; i++ {
		b.record(1, false, base)
		if !b.due(1) {
			t.Fatalf("failure %d should still be probed every cycle", i+1)
		}
	}

	// 4th failure: wait one base interval (minus slack), so the next tick
	// (base later) is due again but nothing sooner.
	b.record(1, false, base)
	if b.due(1) {
		t.Fatal("expected backoff after the free failures are used up")
	}
	clock = clock.Add(base)
	if !b.due(1) {
		t.Fatal("expected server due one base interval later")
	}

	// 5th failure doubles the wait.
	b.record(1, false, base)
	clock = clock.Add(base)
	if b.due(1) {
		t.Fatal("expected the doubled wait to still be running")
	}
	clock = clock.Add(base)
	if !b.due(1) {
		t.Fatal("expected server due after the doubled wait")
	}

	// The delay is capped.
	for i := 0; i < 30; i++ {
		b.record(1, false, base)
	}
	clock = clock.Add(backoffMax)
	if !b.due(1) {
		t.Fatal("wait must never exceed backoffMax")
	}

	// A success clears everything; other servers are unaffected.
	b.record(1, true, base)
	if !b.due(1) || !b.due(2) {
		t.Fatal("success should reset backoff")
	}
}

func TestProbeBackoffPrune(t *testing.T) {
	b := newProbeBackoff()
	for i := 0; i < 10; i++ {
		b.record(1, false, time.Minute)
		b.record(2, false, time.Minute)
	}
	b.prune(map[int64]bool{2: true})
	if _, ok := b.state[1]; ok {
		t.Fatal("state for a deleted server should be dropped")
	}
	if _, ok := b.state[2]; !ok {
		t.Fatal("state for a live server should be kept")
	}
}
