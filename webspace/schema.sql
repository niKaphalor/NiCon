-- Mostly the same schema internal/store/store.go creates/migrates
-- automatically, plus a few PHP-only additions (see below) — safe to run
-- regardless of which side has already touched this database, in either
-- order: every statement here is idempotent (CREATE TABLE IF NOT EXISTS /
-- ADD COLUMN IF NOT EXISTS), including on a `users`/`sessions`/`servers`
-- set the Go relay created first. Run this once via phpMyAdmin or your
-- hosting's SQL console — don't skip it just because the Go relay has
-- already connected to this database: `rate_limits`, `notifications`, and
-- `users.nitrado_token_enc` below are PHP-only and the Go relay's own
-- auto-migration never creates them, so without this script the API errors
-- out on register/reset/contact (missing rate_limits table), notifications
-- (missing table), and Nitrado sync/account (missing nitrado_token_enc
-- column) even though the Go relay itself is working fine.
--
-- rate_limits and notifications are the two tables the Go relay does NOT
-- know about — only used by this PHP API's DB-backed rate limiting (see
-- lib/ratelimit.php) and admin-authored banners, respectively.

CREATE TABLE IF NOT EXISTS users (
	id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
	username VARCHAR(64) NOT NULL UNIQUE,
	password_hash VARCHAR(255) NOT NULL,
	recovery_code_hash VARCHAR(255) NULL,
	is_admin BOOLEAN NOT NULL DEFAULT FALSE,
	created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- nitrado_token_enc doesn't live in the CREATE TABLE above: if the Go
-- relay created `users` first (its own schema has no such column), that
-- CREATE TABLE IF NOT EXISTS is a no-op and the column would otherwise
-- never get added. This ALTER runs every time and is a no-op itself once
-- the column exists, so it's safe on both a fresh table and one the Go
-- relay already created.
--
-- Same AES-256-GCM scheme as servers.password_enc (see lib/crypto.php) —
-- encrypted, not hashed: a Nitrado sync needs the actual token back to
-- call Nitrado's API with, which a one-way hash can't give back. PHP-only
-- column; the Go relay never touches Nitrado sync.
ALTER TABLE users ADD COLUMN IF NOT EXISTS nitrado_token_enc VARBINARY(2048) NULL;

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

CREATE TABLE IF NOT EXISTS rate_limits (
	bucket_key CHAR(64) NOT NULL,
	window_start INT UNSIGNED NOT NULL,
	count INT UNSIGNED NOT NULL DEFAULT 0,
	PRIMARY KEY (bucket_key, window_start)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Admin-authored, shown to every signed-in user until they dismiss it
-- (tracked client-side, not here) or an admin deletes it. Another
-- PHP-only table, like rate_limits — the Go relay has no reason to know
-- about it.
CREATE TABLE IF NOT EXISTS notifications (
	id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
	type VARCHAR(16) NOT NULL DEFAULT 'info',
	message TEXT NOT NULL,
	created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
