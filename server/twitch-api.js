const https = require("https");
const http = require("http");
const { URL } = require("url");

class TwitchAPI {
	constructor(config, db) {
		this.config = config;
		this.db = db;
		this.auth = null;
		this.refreshPromise = null; // Prevent concurrent refresh attempts

		// Load auth from database
		this.loadAuth();
	}

	loadAuth() {
		// Check for manual token in config first (legacy support)
		if (this.config.manualAuth && this.config.manualAuth.access_token) {
			console.log("✓ Using manual token from config");
			this.auth = this.config.manualAuth;

			// Check if token is expired
			if (this.auth.expires_at && Date.now() > this.auth.expires_at) {
				console.log("⚠ Manual access token expired");
				this.auth = null;
			}
			return;
		}

		// Otherwise load from database
		const authData = this.db.getAuth();
		if (authData && authData.access_token) {
			this.auth = authData;
			console.log(`✓ Loaded auth for: ${this.auth.user_login}`);

			// Check if token is expired but has refresh token
			if (this.auth.expires_at && Date.now() > this.auth.expires_at) {
				if (this.auth.refresh_token) {
					console.log("⚠ Access token expired, will refresh on next request");
				} else {
					console.log("⚠ Access token expired, no refresh token available");
					this.auth = null;
					this.db.clearAuth();
				}
			}
		}
	}

	isAuthenticated() {
		return this.auth !== null && this.auth.access_token !== null;
	}

	/**
	 * Check if token needs refresh (expired or expiring within 5 minutes)
	 */
	needsRefresh() {
		if (!this.auth || !this.auth.expires_at) return false;
		// Refresh if expiring in less than 5 minutes
		return Date.now() > (this.auth.expires_at - 5 * 60 * 1000);
	}

	/**
	 * Ensure we have a valid token, refreshing if necessary
	 */
	async ensureValidToken() {
		if (!this.auth) {
			throw new Error("Not authenticated");
		}

		if (this.needsRefresh() && this.auth.refresh_token) {
			await this.refreshAccessToken();
		}
	}

	getUser() {
		if (!this.auth) return null;

		return {
			id: this.auth.user_id,
			login: this.auth.user_login,
			display_name: this.auth.user_display_name
		};
	}

	/**
	 * Get OAuth URL - now uses Authorization Code Flow
	 */
	getAuthUrl() {
		const params = new URLSearchParams({
			client_id: this.config.clientId,
			redirect_uri: this.config.redirectUri,
			response_type: "code", // Changed from "token" to "code"
			scope: this.config.scopes.join(" ")
		});

		return `https://id.twitch.tv/oauth2/authorize?${params.toString()}`;
	}

	/**
	 * Exchange authorization code for access token and refresh token
	 */
	async handleAuthorizationCode(code) {
		if (!code) {
			throw new Error("No authorization code provided");
		}

		if (!this.config.clientSecret) {
			throw new Error("Client Secret not configured - required for Authorization Code Flow");
		}

		console.log("🔄 Exchanging authorization code for tokens...");

		const tokenData = await this.exchangeCodeForTokens(code);

		// Validate the token and get user info
		const userData = await this.validateToken(tokenData.access_token);

		// Calculate expiry time
		const expiresAt = Date.now() + (tokenData.expires_in * 1000);

		// Save auth data with refresh token
		this.auth = {
			access_token: tokenData.access_token,
			refresh_token: tokenData.refresh_token,
			user_id: userData.user_id,
			user_login: userData.login,
			user_display_name: userData.login,
			expires_at: expiresAt
		};

		this.db.saveAuth(this.auth);

		const expiresInHours = Math.round(tokenData.expires_in / 3600);
		console.log(`✓ Authenticated as: ${this.auth.user_login}`);
		console.log(`✓ Token expires in ${expiresInHours} hours`);
		console.log(`✓ Refresh token saved for automatic renewal`);

		return this.auth;
	}

	/**
	 * Exchange authorization code for tokens via Twitch OAuth API
	 */
	async exchangeCodeForTokens(code) {
		const postData = new URLSearchParams({
			client_id: this.config.clientId,
			client_secret: this.config.clientSecret,
			code: code,
			grant_type: "authorization_code",
			redirect_uri: this.config.redirectUri
		}).toString();

		const options = {
			hostname: "id.twitch.tv",
			path: "/oauth2/token",
			method: "POST",
			headers: {
				"Content-Type": "application/x-www-form-urlencoded",
				"Content-Length": Buffer.byteLength(postData)
			}
		};

		return new Promise((resolve, reject) => {
			const req = https.request(options, (res) => {
				let data = "";

				res.on("data", (chunk) => {
					data += chunk;
				});

				res.on("end", () => {
					try {
						const parsed = JSON.parse(data);
						if (res.statusCode === 200) {
							resolve(parsed);
						} else {
							reject(new Error(`Token exchange failed: ${parsed.message || parsed.error || res.statusCode}`));
						}
					} catch (e) {
						reject(new Error(`Failed to parse token response: ${data}`));
					}
				});
			});

			req.on("error", reject);
			req.write(postData);
			req.end();
		});
	}

