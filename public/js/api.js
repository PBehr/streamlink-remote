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

	// Twitch VODs
	async getVods(userId = null, limit = 25, type = "archive") {
		let url = `/api/vods?limit=${limit}&type=${type}`;
		if (userId) {
			url += `&user_id=${userId}`;
		}
		return this.request(url);
	}

	// Twitch Clips
	async getClips(broadcasterId = null, limit = 25, period = "week") {
		let url = `/api/clips?limit=${limit}&period=${period}`;
		if (broadcasterId) {
			url += `&broadcaster_id=${broadcasterId}`;
		}
		return this.request(url);
	}

	// YouTube
	async getYoutubeChannels() {
		return this.request("/api/youtube/channels");
	}

	async addYoutubeChannel(url) {
		return this.request("/api/youtube/channels", {
			method: "POST",
			body: { url }
		});
	}

	async removeYoutubeChannel(channelId) {
		return this.request(`/api/youtube/channels/${encodeURIComponent(channelId)}`, {
			method: "DELETE"
		});
	}

	async getYoutubeVideos(limit = 25) {
		return this.request(`/api/youtube/videos?limit=${limit}`);
	}

	async getYoutubeDirectUrl(videoId, quality = null) {
		let url = `/api/youtube/direct/${encodeURIComponent(videoId)}`;
		if (quality) {
			url += `?quality=${encodeURIComponent(quality)}`;
		}
		return this.request(url);
	}

	// Twitch VOD direct URL
	async getVodDirectUrl(videoId, quality = null) {
		let url = `/api/vod/direct/${encodeURIComponent(videoId)}`;
		if (quality) {
			url += `?quality=${encodeURIComponent(quality)}`;
		}
		return this.request(url);
	}

	// Twitch Clip direct URL
	async getClipDirectUrl(clipId, quality = null) {
		let url = `/api/clip/direct/${encodeURIComponent(clipId)}`;
		if (quality) {
			url += `?quality=${encodeURIComponent(quality)}`;
		}
		return this.request(url);
	}

	// Recording Rules
	async getRecordingRules() {
		return this.request("/api/recording-rules");
	}

	async addRecordingRule(rule) {
		return this.request("/api/recording-rules", {
			method: "POST",
			body: rule
		});
	}

	async updateRecordingRule(id, updates) {
		return this.request(`/api/recording-rules/${id}`, {
			method: "PUT",
			body: updates
		});
	}

	async deleteRecordingRule(id) {
		return this.request(`/api/recording-rules/${id}`, {
			method: "DELETE"
		});
	}

	// Recordings
	async getRecordings(limit = 50) {
		return this.request(`/api/recordings?limit=${limit}`);
	}

	async deleteRecording(id) {
		return this.request(`/api/recordings/${id}`, {
			method: "DELETE"
		});
	}

	// Recording Settings
	async getRecordingSettings() {
		return this.request("/api/recording-settings");
	}

	async updateRecordingSettings(settings) {
		return this.request("/api/recording-settings", {
			method: "PUT",
			body: settings
		});
	}

	// Search games
	async searchGames(query) {
		return this.request(`/api/games/search?q=${encodeURIComponent(query)}`);
	}
}

// Export API instance
window.api = new API();
