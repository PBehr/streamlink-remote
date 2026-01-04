const express = require("express");
const cors = require("cors");
const path = require("path");
const WebSocket = require("ws");
const http = require("http");
const fs = require("fs");

// Load config dynamically to avoid caching issues
const configFile = JSON.parse(fs.readFileSync(path.join(__dirname, "../config/config.json"), "utf8"));

// Merge config with environment variables (env vars take precedence)
const config = {
	server: {
		port: parseInt(process.env.SERVER_PORT) || configFile.server.port,
		host: process.env.SERVER_HOST || configFile.server.host,
		streamPortStart: parseInt(process.env.STREAM_PORT_START) || configFile.server.streamPortStart,
		streamPortEnd: parseInt(process.env.STREAM_PORT_END) || configFile.server.streamPortEnd
	},
	twitch: {
		clientId: process.env.TWITCH_CLIENT_ID || configFile.twitch.clientId,
		redirectUri: process.env.TWITCH_REDIRECT_URI || configFile.twitch.redirectUri,
		scopes: configFile.twitch.scopes,
		apiBaseUrl: configFile.twitch.apiBaseUrl,
		// Support manual auth from environment variables
		manualAuth: (process.env.MANUAL_AUTH_ACCESS_TOKEN && process.env.MANUAL_AUTH_USER_ID) ? {
			access_token: process.env.MANUAL_AUTH_ACCESS_TOKEN,
			user_id: process.env.MANUAL_AUTH_USER_ID,
			user_login: process.env.MANUAL_AUTH_USER_LOGIN,
			user_display_name: process.env.MANUAL_AUTH_USER_DISPLAY_NAME,
			expires_at: parseInt(process.env.MANUAL_AUTH_EXPIRES_AT) || null
		} : configFile.twitch.manualAuth
	},
	streamlink: {
		executable: process.env.STREAMLINK_EXECUTABLE || configFile.streamlink.executable,
		defaultQuality: process.env.STREAMLINK_DEFAULT_QUALITY || configFile.streamlink.defaultQuality,
		timeout: parseInt(process.env.STREAMLINK_TIMEOUT) || configFile.streamlink.timeout,
		retryStreams: parseInt(process.env.STREAMLINK_RETRY_STREAMS) || configFile.streamlink.retryStreams,
		retryOpen: parseInt(process.env.STREAMLINK_RETRY_OPEN) || configFile.streamlink.retryOpen
	},
	database: {
		path: process.env.DATABASE_PATH || configFile.database.path
	}
};

// Use SQLite database for persistent storage
const Database = require("./database");
const TwitchAPI = require("./twitch-api");
const StreamlinkManager = require("./streamlink");
const YouTubeService = require("./youtube");
const YtDlpManager = require("./ytdlp");

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Initialize components
const db = new Database(config.database.path);
db.init(); // Create tables if they don't exist
const twitchAPI = new TwitchAPI(config.twitch, db);
const streamlink = new StreamlinkManager(config.streamlink, config.server);
const youtubeService = new YouTubeService();
const ytdlp = new YtDlpManager(config.server);

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "../public")));

// WebSocket connection handling
const clients = new Set();

wss.on("connection", (ws) => {
	console.log("New WebSocket client connected");
	clients.add(ws);

	ws.on("close", () => {
		console.log("WebSocket client disconnected");
		clients.delete(ws);
	});

	ws.on("error", (error) => {
		console.error("WebSocket error:", error);
		clients.delete(ws);
	});
});

// Broadcast function for sending updates to all clients
function broadcast(type, data) {
	const message = JSON.stringify({ type, data });
	clients.forEach((client) => {
		if (client.readyState === WebSocket.OPEN) {
			client.send(message);
		}
	});
}

// Listen to Streamlink events
streamlink.on("stream:started", (data) => {
	broadcast("stream:started", data);
});

streamlink.on("stream:ended", (data) => {
	broadcast("stream:ended", data);
});

streamlink.on("stream:error", (data) => {
	broadcast("stream:error", data);
});

// API Routes

// Health check
app.get("/api/status", (req, res) => {
	res.json({
		status: "ok",
		version: "1.0.0",
		authenticated: twitchAPI.isAuthenticated(),
		activeStreams: streamlink.getActiveStreams().length
	});
});

// Twitch Authentication
app.get("/api/auth/login", (req, res) => {
	const authUrl = twitchAPI.getAuthUrl();
	res.json({ authUrl });
});

app.get("/auth/callback", async (req, res) => {
	// Twitch returns token in URL fragment (hash), not query params
	// We need to extract it with JavaScript on the client side
	res.send(`
		<html>
			<head><title>Authenticating...</title></head>
			<body style="font-family: sans-serif; text-align: center; padding: 50px;">
				<h1>⏳ Authenticating...</h1>
				<p>Please wait...</p>
				<script>
					// Extract token from URL fragment
					const hash = window.location.hash.substring(1);
					const params = new URLSearchParams(hash);
					const accessToken = params.get('access_token');

					if (accessToken) {
						// Send token to server
						fetch('/api/auth/token', {
							method: 'POST',
							headers: { 'Content-Type': 'application/json' },
							body: JSON.stringify({ access_token: accessToken })
						})
						.then(response => response.json())
						.then(data => {
							if (data.success) {
								document.body.innerHTML = '<h1>✓ Authentication Successful!</h1><p>You can close this window.</p>';
								setTimeout(() => window.close(), 2000);
							} else {
								document.body.innerHTML = '<h1>✗ Authentication Failed</h1><p>' + (data.error || 'Unknown error') + '</p>';
							}
						})
						.catch(error => {
							document.body.innerHTML = '<h1>✗ Error</h1><p>' + error.message + '</p>';
						});
					} else {
						document.body.innerHTML = '<h1>✗ No Access Token</h1><p>Authorization failed or was cancelled.</p>';
					}
				</script>
			</body>
		</html>
	`);
});

app.post("/api/auth/token", async (req, res) => {
	const { access_token } = req.body;

	if (!access_token) {
		return res.status(400).json({ success: false, error: "Missing access token" });
	}

	try {
		await twitchAPI.handleCallback(access_token);
		res.json({ success: true });
	} catch (error) {
		console.error("Token validation error:", error);
		res.status(500).json({ success: false, error: error.message });
	}
});

