package store

import (
	"context"
	"database/sql"
	"embed"
	"fmt"
	"regexp"
	"sort"
	"strconv"
	"strings"
)

// The database schema is a list of numbered migrations (migrations/NNNN_name.sql),
// applied in order when the relay starts and recorded in schema_migrations.
// webspace/schema.sql — what the PHP-only Cloud API's hosting runs by hand — is
// GENERATED from the same files by scripts/build_schema.py, so there is exactly
// one description of the schema.
//
// Every statement must be idempotent (see TestMigrationStatementsAreIdempotent):
// installations from before migrations existed already contain the baseline, and
// two components may start at the same time. The version table is bookkeeping
// ("which numbered steps were applied?") and the basis of the readiness checks
// (/readyz), not what makes re-running safe.

//go:embed migrations/*.sql
var migrationFiles embed.FS

type migration struct {
	Version    int
	Name       string
	Statements []string
}

var migrationNamePattern = regexp.MustCompile(`^(\d{4})_([a-z0-9_]+)\.sql$`)

// loadMigrations reads and validates the embedded migrations: sorted, contiguous
// from 1, each with at least one statement.
func loadMigrations() ([]migration, error) {
	entries, err := migrationFiles.ReadDir("migrations")
	if err != nil {
		return nil, err
	}
	var out []migration
	for _, entry := range entries {
		match := migrationNamePattern.FindStringSubmatch(entry.Name())
		if match == nil {
			return nil, fmt.Errorf("migration %q is not named NNNN_name.sql", entry.Name())
		}
		version, _ := strconv.Atoi(match[1])
		text, err := migrationFiles.ReadFile("migrations/" + entry.Name())
		if err != nil {
			return nil, err
		}
		statements := splitStatements(string(text))
		if len(statements) == 0 {
			return nil, fmt.Errorf("migration %q has no statements", entry.Name())
		}
		out = append(out, migration{Version: version, Name: match[2], Statements: statements})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Version < out[j].Version })
	for i, m := range out {
		if m.Version != i+1 {
			return nil, fmt.Errorf("migration versions must be contiguous from 0001: expected %04d, found %04d", i+1, m.Version)
		}
	}
	return out, nil
}

// ExpectedSchemaVersion is the newest migration this build knows.
func ExpectedSchemaVersion() int {
	migrations, err := loadMigrations()
	if err != nil || len(migrations) == 0 {
		return 0
	}
	return migrations[len(migrations)-1].Version
}

// splitStatements strips whole-line "--" comments and splits on a semicolon at
// the end of a line — the same rule the PHP test loader uses for the generated
// schema.sql, so one file works for both.
var statementEnd = regexp.MustCompile(`;[ \t\r]*(?:\n|$)`)
var commentLine = regexp.MustCompile(`(?m)^[ \t]*--.*$`)

func splitStatements(text string) []string {
	text = commentLine.ReplaceAllString(text, "")
	var out []string
	for _, part := range statementEnd.Split(text, -1) {
		if strings.TrimSpace(part) != "" {
			out = append(out, strings.TrimSpace(part))
		}
	}
	return out
}

const createSchemaMigrations = `CREATE TABLE IF NOT EXISTS schema_migrations (
	version INT UNSIGNED PRIMARY KEY,
	name VARCHAR(128) NOT NULL,
	applied_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`

// migrate applies every migration that is not recorded yet.
func migrate(db *sql.DB) error {
	migrations, err := loadMigrations()
	if err != nil {
		return err
	}
	if _, err := db.Exec(createSchemaMigrations); err != nil {
		return fmt.Errorf("create schema_migrations: %w", err)
	}
	applied := map[int]bool{}
	rows, err := db.Query(`SELECT version FROM schema_migrations`)
	if err != nil {
		return fmt.Errorf("read schema_migrations: %w", err)
	}
	for rows.Next() {
		var version int
		if err := rows.Scan(&version); err != nil {
			rows.Close()
			return err
		}
		applied[version] = true
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return err
	}
	rows.Close()

	for _, m := range migrations {
		if applied[m.Version] {
			continue
		}
		for _, statement := range m.Statements {
			if _, err := db.Exec(statement); err != nil {
				return fmt.Errorf("migration %04d_%s: %w (statement: %.120s)", m.Version, m.Name, err, statement)
			}
		}
		if _, err := db.Exec(`INSERT IGNORE INTO schema_migrations (version, name) VALUES (?, ?)`, m.Version, m.Name); err != nil {
			return fmt.Errorf("record migration %04d: %w", m.Version, err)
		}
	}
	return nil
}

// SchemaVersion is the newest migration recorded in the database (0 if none).
func (s *Store) SchemaVersion(ctx context.Context) (int, error) {
	var version sql.NullInt64
	if err := s.db.QueryRowContext(ctx, `SELECT MAX(version) FROM schema_migrations`).Scan(&version); err != nil {
		return 0, err
	}
	return int(version.Int64), nil
}
