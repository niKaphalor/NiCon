// Package store is NiCon's MariaDB-backed persistence: users, sessions, and
// each user's servers. Every server-scoped query is parameterized by the
// caller's user_id, so cross-user access is enforced by the query itself,
// not by anything the caller has to remember to check. RCON passwords are
// encrypted at rest (see crypto.go); everything else is plain columns.
package store

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"errors"
	"fmt"
	"time"

	mysqldriver "github.com/go-sql-driver/mysql"
)

var (
	ErrNotFound      = errors.New("not found")
	ErrUsernameTaken = errors.New("username already taken")
)

// mysqlDuplicateEntry is MariaDB/MySQL's error number for a UNIQUE
// constraint violation (ER_DUP_ENTRY).
const mysqlDuplicateEntry = 1062

const schema = `
CREATE TABLE IF NOT EXISTS users (
	id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
	username VARCHAR(64) NOT NULL UNIQUE,
	password_hash VARCHAR(255) NOT NULL,
	recovery_code_hash VARCHAR(255) NULL,
	is_admin BOOLEAN NOT NULL DEFAULT FALSE,
	created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS sessions (
	token CHAR(64) PRIMARY KEY,
	user_id INT UNSIGNED NOT NULL,
	created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
	expires_at TIMESTAMP NOT NULL,
	FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS servers (
	id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
	user_id INT UNSIGNED NOT NULL,
	name VARCHAR(255) NOT NULL,
	host VARCHAR(255) NOT NULL,
	port INT UNSIGNED NOT NULL,
	password_enc VARBINARY(512) NULL,
	protocol VARCHAR(16) NOT NULL DEFAULT 'source',
	game VARCHAR(255) NOT NULL DEFAULT '',
	source VARCHAR(16) NOT NULL DEFAULT 'manual',
	nitrado_service_id INT UNSIGNED NULL,
	created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
	updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
	FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
	UNIQUE KEY uniq_user_nitrado_service (user_id, nitrado_service_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
`

// migrations covers columns added after a table's initial CREATE TABLE IF
// NOT EXISTS, so an existing installation picks them up too. Each statement
// must be safe to run every time the relay starts (IF NOT EXISTS or
// equivalent) since there's no migration-version tracking — just an
// idempotent list applied in order.
var migrations = []string{
	`ALTER TABLE users ADD COLUMN IF NOT EXISTS recovery_code_hash VARCHAR(255) NULL`,
	`ALTER TABLE users ADD COLUMN IF NOT EXISTS is_admin BOOLEAN NOT NULL DEFAULT FALSE`,
}

type Store struct {
	db  *sql.DB
	enc *encryptor
}

// Open connects to MariaDB/MySQL at dsn and ensures the schema exists.
// encryptionKey must be exactly EncryptionKeySize bytes (see
// DecodeEncryptionKey / GenerateEncryptionKey).
func Open(dsn string, encryptionKey []byte) (*Store, error) {
	enc, err := newEncryptor(encryptionKey)
	if err != nil {
		return nil, err
	}

	db, err := sql.Open("mysql", dsn)
	if err != nil {
		return nil, fmt.Errorf("open database: %w", err)
	}
	if err := db.Ping(); err != nil {
		db.Close()
		return nil, fmt.Errorf("ping database: %w", err)
	}

	for _, stmt := range splitSchema(schema) {
		if _, err := db.Exec(stmt); err != nil {
			db.Close()
			return nil, fmt.Errorf("migrate schema: %w", err)
		}
	}
	for _, stmt := range migrations {
		if _, err := db.Exec(stmt); err != nil {
			db.Close()
			return nil, fmt.Errorf("run migration %q: %w", stmt, err)
		}
	}

	return &Store{db: db, enc: enc}, nil
}

func (s *Store) Close() error {
	return s.db.Close()
}

// splitSchema splits the schema constant on ";\n" so each CREATE TABLE runs
// as its own statement (the mysql driver doesn't run multi-statement
// strings by default, which is the safer default).
func splitSchema(schema string) []string {
	var stmts []string
	var cur string
	for _, line := range splitLines(schema) {
		cur += line + "\n"
		if len(line) > 0 && line[len(line)-1] == ';' {
			stmts = append(stmts, cur)
			cur = ""
		}
	}
	return stmts
}

