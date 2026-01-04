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
const RecordingManager = require("./recording-manager");

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
const recordingManager = new RecordingManager(config, twitchAPI, db);

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

// ============================================================================
// RECORDING RULES API - Auto-record streams by channel/game
// ============================================================================

// Get all recording rules
app.get("/api/recording-rules", (req, res) => {
	try {
		const rules = db.getRecordingRules();
		res.json({ rules });
	} catch (error) {
		res.status(500).json({ error: error.message });
	}
});

// Add a new recording rule
app.post("/api/recording-rules", async (req, res) => {
	try {
		const { channel_login, channel_name, game_name, quality, enabled } = req.body;

		if (!channel_login) {
			return res.status(400).json({ error: "channel_login is required" });
		}

		const ruleId = db.addRecordingRule({
			channel_login,
			channel_name: channel_name || channel_login,
			game_name: game_name || null,
			quality: quality || "best",
			enabled: enabled !== false
		});

		const rule = db.getRecordingRule(ruleId);
		res.status(201).json({ rule });
	} catch (error) {
		res.status(500).json({ error: error.message });
	}
});

// Update a recording rule
app.put("/api/recording-rules/:id", (req, res) => {
	try {
		const { id } = req.params;
		const updates = req.body;

		const existing = db.getRecordingRule(id);
		if (!existing) {
			return res.status(404).json({ error: "Rule not found" });
		}

		db.updateRecordingRule(id, updates);
		const rule = db.getRecordingRule(id);
		res.json({ rule });
	} catch (error) {
		res.status(500).json({ error: error.message });
	}
});

// Delete a recording rule
app.delete("/api/recording-rules/:id", (req, res) => {
	try {
		const { id } = req.params;

		const existing = db.getRecordingRule(id);
		if (!existing) {
			return res.status(404).json({ error: "Rule not found" });
		}

		db.deleteRecordingRule(id);
		res.json({ success: true });
	} catch (error) {
		res.status(500).json({ error: error.message });
	}
});

// Get all recordings
app.get("/api/recordings", (req, res) => {
	try {
		const limit = parseInt(req.query.limit) || 50;
		const recordings = db.getRecordings(limit);
		const activeRecordings = recordingManager.getActiveRecordings();
		res.json({ recordings, activeRecordings });
	} catch (error) {
		res.status(500).json({ error: error.message });
	}
});

// Delete a recording
app.delete("/api/recordings/:id", (req, res) => {
	try {
		const { id } = req.params;
		const recording = db.getRecordingByFilepath(id) || db.getRecordings().find(r => r.id == id);

		if (!recording) {
			return res.status(404).json({ error: "Recording not found" });
		}

		// Delete file if it exists
		if (recording.filepath && fs.existsSync(recording.filepath)) {
			fs.unlinkSync(recording.filepath);
		}

		db.deleteRecording(recording.id);
		res.json({ success: true });
	} catch (error) {
		res.status(500).json({ error: error.message });
	}
});

// Search games (for autocomplete)
app.get("/api/games/search", async (req, res) => {
	try {
		const { q } = req.query;
		if (!q) {
			return res.json({ games: [] });
		}

		const games = await twitchAPI.searchGames(q);
		res.json({ games });
	} catch (error) {
		res.status(500).json({ error: error.message });
	}
});

// Get recording settings
app.get("/api/recording-settings", (req, res) => {
	try {
		const maxAgeDays = db.getSetting("recording_max_age_days", 7);
		res.json({ maxAgeDays });
	} catch (error) {
		res.status(500).json({ error: error.message });
	}
});

// Update recording settings
app.put("/api/recording-settings", (req, res) => {
	try {
		const { maxAgeDays } = req.body;
		if (maxAgeDays !== undefined) {
			db.setSetting("recording_max_age_days", maxAgeDays);
		}
		res.json({ success: true, maxAgeDays: db.getSetting("recording_max_age_days", 7) });
	} catch (error) {
		res.status(500).json({ error: error.message });
	}
});

// ============================================================================
// XTREAM CODES API - Compatible with Xtream Codes player API
// ============================================================================

// Default credentials (can be anything, we don't enforce auth)
const XTREAM_USER = "user";
const XTREAM_PASS = "pass";

// Helper to get server info for Xtream API responses
function getXtreamServerInfo() {
	const streamHost = process.env.EXTERNAL_HOST ||
	                   (config.server.host === "0.0.0.0" ? streamlink.getLocalIpAddress() : config.server.host);
	const streamPort = config.server.port;
	return {
		url: streamHost,
		port: String(streamPort),
		https_port: String(streamPort),
		server_protocol: "http",
		rtmp_port: "1935",
		timezone: "Europe/Berlin",
		timestamp_now: Math.floor(Date.now() / 1000),
		time_now: new Date().toISOString().replace('T', ' ').substring(0, 19),
		// EPG URL for IPTV players
		epg_url: `http://${streamHost}:${streamPort}/xmltv.php`
	};
}