app.get("/api/auth/status", (req, res) => {
	res.json({
		authenticated: twitchAPI.isAuthenticated(),
		user: twitchAPI.getUser()
	});
});

app.post("/api/auth/logout", (req, res) => {
	twitchAPI.logout();
	res.json({ success: true });
});

// Export token for manual configuration (e.g., for NAS deployment)
app.get("/api/auth/export-token", (req, res) => {
	if (!twitchAPI.isAuthenticated()) {
		return res.status(401).json({ error: "Not authenticated" });
	}

	const tokenData = twitchAPI.exportToken();
	res.json({
		success: true,
		token: tokenData,
		instructions: "Copy this entire JSON object to your config.json under 'twitch.manualAuth'"
	});
});

// Twitch API endpoints
app.get("/api/channels/followed", async (req, res) => {
	try {
		if (!twitchAPI.isAuthenticated()) {
			return res.status(401).json({ error: "Not authenticated" });
		}

		const channels = await twitchAPI.getFollowedChannels();
		res.json({ channels });
	} catch (error) {
		console.error("Error fetching followed channels:", error);
		res.status(500).json({ error: error.message });
	}
});

app.get("/api/streams/live", async (req, res) => {
	try {
		if (!twitchAPI.isAuthenticated()) {
			return res.status(401).json({ error: "Not authenticated" });
		}

		const streams = await twitchAPI.getLiveStreams();
		res.json({ streams });
	} catch (error) {
		console.error("Error fetching live streams:", error);
		res.status(500).json({ error: error.message });
	}
});

app.get("/api/streams/featured", async (req, res) => {
	try {
		const streams = await twitchAPI.getFeaturedStreams();
		res.json({ streams });
	} catch (error) {
		console.error("Error fetching featured streams:", error);
		res.status(500).json({ error: error.message });
	}
});

app.get("/api/search", async (req, res) => {
	const { q } = req.query;

	if (!q || q.trim().length === 0) {
		return res.status(400).json({ error: "Query parameter 'q' is required" });
	}

	try {
		const results = await twitchAPI.searchChannels(q);
		res.json({ results });
	} catch (error) {
		console.error("Error searching channels:", error);
		res.status(500).json({ error: error.message });
	}
});

app.get("/api/channel/:name", async (req, res) => {
	const { name } = req.params;

	try {
		const channel = await twitchAPI.getChannel(name);
		res.json(channel);
	} catch (error) {
		console.error("Error fetching channel:", error);
		res.status(500).json({ error: error.message });
	}
});