	/**
	 * Refresh the access token using the refresh token
	 */
	async refreshAccessToken() {
		// Prevent concurrent refresh attempts
		if (this.refreshPromise) {
			return this.refreshPromise;
		}

		if (!this.auth || !this.auth.refresh_token) {
			throw new Error("No refresh token available");
		}

		if (!this.config.clientSecret) {
			throw new Error("Client Secret not configured - required for token refresh");
		}

		console.log("🔄 Refreshing access token...");

		this.refreshPromise = this._doRefresh();

		try {
			await this.refreshPromise;
		} finally {
			this.refreshPromise = null;
		}
	}

	async _doRefresh() {
		const postData = new URLSearchParams({
			client_id: this.config.clientId,
			client_secret: this.config.clientSecret,
			grant_type: "refresh_token",
			refresh_token: this.auth.refresh_token
		}).toString();

		const options = {
			hostname: "id.twitch.tv",
			path: "/oauth2/token",
			method: "POST",
			headers: {
				"Content-Type": "application/x-www-form-urlencoded",
				"Content-Length": Buffer.byteLength(postData)
			}
		};

		return new Promise((resolve, reject) => {
			const req = https.request(options, (res) => {
				let data = "";

				res.on("data", (chunk) => {
					data += chunk;
				});

				res.on("end", () => {
					try {
						const parsed = JSON.parse(data);
						if (res.statusCode === 200) {
							// Update auth with new tokens
							const expiresAt = Date.now() + (parsed.expires_in * 1000);

							this.auth.access_token = parsed.access_token;
							this.auth.refresh_token = parsed.refresh_token; // Twitch may rotate refresh token
							this.auth.expires_at = expiresAt;

							this.db.saveAuth(this.auth);

							const expiresInHours = Math.round(parsed.expires_in / 3600);
							console.log(`✓ Token refreshed successfully, expires in ${expiresInHours} hours`);
							resolve();
						} else {
							console.error(`✗ Token refresh failed: ${parsed.message || parsed.error}`);
							// Clear auth on refresh failure
							this.auth = null;
							this.db.clearAuth();
							reject(new Error(`Token refresh failed: ${parsed.message || parsed.error || res.statusCode}`));
						}
					} catch (e) {
						reject(new Error(`Failed to parse refresh response: ${data}`));
					}
				});
			});

			req.on("error", reject);
			req.write(postData);
			req.end();
		});
	}

	/**
	 * Legacy callback handler for Implicit Flow (still supported for backwards compatibility)
	 */
	async handleCallback(accessToken) {
		// Accept access token directly (already extracted by client-side JS)
		if (!accessToken) {
			throw new Error("No access token in callback");
		}

		// Validate token and get user info
		const userData = await this.validateToken(accessToken);

		// Save auth data (no refresh token in Implicit Flow)
		this.auth = {
			access_token: accessToken,
			refresh_token: null,
			user_id: userData.user_id,
			user_login: userData.login,
			user_display_name: userData.login,
			expires_at: Date.now() + (60 * 24 * 60 * 60 * 1000) // 60 days estimate
		};

		this.db.saveAuth(this.auth);
		console.log(`✓ Authenticated as: ${this.auth.user_login} (Implicit Flow - no auto-refresh)`);
	}

	async validateToken(accessToken) {
		const options = {
			hostname: "id.twitch.tv",
			path: "/oauth2/validate",
			method: "GET",
			headers: {
				"Authorization": `Bearer ${accessToken}`
			}
		};

		return new Promise((resolve, reject) => {
			const req = https.request(options, (res) => {
				let data = "";

				res.on("data", (chunk) => {
					data += chunk;
				});

				res.on("end", () => {
					if (res.statusCode === 200) {
						resolve(JSON.parse(data));
					} else {
						reject(new Error(`Token validation failed: ${res.statusCode}`));
					}
				});
			});

			req.on("error", reject);
			req.end();
		});
	}

	logout() {
		this.auth = null;
		this.db.clearAuth();
		console.log("✓ Logged out");
	}

