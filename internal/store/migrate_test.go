package store

import (
	"context"
	"regexp"
	"strings"
	"testing"
)

// Allowed statement shapes. Everything in a migration is re-run on databases
// that already have it (installations from before migrations existed, the
// generated webspace/schema.sql replayed by hand, two components starting at
// once), so each statement must be a no-op the second time. Extend this list
// deliberately if a migration really needs something else.
var idempotentStatement = regexp.MustCompile(`(?is)^(` +
	`CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s` +
	`|ALTER\s+TABLE\s+\S+\s+ADD\s+COLUMN\s+IF\s+NOT\s+EXISTS\s` +
	`|ALTER\s+TABLE\s+\S+\s+MODIFY\s+COLUMN\s` +
	`|CREATE\s+(UNIQUE\s+)?INDEX\s+IF\s+NOT\s+EXISTS\s` +
	`|INSERT\s+IGNORE\s+INTO\s` +
	`)`)

func TestMigrationStatementsAreIdempotent(t *testing.T) {
	migrations, err := loadMigrations()
	if err != nil {
		t.Fatal(err)
	}
	for _, m := range migrations {
		for _, statement := range m.Statements {
			if !idempotentStatement.MatchString(statement) {
				t.Errorf("migration %04d_%s has a statement that is not obviously idempotent:\n%.200s\n"+
					"(use CREATE TABLE IF NOT EXISTS, ADD COLUMN IF NOT EXISTS, CREATE INDEX IF NOT EXISTS or INSERT IGNORE)",
					m.Version, m.Name, statement)
			}
		}
	}
}

func TestMigrationsAreContiguousAndExpectedVersionMatches(t *testing.T) {
	migrations, err := loadMigrations()
	if err != nil {
		t.Fatal(err)
	}
	if len(migrations) == 0 || migrations[0].Version != 1 || migrations[0].Name != "baseline" {
		t.Fatalf("migration 0001 must be the baseline, got %+v", migrations)
	}
	if got, want := ExpectedSchemaVersion(), migrations[len(migrations)-1].Version; got != want {
		t.Fatalf("ExpectedSchemaVersion() = %d, want %d", got, want)
	}
}

func TestSplitStatements(t *testing.T) {
	got := splitStatements("-- a comment; with a semicolon;\nCREATE TABLE a (\n\tid INT\n);\n\n  -- another\nINSERT IGNORE INTO a VALUES (1, 'x;y');\nINSERT IGNORE INTO a VALUES (2, 'z');")
	want := []string{"CREATE TABLE a (\n\tid INT\n)", "INSERT IGNORE INTO a VALUES (1, 'x;y')", "INSERT IGNORE INTO a VALUES (2, 'z')"}
	if len(got) != len(want) {
		t.Fatalf("got %d statements %q, want %d", len(got), got, len(want))
	}
	for i := range want {
		if got[i] != want[i] {
			t.Errorf("statement %d = %q, want %q", i, got[i], want[i])
		}
	}
	if strings.Contains(strings.Join(got, ""), "comment") {
		t.Error("comment lines must be dropped")
	}
}

// --- against a real database ---

func TestMigrateRecordsVersionAndIsRepeatable(t *testing.T) {
	st := openTestStore(t)
	ctx := context.Background()

	version, err := st.SchemaVersion(ctx)
	if err != nil || version != ExpectedSchemaVersion() {
		t.Fatalf("SchemaVersion = %d, %v; want %d", version, err, ExpectedSchemaVersion())
	}
	// Running again changes nothing and does not fail.
	if err := migrate(st.db); err != nil {
		t.Fatalf("second migrate: %v", err)
	}
	var rows int
	if err := st.db.QueryRow(`SELECT COUNT(*) FROM schema_migrations WHERE version = 1`).Scan(&rows); err != nil || rows != 1 {
		t.Fatalf("baseline recorded %d times, %v", rows, err)
	}
}

// An installation from before migrations existed has all the tables but no
// schema_migrations: opening it must adopt it without touching its data.
func TestMigrateAdoptsAnExistingInstallation(t *testing.T) {
	st := openTestStore(t)
	ctx := context.Background()
	userID := mustCreateUser(t, st, uniqueUsername(t))

	if _, err := st.db.Exec(`DELETE FROM schema_migrations`); err != nil {
		t.Fatal(err)
	}
	if v, _ := st.SchemaVersion(ctx); v != 0 {
		t.Fatalf("setup: expected an unrecorded database, got version %d", v)
	}
	if err := migrate(st.db); err != nil {
		t.Fatalf("adopting an existing installation: %v", err)
	}
	if v, err := st.SchemaVersion(ctx); err != nil || v != ExpectedSchemaVersion() {
		t.Fatalf("after adoption: %d, %v", v, err)
	}
	if _, err := st.GetUserByID(ctx, userID); err != nil {
		t.Fatalf("existing data must survive: %v", err)
	}
}
