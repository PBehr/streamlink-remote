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
		this.setupYouTube();
		this.setupVods();
		this.setupClips();

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
				case "vods":
					await this.loadVods();
					break;
				case "clips":
					await this.loadClips();
					break;
				case "youtube":
					await this.loadYouTube();
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

	// VODs
	setupVods() {
		const typeSelect = document.getElementById("vods-type-select");
		const channelSelect = document.getElementById("vods-channel-select");

		if (typeSelect) {
			typeSelect.addEventListener("change", () => this.loadVods());
		}
		if (channelSelect) {
			channelSelect.addEventListener("change", () => this.loadVods());
		}
	}

	async loadVods() {
		const container = document.getElementById("vods-list");
		const emptyState = document.getElementById("vods-empty");
		const typeSelect = document.getElementById("vods-type-select");
		const channelSelect = document.getElementById("vods-channel-select");
		const type = typeSelect ? typeSelect.value : "archive";
		const selectedChannel = channelSelect ? channelSelect.value : "";

		try {
			// Populate channel dropdown if empty
			if (channelSelect && channelSelect.options.length <= 1) {
				await this.populateChannelDropdown(channelSelect);
			}

			let data;
			let videos;

			if (selectedChannel === "favorites") {
				// Fetch all VODs and filter by favorites
				data = await api.getVods(null, 100, type);
				videos = (data.videos || []).filter(video => {
					const login = (video.user_login || video.broadcaster_login || "").toLowerCase();
					return this.favorites.has(login);
				});
			} else {
				data = await api.getVods(selectedChannel || null, 50, type);
				videos = data.videos || [];
			}

			if (videos.length === 0) {
				container.innerHTML = "";
				emptyState.classList.remove("hidden");
			} else {
				emptyState.classList.add("hidden");
				container.innerHTML = videos.map(video => this.renderVodCard(video)).join("");
				this.attachVodListeners();
			}
		} catch (error) {
			this.showToast(`Error loading VODs: ${error.message}`, "error");
		}
	}

	renderVodCard(video) {
		const duration = this.formatDuration(video.duration);
		const dateStr = new Date(video.created_at).toLocaleDateString("de-DE", {
			day: "2-digit",
			month: "2-digit",
			year: "numeric"
		});
		const thumbnail = video.thumbnail_url
			? video.thumbnail_url.replace('%{width}', '320').replace('%{height}', '180')
			: '';
		const channelName = video.user_name || video.broadcaster_name || 'Unknown';

		return `
			<div class="stream-card vod-card" data-video-id="${video.id}" data-title="${this.escapeHtml(video.title)}" data-channel="${this.escapeHtml(channelName)}">
				<div class="stream-thumbnail-container">
					<img src="${thumbnail}" alt="${this.escapeHtml(video.title)}" class="stream-thumbnail">
					<span class="vod-badge">VOD</span>
					<span class="vod-duration">${duration}</span>
				</div>
				<div class="stream-info">
					<div class="stream-header">
						<div class="stream-details">
							<div class="stream-title">${this.escapeHtml(video.title)}</div>
							<div class="stream-channel">${this.escapeHtml(channelName)}</div>
						</div>
					</div>
					<div class="stream-meta">
						<span>${dateStr}</span>
						<span>${video.view_count?.toLocaleString() || 0} views</span>
					</div>
				</div>
			</div>
		`;
	}

	formatDuration(duration) {
		// Parse ISO 8601 duration (e.g., "3h2m1s")
		const match = duration.match(/(\d+)h|(\d+)m|(\d+)s/g);
		if (!match) return duration;

		let hours = 0, minutes = 0, seconds = 0;
		match.forEach(part => {
			if (part.includes('h')) hours = parseInt(part);
			if (part.includes('m')) minutes = parseInt(part);
			if (part.includes('s')) seconds = parseInt(part);
		});

		if (hours > 0) {
			return `${hours}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
		}
		return `${minutes}:${seconds.toString().padStart(2, '0')}`;
	}

	attachVodListeners() {
		document.querySelectorAll(".vod-card").forEach(card => {
			card.addEventListener("click", () => {
				const videoId = card.dataset.videoId;
				const title = card.dataset.title;
				const channel = card.dataset.channel;
				this.playVod(videoId, title, channel);
			});
		});
	}

	async playVod(videoId, title, channel) {
		const streamHost = window.location.hostname;
		const streamPort = window.location.port || "80";
		const streamUrl = `http://${streamHost}:${streamPort}/vod/${videoId}`;

		this.showVodModal(videoId, title, channel, streamUrl);
	}

	showVodModal(videoId, title, channel, streamUrl) {
		const modal = document.getElementById("stream-modal");
		const modalBody = document.getElementById("modal-body");

		modalBody.innerHTML = `
			<h2>📼 ${this.escapeHtml(title)}</h2>
			<p class="text-muted">${this.escapeHtml(channel)}</p>
			<div class="active-stream-url">
				<code>${streamUrl}</code>
				<button class="btn btn-small" onclick="app.copyToClipboard('${streamUrl}')">Copy</button>
			</div>
			<div style="margin-top: 1rem;">
				<button class="btn btn-primary" onclick="app.openInPlayer('${streamUrl}')">Open in VLC</button>
				<button class="btn" onclick="window.open('https://www.twitch.tv/videos/${videoId}', '_blank')">Open on Twitch</button>
				<button class="btn" onclick="app.closeModal()">Close</button>
			</div>
			<p style="margin-top: 1rem; color: var(--text-muted); font-size: 0.875rem;">
				💡 The stream will start when you open it in a player
			</p>
		`;

		modal.classList.remove("hidden");

		modal.querySelector(".modal-overlay").addEventListener("click", () => {
			this.closeModal();
		});

		modal.querySelector(".modal-close").addEventListener("click", () => {
			this.closeModal();
		});
	}

	// Clips
	setupClips() {
		const periodSelect = document.getElementById("clips-period-select");
		const channelSelect = document.getElementById("clips-channel-select");

		if (periodSelect) {
			periodSelect.addEventListener("change", () => this.loadClips());
		}
		if (channelSelect) {
			channelSelect.addEventListener("change", () => this.loadClips());
		}
	}

	async loadClips() {
		const container = document.getElementById("clips-list");
		const emptyState = document.getElementById("clips-empty");
		const periodSelect = document.getElementById("clips-period-select");
		const channelSelect = document.getElementById("clips-channel-select");
		const period = periodSelect ? periodSelect.value : "day";
		const selectedChannel = channelSelect ? channelSelect.value : "";

		try {
			// Populate channel dropdown if empty
			if (channelSelect && channelSelect.options.length <= 1) {
				await this.populateChannelDropdown(channelSelect);
			}

			let data;
			let clips;

			if (selectedChannel === "favorites") {
				// Fetch all clips and filter by favorites
				data = await api.getClips(null, 100, period);
				clips = (data.clips || []).filter(clip => {
					const login = (clip.broadcaster_login || clip.broadcaster_name || "").toLowerCase();
					return this.favorites.has(login);
				});
			} else {
				data = await api.getClips(selectedChannel || null, 50, period);
				clips = data.clips || [];
			}

			if (clips.length === 0) {
				container.innerHTML = "";
				emptyState.classList.remove("hidden");
			} else {
				emptyState.classList.add("hidden");
				container.innerHTML = clips.map(clip => this.renderClipCard(clip)).join("");
				this.attachClipListeners();
			}
		} catch (error) {
			this.showToast(`Error loading clips: ${error.message}`, "error");
		}
	}

	renderClipCard(clip) {
		const dateStr = new Date(clip.created_at).toLocaleDateString("de-DE", {
			day: "2-digit",
			month: "2-digit",
			year: "numeric"
		});

		return `
			<div class="stream-card clip-card" data-clip-id="${clip.id}" data-title="${this.escapeHtml(clip.title)}" data-channel="${this.escapeHtml(clip.broadcaster_name)}">
				<div class="stream-thumbnail-container">
					<img src="${clip.thumbnail_url}" alt="${this.escapeHtml(clip.title)}" class="stream-thumbnail">
					<span class="clip-badge">Clip</span>
					<span class="clip-duration">${Math.round(clip.duration)}s</span>
				</div>
				<div class="stream-info">
					<div class="stream-header">
						<div class="stream-details">
							<div class="stream-title">${this.escapeHtml(clip.title)}</div>
							<div class="stream-channel">${this.escapeHtml(clip.broadcaster_name)}</div>
						</div>
					</div>
					<div class="stream-meta">
						<span>${dateStr}</span>
						<span>${clip.view_count?.toLocaleString() || 0} views</span>
					</div>
				</div>
			</div>
		`;
	}

	attachClipListeners() {
		document.querySelectorAll(".clip-card").forEach(card => {
			card.addEventListener("click", () => {
				const clipId = card.dataset.clipId;
				const title = card.dataset.title;
				const channel = card.dataset.channel;
				this.playClip(clipId, title, channel);
			});
		});
	}

	async playClip(clipId, title, channel) {
		const streamHost = window.location.hostname;
		const streamPort = window.location.port || "80";
		const streamUrl = `http://${streamHost}:${streamPort}/clip/${clipId}`;

		this.showClipModal(clipId, title, channel, streamUrl);
	}

	showClipModal(clipId, title, channel, streamUrl) {
		const modal = document.getElementById("stream-modal");
		const modalBody = document.getElementById("modal-body");

		modalBody.innerHTML = `
			<h2>✂️ ${this.escapeHtml(title)}</h2>
			<p class="text-muted">${this.escapeHtml(channel)}</p>
			<div class="active-stream-url">
				<code>${streamUrl}</code>
				<button class="btn btn-small" onclick="app.copyToClipboard('${streamUrl}')">Copy</button>
			</div>
			<div style="margin-top: 1rem;">
				<button class="btn btn-primary" onclick="app.openInPlayer('${streamUrl}')">Open in VLC</button>
				<button class="btn" onclick="window.open('https://clips.twitch.tv/${clipId}', '_blank')">Open on Twitch</button>
				<button class="btn" onclick="app.closeModal()">Close</button>
			</div>
			<p style="margin-top: 1rem; color: var(--text-muted); font-size: 0.875rem;">
				💡 The stream will start when you open it in a player
			</p>
		`;

		modal.classList.remove("hidden");

		modal.querySelector(".modal-overlay").addEventListener("click", () => {
			this.closeModal();
		});

		modal.querySelector(".modal-close").addEventListener("click", () => {
			this.closeModal();
		});
	}

	// YouTube
	setupYouTube() {
		const addBtn = document.getElementById("youtube-add-btn");
		const input = document.getElementById("youtube-channel-input");

		const addChannel = async () => {
			const url = input.value.trim();
			if (!url) return;

			this.showLoading();
			try {
				const result = await api.addYoutubeChannel(url);
				this.showToast(`Added channel: ${result.channel.channel_name}`, "success");
				input.value = "";
				await this.loadYouTube();
			} catch (error) {
				this.showToast(`Error adding channel: ${error.message}`, "error");
			} finally {
				this.hideLoading();
			}
		};

		addBtn.addEventListener("click", addChannel);
		input.addEventListener("keypress", (e) => {
			if (e.key === "Enter") {
				addChannel();
			}
		});
	}

	async loadYouTube() {
		const channelsList = document.getElementById("youtube-channels-list");
		const videosContainer = document.getElementById("youtube-videos");
		const emptyState = document.getElementById("youtube-empty");

		try {
			// Load channels
			const channels = await api.getYoutubeChannels();

			if (channels.length === 0) {
				channelsList.innerHTML = "";
				videosContainer.innerHTML = "";
				emptyState.classList.remove("hidden");
				return;
			}

			emptyState.classList.add("hidden");

			// Render channel tags
			channelsList.innerHTML = channels.map(channel => `
				<div class="youtube-channel-tag" data-channel-id="${channel.channel_id}">
					<span class="channel-name">${this.escapeHtml(channel.channel_name)}</span>
					<button class="remove-channel-btn" title="Remove channel">&times;</button>
				</div>
			`).join("");

			// Attach remove listeners
			channelsList.querySelectorAll(".remove-channel-btn").forEach(btn => {
				btn.addEventListener("click", async (e) => {
					const tag = e.target.closest(".youtube-channel-tag");
					const channelId = tag.dataset.channelId;
					try {
						await api.removeYoutubeChannel(channelId);
						this.showToast("Channel removed", "success");
						await this.loadYouTube();
					} catch (error) {
						this.showToast(`Error removing channel: ${error.message}`, "error");
					}
				});
			});

			// Load videos
			const data = await api.getYoutubeVideos(25);
			const videos = data.videos || [];

			if (videos.length === 0) {
				videosContainer.innerHTML = "<p class='text-muted'>No videos found</p>";
			} else {
				videosContainer.innerHTML = videos.map(video => this.renderYouTubeVideoCard(video)).join("");
				this.attachYouTubeVideoListeners();
			}
		} catch (error) {
			this.showToast(`Error loading YouTube: ${error.message}`, "error");
		}
	}

	renderYouTubeVideoCard(video) {
		const dateStr = new Date(video.published).toLocaleDateString("de-DE", {
			day: "2-digit",
			month: "2-digit",
			year: "numeric"
		});

		return `
			<div class="stream-card youtube-card" data-video-id="${video.videoId}" data-title="${this.escapeHtml(video.title)}">
				<div class="stream-thumbnail-container">
					<img src="${video.thumbnail}" alt="${this.escapeHtml(video.title)}" class="stream-thumbnail">
					<span class="youtube-badge">YouTube</span>
				</div>
				<div class="stream-info">
					<div class="stream-header">
						<div class="stream-details">
							<div class="stream-title">${this.escapeHtml(video.title)}</div>
							<div class="stream-channel">${this.escapeHtml(video.channelName)}</div>
						</div>
					</div>
					<div class="stream-meta">
						<span>${dateStr}</span>
					</div>
				</div>
			</div>
		`;
	}

	attachYouTubeVideoListeners() {
		document.querySelectorAll(".youtube-card").forEach(card => {
			card.addEventListener("click", () => {
				const videoId = card.dataset.videoId;
				const title = card.dataset.title;
				this.playYouTubeVideo(videoId, title);
			});
		});
	}

	async playYouTubeVideo(videoId, title) {
		this.showLoading();

		try {
			// Get the stream URL by making a request to our endpoint
			const streamHost = window.location.hostname;
			const streamPort = window.location.port || "80";
			const streamUrl = `http://${streamHost}:${streamPort}/youtube/${videoId}`;

			// Show modal with stream URL
			this.showYouTubeModal(videoId, title, streamUrl);
		} catch (error) {
			this.showToast(`Error playing video: ${error.message}`, "error");
		} finally {
			this.hideLoading();
		}
	}

	showYouTubeModal(videoId, title, streamUrl) {
		const modal = document.getElementById("stream-modal");
		const modalBody = document.getElementById("modal-body");

		modalBody.innerHTML = `
			<h2>🎬 ${this.escapeHtml(title)}</h2>
			<p>Stream URL ready!</p>
			<div class="active-stream-url">
				<code>${streamUrl}</code>
				<button class="btn btn-small" onclick="app.copyToClipboard('${streamUrl}')">Copy</button>
			</div>
			<div style="margin-top: 1rem;">
				<button class="btn btn-primary" onclick="app.openInPlayer('${streamUrl}')">Open in VLC</button>
				<button class="btn" onclick="window.open('https://www.youtube.com/watch?v=${videoId}', '_blank')">Open on YouTube</button>
				<button class="btn" onclick="app.closeModal()">Close</button>
			</div>
			<p style="margin-top: 1rem; color: var(--text-muted); font-size: 0.875rem;">
				💡 The stream will start when you open it in a player
			</p>
		`;

		modal.classList.remove("hidden");

		modal.querySelector(".modal-overlay").addEventListener("click", () => {
			this.closeModal();
		});

		modal.querySelector(".modal-close").addEventListener("click", () => {
			this.closeModal();
		});
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

			// Update playlist links
			this.renderPlaylistLinks();
		} catch (error) {
			this.showToast(`Error loading settings: ${error.message}`, "error");
		}
	}

	renderPlaylistLinks() {
		const container = document.getElementById("playlist-links");
		const baseUrl = `${window.location.protocol}//${window.location.host}`;

		const playlists = [
			{ name: "Twitch - All Follows", url: `${baseUrl}/playlist.m3u`, desc: "All followed channels" },
			{ name: "Twitch - Live Only", url: `${baseUrl}/playlist-live.m3u`, desc: "Only currently live" },
			{ name: "Twitch - Favorites", url: `${baseUrl}/playlist-favorites.m3u`, desc: "Live favorites only" },
			{ name: "Twitch - VODs (All)", url: `${baseUrl}/playlist-vods.m3u`, desc: "Recent VODs from followed channels" },
			{ name: "Twitch - VODs (Favorites)", url: `${baseUrl}/playlist-vods-favorites.m3u`, desc: "Recent VODs from favorite channels" },
			{ name: "Twitch - Clips (All)", url: `${baseUrl}/playlist-clips.m3u`, desc: "Popular clips from followed channels" },
			{ name: "Twitch - Clips (Favorites)", url: `${baseUrl}/playlist-clips-favorites.m3u`, desc: "Popular clips from favorite channels" },
			{ name: "YouTube", url: `${baseUrl}/playlist-youtube.m3u`, desc: "Recent videos from subscribed channels" }
		];

		container.innerHTML = playlists.map(p => `
			<div class="playlist-link-item">
				<div class="playlist-link-info">
					<strong>${p.name}</strong>
					<span class="text-muted">${p.desc}</span>
				</div>
				<div class="playlist-link-actions">
					<code class="playlist-url">${p.url}</code>
					<button class="btn btn-small" onclick="app.copyToClipboard('${p.url}')">Copy</button>
				</div>
			</div>
		`).join("");
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

	async populateChannelDropdown(selectElement) {
		try {
			const response = await api.getFollowedChannels();
			const channels = response.channels || [];

			// Separate favorites and non-favorites
			const favoriteChannels = channels.filter(ch =>
				this.favorites.has(ch.broadcaster_login.toLowerCase())
			);
			const nonFavoriteChannels = channels.filter(ch =>
				!this.favorites.has(ch.broadcaster_login.toLowerCase())
			);

			// Sort each group alphabetically
			favoriteChannels.sort((a, b) => a.broadcaster_name.localeCompare(b.broadcaster_name));
			nonFavoriteChannels.sort((a, b) => a.broadcaster_name.localeCompare(b.broadcaster_name));

			// Keep the first "All Channels" option
			const firstOption = selectElement.options[0];
			selectElement.innerHTML = "";
			selectElement.appendChild(firstOption);

			// Add "Favorites" option as second choice
			const favoritesOption = document.createElement("option");
			favoritesOption.value = "favorites";
			favoritesOption.textContent = "★ Favorites";
			selectElement.appendChild(favoritesOption);

			// Add favorite channels first (marked with ★)
			favoriteChannels.forEach(channel => {
				const option = document.createElement("option");
				option.value = channel.broadcaster_id;
				option.textContent = `★ ${channel.broadcaster_name}`;
				selectElement.appendChild(option);
			});

			// Add non-favorite channels
			nonFavoriteChannels.forEach(channel => {
				const option = document.createElement("option");
				option.value = channel.broadcaster_id;
				option.textContent = channel.broadcaster_name;
				selectElement.appendChild(option);
			});
		} catch (error) {
			console.error("Error populating channel dropdown:", error);
		}
	}
}

// Initialize app when DOM is ready
document.addEventListener("DOMContentLoaded", () => {
	window.app = new App();
});
