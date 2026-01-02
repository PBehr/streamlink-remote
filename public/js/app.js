// Main Application
class App {
	constructor() {
		this.currentView = "live";
		this.isAuthenticated = false;
		this.settings = {};
		this.favorites = new Set(); // Track favorite channels
		this.init();
	}

	async init() {
		console.log("🚀 Initializing Streamlink Remote...");

		// Setup event listeners
		this.setupNavigation();
		this.setupAuth();
		this.setupSearch();
		this.setupSettings();
		this.setupRefresh();

		// Connect WebSocket
		wsClient.connect();
		this.setupWebSocketHandlers();

		// Load initial data
		await this.loadAuthStatus();
		await this.loadFavorites();
		await this.loadView(this.currentView);
	}

	// Favorites
	async loadFavorites() {
		try {
			const favorites = await api.getFavorites();
			this.favorites = new Set(favorites.map(f => f.channel_login.toLowerCase()));
		} catch (error) {
			console.error("Error loading favorites:", error);
		}
	}

	async toggleFavorite(channel, displayName, event) {
		event.stopPropagation(); // Don't trigger card click
		const lowerChannel = channel.toLowerCase();

		try {
			if (this.favorites.has(lowerChannel)) {
				await api.removeFavorite(channel);
				this.favorites.delete(lowerChannel);
				this.showToast(`Removed ${displayName} from favorites`, "success");
			} else {
				await api.addFavorite(channel, displayName);
				this.favorites.add(lowerChannel);
				this.showToast(`Added ${displayName} to favorites`, "success");
			}
			// Update the star button state
			this.updateFavoriteButtons();
		} catch (error) {
			this.showToast(`Error updating favorite: ${error.message}`, "error");
		}
	}

	updateFavoriteButtons() {
		document.querySelectorAll(".favorite-btn").forEach(btn => {
			const channel = btn.dataset.channel.toLowerCase();
			const isFav = this.favorites.has(channel);
			btn.classList.toggle("is-favorite", isFav);
			btn.innerHTML = isFav ? "★" : "☆";
			btn.title = isFav ? "Remove from favorites" : "Add to favorites";
		});
	}

	// Navigation
	setupNavigation() {
		const navItems = document.querySelectorAll(".nav-item");

		navItems.forEach((item) => {
			item.addEventListener("click", () => {
				const view = item.dataset.view;
				this.switchView(view);
			});
		});
	}

	async switchView(viewName) {
		// Update navigation
		document.querySelectorAll(".nav-item").forEach((item) => {
			item.classList.toggle("active", item.dataset.view === viewName);
		});

		// Update views
		document.querySelectorAll(".view").forEach((view) => {
			view.classList.toggle("active", view.id === `view-${viewName}`);
		});

		this.currentView = viewName;

		// Load view data
		await this.loadView(viewName);
	}

	async loadView(viewName) {
		this.showLoading();

		try {
			switch (viewName) {
				case "live":
					await this.loadLiveStreams();
					break;
				case "featured":
					await this.loadFeaturedStreams();
					break;
				case "active":
					await this.loadActiveStreams();
					break;
				case "search":
					// Search is manual
					break;
				case "settings":
					await this.loadSettings();
					break;
			}
		} catch (error) {
			this.showToast(`Error loading ${viewName}: ${error.message}`, "error");
		} finally {
			this.hideLoading();
		}
	}

	// Auth
	setupAuth() {
		// Auth button will be added dynamically based on status
	}

	async loadAuthStatus() {
		try {
			const data = await api.getAuthStatus();
			this.isAuthenticated = data.authenticated;
			this.updateAuthUI(data);
		} catch (error) {
			console.error("Error loading auth status:", error);
			this.isAuthenticated = false;
			this.updateAuthUI({ authenticated: false });
		}
	}