// Helper to get user info for Xtream API responses
function getXtreamUserInfo() {
	return {
		username: XTREAM_USER,
		password: XTREAM_PASS,
		message: "Welcome to Streamlink Remote",
		auth: 1,
		status: "Active",
		exp_date: "9999999999",
		is_trial: "0",
		active_cons: "0",
		created_at: "1704067200",
		max_connections: "10",
		allowed_output_formats: ["m3u8", "ts", "rtmp"]
	};
}

// Category IDs
const CATEGORY_LIVE_FAVORITES = "1";
const CATEGORY_LIVE_720P = "2";
const CATEGORY_LIVE_480P = "3";
// Game categories use "game_{game_id}" format (e.g. "game_12345")
const CATEGORY_VOD_FAVORITES = "10";
const CATEGORY_VOD_ALL = "11";
const CATEGORY_YOUTUBE = "20";
const CATEGORY_YOUTUBE_SHORTS = "21";
const CATEGORY_CLIPS_FAVORITES = "30";
const CATEGORY_CLIPS_ALL = "31";

// Cache for VOD/YouTube manifest URLs (expires after 5 minutes)
const vodUrlCache = new Map();
const VOD_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

function getCachedVodUrl(videoId) {
	const cached = vodUrlCache.get(videoId);
	if (cached && Date.now() - cached.timestamp < VOD_CACHE_TTL) {
		console.log(`[Xtream] Cache hit for: ${videoId}`);
		return cached.url;
	}
	return null;
}

function setCachedVodUrl(videoId, url) {
	vodUrlCache.set(videoId, { url, timestamp: Date.now() });
	// Clean up old entries
	for (const [key, value] of vodUrlCache) {
		if (Date.now() - value.timestamp > VOD_CACHE_TTL) {
			vodUrlCache.delete(key);
		}
	}
}

// Main Xtream API endpoint: /player_api.php
app.get("/player_api.php", async (req, res) => {
	const { username, password, action } = req.query;

	// Basic validation (we accept any credentials)
	if (!username || !password) {
		return res.status(401).json({ error: "Missing credentials" });
	}

	console.log(`[Xtream] Action: ${action || 'auth'}, User: ${username}`);

	try {
		// No action = authentication request
		if (!action) {
			return res.json({
				user_info: getXtreamUserInfo(),
				server_info: getXtreamServerInfo()
			});
		}

		switch (action) {
			case "get_live_categories":
				return res.json(await getXtreamLiveCategories());

			case "get_live_streams":
				const liveCatId = req.query.category_id || null;
				return res.json(await getXtreamLiveStreams(liveCatId));

			case "get_vod_categories":
				return res.json(await getXtreamVodCategories());

			case "get_vod_streams":
				const vodCatId = req.query.category_id || null;
				return res.json(await getXtreamVodStreams(vodCatId));

			case "get_vod_info":
				const vodId = req.query.vod_id;
				return res.json(await getXtreamVodInfo(vodId));

			case "get_series_categories":
				// Return empty - no series support to speed up sync
				return res.json([]);

			case "get_series":
				// Return empty - no series support
				return res.json([]);

			case "get_series_info":
				// Return empty - no series support
				return res.json({});

			case "get_short_epg":
				const streamId = req.query.stream_id;
				return res.json(await getXtreamShortEpg(streamId));

			case "get_simple_data_table":
				return res.json([]);

			default:
				console.log(`[Xtream] Unknown action: ${action}`);
				return res.json([]);
		}
	} catch (error) {
		console.error(`[Xtream] Error:`, error);
		return res.status(500).json({ error: error.message });
	}
});

// XMLTV EPG endpoint - Xtream Codes compatible
// UHF and other IPTV players request this for EPG data
app.get("/xmltv.php", async (req, res) => {
	console.log(`[Xtream] XMLTV EPG request`);

	try {
		const xml = await generateXmltvEpg();
		res.setHeader('Content-Type', 'application/xml');
		res.send(xml);
	} catch (error) {
		console.error(`[Xtream] XMLTV error:`, error);
		res.setHeader('Content-Type', 'application/xml');
		res.send('<?xml version="1.0" encoding="UTF-8"?><tv></tv>');
	}
});

// Alternative EPG URL formats that some players use
app.get("/epg", async (req, res) => {
	res.redirect('/xmltv.php');
});

app.get("/epg.xml", async (req, res) => {
	res.redirect('/xmltv.php');
});

