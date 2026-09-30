package store

import (
	"context"
	"fmt"
	"strings"
)

// ReencryptReport summarises a ReencryptAll run.
type ReencryptReport struct {
	Servers, Tokens ReencryptCounts
	// TokensUnavailable is true when the database has no users.nitrado_token_enc
	// column (the PHP schema was never applied), so there is nothing to do there.
	TokensUnavailable bool
	// Failures lists rows that could not be decrypted (wrong/missing key,
	// tampered or transplanted value); they are left untouched.
	Failures []string
}

// ReencryptCounts are per-column totals.
type ReencryptCounts struct {
	Scanned   int // rows with a value
	Current   int // already in the ring's write format and key
	Rewritten int // rewritten (or, in a dry run, would be)
	Failed    int
}

// ReencryptAll brings every stored secret to the key ring's write format and
// current key: it migrates legacy (v1) values to v2 with their AAD binding and
// re-encrypts values still under an older key. Each row is rewritten with a
// compare-and-swap on the old value, so a concurrent change made through the
// API is never overwritten. With dryRun nothing is written.
//
// Run it after enabling v2 writes and/or switching the current key, and
// before removing an old key from the configuration.
func (s *Store) ReencryptAll(ctx context.Context, dryRun bool) (ReencryptReport, error) {
	var report ReencryptReport

	type row struct {
		id, userID int64
		blob       []byte
	}

	// --- servers.password_enc
	serverRows, err := s.db.QueryContext(ctx, `SELECT id, user_id, password_enc FROM servers WHERE password_enc IS NOT NULL ORDER BY id`)
	if err != nil {
		return report, err
	}
	var servers []row
	for serverRows.Next() {
		var r row
		if err := serverRows.Scan(&r.id, &r.userID, &r.blob); err != nil {
			serverRows.Close()
			return report, err
		}
		servers = append(servers, r)
	}
	if err := serverRows.Err(); err != nil {
		serverRows.Close()
		return report, err
	}
	serverRows.Close()

	for _, r := range servers {
		report.Servers.Scanned++
		aad := ServerPasswordAAD(r.userID, r.id)
		plaintext, current, err := s.enc.decrypt(r.blob, aad)
		if err != nil {
			report.Servers.Failed++
			report.Failures = append(report.Failures, fmt.Sprintf("server %d: %v", r.id, err))
			continue
		}
		if current {
			report.Servers.Current++
			continue
		}
		if !dryRun {
			sealed, err := s.enc.Encrypt(plaintext, aad)
			if err != nil {
				return report, err
			}
			if _, err := s.db.ExecContext(ctx, `UPDATE servers SET password_enc = ? WHERE id = ? AND password_enc = ?`, sealed, r.id, r.blob); err != nil {
				return report, err
			}
		}
		report.Servers.Rewritten++
	}

	// --- users.nitrado_token_enc (a PHP-only column)
	tokenRows, err := s.db.QueryContext(ctx, `SELECT id, nitrado_token_enc FROM users WHERE nitrado_token_enc IS NOT NULL ORDER BY id`)
	if err != nil {
		if strings.Contains(err.Error(), "Unknown column") {
			report.TokensUnavailable = true
			return report, nil
		}
		return report, err
	}
	var tokens []row
	for tokenRows.Next() {
		var r row
		if err := tokenRows.Scan(&r.id, &r.blob); err != nil {
			tokenRows.Close()
			return report, err
		}
		r.userID = r.id
		tokens = append(tokens, r)
	}
	if err := tokenRows.Err(); err != nil {
		tokenRows.Close()
		return report, err
	}
	tokenRows.Close()

	for _, r := range tokens {
		report.Tokens.Scanned++
		aad := NitradoTokenAAD(r.id)
		plaintext, current, err := s.enc.decrypt(r.blob, aad)
		if err != nil {
			report.Tokens.Failed++
			report.Failures = append(report.Failures, fmt.Sprintf("user %d Nitrado token: %v", r.id, err))
			continue
		}
		if current {
			report.Tokens.Current++
			continue
		}
		if !dryRun {
			sealed, err := s.enc.Encrypt(plaintext, aad)
			if err != nil {
				return report, err
			}
			if _, err := s.db.ExecContext(ctx, `UPDATE users SET nitrado_token_enc = ? WHERE id = ? AND nitrado_token_enc = ?`, sealed, r.id, r.blob); err != nil {
				return report, err
			}
		}
		report.Tokens.Rewritten++
	}
	return report, nil
}