	updateAuthUI(data) {
		const authStatus = document.getElementById("auth-status");

		if (data.authenticated && data.user) {
			authStatus.innerHTML = `
				<span>👤 ${data.user.display_name || data.user.login}</span>
				<button id="logout-btn" class="btn btn-small">Logout</button>
			`;

			document.getElementById("logout-btn").addEventListener("click", () => {
				this.logout();
			});
		} else {
			authStatus.innerHTML = `
				<button id="login-btn" class="btn btn-primary btn-small">Login with Twitch</button>
			`;

			document.getElementById("login-btn").addEventListener("click", () => {
				this.login();
			});
		}
	}

	async login() {
		try {
			const data = await api.getAuthLoginUrl();

			// Open auth URL in new window
			const authWindow = window.open(
				data.authUrl,
				"Twitch Auth",
				"width=600,height=800"
			);

			// Poll for auth completion
			const pollInterval = setInterval(async () => {
				try {
					const status = await api.getAuthStatus();
					if (status.authenticated) {
						clearInterval(pollInterval);
						if (authWindow && !authWindow.closed) {
							authWindow.close();
						}
						this.showToast("Successfully logged in!", "success");
						await this.loadAuthStatus();
						if (this.currentView === "live") {
							await this.loadLiveStreams();
						}
					}
				} catch (error) {
					// Ignore polling errors
				}
			}, 2000);

			// Stop polling if window is closed
			const checkWindow = setInterval(() => {
				if (authWindow && authWindow.closed) {
					clearInterval(pollInterval);
					clearInterval(checkWindow);
				}
			}, 1000);
		} catch (error) {
			this.showToast(`Login error: ${error.message}`, "error");
		}
	}

	async logout() {
		try {
			await api.logout();
			this.isAuthenticated = false;
			this.showToast("Logged out successfully", "success");
			await this.loadAuthStatus();
			document.getElementById("live-streams").innerHTML = "";
			document.getElementById("live-empty").classList.remove("hidden");
		} catch (error) {
			this.showToast(`Logout error: ${error.message}`, "error");
		}
	}

	// Live Streams
	async loadLiveStreams() {
		const container = document.getElementById("live-streams");
		const emptyState = document.getElementById("live-empty");

		if (!this.isAuthenticated) {
			container.innerHTML = "";
			emptyState.innerHTML = `
				<p>Please log in to see live streams from your followed channels</p>
				<button class="btn btn-primary" onclick="app.login()">Login with Twitch</button>
			`;
			emptyState.classList.remove("hidden");
			return;
		}

		try {
			const data = await api.getLiveStreams();
			const streams = data.streams || [];

			if (streams.length === 0) {
				container.innerHTML = "";
				emptyState.classList.remove("hidden");
			} else {
				emptyState.classList.add("hidden");
				container.innerHTML = streams.map((stream) => this.renderStreamCard(stream)).join("");
				this.attachStreamCardListeners();
			}
		} catch (error) {
			this.showToast(`Error loading live streams: ${error.message}`, "error");
		}
	}

	// Featured Streams
	async loadFeaturedStreams() {
		const container = document.getElementById("featured-streams");

		try {
			const data = await api.getFeaturedStreams();
			const streams = data.streams || [];

			container.innerHTML = streams.map((stream) => this.renderStreamCard(stream)).join("");
			this.attachStreamCardListeners();
		} catch (error) {
			this.showToast(`Error loading featured streams: ${error.message}`, "error");
		}
	}

