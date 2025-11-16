const Database = require("better-sqlite3");
const path = require("path");
const fs = require("fs");

class DatabaseManager {
	constructor(dbPath) {
		// Ensure data directory exists
		const dir = path.dirname(dbPath);
		if (!fs.existsSync(dir)) {
			fs.mkdirSync(dir, { recursive: true });
		}

		this.db = new Database(dbPath);
		this.db.pragma("journal_mode = WAL");
	}

	init() {
		// Create tables
		this.db.exec(`
			CREATE TABLE IF NOT EXISTS auth (
				id INTEGER PRIMARY KEY CHECK (id = 1),
				access_token TEXT,
				refresh_token TEXT,
				user_id TEXT,
				user_login TEXT,
				user_display_name TEXT,
				expires_at INTEGER
			);

			CREATE TABLE IF NOT EXISTS settings (
				key TEXT PRIMARY KEY,
				value TEXT
			);

			CREATE TABLE IF NOT EXISTS followed_channels (
				user_id TEXT PRIMARY KEY,
				user_login TEXT,
				display_name TEXT,
				profile_image_url TEXT,
				followed_at INTEGER
			);
		`);

		console.log("✓ Database initialized");
	}

	// Auth methods
	saveAuth(authData) {
		const stmt = this.db.prepare(`
			INSERT OR REPLACE INTO auth (id, access_token, refresh_token, user_id, user_login, user_display_name, expires_at)
			VALUES (1, ?, ?, ?, ?, ?, ?)
		`);

		stmt.run(
			authData.access_token,
			authData.refresh_token || null,
			authData.user_id,
			authData.user_login,
			authData.user_display_name,
			authData.expires_at
		);
	}

	getAuth() {
		const stmt = this.db.prepare("SELECT * FROM auth WHERE id = 1");
		return stmt.get();
	}

	clearAuth() {
		const stmt = this.db.prepare("DELETE FROM auth WHERE id = 1");
		stmt.run();
	}

	// Settings methods
	getSettings() {
		const stmt = this.db.prepare("SELECT key, value FROM settings");
		const rows = stmt.all();

		const settings = {
			defaultQuality: "best",
			lowLatency: false,
			playerInput: "http"
		};

		rows.forEach((row) => {
			try {
				settings[row.key] = JSON.parse(row.value);
			} catch (e) {
				settings[row.key] = row.value;
			}
		});

		return settings;
	}

	updateSettings(settings) {
		const stmt = this.db.prepare(`
			INSERT OR REPLACE INTO settings (key, value)
			VALUES (?, ?)
		`);

		const transaction = this.db.transaction((settings) => {
			for (const [key, value] of Object.entries(settings)) {
				const jsonValue = typeof value === "object" ? JSON.stringify(value) : String(value);
				stmt.run(key, jsonValue);
			}
		});

		transaction(settings);
	}

	getSetting(key, defaultValue = null) {
		const stmt = this.db.prepare("SELECT value FROM settings WHERE key = ?");
		const row = stmt.get(key);

		if (!row) {
			return defaultValue;
		}

		try {
			return JSON.parse(row.value);
		} catch (e) {
			return row.value;
		}
	}

	setSetting(key, value) {
		const stmt = this.db.prepare(`
			INSERT OR REPLACE INTO settings (key, value)
			VALUES (?, ?)
		`);

		const jsonValue = typeof value === "object" ? JSON.stringify(value) : String(value);
		stmt.run(key, jsonValue);
	}

	// Followed channels cache
	saveFollowedChannels(channels) {
		const deleteStmt = this.db.prepare("DELETE FROM followed_channels");
		const insertStmt = this.db.prepare(`
			INSERT INTO followed_channels (user_id, user_login, display_name, profile_image_url, followed_at)
			VALUES (?, ?, ?, ?, ?)
		`);

		const transaction = this.db.transaction((channels) => {
			deleteStmt.run();
			channels.forEach((channel) => {
				insertStmt.run(
					channel.broadcaster_id,
					channel.broadcaster_login,
					channel.broadcaster_name,
					channel.thumbnail_url || "",
					Date.now()
				);
			});
		});

		transaction(channels);
	}

	getFollowedChannels() {
		const stmt = this.db.prepare("SELECT * FROM followed_channels ORDER BY display_name ASC");
		return stmt.all();
	}

	close() {
		this.db.close();
	}
}

module.exports = DatabaseManager;
