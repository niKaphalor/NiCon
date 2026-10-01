package store

import (
	"context"
	"testing"
)

func openRingStore(t *testing.T, ring *KeyRing) *Store {
	t.Helper()
	st, err := OpenWithKeyRing(testDSN(t), ring)
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	t.Cleanup(func() { st.Close() })
	return st
}

func rawPasswordEnc(t *testing.T, st *Store, serverID int64) []byte {
	t.Helper()
	var blob []byte
	if err := st.db.QueryRow(`SELECT password_enc FROM servers WHERE id = ?`, serverID).Scan(&blob); err != nil {
		t.Fatalf("read password_enc: %v", err)
	}
	return blob
}

func TestV2PasswordIsBoundToItsServerRow(t *testing.T) {
	ring := mustRing(t, map[byte][]byte{1: testKey(0)}, 1, true)
	st := openRingStore(t, ring)
	ctx := context.Background()
	userID := mustCreateUser(t, st, uniqueUsername(t))

	victim, err := st.CreateServer(ctx, Server{UserID: userID, Name: "victim", Host: "10.0.0.1", Port: 1, Password: "victim-secret", Protocol: "source", Source: "manual"})
	if err != nil {
		t.Fatal(err)
	}
	mine, err := st.CreateServer(ctx, Server{UserID: userID, Name: "mine", Host: "10.0.0.2", Port: 2, Password: "my-secret", Protocol: "source", Source: "manual"})
	if err != nil {
		t.Fatal(err)
	}
	if blob := rawPasswordEnc(t, st, victim); string(blob[:3]) != v2Magic {
		t.Fatal("a store writing v2 must store v2")
	}
	got, err := st.GetServer(ctx, userID, victim)
	if err != nil || got.Password != "victim-secret" {
		t.Fatalf("GetServer = %+v, %v", got, err)
	}

	// Someone with database write access copies the victim's ciphertext onto
	// another row: it must not decrypt there.
	if _, err := st.db.Exec(`UPDATE servers SET password_enc = ? WHERE id = ?`, rawPasswordEnc(t, st, victim), mine); err != nil {
		t.Fatal(err)
	}
	if _, err := st.GetServer(ctx, userID, mine); err == nil {
		t.Fatal("a ciphertext transplanted onto another server must fail to decrypt")
	}

	// UpdateServerPassword re-binds correctly.
	if err := st.UpdateServerPassword(ctx, userID, mine, "new-secret"); err != nil {
		t.Fatal(err)
	}
	if got, err := st.GetServer(ctx, userID, mine); err != nil || got.Password != "new-secret" {
		t.Fatalf("after update: %+v, %v", got, err)
	}
}

func TestReencryptMigratesLegacyAndRotatesKeys(t *testing.T) {
	ctx := context.Background()
	legacy := openRingStore(t, mustRing(t, map[byte][]byte{1: testKey(0)}, 1, false))
	userID := mustCreateUser(t, legacy, uniqueUsername(t))
	var ids []int64
	for _, pw := range []string{"one", "two"} {
		id, err := legacy.CreateServer(ctx, Server{UserID: userID, Name: pw, Host: "10.0.0.1", Port: 1, Password: pw, Protocol: "source", Source: "manual"})
		if err != nil {
			t.Fatal(err)
		}
		ids = append(ids, id)
	}
	if blob := rawPasswordEnc(t, legacy, ids[0]); string(blob[:3]) == v2Magic {
		t.Fatal("setup: the legacy store must write legacy values")
	}

	// A rotated ring: key 2 current, v2, key 1 kept for reading.
	rotated := openRingStore(t, mustRing(t, map[byte][]byte{1: testKey(0), 2: testKey(50)}, 2, true))

	dry, err := rotated.ReencryptAll(ctx, true)
	if err != nil {
		t.Fatal(err)
	}
	if dry.Servers.Rewritten < 2 {
		t.Fatalf("dry run should report our two rows: %+v", dry.Servers)
	}
	if blob := rawPasswordEnc(t, rotated, ids[0]); string(blob[:3]) == v2Magic {
		t.Fatal("a dry run must not write")
	}

	report, err := rotated.ReencryptAll(ctx, false)
	if err != nil {
		t.Fatal(err)
	}
	if report.Servers.Failed != 0 || len(report.Failures) != 0 {
		t.Fatalf("unexpected failures: %+v", report)
	}
	for i, id := range ids {
		blob := rawPasswordEnc(t, rotated, id)
		if string(blob[:3]) != v2Magic || blob[3] != 2 {
			t.Fatalf("server %d should now be v2 under key 2, got header % x", id, blob[:4])
		}
		got, err := rotated.GetServer(ctx, userID, id)
		if want := []string{"one", "two"}[i]; err != nil || got.Password != want {
			t.Fatalf("server %d after reencrypt: %+v, %v (want %q)", id, got, err, want)
		}
	}

	// Idempotent: a second run has nothing left to do for our rows, and once
	// key 1 is dropped they are still readable.
	again, err := rotated.ReencryptAll(ctx, false)
	if err != nil {
		t.Fatal(err)
	}
	if again.Servers.Failed != 0 {
		t.Fatalf("second run: %+v", again)
	}
	only2 := openRingStore(t, mustRing(t, map[byte][]byte{2: testKey(50)}, 2, true))
	if got, err := only2.GetServer(ctx, userID, ids[1]); err != nil || got.Password != "two" {
		t.Fatalf("readable with only key 2: %+v, %v", got, err)
	}
}