	// Search
	setupSearch() {
		const searchInput = document.getElementById("search-input");
		const searchBtn = document.getElementById("search-btn");

		const performSearch = async () => {
			const query = searchInput.value.trim();
			if (!query) return;

			this.showLoading();

			try {
				const data = await api.searchChannels(query);
				const results = data.results || [];

				const container = document.getElementById("search-results");
				const emptyState = document.getElementById("search-empty");

				if (results.length === 0) {
					container.innerHTML = "";
					emptyState.innerHTML = `<p>No results found for "${query}"</p>`;
					emptyState.classList.remove("hidden");
				} else {
					emptyState.classList.add("hidden");
					container.innerHTML = results.map((channel) => this.renderChannelCard(channel)).join("");
					this.attachChannelCardListeners();
				}
			} catch (error) {
				this.showToast(`Search error: ${error.message}`, "error");
			} finally {
				this.hideLoading();
			}
		};

		searchBtn.addEventListener("click", performSearch);
		searchInput.addEventListener("keypress", (e) => {
			if (e.key === "Enter") {
				performSearch();
			}
		});
	}

	// Active Streams
	async loadActiveStreams() {
		const container = document.getElementById("active-streams");
		const emptyState = document.getElementById("active-empty");

		try {
			const data = await api.getActiveStreams();
			const streams = data.streams || [];

			// Update badge
			document.getElementById("active-count").textContent = streams.length;

			if (streams.length === 0) {
				container.innerHTML = "";
				emptyState.classList.remove("hidden");
			} else {
				emptyState.classList.add("hidden");
				container.innerHTML = streams.map((stream) => this.renderActiveStreamCard(stream)).join("");
				this.attachActiveStreamListeners();
			}
		} catch (error) {
			this.showToast(`Error loading active streams: ${error.message}`, "error");
		}
	}

	// Settings
	setupSettings() {
		const saveBtn = document.getElementById("save-settings-btn");
		saveBtn.addEventListener("click", () => this.saveSettings());
	}

	async loadSettings() {
		try {
			const settings = await api.getSettings();
			this.settings = settings;

			// Update UI
			document.getElementById("quality-select").value = settings.defaultQuality || "best";
			document.getElementById("low-latency-check").checked = settings.lowLatency || false;

			// Update account info
			const accountInfo = document.getElementById("account-info");
			if (this.isAuthenticated) {
				const authStatus = await api.getAuthStatus();
				accountInfo.innerHTML = `
					<p><strong>Logged in as:</strong> ${authStatus.user.display_name || authStatus.user.login}</p>
					<button class="btn btn-error btn-small" onclick="app.logout()">Logout</button>
				`;
			} else {
				accountInfo.innerHTML = `
					<p>Not logged in</p>
					<button class="btn btn-primary btn-small" onclick="app.login()">Login with Twitch</button>
				`;
			}
		} catch (error) {
			this.showToast(`Error loading settings: ${error.message}`, "error");
		}
	}

	async saveSettings() {
		try {
			const settings = {
				defaultQuality: document.getElementById("quality-select").value,
				lowLatency: document.getElementById("low-latency-check").checked
			};

			await api.updateSettings(settings);
			this.settings = settings;
			this.showToast("Settings saved successfully", "success");
		} catch (error) {
			this.showToast(`Error saving settings: ${error.message}`, "error");
		}
	}

	// Refresh
	setupRefresh() {
		const refreshBtn = document.getElementById("refresh-btn");
		refreshBtn.addEventListener("click", () => {
			this.loadView(this.currentView);
		});
	}

	// WebSocket Handlers
	setupWebSocketHandlers() {
		wsClient.on("stream:started", (data) => {
			this.showToast(`Stream started: ${data.channel}`, "success");
			if (this.currentView === "active") {
				this.loadActiveStreams();
			}
			this.updateActiveCount();
		});

		wsClient.on("stream:ended", (data) => {
			this.showToast(`Stream ended: ${data.channel}`, "success");
			if (this.currentView === "active") {
				this.loadActiveStreams();
			}
			this.updateActiveCount();
		});

		wsClient.on("stream:error", (data) => {
			this.showToast(`Stream error (${data.channel}): ${data.error}`, "error");
		});
	}

	async updateActiveCount() {
		try {
			const data = await api.getActiveStreams();
			document.getElementById("active-count").textContent = (data.streams || []).length;
		} catch (error) {
			// Ignore
		}
	}

