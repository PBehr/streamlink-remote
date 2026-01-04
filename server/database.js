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

			CREATE TABLE IF NOT EXISTS favorites (
				channel_login TEXT PRIMARY KEY,
				channel_name TEXT,
				added_at INTEGER
			);

			CREATE TABLE IF NOT EXISTS youtube_channels (
				channel_id TEXT PRIMARY KEY,
				channel_name TEXT,
				channel_url TEXT,
				added_at INTEGER
			);

			CREATE TABLE IF NOT EXISTS recording_rules (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				channel_login TEXT NOT NULL,
				channel_name TEXT,
				game_name TEXT,
				quality TEXT DEFAULT 'best',
				enabled INTEGER DEFAULT 1,
				created_at INTEGER,
				updated_at INTEGER
			);

			CREATE TABLE IF NOT EXISTS recordings (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				rule_id INTEGER,
				channel_login TEXT NOT NULL,
				channel_name TEXT,
				game_name TEXT,
				stream_title TEXT,
				filename TEXT,
				filepath TEXT,
				file_size INTEGER DEFAULT 0,
				started_at INTEGER,
				ended_at INTEGER,
				status TEXT DEFAULT 'recording',
				error TEXT,
				FOREIGN KEY (rule_id) REFERENCES recording_rules(id)
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

	// Favorites methods
	addFavorite(channelLogin, channelName) {
		const stmt = this.db.prepare(`
			INSERT OR REPLACE INTO favorites (channel_login, channel_name, added_at)
			VALUES (?, ?, ?)
		`);
		stmt.run(channelLogin.toLowerCase(), channelName, Date.now());
	}

	removeFavorite(channelLogin) {
		const stmt = this.db.prepare("DELETE FROM favorites WHERE channel_login = ?");
		stmt.run(channelLogin.toLowerCase());
	}

	getFavorites() {
		const stmt = this.db.prepare("SELECT * FROM favorites ORDER BY channel_name ASC");
		return stmt.all();
	}

	isFavorite(channelLogin) {
		const stmt = this.db.prepare("SELECT 1 FROM favorites WHERE channel_login = ?");
		return !!stmt.get(channelLogin.toLowerCase());
	}

	// YouTube channels methods
	addYoutubeChannel(channelId, channelName, channelUrl) {
		const stmt = this.db.prepare(`
			INSERT OR REPLACE INTO youtube_channels (channel_id, channel_name, channel_url, added_at)
			VALUES (?, ?, ?, ?)
		`);
		stmt.run(channelId, channelName, channelUrl, Date.now());
	}

	removeYoutubeChannel(channelId) {
		const stmt = this.db.prepare("DELETE FROM youtube_channels WHERE channel_id = ?");
		stmt.run(channelId);
	}

	getYoutubeChannels() {
		const stmt = this.db.prepare("SELECT * FROM youtube_channels ORDER BY channel_name ASC");
		return stmt.all();
	}

	getYoutubeChannel(channelId) {
		const stmt = this.db.prepare("SELECT * FROM youtube_channels WHERE channel_id = ?");
		return stmt.get(channelId);
	}

	// Recording rules methods
	addRecordingRule(rule) {
		const stmt = this.db.prepare(`
			INSERT INTO recording_rules (channel_login, channel_name, game_name, quality, enabled, created_at, updated_at)
			VALUES (?, ?, ?, ?, ?, ?, ?)
		`);
		const result = stmt.run(
			rule.channel_login.toLowerCase(),
			rule.channel_name,
			rule.game_name || null,
			rule.quality || "best",
			rule.enabled !== false ? 1 : 0,
			Date.now(),
			Date.now()
		);
		return result.lastInsertRowid;
	}

	updateRecordingRule(id, updates) {
		const fields = [];
		const values = [];

		if (updates.channel_login !== undefined) {
			fields.push("channel_login = ?");
			values.push(updates.channel_login.toLowerCase());
		}
		if (updates.channel_name !== undefined) {
			fields.push("channel_name = ?");
			values.push(updates.channel_name);
		}
		if (updates.game_name !== undefined) {
			fields.push("game_name = ?");
			values.push(updates.game_name);
		}
		if (updates.quality !== undefined) {
			fields.push("quality = ?");
			values.push(updates.quality);
		}
		if (updates.enabled !== undefined) {
			fields.push("enabled = ?");
			values.push(updates.enabled ? 1 : 0);
		}

		fields.push("updated_at = ?");
		values.push(Date.now());
		values.push(id);

		const stmt = this.db.prepare(`UPDATE recording_rules SET ${fields.join(", ")} WHERE id = ?`);
		stmt.run(...values);
	}

	deleteRecordingRule(id) {
		const stmt = this.db.prepare("DELETE FROM recording_rules WHERE id = ?");
		stmt.run(id);
	}

	getRecordingRules() {
		const stmt = this.db.prepare("SELECT * FROM recording_rules ORDER BY channel_name ASC");
		return stmt.all();
	}

	getRecordingRule(id) {
		const stmt = this.db.prepare("SELECT * FROM recording_rules WHERE id = ?");
		return stmt.get(id);
	}

	// Recordings methods
	addRecording(recording) {
		const stmt = this.db.prepare(`
			INSERT INTO recordings (rule_id, channel_login, channel_name, game_name, stream_title, filename, filepath, started_at, status)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
		`);
		const result = stmt.run(
			recording.rule_id,
			recording.channel_login,
			recording.channel_name,
			recording.game_name,
			recording.stream_title,
			recording.filename,
			recording.filepath,
			recording.started_at,
			recording.status || "recording"
		);
		return result.lastInsertRowid;
	}

	updateRecordingStatus(filepath, updates) {
		const fields = [];
		const values = [];

		if (updates.status !== undefined) {
			fields.push("status = ?");
			values.push(updates.status);
		}
		if (updates.ended_at !== undefined) {
			fields.push("ended_at = ?");
			values.push(updates.ended_at);
		}
		if (updates.file_size !== undefined) {
			fields.push("file_size = ?");
			values.push(updates.file_size);
		}
		if (updates.error !== undefined) {
			fields.push("error = ?");
			values.push(updates.error);
		}

		values.push(filepath);

		const stmt = this.db.prepare(`UPDATE recordings SET ${fields.join(", ")} WHERE filepath = ?`);
		stmt.run(...values);
	}

	getRecordings(limit = 50) {
		const stmt = this.db.prepare("SELECT * FROM recordings ORDER BY started_at DESC LIMIT ?");
		return stmt.all(limit);
	}

	getRecordingByFilepath(filepath) {
		const stmt = this.db.prepare("SELECT * FROM recordings WHERE filepath = ?");
		return stmt.get(filepath);
	}

	getRecordingsOlderThan(timestamp) {
		const stmt = this.db.prepare("SELECT * FROM recordings WHERE started_at < ? AND status != 'recording'");
		return stmt.all(timestamp);
	}

	deleteRecording(id) {
		const stmt = this.db.prepare("DELETE FROM recordings WHERE id = ?");
		stmt.run(id);
	}

	close() {
		this.db.close();
	}
}

module.exports = DatabaseManager;