func splitLines(s string) []string {
	var lines []string
	start := 0
	for i := 0; i < len(s); i++ {
		if s[i] == '\n' {
			lines = append(lines, s[start:i])
			start = i + 1
		}
	}
	if start < len(s) {
		lines = append(lines, s[start:])
	}
	return lines
}

// --- users ---

type User struct {
	ID               int64
	Username         string
	PasswordHash     string
	RecoveryCodeHash string
	IsAdmin          bool
}

// AdminUserSummary is what the admin panel lists: enough to identify an
// account and gauge its size without exposing anything sensitive (no
// password/recovery-code hashes, no server details).
type AdminUserSummary struct {
	ID          int64
	Username    string
	CreatedAt   time.Time
	IsAdmin     bool
	ServerCount int
}

// CreateUser inserts a new account. recoveryCodeHash is the bcrypt hash of
// its one-time recovery code (see internal/auth) — the only self-service
// path back into an account whose password is forgotten.
func (s *Store) CreateUser(ctx context.Context, username, passwordHash, recoveryCodeHash string) (int64, error) {
	res, err := s.db.ExecContext(ctx,
		`INSERT INTO users (username, password_hash, recovery_code_hash) VALUES (?, ?, ?)`,
		username, passwordHash, recoveryCodeHash)
	if err != nil {
		var mysqlErr *mysqldriver.MySQLError
		if errors.As(err, &mysqlErr) && mysqlErr.Number == mysqlDuplicateEntry {
			return 0, ErrUsernameTaken
		}
		return 0, err
	}
	return res.LastInsertId()
}

// ResetPassword replaces a user's password and recovery code together (the
// old recovery code is single-use — a successful reset always issues a new
// one) and invalidates every existing session, in one transaction.
func (s *Store) ResetPassword(ctx context.Context, userID int64, newPasswordHash, newRecoveryCodeHash string) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()

	res, err := tx.ExecContext(ctx,
		`UPDATE users SET password_hash = ?, recovery_code_hash = ? WHERE id = ?`,
		newPasswordHash, newRecoveryCodeHash, userID)
	if err != nil {
		return err
	}
	if err := checkAffected(res); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `DELETE FROM sessions WHERE user_id = ?`, userID); err != nil {
		return err
	}
	return tx.Commit()
}

// DeleteUser removes a user account. Their sessions and servers are removed
// along with it via ON DELETE CASCADE — this is the one place account data
// actually gets erased (the self-service "delete my account" path).
func (s *Store) DeleteUser(ctx context.Context, userID int64) error {
	res, err := s.db.ExecContext(ctx, `DELETE FROM users WHERE id = ?`, userID)
	if err != nil {
		return err
	}
	return checkAffected(res)
}

func (s *Store) GetUserByUsername(ctx context.Context, username string) (*User, error) {
	var u User
	var recoveryCodeHash sql.NullString
	err := s.db.QueryRowContext(ctx,
		`SELECT id, username, password_hash, recovery_code_hash, is_admin FROM users WHERE username = ?`, username,
	).Scan(&u.ID, &u.Username, &u.PasswordHash, &recoveryCodeHash, &u.IsAdmin)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	u.RecoveryCodeHash = recoveryCodeHash.String
	return &u, nil
}

func (s *Store) GetUserByID(ctx context.Context, id int64) (*User, error) {
	var u User
	var recoveryCodeHash sql.NullString
	err := s.db.QueryRowContext(ctx,
		`SELECT id, username, password_hash, recovery_code_hash, is_admin FROM users WHERE id = ?`, id,
	).Scan(&u.ID, &u.Username, &u.PasswordHash, &recoveryCodeHash, &u.IsAdmin)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	u.RecoveryCodeHash = recoveryCodeHash.String
	return &u, nil
}

// SetAdmin grants or revokes admin status. Deliberately not reachable from
// any HTTP endpoint — the only way to create the first admin (or any
// other) is the `setadmin` CLI command, run by whoever already has
// operator-level access to the relay's host and database.
func (s *Store) SetAdmin(ctx context.Context, userID int64, isAdmin bool) error {
	res, err := s.db.ExecContext(ctx, `UPDATE users SET is_admin = ? WHERE id = ?`, isAdmin, userID)
	if err != nil {
		return err
	}
	return checkAffected(res)
}