	// Stream Actions
	async startStream(channel, user_name) {
		this.showLoading();

		try {
			const quality = this.settings.defaultQuality || "best";
			const result = await api.startStream(channel, quality);

			this.showStreamModal(channel, user_name, result);
		} catch (error) {
			this.showToast(`Error starting stream: ${error.message}`, "error");
		} finally {
			this.hideLoading();
		}
	}

	async stopStream(channel) {
		try {
			await api.stopStream(channel);
			this.showToast(`Stopped stream: ${channel}`, "success");

			if (this.currentView === "active") {
				await this.loadActiveStreams();
			}
		} catch (error) {
			this.showToast(`Error stopping stream: ${error.message}`, "error");
		}
	}

	// Rendering
	renderStreamCard(stream) {
		const thumbnail = stream.thumbnail_url
			.replace("{width}", "440")
			.replace("{height}", "248");
		const isFavorite = this.favorites.has(stream.user_login.toLowerCase());

		return `
			<div class="stream-card" data-channel="${stream.user_login}" data-username="${stream.user_name}">
				<div class="stream-thumbnail-container">
					<img src="${thumbnail}" alt="${stream.title}" class="stream-thumbnail">
					<button class="favorite-btn ${isFavorite ? 'is-favorite' : ''}"
					        data-channel="${stream.user_login}"
					        data-username="${this.escapeHtml(stream.user_name)}"
					        title="${isFavorite ? 'Remove from favorites' : 'Add to favorites'}">
						${isFavorite ? '★' : '☆'}
					</button>
				</div>
				<div class="stream-info">
					<div class="stream-header">
						<div class="stream-details">
							<div class="stream-title">${this.escapeHtml(stream.title)}</div>
							<div class="stream-channel">${this.escapeHtml(stream.user_name)}</div>
						</div>
					</div>
					<div class="stream-meta">
						<span class="live-badge">LIVE</span>
						<span>👁 ${this.formatViewers(stream.viewer_count)}</span>
						<span>${this.escapeHtml(stream.game_name || "")}</span>
					</div>
				</div>
			</div>
		`;
	}

	renderChannelCard(channel) {
		return `
			<div class="stream-card" data-channel="${channel.broadcaster_login}" data-username="${channel.display_name}">
				<img src="${channel.thumbnail_url}" alt="${channel.display_name}" class="stream-thumbnail">
				<div class="stream-info">
					<div class="stream-header">
						<img src="${channel.thumbnail_url}" alt="${channel.display_name}" class="stream-avatar">
						<div class="stream-details">
							<div class="stream-title">${this.escapeHtml(channel.display_name)}</div>
							<div class="stream-channel">${this.escapeHtml(channel.broadcaster_login)}</div>
						</div>
					</div>
					${channel.is_live ? '<div class="stream-meta"><span class="live-badge">LIVE</span></div>' : ""}
				</div>
			</div>
		`;
	}

	renderActiveStreamCard(stream) {
		const uptime = this.formatUptime(stream.uptime);

		return `
			<div class="active-stream-card" data-channel="${stream.channel}">
				<div class="active-stream-header">
					<div class="active-stream-info">
						<h3>${this.escapeHtml(stream.channel)}</h3>
						<div class="active-stream-quality">Quality: ${stream.quality} • Uptime: ${uptime}</div>
					</div>
				</div>
				<div class="active-stream-url">
					<code>${stream.url}</code>
					<button class="btn btn-small" onclick="app.copyToClipboard('${stream.url}')">Copy</button>
				</div>
				<div class="active-stream-actions">
					<button class="btn btn-small" onclick="app.openInPlayer('${stream.url}')">Open in VLC</button>
					<button class="btn btn-error btn-small" onclick="app.stopStream('${stream.channel}')">Stop Stream</button>
				</div>
			</div>
		`;
	}