// Xtream VOD URL format: /movie/{username}/{password}/{stream_id}.{ext}
// This is the standard Xtream format that IPTV clients use
app.get("/movie/:username/:password/:streamId", async (req, res) => {
	const { streamId } = req.params;
	const videoId = streamId.replace(/\.(ts|m3u8|mp4|mkv)$/, "");
	console.log(`[Xtream] Movie request: ${videoId}`);

	// VOD request (Twitch)
	if (videoId.startsWith("vod_")) {
		const twitchId = videoId.replace("vod_", "");
		try {
			let manifestUrl = getCachedVodUrl(`vod_${twitchId}`);
			if (!manifestUrl) {
				const result = await ytdlp.getTwitchVodDirectUrl(twitchId);
				if (result.success && result.directUrl) {
					manifestUrl = result.directUrl;
					setCachedVodUrl(`vod_${twitchId}`, manifestUrl);
				}
			}
			if (manifestUrl) {
				return proxyHlsManifest(res, manifestUrl);
			}
			return res.status(503).send("VOD unavailable");
		} catch (error) {
			return res.status(503).send(`VOD error: ${error.message}`);
		}
	}

	// YouTube request
	if (videoId.startsWith("yt_")) {
		const ytId = videoId.replace("yt_", "");
		try {
			let manifestUrl = getCachedVodUrl(`yt_${ytId}`);
			if (!manifestUrl) {
				const result = await ytdlp.getDirectUrl(ytId);
				if (result.success && result.directUrl) {
					manifestUrl = result.directUrl;
					setCachedVodUrl(`yt_${ytId}`, manifestUrl);
				}
			}
			if (manifestUrl) {
				return proxyHlsManifest(res, manifestUrl);
			}
			return res.status(503).send("YouTube unavailable");
		} catch (error) {
			return res.status(503).send(`YouTube error: ${error.message}`);
		}
	}

	// Clip request (Twitch)
	if (videoId.startsWith("clip_")) {
		const clipId = videoId.replace("clip_", "");
		console.log(`[Xtream] Clip request: ${clipId}`);
		try {
			let clipUrl = getCachedVodUrl(`clip_${clipId}`);
			if (!clipUrl) {
				const result = await ytdlp.getTwitchClipDirectUrl(clipId);
				if (result.success && result.directUrl) {
					clipUrl = result.directUrl;
					setCachedVodUrl(`clip_${clipId}`, clipUrl);
				}
			}
			if (clipUrl) {
				// Clips are direct MP4 files - redirect to them
				return res.redirect(302, clipUrl);
			}
			return res.status(503).send("Clip unavailable");
		} catch (error) {
			return res.status(503).send(`Clip error: ${error.message}`);
		}
	}

	return res.status(404).send("Unknown VOD type");
});

// Cache for user_id -> channel_login mapping (populated from live streams)
const userIdToChannelMap = new Map();

// Quality offsets for stream ID encoding (must match getXtreamLiveStreams)
const QUALITY_OFFSET_720P_ROUTE = 10000000000;
const QUALITY_OFFSET_480P_ROUTE = 20000000000;

// Xtream Live stream URL format: /live/{username}/{password}/{stream_id}.{ext}
// This is the standard Xtream format that IPTV clients use for live streams
// stream_id can be:
//   - numeric user_id (e.g. "12345")
//   - channel_name (e.g. "eliasn97")
//   - channel_name@quality (e.g. "eliasn97@720p60")
//   - numeric with offset (e.g. "1000000012345" for 720p)
app.get("/live/:username/:password/:streamId", async (req, res) => {
	const { streamId } = req.params;
	let channel = streamId.replace(/\.(ts|m3u8)$/, "");
	let requestedQuality = null;

	// Check for quality suffix (e.g. "channelname@720p60")
	if (channel.includes("@")) {
		const parts = channel.split("@");
		channel = parts[0];
		requestedQuality = parts[1]; // e.g. "720p60" or "480p"
	}

	// Check if this is a numeric ID (from Xtream API)
	if (/^\d+$/.test(channel)) {
		const numericId = parseInt(channel, 10);

		// Check for quality offset in the numeric ID
		if (numericId >= QUALITY_OFFSET_480P_ROUTE) {
			requestedQuality = "480p";
			channel = String(numericId - QUALITY_OFFSET_480P_ROUTE);
		} else if (numericId >= QUALITY_OFFSET_720P_ROUTE) {
			requestedQuality = "720p60";
			channel = String(numericId - QUALITY_OFFSET_720P_ROUTE);
		}

		// Now resolve numeric user_id to channel name
		const mappedChannel = userIdToChannelMap.get(channel);
		if (mappedChannel) {
			// mappedChannel could be "channelname" or "channelname@quality"
			if (mappedChannel.includes("@")) {
				const parts = mappedChannel.split("@");
				channel = parts[0];
				if (!requestedQuality) requestedQuality = parts[1];
			} else {
				channel = mappedChannel;
			}
		} else {
			// Try to refresh the mapping from live streams
			try {
				const liveStreams = await twitchAPI.getLiveStreams();
				for (const stream of liveStreams) {
					userIdToChannelMap.set(stream.user_id, stream.user_login);
				}
				const refreshedChannel = userIdToChannelMap.get(channel);
				if (refreshedChannel) {
					channel = refreshedChannel;
				}
			} catch (e) {
				console.error(`[Xtream] Failed to resolve user_id ${channel}:`, e.message);
			}
		}
	}

	// Determine quality: URL param > DB settings > default
	let quality;
	if (requestedQuality) {
		quality = requestedQuality;
	} else {
		const settings = db.getSettings();
		quality = settings.defaultQuality || "best";
	}

	console.log(`[Xtream] Live stream request (via /live): ${channel} @ ${quality}`);

	try {
		// Check if stream is already running with same quality
		// For different qualities, we need to start a new stream
		const streamKey = requestedQuality ? `${channel}@${requestedQuality}` : channel;

		if (streamlink.isStreamActive(streamKey)) {
			const streams = streamlink.getActiveStreams();
			const stream = streams.find(s => s.channel.toLowerCase() === streamKey.toLowerCase());
			if (stream) {
				streamlink.trackClientConnect(streamKey);
				// Redirect to the stream URL
				return res.redirect(302, stream.url);
			}
		}

		// Start the stream with requested quality
		const result = await streamlink.startStream(streamKey, quality);
		if (result.success) {
			streamlink.trackClientConnect(streamKey);
			// Redirect to the stream URL
			return res.redirect(302, result.url);
		}
		return res.status(503).send(`Stream unavailable: ${result.error}`);
	} catch (error) {
		return res.status(503).send(`Stream error: ${error.message}`);
	}
});