	async makeRequest(endpoint, options = {}) {
		if (!this.isAuthenticated()) {
			throw new Error("Not authenticated");
		}

		// Ensure valid token before making request (auto-refresh if needed)
		await this.ensureValidToken();

		// Ensure baseUrl ends with / and endpoint doesn't start with /
		const baseUrl = this.config.apiBaseUrl.endsWith('/')
			? this.config.apiBaseUrl
			: this.config.apiBaseUrl + '/';
		const cleanEndpoint = endpoint.startsWith('/') ? endpoint.substring(1) : endpoint;
		const url = new URL(cleanEndpoint, baseUrl);

		if (options.query) {
			Object.entries(options.query).forEach(([key, value]) => {
				// Handle arrays (e.g., multiple user_id parameters)
				if (Array.isArray(value)) {
					value.forEach(v => url.searchParams.append(key, v));
				} else {
					url.searchParams.append(key, value);
				}
			});
		}

		const requestOptions = {
			method: options.method || "GET",
			headers: {
				"Client-ID": this.config.clientId,
				"Authorization": `Bearer ${this.auth.access_token}`,
				"Content-Type": "application/json"
			}
		};

		// Debug logging
		console.log(`[API] ${requestOptions.method} ${url.toString()}`);

		return new Promise((resolve, reject) => {
			const req = https.request(url, requestOptions, (res) => {
				let data = "";

				res.on("data", (chunk) => {
					data += chunk;
				});

				res.on("end", () => {
					console.log(`[API] Response ${res.statusCode}: ${data.substring(0, 200)}`);

					if (res.statusCode >= 200 && res.statusCode < 300) {
						try {
							resolve(JSON.parse(data));
						} catch (e) {
							resolve(data);
						}
					} else {
						reject(new Error(`API request failed: ${res.statusCode} - ${data}`));
					}
				});
			});

			req.on("error", reject);

			if (options.body) {
				req.write(JSON.stringify(options.body));
			}

			req.end();
		});
	}

	async getFollowedChannels() {
		if (!this.auth || !this.auth.user_id) {
			throw new Error("Not authenticated");
		}

		// Use the new /channels/followed endpoint
		const response = await this.makeRequest("/channels/followed", {
			query: {
				user_id: this.auth.user_id,
				first: 100
			}
		});

		// Cache in database
		if (response.data) {
			this.db.saveFollowedChannels(response.data);
		}

		return response.data || [];
	}

	async getLiveStreams() {
		if (!this.auth || !this.auth.user_id) {
			throw new Error("Not authenticated");
		}

		// Use the new /streams/followed endpoint - directly returns live streams
		const response = await this.makeRequest("/streams/followed", {
			query: {
				user_id: this.auth.user_id,
				first: 100
			}
		});

		return response.data || [];
	}

	async getFeaturedStreams() {
		// Get top streams - requires authentication since May 2020
		if (!this.isAuthenticated()) {
			throw new Error("Authentication required to fetch streams");
		}

		const response = await this.makeRequest("/streams", {
			query: {
				first: 20
			}
		});

		return response.data || [];
	}

	async searchChannels(query) {
		const response = await this.makeRequest("/search/channels", {
			query: {
				query: query,
				first: 20
			}
		});

		return response.data || [];
	}

	/**
	 * Get stream info for specific channel logins
	 * Used for recording manager to check if specific channels are live
	 */
	async getStreamsByLogins(logins) {
		if (!this.isAuthenticated()) {
			throw new Error("Not authenticated");
		}

		if (!logins || logins.length === 0) {
			return [];
		}

		// Twitch API allows up to 100 logins per request
		const response = await this.makeRequest("/streams", {
			query: {
				user_login: logins,
				first: 100
			}
		});

		return response.data || [];
	}

	/**
	 * Get user info for specific user IDs (includes profile_image_url)
	 */
	async getUsersByIds(userIds) {
		if (!this.isAuthenticated() || !userIds || userIds.length === 0) {
			return [];
		}

		// Twitch API allows up to 100 IDs per request
		const response = await this.makeRequest("/users", {
			query: {
				id: userIds.slice(0, 100)
			}
		});

		return response.data || [];
	}

	/**
	 * Search games by name
	 */
	async searchGames(query) {
		if (!this.isAuthenticated()) {
			throw new Error("Not authenticated");
		}

		const response = await this.makeRequest("/search/categories", {
			query: {
				query: query,
				first: 20
			}
		});

		return response.data || [];
	}

	async getChannel(channelName) {
		const response = await this.makeRequest("/users", {
			query: {
				login: channelName
			}
		});

		if (!response.data || response.data.length === 0) {
			throw new Error("Channel not found");
		}

		const user = response.data[0];

		// Get stream info if live
		const streamResponse = await this.makeRequest("/streams", {
			query: {
				user_id: user.id
			}
		});

		return {
			user,
			stream: streamResponse.data && streamResponse.data.length > 0 ? streamResponse.data[0] : null
		};
	}

	/**
	 * Get streams by user IDs
	 * @param {string[]} userIds - Array of Twitch user IDs
	 */
	async getStreamsByUserIds(userIds) {
		if (!this.isAuthenticated() || !userIds || userIds.length === 0) {
			return [];
		}

		const response = await this.makeRequest("/streams", {
			query: {
				user_id: userIds,
				first: userIds.length
			}
		});

		return response.data || [];
	}

