// Package store provides persistent storage for NiCon using an embedded
// bbolt database: the list of configured servers and the Nitrado API token.
package store

import (
	"encoding/json"
	"errors"
	"fmt"

	"go.etcd.io/bbolt"
)

var (
	bucketServers = []byte("servers")
	bucketConfig  = []byte("config")

	keyNitradoToken = []byte("nitrado_token")
)

// ErrNotFound is returned when a requested server does not exist.
var ErrNotFound = errors.New("server not found")

// Server is a single RCON-controllable game server.
type Server struct {
	ID               string `json:"id"`
	Name             string `json:"name"`
	Host             string `json:"host"`
	Port             int    `json:"port"`
	Password         string `json:"password"`
	Source           string `json:"source"` // "manual" or "nitrado"
	Game             string `json:"game,omitempty"`
	NitradoServiceID int    `json:"nitrado_service_id,omitempty"`
}

type Store struct {
	db *bbolt.DB
}

func Open(path string) (*Store, error) {
	db, err := bbolt.Open(path, 0o600, nil)
	if err != nil {
		return nil, fmt.Errorf("open database: %w", err)
	}
	err = db.Update(func(tx *bbolt.Tx) error {
		if _, err := tx.CreateBucketIfNotExists(bucketServers); err != nil {
			return err
		}
		if _, err := tx.CreateBucketIfNotExists(bucketConfig); err != nil {
			return err
		}
		return nil
	})
	if err != nil {
		db.Close()
		return nil, fmt.Errorf("init buckets: %w", err)
	}
	return &Store{db: db}, nil
}

func (s *Store) Close() error {
	return s.db.Close()
}

func (s *Store) ListServers() ([]Server, error) {
	var servers []Server
	err := s.db.View(func(tx *bbolt.Tx) error {
		return tx.Bucket(bucketServers).ForEach(func(k, v []byte) error {
			var srv Server
			if err := json.Unmarshal(v, &srv); err != nil {
				return err
			}
			servers = append(servers, srv)
			return nil
		})
	})
	return servers, err
}

func (s *Store) GetServer(id string) (Server, error) {
	var srv Server
	err := s.db.View(func(tx *bbolt.Tx) error {
		v := tx.Bucket(bucketServers).Get([]byte(id))
		if v == nil {
			return ErrNotFound
		}
		return json.Unmarshal(v, &srv)
	})
	return srv, err
}

func (s *Store) PutServer(srv Server) error {
	data, err := json.Marshal(srv)
	if err != nil {
		return err
	}
	return s.db.Update(func(tx *bbolt.Tx) error {
		return tx.Bucket(bucketServers).Put([]byte(srv.ID), data)
	})
}

func (s *Store) DeleteServer(id string) error {
	return s.db.Update(func(tx *bbolt.Tx) error {
		return tx.Bucket(bucketServers).Delete([]byte(id))
	})
}

func (s *Store) GetNitradoToken() (string, error) {
	var token string
	err := s.db.View(func(tx *bbolt.Tx) error {
		token = string(tx.Bucket(bucketConfig).Get(keyNitradoToken))
		return nil
	})
	return token, err
}

func (s *Store) SetNitradoToken(token string) error {
	return s.db.Update(func(tx *bbolt.Tx) error {
		return tx.Bucket(bucketConfig).Put(keyNitradoToken, []byte(token))
	})
}