// Xtream live stream URL format: /{username}/{password}/{stream_id}
app.get("/:username/:password/:streamId", async (req, res) => {
	const { streamId } = req.params;

	// Check if it's a VOD request (starts with "vod_")
	if (streamId.startsWith("vod_")) {
		const videoId = streamId.replace("vod_", "").replace(/\.(ts|m3u8|mp4)$/, "");
		console.log(`[Xtream] VOD stream request: ${videoId}`);

		try {
			// Check cache first
			let manifestUrl = getCachedVodUrl(`vod_${videoId}`);
			if (!manifestUrl) {
				const result = await ytdlp.getTwitchVodDirectUrl(videoId);
				if (result.success && result.directUrl) {
					manifestUrl = result.directUrl;
					setCachedVodUrl(`vod_${videoId}`, manifestUrl);
				}
			}
			if (manifestUrl) {
				// Twitch VODs have relative segment URLs - must proxy and rewrite
				return proxyHlsManifest(res, manifestUrl);
			}
			return res.status(503).send("VOD unavailable");
		} catch (error) {
			return res.status(503).send(`VOD error: ${error.message}`);
		}
	}

	// Check if it's a YouTube request (starts with "yt_")
	if (streamId.startsWith("yt_")) {
		const videoId = streamId.replace("yt_", "").replace(/\.(ts|m3u8|mp4)$/, "");
		console.log(`[Xtream] YouTube stream request: ${videoId}`);

		try {
			// Check cache first
			let manifestUrl = getCachedVodUrl(`yt_${videoId}`);
			if (!manifestUrl) {
				const result = await ytdlp.getDirectUrl(videoId);
				if (result.success && result.directUrl) {
					manifestUrl = result.directUrl;
					setCachedVodUrl(`yt_${videoId}`, manifestUrl);
				}
			}
			if (manifestUrl) {
				// Proxy the manifest - IPTV clients don't follow redirects properly
				return proxyHlsManifest(res, manifestUrl);
			}
			return res.status(503).send("YouTube unavailable");
		} catch (error) {
			return res.status(503).send(`YouTube error: ${error.message}`);
		}
	}

	// Regular live stream - streamId is the channel name
	const channel = streamId.replace(/\.(ts|m3u8)$/, "");
	console.log(`[Xtream] Live stream request: ${channel}`);

	try {
		// Check if stream is already running
		if (streamlink.isStreamActive(channel)) {
			const streams = streamlink.getActiveStreams();
			const stream = streams.find(s => s.channel.toLowerCase() === channel.toLowerCase());
			if (stream) {
				streamlink.trackClientConnect(channel);
				return res.redirect(302, stream.url);
			}
		}

		// Get quality from database settings
		const settings = db.getSettings();
		const quality = settings.defaultQuality || "best";

		// Start the stream with quality from settings
		const result = await streamlink.startStream(channel, quality);
		if (result.success) {
			streamlink.trackClientConnect(channel);
			return res.redirect(302, result.url);
		}
		return res.status(503).send(`Stream unavailable: ${result.error}`);
	} catch (error) {
		return res.status(503).send(`Stream error: ${error.message}`);
	}
});

// Helper function to proxy HLS manifest and rewrite relative URLs to absolute
async function proxyHlsManifest(res, manifestUrl) {
	try {
		const response = await fetch(manifestUrl);
		if (!response.ok) {
			return res.status(502).send("Failed to fetch manifest");
		}

		const contentType = response.headers.get('content-type') || 'application/vnd.apple.mpegurl';
		let content = await response.text();

		// Get base URL for relative paths
		const baseUrl = manifestUrl.substring(0, manifestUrl.lastIndexOf('/') + 1);

		// Rewrite relative URLs to absolute URLs
		// Match lines that are segment files (.ts) or other manifests (.m3u8) without http
		content = content.split('\n').map(line => {
			const trimmed = line.trim();
			// Skip empty lines, comments (#), and already absolute URLs
			if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('http')) {
				return line;
			}
			// This is a relative URL - make it absolute
			return baseUrl + trimmed;
		}).join('\n');

		res.setHeader('Content-Type', contentType);
		res.setHeader('Access-Control-Allow-Origin', '*');
		res.setHeader('Cache-Control', 'no-cache');
		res.send(content);
	} catch (error) {
		console.error('[Xtream] Proxy error:', error.message);
		res.status(502).send(`Proxy error: ${error.message}`);
	}
}