// M3U Playlist endpoint - generates playlist from followed channels
app.get("/playlist.m3u", async (req, res) => {
	try {
		if (!twitchAPI.isAuthenticated()) {
			return res.status(401).send("Not authenticated");
		}

		// Get followed channels and live streams
		const channels = await twitchAPI.getFollowedChannels();
		const liveStreams = await twitchAPI.getLiveStreams();

		// Create a map of live stream data for quick lookup (includes thumbnails)
		const liveStreamMap = new Map();
		for (const stream of liveStreams) {
			liveStreamMap.set(stream.user_login.toLowerCase(), stream);
		}

		// Optional: filter for live only
		const liveOnly = req.query.live === 'true' || req.query.live === '1';
		let playlistChannels = channels;

		if (liveOnly) {
			playlistChannels = channels.filter(c =>
				liveStreamMap.has(c.broadcaster_login.toLowerCase())
			);
		}

		// Build M3U playlist
		const streamHost = process.env.EXTERNAL_HOST ||
		                   (config.server.host === "0.0.0.0" ? streamlink.getLocalIpAddress() : config.server.host);
		const streamPort = config.server.port;
		const quality = req.query.quality || '';
		const qualityParam = quality ? `?quality=${encodeURIComponent(quality)}` : '';

		let m3u = '#EXTM3U\n';

		for (const channel of playlistChannels) {
			const channelName = channel.broadcaster_login || channel.user_login;
			const displayName = channel.broadcaster_name || channel.user_name || channelName;

			// Check if channel is live and get stream thumbnail
			const liveStream = liveStreamMap.get(channelName.toLowerCase());
			let logoUrl = '';
			let streamTitle = '';
			let gameName = '';

			if (liveStream) {
				// Use stream thumbnail for live streams
				if (liveStream.thumbnail_url) {
					logoUrl = liveStream.thumbnail_url
						.replace('{width}', '440')
						.replace('{height}', '248');
				}
				// Get the actual stream title set by the streamer
				streamTitle = liveStream.title || '';
				gameName = liveStream.game_name || 'Streaming';
			} else {
				// Fallback to channel profile image if available
				logoUrl = channel.thumbnail_url || channel.profile_image_url || '';
			}

			// Escape quotes in title for M3U format
			const escapedTitle = streamTitle.replace(/"/g, "'");

			// Build the display title for IPTV players
			// Format: "StreamerName: Stream Title [Game]" for live, just "StreamerName" for offline
			let fullTitle;
			if (liveStream) {
				fullTitle = streamTitle
					? `${displayName}: ${streamTitle}`
					: `${displayName} - ${gameName}`;
			} else {
				fullTitle = displayName;
			}

			// EXTINF format with tvg-name as channel name and full title after comma
			// Many IPTV players use the text after the comma as the display title
			m3u += `#EXTINF:-1 tvg-id="${channelName}" tvg-name="${displayName}" tvg-logo="${logoUrl}" group-title="Twitch"`;
			if (liveStream) {
				m3u += ` tvg-chno="${liveStream.viewer_count || 0}"`;
			}
			m3u += `,${fullTitle}\n`;
			m3u += `http://${streamHost}:${streamPort}/stream/${channelName}${qualityParam}\n`;
		}

		// Set headers to prevent caching
		res.setHeader('Content-Type', 'audio/x-mpegurl');
		res.setHeader('Content-Disposition', 'attachment; filename="twitch-follows.m3u"');
		res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
		res.setHeader('Pragma', 'no-cache');
		res.setHeader('Expires', '0');
		res.send(m3u);

		console.log(`[Playlist] Generated M3U with ${playlistChannels.length} channels (liveOnly: ${liveOnly}, live: ${liveStreams.length})`);
	} catch (error) {
		console.error("Error generating playlist:", error);
		res.status(500).send(`Error generating playlist: ${error.message}`);
	}
});

// Live streams M3U - only currently live followed channels (no redirect, direct generation)
app.get("/playlist-live.m3u", async (req, res) => {
	try {
		if (!twitchAPI.isAuthenticated()) {
			return res.status(401).send("Not authenticated");
		}

		// Get live streams directly
		const liveStreams = await twitchAPI.getLiveStreams();

		// Build M3U playlist
		const streamHost = process.env.EXTERNAL_HOST ||
		                   (config.server.host === "0.0.0.0" ? streamlink.getLocalIpAddress() : config.server.host);
		const streamPort = config.server.port;
		const quality = req.query.quality || '';
		const qualityParam = quality ? `?quality=${encodeURIComponent(quality)}` : '';

		let m3u = '#EXTM3U\n';

		for (const stream of liveStreams) {
			const channelName = stream.user_login;
			const displayName = stream.user_name || channelName;
			const streamTitle = stream.title || '';
			const gameName = stream.game_name || 'Streaming';
			const viewerCount = stream.viewer_count || 0;

			// Use stream thumbnail
			let logoUrl = '';
			if (stream.thumbnail_url) {
				logoUrl = stream.thumbnail_url
					.replace('{width}', '440')
					.replace('{height}', '248');
			}

			// Sanitize strings for M3U compatibility (remove/replace problematic characters)
			const sanitize = (str) => str
				.replace(/"/g, "'")      // Replace double quotes
				.replace(/\n/g, ' ')     // Remove newlines
				.replace(/\r/g, '');     // Remove carriage returns

			// Sanitize group title (no special chars, just alphanumeric and spaces)
			const safeGameName = gameName.replace(/[^a-zA-Z0-9\s\-]/g, '').trim() || 'Twitch';

			// Build the display title: "StreamerName - Stream Title"
			const fullTitle = streamTitle
				? sanitize(`${displayName} - ${streamTitle}`)
				: sanitize(`${displayName} - ${gameName}`);

			// EXTINF format - use Twitch as group for compatibility, game in title
			m3u += `#EXTINF:-1 tvg-id="${channelName}" tvg-name="${sanitize(displayName)}" tvg-logo="${logoUrl}" group-title="Twitch" tvg-chno="${viewerCount}",${fullTitle}\n`;
			m3u += `http://${streamHost}:${streamPort}/stream/${channelName}${qualityParam}\n`;
		}

		// Set headers to prevent caching
		res.setHeader('Content-Type', 'audio/x-mpegurl');
		res.setHeader('Content-Disposition', 'attachment; filename="twitch-live.m3u"');
		res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
		res.setHeader('Pragma', 'no-cache');
		res.setHeader('Expires', '0');
		res.send(m3u);

		console.log(`[Playlist] Generated live M3U with ${liveStreams.length} streams`);
	} catch (error) {
		console.error("Error generating live playlist:", error);
		res.status(500).send(`Error generating playlist: ${error.message}`);
	}
});

// Favorites M3U - only live streams from favorites
app.get("/playlist-favorites.m3u", async (req, res) => {
	try {
		if (!twitchAPI.isAuthenticated()) {
			return res.status(401).send("Not authenticated");
		}

		// Get favorites from database
		const favorites = db.getFavorites();
		if (favorites.length === 0) {
			res.setHeader('Content-Type', 'audio/x-mpegurl');
			res.setHeader('Content-Disposition', 'attachment; filename="twitch-favorites.m3u"');
			return res.send('#EXTM3U\n');
		}

		const favoriteLogins = new Set(favorites.map(f => f.channel_login.toLowerCase()));

		// Get live streams and filter by favorites
		const liveStreams = await twitchAPI.getLiveStreams();
		const liveFavorites = liveStreams.filter(s =>
			favoriteLogins.has(s.user_login.toLowerCase())
		);

		// Get followed channels to find broadcaster IDs for VOD fetching
		const followedChannels = await twitchAPI.getFollowedChannels();
		const favoriteChannels = followedChannels.filter(ch =>
			favoriteLogins.has(ch.broadcaster_login.toLowerCase())
		);

		// Fetch recent VODs for each favorite channel (limit 3 per channel)
		const vodLimit = parseInt(req.query.vodLimit) || 3;
		const allVideos = [];
		for (const channel of favoriteChannels) {
			try {
				const videos = await twitchAPI.getVideos(channel.broadcaster_id, vodLimit, "archive");
				allVideos.push(...videos.map(v => ({
					...v,
					broadcaster_name: channel.broadcaster_name,
					broadcaster_login: channel.broadcaster_login
				})));
			} catch (e) {
				// Silently skip channels with no VODs
			}
		}
		// Sort VODs by date (newest first)
		allVideos.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

		// Build M3U playlist
		const streamHost = process.env.EXTERNAL_HOST ||
		                   (config.server.host === "0.0.0.0" ? streamlink.getLocalIpAddress() : config.server.host);
		const streamPort = config.server.port;
		const quality = req.query.quality || '';
		const qualityParam = quality ? `?quality=${encodeURIComponent(quality)}` : '';

		let m3u = '#EXTM3U\n';

		const sanitize = (str) => str
			.replace(/"/g, "'")
			.replace(/\n/g, ' ')
			.replace(/\r/g, '');

		// Add LIVE streams first (group: "Favorites Live")
		for (const stream of liveFavorites) {
			const channelName = stream.user_login;
			const displayName = stream.user_name || channelName;
			const streamTitle = stream.title || '';
			const gameName = stream.game_name || 'Streaming';
			const viewerCount = stream.viewer_count || 0;

			let logoUrl = '';
			if (stream.thumbnail_url) {
				logoUrl = stream.thumbnail_url
					.replace('{width}', '440')
					.replace('{height}', '248');
			}

			const fullTitle = streamTitle
				? sanitize(`🔴 ${displayName} - ${streamTitle}`)
				: sanitize(`🔴 ${displayName} - ${gameName}`);

			// Live streams: use tvg-id for EPG, no .mp4 extension
			m3u += `#EXTINF:-1 tvg-id="${channelName}" tvg-name="${sanitize(displayName)}" tvg-logo="${logoUrl}" group-title="Favorites Live" tvg-chno="${viewerCount}",${fullTitle}\n`;
			m3u += `http://${streamHost}:${streamPort}/stream/${channelName}${qualityParam}\n`;
		}

		// Add VODs (group: "Favorites VODs") - with .mp4 for UHF movie detection
		for (const video of allVideos) {
			const channelName = video.user_name || video.broadcaster_name || 'Unknown';
			const fullTitle = sanitize(`${channelName} - ${video.title}`);
			const thumbnail = video.thumbnail_url
				? video.thumbnail_url.replace('%{width}', '320').replace('%{height}', '180')
				: '';

			// Parse duration from Twitch format
			let durationSecs = -1;
			if (video.duration) {
				const match = video.duration.match(/(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?/);
				if (match) {
					const hours = parseInt(match[1]) || 0;
					const mins = parseInt(match[2]) || 0;
					const secs = parseInt(match[3]) || 0;
					durationSecs = hours * 3600 + mins * 60 + secs;
				}
			}

			// VODs: no tvg-id, .mp4 extension for UHF movie detection
			m3u += `#EXTINF:${durationSecs} tvg-logo="${thumbnail}" group-title="Favorites VODs",${fullTitle}\n`;
			m3u += `http://${streamHost}:${streamPort}/vod/${video.id}.mp4\n`;
		}

		res.setHeader('Content-Type', 'audio/x-mpegurl');
		res.setHeader('Content-Disposition', 'attachment; filename="twitch-favorites.m3u"');
		res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
		res.setHeader('Pragma', 'no-cache');
		res.setHeader('Expires', '0');
		res.send(m3u);

		console.log(`[Playlist] Generated favorites M3U with ${liveFavorites.length} live + ${allVideos.length} VODs`);
	} catch (error) {
		console.error("Error generating favorites playlist:", error);
		res.status(500).send(`Error generating playlist: ${error.message}`);
	}
});

// Favorites API endpoints
app.get("/api/favorites", (req, res) => {
	try {
		const favorites = db.getFavorites();
		res.json(favorites);
	} catch (error) {
		console.error("Error getting favorites:", error);
		res.status(500).json({ error: error.message });
	}
});

app.post("/api/favorites/:channel", (req, res) => {
	const { channel } = req.params;
	const { displayName } = req.body;

	try {
		db.addFavorite(channel, displayName || channel);
		res.json({ success: true, channel, isFavorite: true });
		console.log(`[Favorites] Added: ${channel}`);
	} catch (error) {
		console.error("Error adding favorite:", error);
		res.status(500).json({ error: error.message });
	}
});

app.delete("/api/favorites/:channel", (req, res) => {
	const { channel } = req.params;

	try {
		db.removeFavorite(channel);
		res.json({ success: true, channel, isFavorite: false });
		console.log(`[Favorites] Removed: ${channel}`);
	} catch (error) {
		console.error("Error removing favorite:", error);
		res.status(500).json({ error: error.message });
	}
});

app.get("/api/favorites/:channel", (req, res) => {
	const { channel } = req.params;

	try {
		const isFavorite = db.isFavorite(channel);
		res.json({ channel, isFavorite });
	} catch (error) {
		console.error("Error checking favorite:", error);
		res.status(500).json({ error: error.message });
	}
});

// On-demand stream endpoint for M3U playlist / direct player access
// This endpoint starts a stream if not running and redirects to the stream URL
app.get("/stream/:channel", async (req, res) => {
	const { channel } = req.params;
	const quality = req.query.quality || null;

	console.log(`[On-Demand] Request for channel: ${channel}`);

	try {
		// Check if stream is already running
		if (streamlink.isStreamActive(channel)) {
			const streams = streamlink.getActiveStreams();
			const stream = streams.find(s => s.channel.toLowerCase() === channel.toLowerCase());
			if (stream) {
				console.log(`[On-Demand] Stream already active, redirecting to ${stream.url}`);
				// Track this client connection
				streamlink.trackClientConnect(channel);
				return res.redirect(302, stream.url);
			}
		}

		// Check if we have room for another stream (max ports)
		const activeStreams = streamlink.getActiveStreams();
		const maxStreams = config.server.streamPortEnd - config.server.streamPortStart + 1;

		if (activeStreams.length >= maxStreams) {
			// Find oldest stream without active clients and stop it
			const oldestWithoutClients = streamlink.getOldestStreamWithoutClients();
			if (oldestWithoutClients) {
				console.log(`[On-Demand] Max streams reached, stopping oldest without clients: ${oldestWithoutClients}`);
				streamlink.stopStream(oldestWithoutClients);
			} else {
				// All streams have active clients, stop the oldest one anyway
				const oldest = activeStreams.sort((a, b) => a.startedAt - b.startedAt)[0];
				console.log(`[On-Demand] Max streams reached, stopping oldest stream: ${oldest.channel}`);
				streamlink.stopStream(oldest.channel);
			}
			// Wait a moment for cleanup
			await new Promise(resolve => setTimeout(resolve, 500));
		}

		// Start the stream
		console.log(`[On-Demand] Starting stream for ${channel}...`);
		const result = await streamlink.startStream(channel, quality);

		if (result.success) {
			console.log(`[On-Demand] Stream started, redirecting to ${result.url}`);
			// Track this client connection
			streamlink.trackClientConnect(channel);
			return res.redirect(302, result.url);
		} else {
			console.error(`[On-Demand] Failed to start stream: ${result.error}`);
			return res.status(503).send(`Stream unavailable: ${result.error || 'Unknown error'}`);
		}
	} catch (error) {
		console.error(`[On-Demand] Error: ${error.message}`);
		return res.status(503).send(`Stream unavailable: ${error.message}`);
	}
});

// Stream control endpoints
app.post("/api/stream/start", async (req, res) => {
	const { channel, quality } = req.body;

	if (!channel) {
		return res.status(400).json({ error: "Channel name is required" });
	}

	try {
		const result = await streamlink.startStream(channel, quality);
		res.json(result);
	} catch (error) {
		console.error("Error starting stream:", error);
		res.status(500).json({ error: error.message });
	}
});

app.post("/api/stream/stop", (req, res) => {
	const { channel } = req.body;

	if (!channel) {
		return res.status(400).json({ error: "Channel name is required" });
	}

	try {
		const result = streamlink.stopStream(channel);
		res.json(result);
	} catch (error) {
		console.error("Error stopping stream:", error);
		res.status(500).json({ error: error.message });
	}
});

app.get("/api/stream/active", (req, res) => {
	const streams = streamlink.getActiveStreams();
	res.json({ streams });
});

// Settings endpoints
app.get("/api/settings", (req, res) => {
	const settings = db.getSettings();
	res.json(settings);
});

app.put("/api/settings", (req, res) => {
	try {
		db.updateSettings(req.body);
		res.json({ success: true });
	} catch (error) {
		console.error("Error updating settings:", error);
		res.status(500).json({ error: error.message });
	}
});

// Twitch VODs API endpoint
app.get("/api/vods", async (req, res) => {
	if (!twitchAPI.isAuthenticated()) {
		return res.status(401).json({ error: "Not authenticated" });
	}

	const userId = req.query.user_id || null;
	const limit = parseInt(req.query.limit) || 25;
	const type = req.query.type || "archive"; // archive, highlight, upload, all

	try {
		const videos = await twitchAPI.getVideos(userId, limit, type);
		res.json({ videos });
		console.log(`[VODs] Fetched ${videos.length} videos`);
	} catch (error) {
		console.error("Error fetching VODs:", error);
		res.status(500).json({ error: error.message });
	}
});

// Twitch Clips API endpoint
app.get("/api/clips", async (req, res) => {
	if (!twitchAPI.isAuthenticated()) {
		return res.status(401).json({ error: "Not authenticated" });
	}

	const broadcasterId = req.query.broadcaster_id || null;
	const limit = parseInt(req.query.limit) || 25;
	const period = req.query.period || "week"; // day, week, month, all

	try {
		const clips = await twitchAPI.getClips(broadcasterId, limit, period);
		res.json({ clips });
		console.log(`[Clips] Fetched ${clips.length} clips`);
	} catch (error) {
		console.error("Error fetching clips:", error);
		res.status(500).json({ error: error.message });
	}
});

// Twitch VOD on-demand stream endpoint - redirects directly to Twitch CDN (seekable!)
app.get("/vod/:videoId", async (req, res) => {
	// Strip .mp4 extension if present (for UHF IPTV player compatibility)
	const videoId = req.params.videoId.replace(/\.mp4$/i, '');
	const quality = req.query.quality || null;

	console.log(`[VOD] Request for video: ${videoId}`);

	try {
		// Get direct URL from yt-dlp and redirect to it
		const result = await ytdlp.getTwitchVodDirectUrl(videoId, quality);

		if (result.success && result.directUrl) {
			console.log(`[VOD] Redirecting to direct URL for ${videoId}`);
			return res.redirect(302, result.directUrl);
		} else {
			console.error(`[VOD] Failed to get URL: ${result.error}`);
			return res.status(503).send(`Stream unavailable: ${result.error || 'Unknown error'}`);
		}
	} catch (error) {
		console.error(`[VOD] Error: ${error.message}`);
		return res.status(503).send(`Stream unavailable: ${error.message}`);
	}
});

// Twitch Clip on-demand stream endpoint - redirects directly to Twitch CDN
app.get("/clip/:clipId", async (req, res) => {
	// Strip .mp4 extension if present (for UHF IPTV player compatibility)
	const clipId = req.params.clipId.replace(/\.mp4$/i, '');
	const quality = req.query.quality || null;

	console.log(`[Clip] Request for clip: ${clipId}`);

	try {
		// Get direct URL from yt-dlp and redirect to it
		const result = await ytdlp.getTwitchClipDirectUrl(clipId, quality);

		if (result.success && result.directUrl) {
			console.log(`[Clip] Redirecting to direct URL for ${clipId}`);
			return res.redirect(302, result.directUrl);
		} else {
			console.error(`[Clip] Failed to get URL: ${result.error}`);
			return res.status(503).send(`Stream unavailable: ${result.error || 'Unknown error'}`);
		}
	} catch (error) {
		console.error(`[Clip] Error: ${error.message}`);
		return res.status(503).send(`Stream unavailable: ${error.message}`);
	}
});

// VODs M3U Playlist endpoint
app.get("/playlist-vods.m3u", async (req, res) => {
	if (!twitchAPI.isAuthenticated()) {
		res.setHeader('Content-Type', 'audio/x-mpegurl');
		res.setHeader('Content-Disposition', 'attachment; filename="vods.m3u"');
		return res.send('#EXTM3U\n');
	}

	try {
		const limit = parseInt(req.query.limit) || 25;
		const type = req.query.type || "archive";
		const videos = await twitchAPI.getVideos(null, limit, type);

		// Build M3U playlist
		const streamHost = process.env.EXTERNAL_HOST ||
		                   (config.server.host === "0.0.0.0" ? streamlink.getLocalIpAddress() : config.server.host);
		const streamPort = config.server.port;

		let m3u = '#EXTM3U\n';

		for (const video of videos) {
			const sanitize = (str) => str
				.replace(/"/g, "'")
				.replace(/\n/g, ' ')
				.replace(/\r/g, '');

			const channelName = video.user_name || video.broadcaster_name || 'Unknown';
			const fullTitle = sanitize(`${channelName} - ${video.title}`);
			const thumbnail = video.thumbnail_url
				? video.thumbnail_url.replace('%{width}', '320').replace('%{height}', '180')
				: '';

			// Parse duration from Twitch format (e.g., "3h2m1s" or "45m30s")
			let durationSecs = -1;
			if (video.duration) {
				const match = video.duration.match(/(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?/);
				if (match) {
					const hours = parseInt(match[1]) || 0;
					const mins = parseInt(match[2]) || 0;
					const secs = parseInt(match[3]) || 0;
					durationSecs = hours * 3600 + mins * 60 + secs;
				}
			}

			// Mark as VOD for IPTV players like UHF
			// - Use .mp4 extension in URL (critical for UHF to detect as movie/VOD)
			// - Keep tvg-logo for thumbnails
			m3u += `#EXTINF:${durationSecs} tvg-logo="${thumbnail}" group-title="Twitch VODs",${fullTitle}\n`;
			m3u += `http://${streamHost}:${streamPort}/vod/${video.id}.mp4\n`;
		}

		res.setHeader('Content-Type', 'audio/x-mpegurl');
		res.setHeader('Content-Disposition', 'attachment; filename="vods.m3u"');
		res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
		res.send(m3u);

		console.log(`[Playlist] Generated VODs M3U with ${videos.length} videos (UHF VOD format)`);
	} catch (error) {
		console.error("Error generating VODs playlist:", error);
		res.status(500).send(`Error generating playlist: ${error.message}`);
	}
});

// Clips M3U Playlist endpoint
app.get("/playlist-clips.m3u", async (req, res) => {
	if (!twitchAPI.isAuthenticated()) {
		res.setHeader('Content-Type', 'audio/x-mpegurl');
		res.setHeader('Content-Disposition', 'attachment; filename="clips.m3u"');
		return res.send('#EXTM3U\n');
	}

	try {
		const limit = parseInt(req.query.limit) || 25;
		const period = req.query.period || "week";
		const clips = await twitchAPI.getClips(null, limit, period);

		// Build M3U playlist
		const streamHost = process.env.EXTERNAL_HOST ||
		                   (config.server.host === "0.0.0.0" ? streamlink.getLocalIpAddress() : config.server.host);
		const streamPort = config.server.port;

		let m3u = '#EXTM3U\n';

		for (const clip of clips) {
			const sanitize = (str) => str
				.replace(/"/g, "'")
				.replace(/\n/g, ' ')
				.replace(/\r/g, '');

			const fullTitle = sanitize(`${clip.broadcaster_name} - ${clip.title}`);
			// Clips have a duration field in seconds from Twitch API
			const durationSecs = Math.round(clip.duration) || -1;

			// Mark as VOD for IPTV players like UHF
			// - Use .mp4 extension in URL (critical for UHF to detect as movie/VOD)
			m3u += `#EXTINF:${durationSecs} tvg-logo="${clip.thumbnail_url}" group-title="Twitch Clips",${fullTitle}\n`;
			m3u += `http://${streamHost}:${streamPort}/clip/${clip.id}.mp4\n`;
		}

		res.setHeader('Content-Type', 'audio/x-mpegurl');
		res.setHeader('Content-Disposition', 'attachment; filename="clips.m3u"');
		res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
		res.send(m3u);

		console.log(`[Playlist] Generated Clips M3U with ${clips.length} clips (UHF VOD format)`);
	} catch (error) {
		console.error("Error generating Clips playlist:", error);
		res.status(500).send(`Error generating playlist: ${error.message}`);
	}
});

// VODs Favorites M3U Playlist endpoint
app.get("/playlist-vods-favorites.m3u", async (req, res) => {
	if (!twitchAPI.isAuthenticated()) {
		res.setHeader('Content-Type', 'audio/x-mpegurl');
		res.setHeader('Content-Disposition', 'attachment; filename="vods-favorites.m3u"');
		return res.send('#EXTM3U\n');
	}

	try {
		const limit = parseInt(req.query.limit) || 25;
		const type = req.query.type || "archive";

		// Get favorites
		const favorites = db.getFavorites();
		if (favorites.length === 0) {
			res.setHeader('Content-Type', 'audio/x-mpegurl');
			res.setHeader('Content-Disposition', 'attachment; filename="vods-favorites.m3u"');
			return res.send('#EXTM3U\n');
		}

		// Get followed channels to find broadcaster IDs for favorites
		const followedChannels = await twitchAPI.getFollowedChannels();
		const favoriteLogins = new Set(favorites.map(f => f.channel_login.toLowerCase()));
		const favoriteChannels = followedChannels.filter(ch =>
			favoriteLogins.has(ch.broadcaster_login.toLowerCase())
		);

		if (favoriteChannels.length === 0) {
			res.setHeader('Content-Type', 'audio/x-mpegurl');
			res.setHeader('Content-Disposition', 'attachment; filename="vods-favorites.m3u"');
			return res.send('#EXTM3U\n');
		}

		// Fetch videos for each favorite channel
		const allVideos = [];
		for (const channel of favoriteChannels) {
			try {
				const videos = await twitchAPI.getVideos(channel.broadcaster_id, 5, type);
				allVideos.push(...videos.map(v => ({
					...v,
					broadcaster_name: channel.broadcaster_name,
					broadcaster_login: channel.broadcaster_login
				})));
			} catch (e) {
				console.error(`Error fetching VODs for ${channel.broadcaster_login}:`, e.message);
			}
		}

		// Sort by created_at and limit
		allVideos.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
		const videos = allVideos.slice(0, limit);

		// Build M3U playlist
		const streamHost = process.env.EXTERNAL_HOST ||
		                   (config.server.host === "0.0.0.0" ? streamlink.getLocalIpAddress() : config.server.host);
		const streamPort = config.server.port;

		let m3u = '#EXTM3U\n';

		for (const video of videos) {
			const sanitize = (str) => str
				.replace(/"/g, "'")
				.replace(/\n/g, ' ')
				.replace(/\r/g, '');

			const channelName = video.user_name || video.broadcaster_name || 'Unknown';
			const fullTitle = sanitize(`${channelName} - ${video.title}`);
			const thumbnail = video.thumbnail_url
				? video.thumbnail_url.replace('%{width}', '320').replace('%{height}', '180')
				: '';

			// Parse duration from Twitch format (e.g., "3h2m1s" or "45m30s")
			let durationSecs = -1;
			if (video.duration) {
				const match = video.duration.match(/(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?/);
				if (match) {
					const hours = parseInt(match[1]) || 0;
					const mins = parseInt(match[2]) || 0;
					const secs = parseInt(match[3]) || 0;
					durationSecs = hours * 3600 + mins * 60 + secs;
				}
			}

			// Mark as VOD for IPTV players like UHF
			// - Use .mp4 extension in URL (critical for UHF to detect as movie/VOD)
			m3u += `#EXTINF:${durationSecs} tvg-logo="${thumbnail}" group-title="Twitch VODs (Favorites)",${fullTitle}\n`;
			m3u += `http://${streamHost}:${streamPort}/vod/${video.id}.mp4\n`;
		}

		res.setHeader('Content-Type', 'audio/x-mpegurl');
		res.setHeader('Content-Disposition', 'attachment; filename="vods-favorites.m3u"');
		res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
		res.send(m3u);

		console.log(`[Playlist] Generated VODs Favorites M3U with ${videos.length} videos from ${favoriteChannels.length} channels (UHF VOD format)`);
	} catch (error) {
		console.error("Error generating VODs Favorites playlist:", error);
		res.status(500).send(`Error generating playlist: ${error.message}`);
	}
});

// Clips Favorites M3U Playlist endpoint
app.get("/playlist-clips-favorites.m3u", async (req, res) => {
	if (!twitchAPI.isAuthenticated()) {
		res.setHeader('Content-Type', 'audio/x-mpegurl');
		res.setHeader('Content-Disposition', 'attachment; filename="clips-favorites.m3u"');
		return res.send('#EXTM3U\n');
	}

	try {
		const limit = parseInt(req.query.limit) || 25;
		const period = req.query.period || "day";

		// Get favorites
		const favorites = db.getFavorites();
		if (favorites.length === 0) {
			res.setHeader('Content-Type', 'audio/x-mpegurl');
			res.setHeader('Content-Disposition', 'attachment; filename="clips-favorites.m3u"');
			return res.send('#EXTM3U\n');
		}

		// Get followed channels to find broadcaster IDs for favorites
		const followedChannels = await twitchAPI.getFollowedChannels();
		const favoriteLogins = new Set(favorites.map(f => f.channel_login.toLowerCase()));
		const favoriteChannels = followedChannels.filter(ch =>
			favoriteLogins.has(ch.broadcaster_login.toLowerCase())
		);

		if (favoriteChannels.length === 0) {
			res.setHeader('Content-Type', 'audio/x-mpegurl');
			res.setHeader('Content-Disposition', 'attachment; filename="clips-favorites.m3u"');
			return res.send('#EXTM3U\n');
		}

		// Fetch clips for each favorite channel
		const allClips = [];
		for (const channel of favoriteChannels) {
			try {
				const clips = await twitchAPI.getClips(channel.broadcaster_id, 10, period);
				allClips.push(...clips);
			} catch (e) {
				console.error(`Error fetching clips for ${channel.broadcaster_login}:`, e.message);
			}
		}

		// Sort by view_count and limit
		allClips.sort((a, b) => b.view_count - a.view_count);
		const clips = allClips.slice(0, limit);

		// Build M3U playlist
		const streamHost = process.env.EXTERNAL_HOST ||
		                   (config.server.host === "0.0.0.0" ? streamlink.getLocalIpAddress() : config.server.host);
		const streamPort = config.server.port;

		let m3u = '#EXTM3U\n';

		for (const clip of clips) {
			const sanitize = (str) => str
				.replace(/"/g, "'")
				.replace(/\n/g, ' ')
				.replace(/\r/g, '');

			const fullTitle = sanitize(`${clip.broadcaster_name} - ${clip.title}`);
			// Clips have a duration field in seconds from Twitch API
			const durationSecs = Math.round(clip.duration) || -1;

			// Mark as VOD for IPTV players like UHF
			// - Use .mp4 extension in URL (critical for UHF to detect as movie/VOD)
			m3u += `#EXTINF:${durationSecs} tvg-logo="${clip.thumbnail_url}" group-title="Twitch Clips (Favorites)",${fullTitle}\n`;
			m3u += `http://${streamHost}:${streamPort}/clip/${clip.id}.mp4\n`;
		}

		res.setHeader('Content-Type', 'audio/x-mpegurl');
		res.setHeader('Content-Disposition', 'attachment; filename="clips-favorites.m3u"');
		res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
		res.send(m3u);

		console.log(`[Playlist] Generated Clips Favorites M3U with ${clips.length} clips from ${favoriteChannels.length} channels (UHF VOD format)`);
	} catch (error) {
		console.error("Error generating Clips Favorites playlist:", error);
		res.status(500).send(`Error generating playlist: ${error.message}`);
	}
});

// YouTube Channels API endpoints
app.get("/api/youtube/channels", (req, res) => {
	try {
		const channels = db.getYoutubeChannels();
		res.json(channels);
	} catch (error) {
		console.error("Error getting YouTube channels:", error);
		res.status(500).json({ error: error.message });
	}
});

app.post("/api/youtube/channels", async (req, res) => {
	const { url } = req.body;

	if (!url) {
		return res.status(400).json({ error: "URL is required" });
	}

	try {
		// Resolve channel ID and name from URL
		const { channelId, channelName } = await youtubeService.resolveChannelId(url);

		// Get channel name if not already resolved
		let finalChannelName = channelName;
		if (!finalChannelName) {
			// Fetch videos to get channel name from RSS
			const videos = await youtubeService.fetchChannelVideos(channelId);
			if (videos.length > 0) {
				finalChannelName = videos[0].channelName;
			} else {
				finalChannelName = channelId;
			}
		}

		// Store in database
		const channelUrl = `https://www.youtube.com/channel/${channelId}`;
		db.addYoutubeChannel(channelId, finalChannelName, channelUrl);

		res.json({
			success: true,
			channel: {
				channel_id: channelId,
				channel_name: finalChannelName,
				channel_url: channelUrl
			}
		});
		console.log(`[YouTube] Added channel: ${finalChannelName} (${channelId})`);
	} catch (error) {
		console.error("Error adding YouTube channel:", error);
		res.status(400).json({ error: error.message });
	}
});

app.delete("/api/youtube/channels/:channelId", (req, res) => {
	const { channelId } = req.params;

	try {
		db.removeYoutubeChannel(channelId);
		res.json({ success: true, channelId });
		console.log(`[YouTube] Removed channel: ${channelId}`);
	} catch (error) {
		console.error("Error removing YouTube channel:", error);
		res.status(500).json({ error: error.message });
	}
});

// YouTube videos feed endpoint
app.get("/api/youtube/videos", async (req, res) => {
	const limit = parseInt(req.query.limit) || 25;

	try {
		const channels = db.getYoutubeChannels();
		if (channels.length === 0) {
			return res.json({ videos: [] });
		}

		const videos = await youtubeService.fetchAllChannelVideos(channels, limit);
		res.json({ videos });
	} catch (error) {
		console.error("Error fetching YouTube videos:", error);
		res.status(500).json({ error: error.message });
	}
});

// YouTube M3U Playlist endpoint
app.get("/playlist-youtube.m3u", async (req, res) => {
	try {
		const channels = db.getYoutubeChannels();
		if (channels.length === 0) {
			res.setHeader('Content-Type', 'audio/x-mpegurl');
			res.setHeader('Content-Disposition', 'attachment; filename="youtube.m3u"');
			return res.send('#EXTM3U\n');
		}

		const limit = parseInt(req.query.limit) || 25;
		const videos = await youtubeService.fetchAllChannelVideos(channels, limit);

		// Build M3U playlist
		const streamHost = process.env.EXTERNAL_HOST ||
		                   (config.server.host === "0.0.0.0" ? streamlink.getLocalIpAddress() : config.server.host);
		const streamPort = config.server.port;

		let m3u = '#EXTM3U\n';

		for (const video of videos) {
			const sanitize = (str) => str
				.replace(/"/g, "'")
				.replace(/\n/g, ' ')
				.replace(/\r/g, '');

			// Format date for display
			const dateStr = video.published.toLocaleDateString('de-DE', {
				day: '2-digit',
				month: '2-digit'
			});

			const fullTitle = sanitize(`${video.channelName} - ${video.title}`);

			// Mark as VOD for IPTV players like UHF
			// - Use .mp4 extension in URL (critical for UHF to detect as movie/VOD)
			// - Use 1800 (30 min) as default duration (YouTube RSS doesn't provide duration)
			const defaultDuration = 1800;
			m3u += `#EXTINF:${defaultDuration} tvg-logo="${video.thumbnail}" group-title="YouTube",${fullTitle} (${dateStr})\n`;
			m3u += `http://${streamHost}:${streamPort}/youtube/${video.videoId}.mp4\n`;
		}

		res.setHeader('Content-Type', 'audio/x-mpegurl');
		res.setHeader('Content-Disposition', 'attachment; filename="youtube.m3u"');
		res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
		res.setHeader('Pragma', 'no-cache');
		res.setHeader('Expires', '0');
		res.send(m3u);

		console.log(`[Playlist] Generated YouTube M3U with ${videos.length} videos from ${channels.length} channels (UHF VOD format)`);
	} catch (error) {
		console.error("Error generating YouTube playlist:", error);
		res.status(500).send(`Error generating playlist: ${error.message}`);
	}
});

// Twitch VOD direct URL API endpoint (returns JSON with seekable direct URL)
app.get("/api/vod/direct/:videoId", async (req, res) => {
	const { videoId } = req.params;
	const quality = req.query.quality || null;

	console.log(`[VOD-API] Getting direct URL for: ${videoId}`);

	try {
		const result = await ytdlp.getTwitchVodDirectUrl(videoId, quality);
		res.json(result);
	} catch (error) {
		console.error(`[VOD-API] Error: ${error.message}`);
		res.status(503).json({ error: error.message });
	}
});

// Twitch Clip direct URL API endpoint (returns JSON with seekable direct URL)
app.get("/api/clip/direct/:clipId", async (req, res) => {
	const { clipId } = req.params;
	const quality = req.query.quality || null;

	console.log(`[Clip-API] Getting direct URL for: ${clipId}`);

	try {
		const result = await ytdlp.getTwitchClipDirectUrl(clipId, quality);
		res.json(result);
	} catch (error) {
		console.error(`[Clip-API] Error: ${error.message}`);
		res.status(503).json({ error: error.message });
	}
});

// YouTube direct URL API endpoint (returns JSON with seekable direct URL)
app.get("/api/youtube/direct/:videoId", async (req, res) => {
	const { videoId } = req.params;
	const quality = req.query.quality || null;

	console.log(`[YouTube-API] Getting direct URL for: ${videoId}`);

	try {
		const result = await ytdlp.getDirectUrl(videoId, quality);
		res.json(result);
	} catch (error) {
		console.error(`[YouTube-API] Error: ${error.message}`);
		res.status(503).json({ error: error.message });
	}
});

// YouTube on-demand stream endpoint - redirects directly to YouTube CDN (seekable!)
app.get("/youtube/:videoId", async (req, res) => {
	// Strip .mp4 extension if present (for UHF IPTV player compatibility)
	const videoId = req.params.videoId.replace(/\.mp4$/i, '');
	const quality = req.query.quality || null;

	console.log(`[YouTube] Request for video: ${videoId}`);

	try {
		// Get direct URL from yt-dlp and redirect to it
		const result = await ytdlp.getDirectUrl(videoId, quality);

		if (result.success && result.directUrl) {
			console.log(`[YouTube] Redirecting to direct URL for ${videoId}`);
			return res.redirect(302, result.directUrl);
		} else {
			console.error(`[YouTube] Failed to get URL: ${result.error}`);
			return res.status(503).send(`Stream unavailable: ${result.error || 'Unknown error'}`);
		}
	} catch (error) {
		console.error(`[YouTube] Error: ${error.message}`);
		return res.status(503).send(`Stream unavailable: ${error.message}`);
	}
});

// Serve index.html for all other routes (SPA)
app.get("*", (req, res) => {
	res.sendFile(path.join(__dirname, "../public/index.html"));
});

// Start server
const PORT = config.server.port;
const HOST = config.server.host;

server.listen(PORT, HOST, () => {
	console.log(`🚀 Streamlink Remote server running on http://${HOST}:${PORT}`);
	console.log(`📺 Stream ports: ${config.server.streamPortStart}-${config.server.streamPortEnd}`);
	console.log(`🔌 WebSocket server ready`);

	// Initialize database
	db.init();

	// Check if authenticated
	if (twitchAPI.isAuthenticated()) {
		console.log(`✓ Authenticated as: ${twitchAPI.getUser()?.login || "unknown"}`);
	} else {
		console.log(`⚠ Not authenticated. Please log in via the web interface.`);
	}
});

// Graceful shutdown
process.on("SIGTERM", () => {
	console.log("SIGTERM received, shutting down gracefully...");
	streamlink.stopAll();
	ytdlp.stopAll();
	server.close(() => {
		console.log("Server closed");
		process.exit(0);
	});
});

process.on("SIGINT", () => {
	console.log("\nSIGINT received, shutting down gracefully...");
	streamlink.stopAll();
	ytdlp.stopAll();
	server.close(() => {
		console.log("Server closed");
		process.exit(0);
	});
});