// SetRecoveryCodeHash replaces a user's recovery code hash without
// touching their password — used by the `gen-recovery-code` CLI command
// and by an admin regenerating a code for a user who's lost theirs.
func (s *Store) SetRecoveryCodeHash(ctx context.Context, userID int64, recoveryCodeHash string) error {
	res, err := s.db.ExecContext(ctx, `UPDATE users SET recovery_code_hash = ? WHERE id = ?`, recoveryCodeHash, userID)
	if err != nil {
		return err
	}
	return checkAffected(res)
}

// ListUsers returns every account on the relay for the admin panel, each
// with its stored server count, newest first.
func (s *Store) ListUsers(ctx context.Context) ([]AdminUserSummary, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT u.id, u.username, u.created_at, u.is_admin, COUNT(s.id)
		FROM users u
		LEFT JOIN servers s ON s.user_id = u.id
		GROUP BY u.id, u.username, u.created_at, u.is_admin
		ORDER BY u.created_at DESC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var out []AdminUserSummary
	for rows.Next() {
		var u AdminUserSummary
		if err := rows.Scan(&u.ID, &u.Username, &u.CreatedAt, &u.IsAdmin, &u.ServerCount); err != nil {
			return nil, err
		}
		out = append(out, u)
	}
	return out, rows.Err()
}

// --- sessions ---

// hashToken is what's actually stored in and looked up against
// sessions.token. The session token is a 256-bit random value handed to
// the browser and sent back on every authenticated request — functionally
// a bearer credential — so it's hashed at rest the same way a password
// would be, rather than kept as a plaintext column anyone with read
// access to the database (a backup, a misconfigured admin tool, an
// injection bug elsewhere) could use directly. A fast unsalted hash is
// fine here, unlike a password hash: the input is already 256 bits of
// randomness, not something guessable to speed up an offline attack
// against. Mirrors webspace/lib/crypto.php's nicon_hash_token — both
// sides must produce the same digest for a token created by one to
// authenticate against the other. SHA-256's 32-byte digest hex-encodes to
// 64 characters, fitting the existing `sessions.token CHAR(64)` column
// exactly, so no schema change is needed.
func hashToken(token string) string {
	sum := sha256.Sum256([]byte(token))
	return hex.EncodeToString(sum[:])
}

func (s *Store) CreateSession(ctx context.Context, token string, userID int64, ttlSeconds int) error {
	_, err := s.db.ExecContext(ctx,
		`INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, DATE_ADD(NOW(), INTERVAL ? SECOND))`,
		hashToken(token), userID, ttlSeconds)
	return err
}

// SessionUserID returns the user ID for a still-valid session token.
func (s *Store) SessionUserID(ctx context.Context, token string) (int64, error) {
	var userID int64
	err := s.db.QueryRowContext(ctx,
		`SELECT user_id FROM sessions WHERE token = ? AND expires_at > NOW()`, hashToken(token),
	).Scan(&userID)
	if errors.Is(err, sql.ErrNoRows) {
		return 0, ErrNotFound
	}
	return userID, err
}

func (s *Store) DeleteSession(ctx context.Context, token string) error {
	_, err := s.db.ExecContext(ctx, `DELETE FROM sessions WHERE token = ?`, hashToken(token))
	return err
}

// CleanupExpired deletes sessions whose expiry has already passed and
// reports how many rows were removed. Not needed for correctness — every
// query above already checks expires_at > NOW(), so an expired row is
// never usable — this only reclaims storage so the table doesn't grow
// unbounded from tokens whose owner never explicitly logged out. Called
// periodically from main.go's runServer, since the relay is the one
// long-running process here.
func (s *Store) CleanupExpired(ctx context.Context) (int64, error) {
	res, err := s.db.ExecContext(ctx, `DELETE FROM sessions WHERE expires_at <= NOW()`)
	if err != nil {
		return 0, err
	}
	return res.RowsAffected()
}

// --- servers ---

type Server struct {
	ID               int64
	UserID           int64
	Name             string
	Host             string
	Port             int
	Password         string // decrypted; empty means "not set yet"
	Protocol         string
	Game             string
	Source           string
	NitradoServiceID *int64
}