// ============================================================================
// Xtream API Helper Functions
// ============================================================================

async function getXtreamLiveCategories() {
	const categories = [
		{ category_id: CATEGORY_LIVE_FAVORITES, category_name: "⭐ Favorites (Best)", parent_id: 0 },
		{ category_id: CATEGORY_LIVE_720P, category_name: "📺 All Live [720p60]", parent_id: 0 },
		{ category_id: CATEGORY_LIVE_480P, category_name: "📺 All Live [480p]", parent_id: 0 }
	];

	// Get live streams to extract unique game categories
	if (twitchAPI.isAuthenticated()) {
		const liveStreams = await twitchAPI.getLiveStreams();
		const gameCategories = new Map();

		for (const stream of liveStreams) {
			const gameId = stream.game_id || "0";
			const gameName = stream.game_name || "Just Chatting";

			if (!gameCategories.has(gameId)) {
				gameCategories.set(gameId, gameName);
			}
		}

		// Add game categories (use game_id + 100 as category_id to avoid conflicts)
		for (const [gameId, gameName] of gameCategories) {
			categories.push({
				category_id: `game_${gameId}`,
				category_name: `🎮 ${gameName}`,
				parent_id: 0
			});
		}
	}

	return categories;
}

// Quality stream ID encoding (must be numeric for UHF compatibility):
// - Normal streams: use Twitch user_id directly
// - 720p streams: user_id + 10,000,000,000 (10 billion offset)
// - 480p streams: user_id + 20,000,000,000 (20 billion offset)
// Twitch user_ids are ~9 digits max, so this keeps IDs unique
const QUALITY_OFFSET_720P = 10000000000;
const QUALITY_OFFSET_480P = 20000000000;

async function getXtreamLiveStreams(categoryId = null) {
	if (!twitchAPI.isAuthenticated()) {
		return [];
	}

	const streamHost = process.env.EXTERNAL_HOST ||
	                   (config.server.host === "0.0.0.0" ? streamlink.getLocalIpAddress() : config.server.host);
	const streamPort = config.server.port;

	const streams = [];

	// Get favorites
	const favorites = db.getFavorites();
	const favoriteLogins = new Set(favorites.map(f => f.channel_login.toLowerCase()));

	// Get live streams
	const liveStreams = await twitchAPI.getLiveStreams();

	// Helper function to add a stream entry
	const addStreamEntry = (stream, qualitySuffix, quality, streamIdOffset, targetCategoryId) => {
		const channelName = stream.user_login;
		const twitchUserId = stream.user_id;
		const twitchUserIdNum = parseInt(twitchUserId, 10);
		const displayName = stream.user_name || channelName;
		const gameName = stream.game_name || "Just Chatting";
		const streamTitle = stream.title || "";
		const viewerCount = stream.viewer_count || 0;

		// Store mapping for resolution
		userIdToChannelMap.set(twitchUserId, channelName);
		if (streamIdOffset > 0) {
			const qualityStreamId = String(twitchUserIdNum + streamIdOffset);
			userIdToChannelMap.set(qualityStreamId, `${channelName}${qualitySuffix}`);
		}

		let logoUrl = stream.thumbnail_url || "";
		if (logoUrl) {
			logoUrl = logoUrl.replace('{width}', '440').replace('{height}', '248');
		}

		const streamId = streamIdOffset > 0 ? String(twitchUserIdNum + streamIdOffset) : twitchUserId;

		streams.push({
			num: streams.length + 1,
			name: qualitySuffix ? `${displayName} [${quality}]` : `${displayName} - ${gameName}`,
			stream_type: "live",
			stream_id: streamId,
			stream_icon: logoUrl,
			epg_channel_id: twitchUserId,
			added: Math.floor(Date.now() / 1000),
			category_id: targetCategoryId,
			custom_sid: channelName,
			tv_archive: 0,
			direct_source: `http://${streamHost}:${streamPort}/live/${XTREAM_USER}/${XTREAM_PASS}/${streamId}.ts`,
			tv_archive_duration: 0,
			title: streamTitle,
			viewers: viewerCount
		});
	};

	for (const stream of liveStreams) {
		const isFavorite = favoriteLogins.has(stream.user_login.toLowerCase());
		const gameId = stream.game_id || "0";
		const gameCategoryId = `game_${gameId}`;
		const defaultCategoryId = isFavorite ? CATEGORY_LIVE_FAVORITES : gameCategoryId;

		// When no category filter, return all streams in their default categories PLUS quality variants
		if (categoryId === null) {
			// Add default quality stream (in favorites or game category)
			addStreamEntry(stream, "", "best", 0, defaultCategoryId);
			// Add 720p variant
			addStreamEntry(stream, "@720p60", "720p60", QUALITY_OFFSET_720P, CATEGORY_LIVE_720P);
			// Add 480p variant
			addStreamEntry(stream, "@480p", "480p", QUALITY_OFFSET_480P, CATEGORY_LIVE_480P);
			continue;
		}

		// Filter by specific category
		if (categoryId === CATEGORY_LIVE_FAVORITES) {
			if (!isFavorite) continue;
			addStreamEntry(stream, "", "best", 0, CATEGORY_LIVE_FAVORITES);
		} else if (categoryId === CATEGORY_LIVE_720P) {
			addStreamEntry(stream, "@720p60", "720p60", QUALITY_OFFSET_720P, CATEGORY_LIVE_720P);
		} else if (categoryId === CATEGORY_LIVE_480P) {
			addStreamEntry(stream, "@480p", "480p", QUALITY_OFFSET_480P, CATEGORY_LIVE_480P);
		} else if (categoryId.startsWith("game_")) {
			if (categoryId !== gameCategoryId) continue;
			addStreamEntry(stream, "", "best", 0, gameCategoryId);
		}
	}

	return streams;
}

