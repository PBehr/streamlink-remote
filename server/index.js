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

// Use in-memory database for Windows testing (better-sqlite3 has native build issues)
const Database = require("./database-memory");
const TwitchAPI = require("./twitch-api");
const StreamlinkManager = require("./streamlink");

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Initialize components
const db = new Database(config.database.path);
const twitchAPI = new TwitchAPI(config.twitch, db);
const streamlink = new StreamlinkManager(config.streamlink, config.server);

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
	server.close(() => {
		console.log("Server closed");
		process.exit(0);
	});
});

process.on("SIGINT", () => {
	console.log("\nSIGINT received, shutting down gracefully...");
	streamlink.stopAll();
	server.close(() => {
		console.log("Server closed");
		process.exit(0);
	});
});
