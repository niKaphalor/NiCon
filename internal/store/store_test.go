package store

import (
	"context"
	"database/sql"
	"errors"
	"os"
	"strconv"
	"sync/atomic"
	"testing"
	"time"
)

// These are integration tests against a real MariaDB/MySQL instance — the
// schema uses server-side features (AUTO_INCREMENT, ON DUPLICATE KEY
// UPDATE, foreign keys) that don't have a meaningful pure-Go substitute.
// Set NICON_TEST_DB_DSN to a database dedicated to testing (never a
// database holding real accounts) to run them; they're skipped otherwise,
// including in CI unless a MariaDB service is configured.
func testDSN(t *testing.T) string {
	t.Helper()
	dsn := os.Getenv("NICON_TEST_DB_DSN")
	if dsn == "" {
		t.Skip("NICON_TEST_DB_DSN not set; skipping store integration test")
	}
	return dsn
}

func openTestStore(t *testing.T) *Store {
	t.Helper()
	dsn := testDSN(t)

	key := make([]byte, EncryptionKeySize)
	for i := range key {
		key[i] = byte(i)
	}
	st, err := Open(dsn, key)
	if err != nil {
		t.Fatalf("open test store: %v", err)
	}
	t.Cleanup(func() { st.Close() })
	return st
}

var usernameCounter int64

// uniqueUsername returns a username that won't collide with other tests
// or previous runs against the same shared test database.
func uniqueUsername(t *testing.T) string {
	t.Helper()
	n := atomic.AddInt64(&usernameCounter, 1)
	return "t_" + time.Now().Format("150405") + "_" + strconv.FormatInt(n, 10)
}

func mustCreateUser(t *testing.T, st *Store, username string) int64 {
	t.Helper()
	id, err := st.CreateUser(context.Background(), username, "hash-"+username, "recovery-hash-"+username)
	if err != nil {
		t.Fatalf("CreateUser(%q): %v", username, err)
	}
	return id
}

func TestCreateAndGetUser(t *testing.T) {
	st := openTestStore(t)
	ctx := context.Background()
	username := uniqueUsername(t)

	id := mustCreateUser(t, st, username)
	if id == 0 {
		t.Fatal("CreateUser returned id 0")
	}

	byUsername, err := st.GetUserByUsername(ctx, username)
	if err != nil {
		t.Fatalf("GetUserByUsername: %v", err)
	}
	if byUsername.ID != id || byUsername.Username != username {
		t.Errorf("GetUserByUsername = %+v, want id=%d username=%q", byUsername, id, username)
	}
	if byUsername.RecoveryCodeHash != "recovery-hash-"+username {
		t.Errorf("RecoveryCodeHash = %q, want %q", byUsername.RecoveryCodeHash, "recovery-hash-"+username)
	}
	if byUsername.IsAdmin {
		t.Error("newly created user is_admin = true, want false")
	}

	byID, err := st.GetUserByID(ctx, id)
	if err != nil {
		t.Fatalf("GetUserByID: %v", err)
	}
	if byID.Username != username {
		t.Errorf("GetUserByID username = %q, want %q", byID.Username, username)
	}
}

func TestGetUserNotFound(t *testing.T) {
	st := openTestStore(t)
	ctx := context.Background()

	if _, err := st.GetUserByUsername(ctx, "does-not-exist-"+uniqueUsername(t)); !errors.Is(err, ErrNotFound) {
		t.Errorf("GetUserByUsername for unknown user: err = %v, want ErrNotFound", err)
	}
	if _, err := st.GetUserByID(ctx, 99999999); !errors.Is(err, ErrNotFound) {
		t.Errorf("GetUserByID for unknown id: err = %v, want ErrNotFound", err)
	}
}

func TestCreateUserDuplicateUsername(t *testing.T) {
	st := openTestStore(t)
	ctx := context.Background()
	username := uniqueUsername(t)

	mustCreateUser(t, st, username)

	_, err := st.CreateUser(ctx, username, "another-hash", "another-recovery-hash")
	if !errors.Is(err, ErrUsernameTaken) {
		t.Fatalf("CreateUser with duplicate username: err = %v, want ErrUsernameTaken", err)
	}
}

