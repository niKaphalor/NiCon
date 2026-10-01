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

// MaxOpenConns is this Store's connection pool ceiling — see Open's own
// comment for the reasoning behind having one at all. It's exported so
// main.go's healthCheckConcurrency can be defined relative to it rather
// than as an independently-chosen number.
const MaxOpenConns = 25

type Store struct {
	db  *sql.DB
	enc *KeyRing
}

// RCONAuditRecord is the durable, cross-server record of an operator command.
// Username and ServerName are snapshots so the audit trail remains readable
// after the associated account or server profile is deleted.
type RCONAuditRecord struct {
	ID              int64
	UserID          int64
	ServerID        int64
	Username        string
	ServerName      string
	Command         string
	Action          string
	TargetPlayer    string
	Origin          string
	Result          string
	Success         bool
	UpstreamMs      float64
	RelayOverheadMs float64
	CreatedAt       time.Time
}

// Open connects to MariaDB/MySQL at dsn and ensures the schema exists.
// encryptionKey must be exactly EncryptionKeySize bytes (see
// DecodeEncryptionKey / GenerateEncryptionKey).
func Open(dsn string, encryptionKey []byte) (*Store, error) {
	ring, err := newSingleKeyRing(encryptionKey)
	if err != nil {
		return nil, err
	}
	return OpenWithKeyRing(dsn, ring)
}

// OpenWithKeyRing is Open with a full key ring (key rotation, format v2).
func OpenWithKeyRing(dsn string, enc *KeyRing) (*Store, error) {
	db, err := sql.Open("mysql", dsn)
	if err != nil {
		return nil, fmt.Errorf("open database: %w", err)
	}
	// Unbounded by default (Go's own default MaxIdleConns is just 2), and
	// the relay now runs two independent 5-minute background loops on top
	// of ordinary foreground WS command traffic (see main.go's
	// runHealthChecks/runPublicInfoChecks) — a burst of concurrent
	// goroutines each doing one write routinely exceeds an idle pool of 2,
	// so connections get closed and re-opened (fresh TCP+auth) every burst
	// instead of reused. These bounds keep both worst-case open connections
	// and idle-churn in check without needing to be exact.
	//
	// MaxOpenConns is exported specifically so main.go's healthCheckConcurrency
	// can be defined as a fraction of it instead of as its own independent
	// number — the two used to be sized coincidentally (25 here, 5 there,
	// with nothing tying them together), so raising one without the other
	// could silently starve this pool once server counts grow. Deriving
	// keeps that relationship enforced by the compiler instead of by
	// whoever happens to remember to check both places.
	db.SetMaxOpenConns(MaxOpenConns)
	db.SetMaxIdleConns(10)
	db.SetConnMaxLifetime(5 * time.Minute)
	if err := db.Ping(); err != nil {
		db.Close()
		return nil, fmt.Errorf("ping database: %w", err)
	}

	if err := migrate(db); err != nil {
		db.Close()
		return nil, fmt.Errorf("migrate schema: %w", err)
	}

	return &Store{db: db, enc: enc}, nil
}

func (s *Store) Close() error {
	return s.db.Close()
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
	QueryProtocol    string
	QueryPort        *int
	Game             string
	Source           string
	NitradoServiceID *int64
	// UseTLS connects over TLS (wss / https) for the protocols that support it
	// (WebRCON, BattleBit, Palworld REST); certificates are always verified.
	UseTLS bool
}