func (s *Store) ListServers(ctx context.Context, userID int64) ([]Server, error) {
	rows, err := s.db.QueryContext(ctx,
		`SELECT id, user_id, name, host, port, password_enc, protocol, game, source, nitrado_service_id
		 FROM servers WHERE user_id = ? ORDER BY name`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var out []Server
	for rows.Next() {
		srv, err := s.scanServer(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, srv)
	}
	return out, rows.Err()
}

// GetServer returns a server only if it belongs to userID; a server owned
// by someone else looks identical to a nonexistent one to the caller.
func (s *Store) GetServer(ctx context.Context, userID, serverID int64) (*Server, error) {
	row := s.db.QueryRowContext(ctx,
		`SELECT id, user_id, name, host, port, password_enc, protocol, game, source, nitrado_service_id
		 FROM servers WHERE id = ? AND user_id = ?`, serverID, userID)
	srv, err := s.scanServer(row)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	return &srv, nil
}

type scannable interface {
	Scan(dest ...any) error
}

func (s *Store) scanServer(row scannable) (Server, error) {
	var srv Server
	var passwordEnc []byte
	if err := row.Scan(
		&srv.ID, &srv.UserID, &srv.Name, &srv.Host, &srv.Port, &passwordEnc,
		&srv.Protocol, &srv.Game, &srv.Source, &srv.NitradoServiceID,
	); err != nil {
		return Server{}, err
	}
	if len(passwordEnc) > 0 {
		password, err := s.enc.Decrypt(passwordEnc)
		if err != nil {
			return Server{}, fmt.Errorf("decrypt password for server %d: %w", srv.ID, err)
		}
		srv.Password = password
	}
	return srv, nil
}

// CreateServer inserts a new server for srv.UserID and returns its ID.
func (s *Store) CreateServer(ctx context.Context, srv Server) (int64, error) {
	passwordEnc, err := s.encryptPasswordOrNil(srv.Password)
	if err != nil {
		return 0, err
	}
	res, err := s.db.ExecContext(ctx,
		`INSERT INTO servers (user_id, name, host, port, password_enc, protocol, game, source, nitrado_service_id)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		srv.UserID, srv.Name, srv.Host, srv.Port, passwordEnc, srv.Protocol, srv.Game, srv.Source, srv.NitradoServiceID)
	if err != nil {
		return 0, err
	}
	return res.LastInsertId()
}

// UpsertNitradoServer inserts or updates a server synced from Nitrado,
// matched on (user_id, nitrado_service_id). An existing row's password is
// preserved (Nitrado never gives us one to overwrite it with).
func (s *Store) UpsertNitradoServer(ctx context.Context, srv Server) error {
	_, err := s.db.ExecContext(ctx,
		`INSERT INTO servers (user_id, name, host, port, protocol, game, source, nitrado_service_id)
		 VALUES (?, ?, ?, ?, ?, ?, 'nitrado', ?)
		 ON DUPLICATE KEY UPDATE name = VALUES(name), host = VALUES(host), port = VALUES(port),
		   protocol = VALUES(protocol), game = VALUES(game)`,
		srv.UserID, srv.Name, srv.Host, srv.Port, srv.Protocol, srv.Game, srv.NitradoServiceID)
	return err
}

// UpdateServerPassword sets a server's RCON password; a no-op (returns
// ErrNotFound) if the server doesn't belong to userID.
func (s *Store) UpdateServerPassword(ctx context.Context, userID, serverID int64, password string) error {
	passwordEnc, err := s.encryptPasswordOrNil(password)
	if err != nil {
		return err
	}
	res, err := s.db.ExecContext(ctx,
		`UPDATE servers SET password_enc = ? WHERE id = ? AND user_id = ?`, passwordEnc, serverID, userID)
	if err != nil {
		return err
	}
	return checkAffected(res)
}

// DeleteServer removes a server; a no-op (returns ErrNotFound) if it
// doesn't belong to userID.
func (s *Store) DeleteServer(ctx context.Context, userID, serverID int64) error {
	res, err := s.db.ExecContext(ctx, `DELETE FROM servers WHERE id = ? AND user_id = ?`, serverID, userID)
	if err != nil {
		return err
	}
	return checkAffected(res)
}

func checkAffected(res sql.Result) error {
	n, err := res.RowsAffected()
	if err != nil {
		return err
	}
	if n == 0 {
		return ErrNotFound
	}
	return nil
}

func (s *Store) encryptPasswordOrNil(password string) ([]byte, error) {
	if password == "" {
		return nil, nil
	}
	return s.enc.Encrypt(password)
}