func TestSessionsCreateLookupDelete(t *testing.T) {
	st := openTestStore(t)
	ctx := context.Background()
	userID := mustCreateUser(t, st, uniqueUsername(t))
	token := "session-token-" + uniqueUsername(t)

	if err := st.CreateSession(ctx, token, userID, 3600); err != nil {
		t.Fatalf("CreateSession: %v", err)
	}

	gotUserID, err := st.SessionUserID(ctx, token)
	if err != nil {
		t.Fatalf("SessionUserID: %v", err)
	}
	if gotUserID != userID {
		t.Errorf("SessionUserID = %d, want %d", gotUserID, userID)
	}

	if err := st.DeleteSession(ctx, token); err != nil {
		t.Fatalf("DeleteSession: %v", err)
	}
	if _, err := st.SessionUserID(ctx, token); !errors.Is(err, ErrNotFound) {
		t.Errorf("SessionUserID after delete: err = %v, want ErrNotFound", err)
	}
}

func TestSessionExpiry(t *testing.T) {
	st := openTestStore(t)
	ctx := context.Background()
	userID := mustCreateUser(t, st, uniqueUsername(t))
	token := "expired-session-" + uniqueUsername(t)

	// A negative TTL puts expires_at in the past immediately.
	if err := st.CreateSession(ctx, token, userID, -3600); err != nil {
		t.Fatalf("CreateSession: %v", err)
	}
	if _, err := st.SessionUserID(ctx, token); !errors.Is(err, ErrNotFound) {
		t.Errorf("SessionUserID for expired session: err = %v, want ErrNotFound", err)
	}
}

func TestResetPasswordRotatesCredentialsAndWipesSessions(t *testing.T) {
	st := openTestStore(t)
	ctx := context.Background()
	userID := mustCreateUser(t, st, uniqueUsername(t))
	token := "pre-reset-session-" + uniqueUsername(t)
	if err := st.CreateSession(ctx, token, userID, 3600); err != nil {
		t.Fatalf("CreateSession: %v", err)
	}

	if err := st.ResetPassword(ctx, userID, "new-password-hash", "new-recovery-hash"); err != nil {
		t.Fatalf("ResetPassword: %v", err)
	}

	u, err := st.GetUserByID(ctx, userID)
	if err != nil {
		t.Fatal(err)
	}
	if u.PasswordHash != "new-password-hash" {
		t.Errorf("PasswordHash = %q, want %q", u.PasswordHash, "new-password-hash")
	}
	if u.RecoveryCodeHash != "new-recovery-hash" {
		t.Errorf("RecoveryCodeHash = %q, want %q", u.RecoveryCodeHash, "new-recovery-hash")
	}

	if _, err := st.SessionUserID(ctx, token); !errors.Is(err, ErrNotFound) {
		t.Errorf("session survived ResetPassword: err = %v, want ErrNotFound", err)
	}
}

func TestResetPasswordUnknownUser(t *testing.T) {
	st := openTestStore(t)
	ctx := context.Background()

	if err := st.ResetPassword(ctx, 99999999, "hash", "recovery"); !errors.Is(err, ErrNotFound) {
		t.Errorf("ResetPassword for unknown user: err = %v, want ErrNotFound", err)
	}
}

func TestDeleteUserCascadesSessionsAndServers(t *testing.T) {
	st := openTestStore(t)
	ctx := context.Background()
	userID := mustCreateUser(t, st, uniqueUsername(t))

	token := "cascade-session-" + uniqueUsername(t)
	if err := st.CreateSession(ctx, token, userID, 3600); err != nil {
		t.Fatal(err)
	}
	serverID, err := st.CreateServer(ctx, Server{UserID: userID, Name: "s1", Host: "h", Port: 1, Protocol: "source"})
	if err != nil {
		t.Fatal(err)
	}

	if err := st.DeleteUser(ctx, userID); err != nil {
		t.Fatalf("DeleteUser: %v", err)
	}

	if _, err := st.GetUserByID(ctx, userID); !errors.Is(err, ErrNotFound) {
		t.Errorf("user survived DeleteUser: err = %v, want ErrNotFound", err)
	}
	if _, err := st.SessionUserID(ctx, token); !errors.Is(err, ErrNotFound) {
		t.Errorf("session survived DeleteUser (no cascade): err = %v, want ErrNotFound", err)
	}
	if _, err := st.GetServer(ctx, userID, serverID); !errors.Is(err, ErrNotFound) {
		t.Errorf("server survived DeleteUser (no cascade): err = %v, want ErrNotFound", err)
	}
}

func TestDeleteUserUnknown(t *testing.T) {
	st := openTestStore(t)
	if err := st.DeleteUser(context.Background(), 99999999); !errors.Is(err, ErrNotFound) {
		t.Errorf("DeleteUser for unknown id: err = %v, want ErrNotFound", err)
	}
}

