package main

import (
	"sync"
	"time"
)

// probeBackoff throttles the periodic background probes against targets
// that keep failing. Without it every saved server is dialed every cycle
// forever, so an account full of dead (or deliberately unreachable) hosts
// produces permanent connection attempts at no cost to the account holder.
//
// The first backoffFreeFailures consecutive failures cost nothing (a
// restarting game server shouldn't lose samples); after that the wait
// doubles per failure up to backoffMax. A success clears the state. Skipped
// servers get no sample for that cycle — the accepted price for the lower
// load. State is in memory only: a relay restart probes everything once.
type probeBackoff struct {
	mu    sync.Mutex
	state map[int64]backoffEntry
	now   func() time.Time
}

type backoffEntry struct {
	fails int
	next  time.Time
}

const (
	backoffFreeFailures = 3
	backoffMax          = 6 * time.Hour
	// backoffSlack keeps a wait of exactly N ticks from being pushed to
	// N+1 by the few seconds a probe takes after its tick started.
	backoffSlack = time.Minute
)

func newProbeBackoff() *probeBackoff {
	return &probeBackoff{state: make(map[int64]backoffEntry), now: time.Now}
}

// due reports whether serverID should be probed in this cycle.
func (b *probeBackoff) due(serverID int64) bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	e, ok := b.state[serverID]
	return !ok || !b.now().Before(e.next)
}

// record stores the outcome of a probe. base is the normal cycle interval.
func (b *probeBackoff) record(serverID int64, ok bool, base time.Duration) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if ok {
		delete(b.state, serverID)
		return
	}
	e := b.state[serverID]
	e.fails++
	if e.fails > backoffFreeFailures {
		delay := base
		for i := backoffFreeFailures + 1; i < e.fails && delay < backoffMax; i++ {
			delay *= 2
		}
		if delay > backoffMax {
			delay = backoffMax
		}
		e.next = b.now().Add(delay - backoffSlack)
	}
	b.state[serverID] = e
}

// prune drops state for servers that no longer exist.
func (b *probeBackoff) prune(live map[int64]bool) {
	b.mu.Lock()
	defer b.mu.Unlock()
	for id := range b.state {
		if !live[id] {
			delete(b.state, id)
		}
	}
}