	// Export current token for manual configuration (e.g., NAS deployment)
	exportToken() {
		if (!this.auth || !this.auth.access_token) {
			return null;
		}

		return {
			access_token: this.auth.access_token,
			user_id: this.auth.user_id,
			user_login: this.auth.user_login,
			user_display_name: this.auth.user_display_name,
			expires_at: this.auth.expires_at
		};
	}

	/**
	 * Get VODs (Videos) for followed channels or a specific channel
	 * @param {string} userId - Optional: specific user ID. If not provided, gets VODs from followed channels
	 * @param {number} limit - Number of videos to fetch per channel
	 * @param {string} type - Video type: "archive" (past broadcasts), "highlight", "upload", or "all"
	 */
	async getVideos(userId = null, limit = 20, type = "archive") {
		if (!this.isAuthenticated()) {
			throw new Error("Not authenticated");
		}

		if (userId) {
			// Get videos for a specific channel
			const response = await this.makeRequest("/videos", {
				query: {
					user_id: userId,
					first: limit,
					type: type
				}
			});
			return response.data || [];
		}

		// Get videos from followed channels
		const followedChannels = await this.getFollowedChannels();
		if (followedChannels.length === 0) {
			return [];
		}

		// Fetch videos for each followed channel (in parallel, max 5 at a time)
		const allVideos = [];
		const batchSize = 5;

		for (let i = 0; i < followedChannels.length; i += batchSize) {
			const batch = followedChannels.slice(i, i + batchSize);
			const promises = batch.map(async (channel) => {
				try {
					const response = await this.makeRequest("/videos", {
						query: {
							user_id: channel.broadcaster_id,
							first: 5, // Get 5 recent videos per channel
							type: type
						}
					});
					return (response.data || []).map(video => ({
						...video,
						broadcaster_name: channel.broadcaster_name,
						broadcaster_login: channel.broadcaster_login
					}));
				} catch (error) {
					console.error(`Error fetching videos for ${channel.broadcaster_login}:`, error.message);
					return [];
				}
			});

			const results = await Promise.all(promises);
			results.forEach(videos => allVideos.push(...videos));
		}

		// Sort by created_at (newest first) and limit
		return allVideos
			.sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
			.slice(0, limit);
	}

	/**
	 * Get Clips for followed channels or a specific channel
	 * @param {string} broadcasterId - Optional: specific broadcaster ID
	 * @param {number} limit - Number of clips to fetch
	 * @param {string} period - Time period: "day", "week", "month", "all"
	 */
	async getClips(broadcasterId = null, limit = 20, period = "week") {
		if (!this.isAuthenticated()) {
			throw new Error("Not authenticated");
		}

		// Calculate start date based on period
		const now = new Date();
		let startedAt;
		switch (period) {
			case "day":
				startedAt = new Date(now - 24 * 60 * 60 * 1000);
				break;
			case "week":
				startedAt = new Date(now - 7 * 24 * 60 * 60 * 1000);
				break;
			case "month":
				startedAt = new Date(now - 30 * 24 * 60 * 60 * 1000);
				break;
			default:
				startedAt = null;
		}

		if (broadcasterId) {
			// Get clips for a specific channel
			const query = {
				broadcaster_id: broadcasterId,
				first: limit
			};
			if (startedAt) {
				query.started_at = startedAt.toISOString();
				query.ended_at = now.toISOString();
			}

			const response = await this.makeRequest("/clips", { query });
			return response.data || [];
		}

		// Get clips from followed channels
		const followedChannels = await this.getFollowedChannels();
		if (followedChannels.length === 0) {
			return [];
		}

		// Fetch clips for each followed channel (in parallel, max 5 at a time)
		const allClips = [];
		const batchSize = 5;

		for (let i = 0; i < followedChannels.length; i += batchSize) {
			const batch = followedChannels.slice(i, i + batchSize);
			const promises = batch.map(async (channel) => {
				try {
					const query = {
						broadcaster_id: channel.broadcaster_id,
						first: 5 // Get 5 recent clips per channel
					};
					if (startedAt) {
						query.started_at = startedAt.toISOString();
						query.ended_at = now.toISOString();
					}

					const response = await this.makeRequest("/clips", { query });
					return response.data || [];
				} catch (error) {
					console.error(`Error fetching clips for ${channel.broadcaster_login}:`, error.message);
					return [];
				}
			});

			const results = await Promise.all(promises);
			results.forEach(clips => allClips.push(...clips));
		}

		// Sort by view_count (most viewed first) and limit
		return allClips
			.sort((a, b) => b.view_count - a.view_count)
			.slice(0, limit);
	}
}

module.exports = TwitchAPI;