func TestSetAdmin(t *testing.T) {
	st := openTestStore(t)
	ctx := context.Background()
	userID := mustCreateUser(t, st, uniqueUsername(t))

	if err := st.SetAdmin(ctx, userID, true); err != nil {
		t.Fatalf("SetAdmin(true): %v", err)
	}
	u, err := st.GetUserByID(ctx, userID)
	if err != nil {
		t.Fatal(err)
	}
	if !u.IsAdmin {
		t.Error("IsAdmin = false after SetAdmin(true)")
	}

	if err := st.SetAdmin(ctx, userID, false); err != nil {
		t.Fatalf("SetAdmin(false): %v", err)
	}
	u, err = st.GetUserByID(ctx, userID)
	if err != nil {
		t.Fatal(err)
	}
	if u.IsAdmin {
		t.Error("IsAdmin = true after SetAdmin(false)")
	}
}

func TestSetRecoveryCodeHashLeavesPasswordAlone(t *testing.T) {
	st := openTestStore(t)
	ctx := context.Background()
	username := uniqueUsername(t)
	userID := mustCreateUser(t, st, username)

	if err := st.SetRecoveryCodeHash(ctx, userID, "regenerated-hash"); err != nil {
		t.Fatalf("SetRecoveryCodeHash: %v", err)
	}
	u, err := st.GetUserByID(ctx, userID)
	if err != nil {
		t.Fatal(err)
	}
	if u.RecoveryCodeHash != "regenerated-hash" {
		t.Errorf("RecoveryCodeHash = %q, want %q", u.RecoveryCodeHash, "regenerated-hash")
	}
	if u.PasswordHash != "hash-"+username {
		t.Errorf("PasswordHash changed to %q, want unchanged %q", u.PasswordHash, "hash-"+username)
	}
}

func TestListUsersIncludesServerCount(t *testing.T) {
	st := openTestStore(t)
	ctx := context.Background()
	username := uniqueUsername(t)
	userID := mustCreateUser(t, st, username)

	if _, err := st.CreateServer(ctx, Server{UserID: userID, Name: "a", Host: "h", Port: 1, Protocol: "source"}); err != nil {
		t.Fatal(err)
	}
	if _, err := st.CreateServer(ctx, Server{UserID: userID, Name: "b", Host: "h", Port: 2, Protocol: "source"}); err != nil {
		t.Fatal(err)
	}

	users, err := st.ListUsers(ctx)
	if err != nil {
		t.Fatalf("ListUsers: %v", err)
	}
	var found *AdminUserSummary
	for i := range users {
		if users[i].Username == username {
			found = &users[i]
			break
		}
	}
	if found == nil {
		t.Fatalf("ListUsers did not include %q", username)
	}
	if found.ServerCount != 2 {
		t.Errorf("ServerCount = %d, want 2", found.ServerCount)
	}
	if found.ID != userID {
		t.Errorf("ID = %d, want %d", found.ID, userID)
	}
}

func TestServerCRUDAndCrossUserIsolation(t *testing.T) {
	st := openTestStore(t)
	ctx := context.Background()
	user1 := mustCreateUser(t, st, uniqueUsername(t))
	user2 := mustCreateUser(t, st, uniqueUsername(t))

	serverID, err := st.CreateServer(ctx, Server{
		UserID: user1, Name: "my-server", Host: "1.2.3.4", Port: 27015,
		Password: "rcon-secret", Protocol: "source",
	})
	if err != nil {
		t.Fatalf("CreateServer: %v", err)
	}

	// Owner can read it, with the password decrypted correctly.
	srv, err := st.GetServer(ctx, user1, serverID)
	if err != nil {
		t.Fatalf("GetServer as owner: %v", err)
	}
	if srv.Password != "rcon-secret" {
		t.Errorf("decrypted password = %q, want %q", srv.Password, "rcon-secret")
	}

	// A different user gets ErrNotFound, not the server or an authorization error.
	if _, err := st.GetServer(ctx, user2, serverID); !errors.Is(err, ErrNotFound) {
		t.Errorf("GetServer as non-owner: err = %v, want ErrNotFound", err)
	}
	if err := st.UpdateServerPassword(ctx, user2, serverID, "hijacked"); !errors.Is(err, ErrNotFound) {
		t.Errorf("UpdateServerPassword as non-owner: err = %v, want ErrNotFound", err)
	}
	if err := st.DeleteServer(ctx, user2, serverID); !errors.Is(err, ErrNotFound) {
		t.Errorf("DeleteServer as non-owner: err = %v, want ErrNotFound", err)
	}

	// The non-owner's failed attempts didn't change anything.
	srv, err = st.GetServer(ctx, user1, serverID)
	if err != nil {
		t.Fatal(err)
	}
	if srv.Password != "rcon-secret" {
		t.Error("non-owner's failed UpdateServerPassword call changed the password anyway")
	}

	// ListServers only shows the owner's own servers.
	user2Servers, err := st.ListServers(ctx, user2)
	if err != nil {
		t.Fatal(err)
	}
	for _, s := range user2Servers {
		if s.ID == serverID {
			t.Error("ListServers(user2) included user1's server")
		}
	}

	// Owner can update and delete.
	if err := st.UpdateServerPassword(ctx, user1, serverID, "new-secret"); err != nil {
		t.Fatalf("UpdateServerPassword as owner: %v", err)
	}
	srv, err = st.GetServer(ctx, user1, serverID)
	if err != nil {
		t.Fatal(err)
	}
	if srv.Password != "new-secret" {
		t.Errorf("password after update = %q, want %q", srv.Password, "new-secret")
	}

	if err := st.DeleteServer(ctx, user1, serverID); err != nil {
		t.Fatalf("DeleteServer as owner: %v", err)
	}
	if _, err := st.GetServer(ctx, user1, serverID); !errors.Is(err, ErrNotFound) {
		t.Errorf("GetServer after delete: err = %v, want ErrNotFound", err)
	}
}

