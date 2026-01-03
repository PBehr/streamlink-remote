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
		this.favorites = new Map(); // channel_login -> { channel_login, channel_name, added_at }
		this.youtubeChannels = new Map(); // channel_id -> { channel_id, channel_name, channel_url, added_at }
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

	// Favorites methods
	addFavorite(channelLogin, channelName) {
		const key = channelLogin.toLowerCase();
		this.favorites.set(key, {
			channel_login: key,
			channel_name: channelName,
			added_at: Date.now()
		});
	}

	removeFavorite(channelLogin) {
		this.favorites.delete(channelLogin.toLowerCase());
	}

	getFavorites() {
		return Array.from(this.favorites.values()).sort((a, b) =>
			a.channel_name.localeCompare(b.channel_name)
		);
	}

	isFavorite(channelLogin) {
		return this.favorites.has(channelLogin.toLowerCase());
	}

	// YouTube channels methods
	addYoutubeChannel(channelId, channelName, channelUrl) {
		this.youtubeChannels.set(channelId, {
			channel_id: channelId,
			channel_name: channelName,
			channel_url: channelUrl,
			added_at: Date.now()
		});
	}

	removeYoutubeChannel(channelId) {
		this.youtubeChannels.delete(channelId);
	}

	getYoutubeChannels() {
		return Array.from(this.youtubeChannels.values()).sort((a, b) =>
			a.channel_name.localeCompare(b.channel_name)
		);
	}

	getYoutubeChannel(channelId) {
		return this.youtubeChannels.get(channelId);
	}

	close() {
		// Nothing to close
	}
}

module.exports = DatabaseManager;
