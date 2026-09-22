// Package rconmgr manages one pooled RCON connection per server, connecting
// lazily on first use and reconnecting once on a failed command before
// giving up.
package rconmgr

import (
	"fmt"
	"sync"

	"github.com/gorcon/rcon"
)

type Manager struct {
	mu    sync.Mutex
	conns map[string]*rcon.Conn
}

func New() *Manager {
	return &Manager{conns: make(map[string]*rcon.Conn)}
}

// Execute sends a single RCON command to the server identified by id,
// connecting (or reconnecting) as needed. address is "host:port".
func (m *Manager) Execute(id, address, password, command string) (string, error) {
	m.mu.Lock()
	defer m.mu.Unlock()

	conn, ok := m.conns[id]
	if !ok {
		var err error
		conn, err = rcon.Dial(address, password)
		if err != nil {
			return "", fmt.Errorf("connect: %w", err)
		}
		m.conns[id] = conn
	}

	response, err := conn.Execute(command)
	if err != nil {
		// The pooled connection may have gone stale; reconnect once and retry.
		conn.Close()
		delete(m.conns, id)

		conn, dialErr := rcon.Dial(address, password)
		if dialErr != nil {
			return "", fmt.Errorf("reconnect: %w", dialErr)
		}
		m.conns[id] = conn

		response, err = conn.Execute(command)
		if err != nil {
			return "", fmt.Errorf("execute: %w", err)
		}
	}
	return response, nil
}

// Close closes and forgets any pooled connection for id.
func (m *Manager) Close(id string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if conn, ok := m.conns[id]; ok {
		conn.Close()
		delete(m.conns, id)
	}
}

// CloseAll closes every pooled connection.
func (m *Manager) CloseAll() {
	m.mu.Lock()
	defer m.mu.Unlock()
	for id, conn := range m.conns {
		conn.Close()
		delete(m.conns, id)
	}
}
