package main

import (
	"context"
	"log"
	"math/rand"
	"sync"
	"time"

	"github.com/niKaphalor/NiCon/internal/store"
)

// probeScheduler drives one kind of periodic background probe (the RCON
// health check, the public A2S/Minecraft status query) against every stored
// server.
//
// It replaces "every N minutes: load all servers and probe them in one
// batch". That design had three problems: a batch that took longer than the
// interval made the next one get skipped for EVERY server; one slow server
// held its slot in the batch while others waited; and every server was probed
// in the same instant, once per cycle, in a thundering herd.
//
// Instead each server has its own due time:
//   - a server seen for the first time is scheduled at a random moment inside
//     a short warm-up window (so a restart still produces first results
//     quickly, but not all at once),
//   - after a probe finishes, the next one is due `interval` later, +/- jitter
//     (measured from completion, so a slow probe can never overlap itself),
//   - at most one probe per server is in flight, and probes share a bounded
//     worker pool (sem) with the other schedulers,
//   - servers that keep failing are throttled by probeBackoff on top of that.
//
// The server list is reloaded only every `refresh` (listing decrypts every
// stored password), not on every tick.
type probeScheduler struct {
	name     string
	interval time.Duration
	jitter   float64       // fraction of interval, e.g. 0.1 for +/-10 %
	warmup   time.Duration // window over which first probes of unseen servers are spread
	tick     time.Duration // how often to look for due servers
	refresh  time.Duration // how often to reload the server list

	list    func(context.Context) ([]store.Server, error)
	probe   func(context.Context, store.Server) bool // runs and records one probe; reports success
	sem     chan struct{}                            // shared worker-pool slots
	backoff *probeBackoff
	logger  *log.Logger

	// Injectable for tests.
	now func() time.Time
	rnd func() float64 // uniform in [0, 1)

	mu          sync.Mutex
	servers     []store.Server
	loaded      bool
	refreshedAt time.Time
	next        map[int64]time.Time
	inflight    map[int64]bool
	wg          sync.WaitGroup
}

func newProbeScheduler(name string, interval time.Duration, list func(context.Context) ([]store.Server, error),
	probe func(context.Context, store.Server) bool, sem chan struct{}, logger *log.Logger) *probeScheduler {
	return &probeScheduler{
		name: name, interval: interval, jitter: 0.1,
		warmup:  interval / 5,
		tick:    10 * time.Second,
		refresh: time.Minute,
		list:    list, probe: probe, sem: sem, logger: logger,
		backoff:  newProbeBackoff(),
		now:      time.Now,
		rnd:      rand.Float64,
		next:     make(map[int64]time.Time),
		inflight: make(map[int64]bool),
	}
}

// Run blocks until ctx is cancelled.
func (s *probeScheduler) Run(ctx context.Context) {
	s.runOnce(ctx)
	ticker := time.NewTicker(s.tick)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			s.runOnce(ctx)
		}
	}
}

// runOnce reloads the server list if it is stale and starts a probe for every
// server that is due. It does not wait for the probes to finish.
func (s *probeScheduler) runOnce(ctx context.Context) {
	now := s.now()

	s.mu.Lock()
	stale := !s.loaded || now.Sub(s.refreshedAt) >= s.refresh
	s.mu.Unlock()
	if stale {
		servers, err := s.list(ctx)
		if err != nil {
			s.logger.Printf("%s: list servers: %v", s.name, err)
			// Keep working from the previous list; retry on the next tick.
		} else {
			s.mu.Lock()
			s.servers = servers
			s.loaded = true
			s.refreshedAt = now
			live := make(map[int64]bool, len(servers))
			for _, srv := range servers {
				live[srv.ID] = true
			}
			for id := range s.next {
				if !live[id] {
					delete(s.next, id)
				}
			}
			s.mu.Unlock()
			s.backoff.prune(live)
		}
	}

	s.mu.Lock()
	var due []store.Server
	for _, srv := range s.servers {
		when, seen := s.next[srv.ID]
		if !seen {
			s.next[srv.ID] = now.Add(time.Duration(s.rnd() * float64(s.warmup)))
			continue
		}
		if now.Before(when) || s.inflight[srv.ID] {
			continue
		}
		if !s.backoff.due(srv.ID) {
			continue // repeatedly unreachable — see probeBackoff
		}
		s.inflight[srv.ID] = true
		due = append(due, srv)
	}
	s.mu.Unlock()

	for _, srv := range due {
		srv := srv
		s.wg.Add(1)
		go func() {
			defer s.wg.Done()
			s.sem <- struct{}{}
			ok := s.probe(ctx, srv)
			<-s.sem
			s.backoff.record(srv.ID, ok, s.interval)

			s.mu.Lock()
			delete(s.inflight, srv.ID)
			// Measured from completion, with jitter around the interval.
			spread := (s.rnd()*2 - 1) * s.jitter
			s.next[srv.ID] = s.now().Add(time.Duration(float64(s.interval) * (1 + spread)))
			s.mu.Unlock()
		}()
	}
}

// wait blocks until every probe started so far has finished (tests).
func (s *probeScheduler) wait() { s.wg.Wait() }
