-- Same schema internal/store/store.go creates/migrates automatically —
-- if you've already pointed the Go relay at this database once, these
-- tables exist already and this script is a no-op (IF NOT EXISTS). If
-- you're setting the database up fresh here first, run this once via
-- phpMyAdmin or your hosting's SQL console before using the API.
--
-- rate_limits is the one table the Go relay does NOT know about — it's
-- only used by this PHP API's DB-backed rate limiting (see lib/ratelimit.php).

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

CREATE TABLE IF NOT EXISTS rate_limits (
	bucket_key CHAR(64) NOT NULL,
	window_start INT UNSIGNED NOT NULL,
	count INT UNSIGNED NOT NULL DEFAULT 0,
	PRIMARY KEY (bucket_key, window_start)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