async function getXtreamVodCategories() {
	const categories = [
		{ category_id: CATEGORY_VOD_FAVORITES, category_name: "⭐ Favorites VODs", parent_id: 0 },
		{ category_id: CATEGORY_VOD_ALL, category_name: "📼 All VODs", parent_id: 0 },
		{ category_id: CATEGORY_CLIPS_FAVORITES, category_name: "⭐ Favorites Clips", parent_id: 0 },
		{ category_id: CATEGORY_CLIPS_ALL, category_name: "🎬 All Clips", parent_id: 0 },
		{ category_id: CATEGORY_YOUTUBE, category_name: "▶️ YouTube", parent_id: 0 },
		{ category_id: CATEGORY_YOUTUBE_SHORTS, category_name: "📱 YouTube Shorts", parent_id: 0 }
	];
	return categories;
}

async function getXtreamVodStreams(categoryId = null) {
	if (!twitchAPI.isAuthenticated()) {
		return [];
	}

	const streamHost = process.env.EXTERNAL_HOST ||
	                   (config.server.host === "0.0.0.0" ? streamlink.getLocalIpAddress() : config.server.host);
	const streamPort = config.server.port;

	const vods = [];

	// YouTube videos (including Shorts)
	if (!categoryId || categoryId === CATEGORY_YOUTUBE || categoryId === CATEGORY_YOUTUBE_SHORTS) {
		const youtubeChannels = db.getYoutubeChannels();
		for (const channel of youtubeChannels) {
			try {
				const videos = await youtubeService.fetchChannelVideos(channel.channel_id);
				// Take only the first 10 videos per channel
				const limitedVideos = videos.slice(0, 10);
				for (const video of limitedVideos) {
					// Use isShort flag from YouTube service (detected via /shorts/ URL check)
					const isShort = video.isShort || false;

					// Filter by category
					if (categoryId === CATEGORY_YOUTUBE && isShort) continue;
					if (categoryId === CATEGORY_YOUTUBE_SHORTS && !isShort) continue;

					vods.push({
						num: vods.length + 1,
						name: `${channel.channel_name} - ${video.title}`,
						stream_type: "movie",
						stream_id: `yt_${video.videoId}`,
						stream_icon: video.thumbnail,
						rating: "",
						rating_5based: 0,
						added: Math.floor(new Date(video.published).getTime() / 1000),
						category_id: isShort ? CATEGORY_YOUTUBE_SHORTS : CATEGORY_YOUTUBE,
						container_extension: "m3u8",
						custom_sid: "",
						direct_source: `http://${streamHost}:${streamPort}/${XTREAM_USER}/${XTREAM_PASS}/yt_${video.videoId}`
					});
				}
			} catch (e) {
				// Skip channels with errors
				console.error(`[Xtream] Error fetching YouTube videos for ${channel.channel_name}:`, e.message);
			}
		}
	}

	// Twitch VODs
	if (!categoryId || categoryId === CATEGORY_VOD_FAVORITES || categoryId === CATEGORY_VOD_ALL) {
		const favorites = db.getFavorites();
		const favoriteLogins = new Set(favorites.map(f => f.channel_login.toLowerCase()));
		const followedChannels = await twitchAPI.getFollowedChannels();

		for (const channel of followedChannels) {
			const isFavorite = favoriteLogins.has(channel.broadcaster_login.toLowerCase());

			// Filter by category - only filter if a specific category is requested
			if (categoryId === CATEGORY_VOD_FAVORITES && !isFavorite) continue;
			if (categoryId === CATEGORY_VOD_ALL && isFavorite) continue;
			// When categoryId is null, include all VODs (both favorites and non-favorites)

			try {
				const videos = await twitchAPI.getVideos(channel.broadcaster_id, 5, "archive");
				for (const video of videos) {
					// Parse duration
					let durationSecs = 0;
					if (video.duration) {
						const match = video.duration.match(/(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?/);
						if (match) {
							durationSecs = (parseInt(match[1]) || 0) * 3600 +
							               (parseInt(match[2]) || 0) * 60 +
							               (parseInt(match[3]) || 0);
						}
					}

					const thumbnail = video.thumbnail_url
						? video.thumbnail_url.replace('%{width}', '320').replace('%{height}', '180')
						: '';

					vods.push({
						num: vods.length + 1,
						name: `${channel.broadcaster_name} - ${video.title}`,
						stream_type: "movie",
						stream_id: `vod_${video.id}`,
						stream_icon: thumbnail,
						rating: "",
						rating_5based: 0,
						added: Math.floor(new Date(video.created_at).getTime() / 1000),
						category_id: isFavorite ? CATEGORY_VOD_FAVORITES : CATEGORY_VOD_ALL,
						container_extension: "m3u8",
						custom_sid: "",
						direct_source: `http://${streamHost}:${streamPort}/${XTREAM_USER}/${XTREAM_PASS}/vod_${video.id}`,
						// Extra VOD info
						duration: durationSecs,
						duration_secs: durationSecs,
						bitrate: 0
					});
				}
			} catch (e) {
				// Skip channels with no VODs
			}
		}
	}

	// Twitch Clips
	if (!categoryId || categoryId === CATEGORY_CLIPS_FAVORITES || categoryId === CATEGORY_CLIPS_ALL) {
		const favorites = db.getFavorites();
		const favoriteLogins = new Set(favorites.map(f => f.channel_login.toLowerCase()));
		const followedChannels = await twitchAPI.getFollowedChannels();

		const clipsList = []; // Collect clips separately for sorting

		for (const channel of followedChannels) {
			const isFavorite = favoriteLogins.has(channel.broadcaster_login.toLowerCase());

			// Filter by category
			if (categoryId === CATEGORY_CLIPS_FAVORITES && !isFavorite) continue;
			if (categoryId === CATEGORY_CLIPS_ALL && isFavorite) continue;

			try {
				// Get more clips (30 days) to have better selection for sorting by date
				const clips = await twitchAPI.getClips(channel.broadcaster_id, 10, "month");
				for (const clip of clips) {
					clipsList.push({
						clip,
						channel,
						isFavorite
					});
				}
			} catch (e) {
				// Skip channels with no clips
			}
		}

		// Sort clips by created_at (newest first) and take top results
		clipsList.sort((a, b) => new Date(b.clip.created_at) - new Date(a.clip.created_at));
		const topClips = clipsList.slice(0, 150); // Limit to 150 newest clips

		for (const { clip, channel, isFavorite } of topClips) {
			vods.push({
				num: vods.length + 1,
				name: `${channel.broadcaster_name} - ${clip.title}`,
				stream_type: "movie",
				stream_id: `clip_${clip.id}`,
				stream_icon: clip.thumbnail_url || '',
				rating: "",
				rating_5based: 0,
				added: Math.floor(new Date(clip.created_at).getTime() / 1000),
				category_id: isFavorite ? CATEGORY_CLIPS_FAVORITES : CATEGORY_CLIPS_ALL,
				container_extension: "mp4",
				custom_sid: "",
				direct_source: `http://${streamHost}:${streamPort}/movie/${XTREAM_USER}/${XTREAM_PASS}/clip_${clip.id}.mp4`,
				// Extra clip info
				duration: clip.duration || 0,
				duration_secs: clip.duration || 0,
				bitrate: 0
			});
		}
	}

	return vods;
}

async function getXtreamVodInfo(vodId) {
	if (!vodId) return {};

	const streamHost = process.env.EXTERNAL_HOST ||
	                   (config.server.host === "0.0.0.0" ? streamlink.getLocalIpAddress() : config.server.host);
	const streamPort = config.server.port;

	// YouTube video
	if (vodId.startsWith("yt_")) {
		const videoId = vodId.replace("yt_", "");
		return {
			info: {
				name: `YouTube Video ${videoId}`,
				description: "",
				category_id: CATEGORY_YOUTUBE,
				stream_type: "movie"
			},
			movie_data: {
				stream_id: vodId,
				container_extension: "m3u8",
				direct_source: `http://${streamHost}:${streamPort}/${XTREAM_USER}/${XTREAM_PASS}/${vodId}`
			}
		};
	}

	// Twitch VOD
	if (vodId.startsWith("vod_")) {
		const videoId = vodId.replace("vod_", "");
		return {
			info: {
				name: `Twitch VOD ${videoId}`,
				description: "",
				category_id: CATEGORY_VOD_FAVORITES,
				stream_type: "movie"
			},
			movie_data: {
				stream_id: vodId,
				container_extension: "m3u8",
				direct_source: `http://${streamHost}:${streamPort}/${XTREAM_USER}/${XTREAM_PASS}/${vodId}`
			}
		};
	}

	return {};
}

// Series functions removed - returning empty in switch/case to speed up sync

async function getXtreamShortEpg(streamId) {
	if (!streamId || !twitchAPI.isAuthenticated()) {
		return { epg_listings: [] };
	}

	try {
		// Get channel info to fetch current stream title
		const channelInfo = await twitchAPI.getChannel(streamId);

		if (channelInfo && channelInfo.stream) {
			const stream = channelInfo.stream;
			const now = Math.floor(Date.now() / 1000);
			const startTime = new Date(stream.started_at).getTime() / 1000;
			// Assume stream runs for 8 hours from start
			const endTime = startTime + (8 * 60 * 60);

			return {
				epg_listings: [{
					id: `epg_${streamId}_${now}`,
					epg_id: streamId,
					title: stream.title || "Live Stream",
					lang: "de",
					start: new Date(startTime * 1000).toISOString().replace('T', ' ').substring(0, 19),
					end: new Date(endTime * 1000).toISOString().replace('T', ' ').substring(0, 19),
					description: `🎮 ${stream.game_name || "Just Chatting"}\n👥 ${stream.viewer_count || 0} viewers`,
					channel_id: streamId,
					start_timestamp: startTime,
					stop_timestamp: endTime,
					now_playing: 1,
					has_archive: 0
				}]
			};
		}

		return { epg_listings: [] };
	} catch (error) {
		console.error(`[Xtream] EPG error for ${streamId}:`, error.message);
		return { epg_listings: [] };
	}
}

/**
 * Generate XMLTV format EPG for all live streams
 * This is the standard format that IPTV players like UHF expect
 */
async function generateXmltvEpg() {
	const lines = ['<?xml version="1.0" encoding="UTF-8"?>'];
	lines.push('<tv generator-info-name="Streamlink Remote" generator-info-url="http://localhost">');

	if (!twitchAPI.isAuthenticated()) {
		lines.push('</tv>');
		return lines.join('\n');
	}

	try {
		const liveStreams = await twitchAPI.getLiveStreams();

		// Generate channel definitions - use numeric user_id to match epg_channel_id in streams
		for (const stream of liveStreams) {
			const channelId = stream.user_id; // Numeric Twitch user ID
			const displayName = escapeXml(stream.user_name || stream.user_login);
			let iconUrl = stream.thumbnail_url || "";
			if (iconUrl) {
				iconUrl = iconUrl.replace('{width}', '70').replace('{height}', '70');
			}

			lines.push(`  <channel id="${channelId}">`);
			lines.push(`    <display-name>${displayName}</display-name>`);
			if (iconUrl) {
				lines.push(`    <icon src="${escapeXml(iconUrl)}" />`);
			}
			lines.push(`  </channel>`);
		}

		// Generate programme entries
		for (const stream of liveStreams) {
			const channelId = stream.user_id; // Numeric Twitch user ID
			const title = escapeXml(stream.title || "Live Stream");
			const gameName = escapeXml(stream.game_name || "Just Chatting");
			const viewerCount = stream.viewer_count || 0;

			// Parse start time
			const startTime = new Date(stream.started_at);
			// Assume 8 hours duration
			const endTime = new Date(startTime.getTime() + 8 * 60 * 60 * 1000);

			const startStr = formatXmltvDate(startTime);
			const endStr = formatXmltvDate(endTime);

			lines.push(`  <programme start="${startStr}" stop="${endStr}" channel="${channelId}">`);
			lines.push(`    <title lang="de">${title}</title>`);
			lines.push(`    <desc lang="de">🎮 ${gameName} | 👥 ${viewerCount} viewers</desc>`);
			lines.push(`    <category lang="de">${gameName}</category>`);
			lines.push(`  </programme>`);
		}

		lines.push('</tv>');
		return lines.join('\n');
	} catch (error) {
		console.error('[Xtream] Error generating XMLTV:', error.message);
		lines.push('</tv>');
		return lines.join('\n');
	}
}

function escapeXml(str) {
	if (!str) return '';
	return str
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&apos;');
}

function formatXmltvDate(date) {
	// Format: YYYYMMDDHHmmss +0100
	const pad = (n) => n.toString().padStart(2, '0');
	const year = date.getFullYear();
	const month = pad(date.getMonth() + 1);
	const day = pad(date.getDate());
	const hours = pad(date.getHours());
	const minutes = pad(date.getMinutes());
	const seconds = pad(date.getSeconds());

	// Get timezone offset
	const tzOffset = -date.getTimezoneOffset();
	const tzHours = pad(Math.floor(Math.abs(tzOffset) / 60));
	const tzMins = pad(Math.abs(tzOffset) % 60);
	const tzSign = tzOffset >= 0 ? '+' : '-';

	return `${year}${month}${day}${hours}${minutes}${seconds} ${tzSign}${tzHours}${tzMins}`;
}

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

	// Initialize recording manager
	recordingManager.init();

	// Check if authenticated
	if (twitchAPI.isAuthenticated()) {
		console.log(`✓ Authenticated as: ${twitchAPI.getUser()?.login || "unknown"}`);
	} else {
		console.log(`⚠ Not authenticated. Please log in via the web interface.`);
	}
});

// Graceful shutdown
process.on("SIGTERM", async () => {
	console.log("SIGTERM received, shutting down gracefully...");
	await recordingManager.shutdown();
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
