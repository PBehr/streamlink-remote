// In-Memory Database (for testing without better-sqlite3)
class DatabaseManager {
	constructor(dbPath) {
		this.auth = null;
		this.settings = {
			defaultQuality: "best",
			lowLatency: false,
			playerInput: "http"
		};
		this.followedChannels = [];
	}

	init() {
		console.log("✓ In-Memory Database initialized");
	}

	// Auth methods
	saveAuth(authData) {
		this.auth = { ...authData };
	}

	getAuth() {
		return this.auth;
	}

	clearAuth() {
		this.auth = null;
	}

	// Settings methods
	getSettings() {
		return { ...this.settings };
	}

	updateSettings(settings) {
		this.settings = { ...this.settings, ...settings };
	}

	getSetting(key, defaultValue = null) {
		return this.settings[key] !== undefined ? this.settings[key] : defaultValue;
	}

	setSetting(key, value) {
		this.settings[key] = value;
	}

	// Followed channels cache
	saveFollowedChannels(channels) {
		this.followedChannels = [...channels];
	}

	getFollowedChannels() {
		return [...this.followedChannels];
	}

	close() {
		// Nothing to close
	}
}

module.exports = DatabaseManager;