func TestServerWithoutPasswordHasEmptyPassword(t *testing.T) {
	st := openTestStore(t)
	ctx := context.Background()
	userID := mustCreateUser(t, st, uniqueUsername(t))

	serverID, err := st.CreateServer(ctx, Server{UserID: userID, Name: "no-pw", Host: "h", Port: 1, Protocol: "source"})
	if err != nil {
		t.Fatal(err)
	}
	srv, err := st.GetServer(ctx, userID, serverID)
	if err != nil {
		t.Fatal(err)
	}
	if srv.Password != "" {
		t.Errorf("Password = %q, want empty for a server created without one", srv.Password)
	}
}

func TestUpsertNitradoServerIdempotentAndPreservesPassword(t *testing.T) {
	st := openTestStore(t)
	ctx := context.Background()
	userID := mustCreateUser(t, st, uniqueUsername(t))
	serviceID := int64(424242)

	err := st.UpsertNitradoServer(ctx, Server{
		UserID: userID, Name: "Rust Server", Host: "1.1.1.1", Port: 28016,
		Protocol: "webrcon", Game: "Rust", NitradoServiceID: &serviceID,
	})
	if err != nil {
		t.Fatalf("first UpsertNitradoServer: %v", err)
	}

	servers, err := st.ListServers(ctx, userID)
	if err != nil {
		t.Fatal(err)
	}
	if len(servers) != 1 {
		t.Fatalf("after first upsert: %d servers, want 1", len(servers))
	}
	serverID := servers[0].ID

	// Set a password directly (simulating the user filling it in), then
	// re-sync from Nitrado with a changed name/host — the password must
	// survive since Nitrado never supplies one.
	if err := st.UpdateServerPassword(ctx, userID, serverID, "rcon-pw"); err != nil {
		t.Fatal(err)
	}

	err = st.UpsertNitradoServer(ctx, Server{
		UserID: userID, Name: "Rust Server (renamed)", Host: "2.2.2.2", Port: 28016,
		Protocol: "webrcon", Game: "Rust", NitradoServiceID: &serviceID,
	})
	if err != nil {
		t.Fatalf("second UpsertNitradoServer: %v", err)
	}

	servers, err = st.ListServers(ctx, userID)
	if err != nil {
		t.Fatal(err)
	}
	if len(servers) != 1 {
		t.Fatalf("after second upsert: %d servers, want 1 (should update, not duplicate)", len(servers))
	}
	if servers[0].ID != serverID {
		t.Errorf("second upsert created a new row (id %d) instead of updating %d", servers[0].ID, serverID)
	}
	if servers[0].Name != "Rust Server (renamed)" {
		t.Errorf("Name = %q, want the updated name", servers[0].Name)
	}
	if servers[0].Host != "2.2.2.2" {
		t.Errorf("Host = %q, want the updated host", servers[0].Host)
	}
	if servers[0].Password != "rcon-pw" {
		t.Errorf("Password = %q, want the previously-set password preserved", servers[0].Password)
	}
}

