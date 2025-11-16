const https = require("https");
const http = require("http");
const { URL } = require("url");

class TwitchAPI {
	constructor(config, db) {
		this.config = config;
		this.db = db;
		this.auth = null;

		// Load auth from database
		this.loadAuth();
	}

	loadAuth() {
		// Check for manual token in config first
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

			// Check if token is expired
			if (this.auth.expires_at && Date.now() > this.auth.expires_at) {
				console.log("⚠ Access token expired");
				this.auth = null;
				this.db.clearAuth();
			}
		}
	}

	isAuthenticated() {
		return this.auth !== null && this.auth.access_token !== null;
	}

	getUser() {
		if (!this.auth) return null;

		return {
			id: this.auth.user_id,
			login: this.auth.user_login,
			display_name: this.auth.user_display_name
		};
	}

	getAuthUrl() {
		const params = new URLSearchParams({
			client_id: this.config.clientId,
			redirect_uri: this.config.redirectUri,
			response_type: "token",
			scope: this.config.scopes.join(" ")
		});

		return `https://id.twitch.tv/oauth2/authorize?${params.toString()}`;
	}

	async handleCallback(accessToken) {
		// Accept access token directly (already extracted by client-side JS)
		if (!accessToken) {
			throw new Error("No access token in callback");
		}

		// Validate token and get user info
		const userData = await this.validateToken(accessToken);

		// Save auth data
		this.auth = {
			access_token: accessToken,
			refresh_token: null,
			user_id: userData.user_id,
			user_login: userData.login,
			user_display_name: userData.login,
			expires_at: Date.now() + (60 * 24 * 60 * 60 * 1000) // 60 days
		};

		this.db.saveAuth(this.auth);
		console.log(`✓ Authenticated as: ${this.auth.user_login}`);
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
}

module.exports = TwitchAPI;
