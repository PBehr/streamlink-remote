// API Client
class API {
	constructor(baseUrl = "") {
		this.baseUrl = baseUrl;
	}

	async request(endpoint, options = {}) {
		const url = `${this.baseUrl}${endpoint}`;
		const config = {
			method: options.method || "GET",
			headers: {
				"Content-Type": "application/json",
				...options.headers
			}
		};

		if (options.body) {
			config.body = JSON.stringify(options.body);
		}

		try {
			const response = await fetch(url, config);
			const data = await response.json();

			if (!response.ok) {
				throw new Error(data.error || `HTTP ${response.status}`);
			}

			return data;
		} catch (error) {
			console.error(`API Error [${endpoint}]:`, error);
			throw error;
		}
	}

	// Status
	async getStatus() {
		return this.request("/api/status");
	}

	// Auth
	async getAuthStatus() {
		return this.request("/api/auth/status");
	}

	async getAuthLoginUrl() {
		return this.request("/api/auth/login");
	}

	async logout() {
		return this.request("/api/auth/logout", { method: "POST" });
	}

	// Channels & Streams
	async getFollowedChannels() {
		return this.request("/api/channels/followed");
	}

	async getLiveStreams() {
		return this.request("/api/streams/live");
	}

	async getFeaturedStreams() {
		return this.request("/api/streams/featured");
	}

	async searchChannels(query) {
		return this.request(`/api/search?q=${encodeURIComponent(query)}`);
	}

	async getChannel(name) {
		return this.request(`/api/channel/${encodeURIComponent(name)}`);
	}

	// Stream Control
	async startStream(channel, quality) {
		return this.request("/api/stream/start", {
			method: "POST",
			body: { channel, quality }
		});
	}

	async stopStream(channel) {
		return this.request("/api/stream/stop", {
			method: "POST",
			body: { channel }
		});
	}

	async getActiveStreams() {
		return this.request("/api/stream/active");
	}

	// Settings
	async getSettings() {
		return this.request("/api/settings");
	}

	async updateSettings(settings) {
		return this.request("/api/settings", {
			method: "PUT",
			body: settings
		});
	}

	// Favorites
	async getFavorites() {
		return this.request("/api/favorites");
	}

	async addFavorite(channel, displayName) {
		return this.request(`/api/favorites/${encodeURIComponent(channel)}`, {
			method: "POST",
			body: { displayName }
		});
	}

	async removeFavorite(channel) {
		return this.request(`/api/favorites/${encodeURIComponent(channel)}`, {
			method: "DELETE"
		});
	}

	async isFavorite(channel) {
		return this.request(`/api/favorites/${encodeURIComponent(channel)}`);
	}
}

// Export API instance
window.api = new API();