// health fields aren't exposed through Server/GetServer (nothing but the
// health-check loop and this test need to read them back), so these tests
// query st.db directly — fine from within package store itself.
func queryServerHealth(t *testing.T, st *Store, serverID int64) (ok sql.NullBool, latencyMs sql.NullInt64, errMsg sql.NullString, checkedAt sql.NullTime) {
	t.Helper()
	row := st.db.QueryRow(`SELECT health_ok, health_latency_ms, health_error, health_checked_at FROM servers WHERE id = ?`, serverID)
	if err := row.Scan(&ok, &latencyMs, &errMsg, &checkedAt); err != nil {
		t.Fatalf("query health columns: %v", err)
	}
	return
}

func TestListServersForHealthCheckOnlyIncludesServersWithPassword(t *testing.T) {
	st := openTestStore(t)
	ctx := context.Background()
	userID := mustCreateUser(t, st, uniqueUsername(t))

	withPassword, err := st.CreateServer(ctx, Server{
		UserID: userID, Name: "has-pw", Host: "h", Port: 1, Protocol: "source", Password: "secret",
	})
	if err != nil {
		t.Fatal(err)
	}
	withoutPassword, err := st.CreateServer(ctx, Server{UserID: userID, Name: "no-pw", Host: "h", Port: 1, Protocol: "source"})
	if err != nil {
		t.Fatal(err)
	}

	list, err := st.ListServersForHealthCheck(ctx)
	if err != nil {
		t.Fatalf("ListServersForHealthCheck: %v", err)
	}
	var sawWithPassword, sawWithoutPassword bool
	for _, s := range list {
		if s.ID == withPassword {
			sawWithPassword = true
			if s.Password != "secret" {
				t.Errorf("password = %q, want the decrypted password (this is what the health checker actually dials with)", s.Password)
			}
		}
		if s.ID == withoutPassword {
			sawWithoutPassword = true
		}
	}
	if !sawWithPassword {
		t.Error("ListServersForHealthCheck omitted a server that has a password set")
	}
	if sawWithoutPassword {
		t.Error("ListServersForHealthCheck included a server with no password — it can't be connected to, so it can't be health-checked")
	}
}

func TestUpdateServerHealthOkAndFailure(t *testing.T) {
	st := openTestStore(t)
	ctx := context.Background()
	userID := mustCreateUser(t, st, uniqueUsername(t))
	serverID, err := st.CreateServer(ctx, Server{UserID: userID, Name: "s", Host: "h", Port: 1, Protocol: "source", Password: "x"})
	if err != nil {
		t.Fatal(err)
	}

	// Before any check: health_ok is NULL (never checked), not false.
	ok, _, _, checkedAt := queryServerHealth(t, st, serverID)
	if ok.Valid {
		t.Errorf("health_ok before any check = %v, want NULL (not yet checked)", ok.Bool)
	}
	if checkedAt.Valid {
		t.Error("health_checked_at before any check should be NULL")
	}

	if err := st.UpdateServerHealth(ctx, serverID, true, 42, ""); err != nil {
		t.Fatalf("UpdateServerHealth(ok): %v", err)
	}
	ok, latencyMs, errMsg, checkedAt := queryServerHealth(t, st, serverID)
	if !ok.Valid || !ok.Bool {
		t.Errorf("health_ok after a successful check = %v (valid=%v), want true", ok.Bool, ok.Valid)
	}
	if !latencyMs.Valid || latencyMs.Int64 != 42 {
		t.Errorf("health_latency_ms = %v (valid=%v), want 42", latencyMs.Int64, latencyMs.Valid)
	}
	if errMsg.Valid {
		t.Errorf("health_error after a successful check = %q, want NULL", errMsg.String)
	}
	if !checkedAt.Valid {
		t.Error("health_checked_at should be set after a check")
	}

	if err := st.UpdateServerHealth(ctx, serverID, false, 0, "connection refused"); err != nil {
		t.Fatalf("UpdateServerHealth(fail): %v", err)
	}
	ok, latencyMs, errMsg, _ = queryServerHealth(t, st, serverID)
	if !ok.Valid || ok.Bool {
		t.Errorf("health_ok after a failed check = %v (valid=%v), want false", ok.Bool, ok.Valid)
	}
	if latencyMs.Valid {
		t.Errorf("health_latency_ms after a failed check = %v, want NULL (a failed connect has no meaningful round-trip time)", latencyMs.Int64)
	}
	if !errMsg.Valid || errMsg.String != "connection refused" {
		t.Errorf("health_error = %q (valid=%v), want %q", errMsg.String, errMsg.Valid, "connection refused")
	}
}