func (s *Store) ListServers(ctx context.Context, userID int64) ([]Server, error) {
	rows, err := s.db.QueryContext(ctx,
		`SELECT id, user_id, name, host, port, password_enc, protocol, query_protocol, query_port, game, source, nitrado_service_id, use_tls
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
		`SELECT id, user_id, name, host, port, password_enc, protocol, query_protocol, query_port, game, source, nitrado_service_id, use_tls
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
	var queryPort sql.NullInt64
	if err := row.Scan(
		&srv.ID, &srv.UserID, &srv.Name, &srv.Host, &srv.Port, &passwordEnc,
		&srv.Protocol, &srv.QueryProtocol, &queryPort, &srv.Game, &srv.Source, &srv.NitradoServiceID, &srv.UseTLS,
	); err != nil {
		return Server{}, err
	}
	if queryPort.Valid {
		port := int(queryPort.Int64)
		srv.QueryPort = &port
	}
	if len(passwordEnc) > 0 {
		password, err := s.enc.Decrypt(passwordEnc, ServerPasswordAAD(srv.UserID, srv.ID))
		if err != nil {
			return Server{}, fmt.Errorf("decrypt password for server %d: %w", srv.ID, err)
		}
		srv.Password = password
	}
	return srv, nil
}

// CreateServer inserts a new server for srv.UserID and returns its ID.
func (s *Store) CreateServer(ctx context.Context, srv Server) (int64, error) {
	if srv.QueryProtocol == "" {
		srv.QueryProtocol = "auto"
	}
	// In format v2 the ciphertext is bound to the server's ID, which only
	// exists after the INSERT — so insert first, then store the password in
	// the same transaction. (The legacy format needs no ID.)
	insertPassword := srv.Password
	if s.enc.WritesV2() {
		insertPassword = ""
	}
	passwordEnc, err := s.encryptOrNil(insertPassword, "")
	if err != nil {
		return 0, err
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return 0, err
	}
	defer tx.Rollback()
	res, err := tx.ExecContext(ctx,
		`INSERT INTO servers (user_id, name, host, port, password_enc, protocol, query_protocol, query_port, game, source, nitrado_service_id, use_tls)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		srv.UserID, srv.Name, srv.Host, srv.Port, passwordEnc, srv.Protocol, srv.QueryProtocol, srv.QueryPort, srv.Game, srv.Source, srv.NitradoServiceID, srv.UseTLS)
	if err != nil {
		return 0, err
	}
	id, err := res.LastInsertId()
	if err != nil {
		return 0, err
	}
	if s.enc.WritesV2() && srv.Password != "" {
		sealed, err := s.encryptOrNil(srv.Password, ServerPasswordAAD(srv.UserID, id))
		if err != nil {
			return 0, err
		}
		if _, err := tx.ExecContext(ctx, `UPDATE servers SET password_enc = ? WHERE id = ?`, sealed, id); err != nil {
			return 0, err
		}
	}
	return id, tx.Commit()
}

// UpsertNitradoServer inserts or updates a server synced from Nitrado,
// matched on (user_id, nitrado_service_id). An existing row's password is
// preserved (Nitrado never gives us one to overwrite it with).
func (s *Store) UpsertNitradoServer(ctx context.Context, srv Server) error {
	if srv.QueryProtocol == "" {
		srv.QueryProtocol = "auto"
	}
	_, err := s.db.ExecContext(ctx,
		`INSERT INTO servers (user_id, name, host, port, protocol, query_protocol, query_port, game, source, nitrado_service_id)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'nitrado', ?)
		 ON DUPLICATE KEY UPDATE name = VALUES(name), host = VALUES(host), port = VALUES(port),
		   protocol = VALUES(protocol), query_protocol = VALUES(query_protocol), query_port = VALUES(query_port), game = VALUES(game)`,
		srv.UserID, srv.Name, srv.Host, srv.Port, srv.Protocol, srv.QueryProtocol, srv.QueryPort, srv.Game, srv.NitradoServiceID)
	return err
}

// UpdateServerPassword sets a server's RCON password; a no-op (returns
// ErrNotFound) if the server doesn't belong to userID.
func (s *Store) UpdateServerPassword(ctx context.Context, userID, serverID int64, password string) error {
	passwordEnc, err := s.encryptOrNil(password, ServerPasswordAAD(userID, serverID))
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

// ListServersForHealthCheck returns every server (across every user) that
// has a password set — the only ones actually connectable — for the
// periodic health-check loop in main.go. Unlike ListServers, this isn't
// scoped to one user: it's a maintenance job over the whole table, not a
// per-request query.
func (s *Store) ListServersForHealthCheck(ctx context.Context) ([]Server, error) {
	rows, err := s.db.QueryContext(ctx,
		`SELECT id, user_id, name, host, port, password_enc, protocol, query_protocol, query_port, game, source, nitrado_service_id, use_tls
		 FROM servers WHERE password_enc IS NOT NULL`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var out []Server
	for rows.Next() {
		srv, err := s.scanServer(rows)
		if err != nil {
			// One server's password failing to decrypt (corrupt data, a
			// key mismatch) shouldn't stop every other server from being
			// checked — skip just this one and keep going. Unlike
			// GetServer/ListServers, where a decrypt failure is the
			// caller's own data right now and worth surfacing as an
			// error, this is a maintenance sweep over everyone's
			// servers — best-effort is the right default here.
			continue
		}
		out = append(out, srv)
	}
	return out, rows.Err()
}

// ListServersForPublicInfoCheck returns every server (across every user)
// whose independent query configuration supports a passive,
// unauthenticated status query (see internal/relay's
// QueryA2SInfo/QueryMinecraftStat and main.go's public-info loop).
// Unlike ListServersForHealthCheck, a stored RCON password is irrelevant
// here: the whole point is populating player/uptime history for servers
// that don't have one yet.
func (s *Store) ListServersForPublicInfoCheck(ctx context.Context) ([]Server, error) {
	rows, err := s.db.QueryContext(ctx,
		`SELECT id, user_id, name, host, port, password_enc, protocol, query_protocol, query_port, game, source, nitrado_service_id, use_tls
		 FROM servers
		 WHERE query_protocol IN ('a2s', 'minecraft')
		    OR (query_protocol = 'auto' AND (protocol = 'source' OR game = 'Minecraft'))`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var out []Server
	for rows.Next() {
		srv, err := s.scanServer(rows)
		if err != nil {
			continue // best-effort maintenance sweep — see ListServersForHealthCheck
		}
		out = append(out, srv)
	}
	return out, rows.Err()
}

// UpdateServerPlayerSample records one passive, unauthenticated status
// probe (A2S or Minecraft Query — see internal/relay's PublicInfoCheck and
// main.go's public-info loop) into the same history table
// UpdateServerHealth uses, under its own source label so a failed probe
// can't be confused with a real RCON health-check failure. Unlike
// UpdateServerHealth, this never touches servers.health_* — that column
// set means "the last real RCON connect attempt," which sits alongside,
// not underneath, "is this server's public query port reachable."
// playerCurrent/playerMax are nil (stored as SQL NULL) when online is
// false, matching UpdateServerHealth's own handling of a failed check.
func (s *Store) UpdateServerPlayerSample(ctx context.Context, serverID int64, online bool, playerCurrent, playerMax *int, source string) error {
	_, err := s.db.ExecContext(ctx,
		`INSERT INTO server_health_samples (server_id, online, player_current, player_max, source) VALUES (?, ?, ?, ?, ?)`,
		serverID, online, playerCurrent, playerMax, source)
	return err
}

// RecordRCONAudit persists an operator-visible command outcome. Output is
// bounded before insertion so a game server cannot turn one response into an
// unbounded audit row. The command itself is already capped by the relay.
func (s *Store) RecordRCONAudit(ctx context.Context, record RCONAuditRecord) error {
	record.Action = truncateRunes(record.Action, 64)
	record.TargetPlayer = truncateRunes(record.TargetPlayer, 255)
	record.Origin = truncateRunes(record.Origin, 32)
	record.Result = truncateRunes(record.Result, 4000)
	if record.Action == "" {
		record.Action = "command"
	}
	if record.Origin == "" {
		record.Origin = "manual"
	}
	_, err := s.db.ExecContext(ctx, `
		INSERT INTO rcon_audit_log
			(user_id, server_id, username, server_name, command, action, target_player, origin, result, success, upstream_ms, relay_overhead_ms)
		SELECT ?, ?, username, ?, ?, ?, NULLIF(?, ''), ?, NULLIF(?, ''), ?, ?, ?
		FROM users WHERE id = ?`,
		record.UserID, record.ServerID, truncateRunes(record.ServerName, 255), record.Command,
		record.Action, record.TargetPlayer, record.Origin, record.Result, record.Success,
		record.UpstreamMs, record.RelayOverheadMs, record.UserID)
	return err
}

// ListRCONAudit is used by integration tests and administrative tooling. The
// browser-facing API reads the same table from PHP so it can merge account and
// command events into one timeline.
func (s *Store) ListRCONAudit(ctx context.Context, userID int64, limit int) ([]RCONAuditRecord, error) {
	if limit < 1 || limit > 500 {
		limit = 100
	}
	rows, err := s.db.QueryContext(ctx, `
		SELECT id, COALESCE(user_id, 0), COALESCE(server_id, 0), username, server_name,
		       command, action, COALESCE(target_player, ''), origin, COALESCE(result, ''),
		       success, COALESCE(upstream_ms, 0), COALESCE(relay_overhead_ms, 0), created_at
		FROM rcon_audit_log WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT ?`, userID, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var records []RCONAuditRecord
	for rows.Next() {
		var record RCONAuditRecord
		if err := rows.Scan(&record.ID, &record.UserID, &record.ServerID, &record.Username, &record.ServerName,
			&record.Command, &record.Action, &record.TargetPlayer, &record.Origin, &record.Result,
			&record.Success, &record.UpstreamMs, &record.RelayOverheadMs, &record.CreatedAt); err != nil {
			return nil, err
		}
		records = append(records, record)
	}
	return records, rows.Err()
}

func truncateRunes(value string, max int) string {
	runes := []rune(value)
	if len(runes) <= max {
		return value
	}
	return string(runes[:max])
}

// UpdateServerHealth records the outcome of one periodic health check (a
// real RCON connect attempt, not just a TCP reachability check — see
// main.go's runHealthChecks). errMsg is ignored when ok is true;
// latencyMs is ignored (stored NULL) when ok is false, since a failed
// connect didn't produce a meaningful round-trip time.
func (s *Store) UpdateServerHealth(ctx context.Context, serverID int64, ok bool, latencyMs int, errMsg string) error {
	var latencyCol, errCol any
	if ok {
		latencyCol = latencyMs
	} else if errMsg != "" {
		errCol = errMsg
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err = tx.ExecContext(ctx,
		`UPDATE servers SET health_checked_at = NOW(), health_ok = ?, health_latency_ms = ?, health_error = ? WHERE id = ?`,
		ok, latencyCol, errCol, serverID); err != nil {
		return err
	}
	if _, err = tx.ExecContext(ctx,
		`INSERT INTO server_health_samples (server_id, online, latency_ms, source) VALUES (?, ?, ?, 'relay')`,
		serverID, ok, latencyCol); err != nil {
		return err
	}
	return tx.Commit()
}

// CleanupHealthSamples keeps the detailed five-minute series bounded. Older
// samples are deliberately removed rather than silently growing forever.
func (s *Store) CleanupHealthSamples(ctx context.Context, retention time.Duration) (int64, error) {
	cutoff := time.Now().UTC().Add(-retention)
	res, err := s.db.ExecContext(ctx, `DELETE FROM server_health_samples WHERE sampled_at < ?`, cutoff)
	if err != nil {
		return 0, err
	}
	return res.RowsAffected()
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

// encryptOrNil seals a non-empty secret for the row named by aad; the empty
// string means "not set" and is stored as NULL.
func (s *Store) encryptOrNil(secret, aad string) ([]byte, error) {
	if secret == "" {
		return nil, nil
	}
	return s.enc.Encrypt(secret, aad)
}