	attachStreamCardListeners() {
		document.querySelectorAll(".stream-card").forEach((card) => {
			card.addEventListener("click", (e) => {
				// Don't start stream if clicking on favorite button
				if (e.target.classList.contains("favorite-btn")) return;
				const channel = card.dataset.channel;
				const username = card.dataset.username;
				this.startStream(channel, username);
			});
		});

		// Attach favorite button listeners
		document.querySelectorAll(".favorite-btn").forEach((btn) => {
			btn.addEventListener("click", (e) => {
				const channel = btn.dataset.channel;
				const username = btn.dataset.username;
				this.toggleFavorite(channel, username, e);
			});
		});
	}

	attachChannelCardListeners() {
		document.querySelectorAll(".stream-card").forEach((card) => {
			card.addEventListener("click", () => {
				const channel = card.dataset.channel;
				const username = card.dataset.username;
				this.startStream(channel, username);
			});
		});
	}

	attachActiveStreamListeners() {
		// Already handled via onclick attributes
	}

	// Modal
	showStreamModal(channel, username, result) {
		const modal = document.getElementById("stream-modal");
		const modalBody = document.getElementById("modal-body");

		modalBody.innerHTML = `
			<h2>🎬 ${this.escapeHtml(username || channel)}</h2>
			<p>Stream is now running!</p>
			<div class="active-stream-url">
				<code>${result.url}</code>
				<button class="btn btn-small" onclick="app.copyToClipboard('${result.url}')">Copy</button>
			</div>
			<div style="margin-top: 1rem;">
				<button class="btn btn-primary" onclick="app.openInPlayer('${result.url}')">Open in VLC</button>
				<button class="btn" onclick="app.closeModal()">Close</button>
			</div>
			<p style="margin-top: 1rem; color: var(--text-muted); font-size: 0.875rem;">
				💡 Tip: You can find this URL in the "Active" tab
			</p>
		`;

		modal.classList.remove("hidden");

		// Close on overlay click
		modal.querySelector(".modal-overlay").addEventListener("click", () => {
			this.closeModal();
		});

		modal.querySelector(".modal-close").addEventListener("click", () => {
			this.closeModal();
		});
	}

	closeModal() {
		document.getElementById("stream-modal").classList.add("hidden");
	}

	// Utilities
	async copyToClipboard(text) {
		try {
			await navigator.clipboard.writeText(text);
			this.showToast("Copied to clipboard!", "success");
		} catch (error) {
			this.showToast("Failed to copy to clipboard", "error");
		}
	}

	openInPlayer(url) {
		// Try to open VLC URL scheme
		window.location.href = `vlc://${url}`;

		// Also show toast with URL
		this.showToast(`Opening in VLC: ${url}`, "success");
	}

	showLoading() {
		document.getElementById("loading").classList.remove("hidden");
	}

	hideLoading() {
		document.getElementById("loading").classList.add("hidden");
	}

	showToast(message, type = "success") {
		const container = document.getElementById("toast-container");
		const toast = document.createElement("div");
		toast.className = `toast ${type}`;
		toast.textContent = message;

		container.appendChild(toast);

		setTimeout(() => {
			toast.remove();
		}, 5000);
	}

	formatViewers(count) {
		if (count >= 1000) {
			return `${(count / 1000).toFixed(1)}K`;
		}
		return count.toString();
	}

	formatUptime(ms) {
		const seconds = Math.floor(ms / 1000);
		const minutes = Math.floor(seconds / 60);
		const hours = Math.floor(minutes / 60);

		if (hours > 0) {
			return `${hours}h ${minutes % 60}m`;
		} else if (minutes > 0) {
			return `${minutes}m`;
		} else {
			return `${seconds}s`;
		}
	}

	escapeHtml(text) {
		const div = document.createElement("div");
		div.textContent = text;
		return div.innerHTML;
	}
}

// Initialize app when DOM is ready
document.addEventListener("DOMContentLoaded", () => {
	window.app = new App();
});
