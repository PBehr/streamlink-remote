const { spawn } = require("child_process");
const EventEmitter = require("events");
const os = require("os");

class StreamlinkManager extends EventEmitter {
	constructor(config, serverConfig) {
		super();
		this.config = config;
		this.serverConfig = serverConfig;
		this.activeStreams = new Map();
		this.nextPort = serverConfig.streamPortStart;
		// Client tracking for auto-stop
		this.clientConnections = new Map(); // channel -> { count: number, lastActivity: timestamp }
		this.autoStopTimeout = 120000; // 2 minutes without clients before auto-stop
		this.autoStopCheckInterval = 30000; // Check every 30 seconds
		this._startAutoStopChecker();
	}

	// Start periodic checker for streams without clients
	_startAutoStopChecker() {
		setInterval(() => {
			this._checkAutoStop();
		}, this.autoStopCheckInterval);
	}

	// Check and stop streams without recent client activity
	_checkAutoStop() {
		const now = Date.now();
		for (const [channel, streamData] of this.activeStreams) {
			const clientInfo = this.clientConnections.get(channel);

			// Skip if stream was started less than autoStopTimeout ago
			if (now - streamData.startedAt < this.autoStopTimeout) {
				continue;
			}

			// If no client info exists or no recent activity, consider stopping
			if (!clientInfo || (now - clientInfo.lastActivity > this.autoStopTimeout)) {
				console.log(`[AutoStop] No client activity for ${channel} in ${this.autoStopTimeout/1000}s, stopping stream`);
				this.stopStream(channel);
				this.clientConnections.delete(channel);
			}
		}
	}

	// Track client connection to a stream
	trackClientConnect(channel) {
		const lowerChannel = channel.toLowerCase();
		const existing = this.clientConnections.get(lowerChannel);
		if (existing) {
			existing.count++;
			existing.lastActivity = Date.now();
		} else {
			this.clientConnections.set(lowerChannel, {
				count: 1,
				lastActivity: Date.now()
			});
		}
		console.log(`[Client] Connected to ${channel}, active clients: ${this.clientConnections.get(lowerChannel).count}`);
	}

	// Track client disconnect from a stream
	trackClientDisconnect(channel) {
		const lowerChannel = channel.toLowerCase();
		const existing = this.clientConnections.get(lowerChannel);
		if (existing && existing.count > 0) {
			existing.count--;
			existing.lastActivity = Date.now();
			console.log(`[Client] Disconnected from ${channel}, active clients: ${existing.count}`);
		}
	}

	// Get oldest stream without active clients (for replacement when max streams reached)
	getOldestStreamWithoutClients() {
		const now = Date.now();
		let oldestChannel = null;
		let oldestTime = Infinity;

		for (const [channel, streamData] of this.activeStreams) {
			const clientInfo = this.clientConnections.get(channel.toLowerCase());

			// Consider "without clients" if no recent activity (last 60 seconds)
			const hasRecentActivity = clientInfo && (now - clientInfo.lastActivity < 60000);

			if (!hasRecentActivity && streamData.startedAt < oldestTime) {
				oldestTime = streamData.startedAt;
				oldestChannel = channel;
			}
		}

		return oldestChannel;
	}

	getLocalIpAddress() {
		const interfaces = os.networkInterfaces();
		let fallbackIp = null;

		for (const name of Object.keys(interfaces)) {
			for (const iface of interfaces[name]) {
				// Skip internal (loopback) and non-IPv4 addresses
				if (iface.family === "IPv4" && !iface.internal) {
					// Prefer 192.168.x.x addresses (typical home network)
					if (iface.address.startsWith("192.168.")) {
						return iface.address;
					}
					// Also accept 10.x.x.x and 172.16-31.x.x (private networks)
					if (iface.address.startsWith("10.") ||
					    /^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(iface.address)) {
						fallbackIp = iface.address;
					}
				}
			}
		}

		return fallbackIp || "localhost"; // Fallback
	}

	getNextPort() {
		const port = this.nextPort;
		this.nextPort++;

		if (this.nextPort > this.serverConfig.streamPortEnd) {
			this.nextPort = this.serverConfig.streamPortStart;
		}

		return port;
	}

	async startStream(channel, quality = null, customUrl = null) {
		// Check if stream already running
		if (this.activeStreams.has(channel)) {
			const existing = this.activeStreams.get(channel);
			return {
				success: true,
				alreadyRunning: true,
				channel,
				url: existing.url,
				port: existing.port
			};
		}

		const streamQuality = quality || this.config.defaultQuality;
		const port = this.getNextPort();
		// Use EXTERNAL_HOST env var if set, otherwise auto-detect
		const streamHost = process.env.EXTERNAL_HOST ||
		                   (this.serverConfig.host === "0.0.0.0" ? this.getLocalIpAddress() : this.serverConfig.host);
		const url = `http://${streamHost}:${port}/`;

		// Determine the source URL (Twitch channel or custom URL for YouTube etc.)
		const sourceUrl = customUrl || `twitch.tv/${channel}`;
		const isTwitch = !customUrl && !channel.startsWith("yt:");

		const args = [
			sourceUrl,
			streamQuality,
			"--player-external-http",
			"--player-external-http-interface",
			this.serverConfig.host,
			"--player-external-http-port",
			String(port),
			"--retry-streams",
			String(this.config.retryStreams),
			"--retry-open",
			String(this.config.retryOpen)
		];

		// Add Twitch-specific options only for Twitch streams
		if (isTwitch) {
			args.push(
				"--twitch-disable-ads",
				"--twitch-proxy-playlist=https://eu.luminous.dev,https://lb-eu.cdn-perfprod.com"
			);
		}

		console.log(`Starting stream: ${channel} (${streamQuality}) on port ${port}`);
		console.log(`Command: ${this.config.executable} ${args.join(" ")}`);

		return new Promise((resolve, reject) => {
			const process = spawn(this.config.executable, args);

			const streamData = {
				channel,
				quality: streamQuality,
				port,
				url,
				process,
				startedAt: Date.now(),
				pid: process.pid
			};

			let outputBuffer = "";
			let errorBuffer = "";
			let resolved = false;

			const resolveSuccess = () => {
				if (!resolved) {
					resolved = true;
					this.activeStreams.set(channel, streamData);
					this.emit("stream:started", {
						channel,
						url,
						port,
						quality: streamQuality
					});
					resolve({
						success: true,
						channel,
						url,
						port,
						quality: streamQuality
					});
				}
			};

			const rejectError = (error) => {
				if (!resolved) {
					resolved = true;
					this.emit("stream:error", {
						channel,
						error: error.message
					});
					reject(error);
				}
			};

			// Timeout after configured seconds
			const timeout = setTimeout(() => {
				if (!resolved) {
					process.kill();
					rejectError(new Error(`Stream startup timeout after ${this.config.timeout}s`));
				}
			}, this.config.timeout * 1000);

			process.stdout.on("data", (data) => {
				const output = data.toString();
				outputBuffer += output;
				console.log(`[${channel}] ${output.trim()}`);

				// Look for successful stream start indicators
				if (output.includes("Starting server") || output.includes("Opening stream")) {
					clearTimeout(timeout);
					resolveSuccess();
				}
			});

			process.stderr.on("data", (data) => {
				const error = data.toString();
				errorBuffer += error;
				console.error(`[${channel}] ERROR: ${error.trim()}`);

				// Check for common errors
				if (error.includes("Unable to open URL") || error.includes("No playable streams found")) {
					clearTimeout(timeout);
					process.kill();
					rejectError(new Error("Stream not available or offline"));
				}
			});

			process.on("error", (error) => {
				clearTimeout(timeout);
				console.error(`[${channel}] Process error:`, error);
				rejectError(error);
			});

			process.on("close", (code) => {
				clearTimeout(timeout);
				console.log(`[${channel}] Process exited with code ${code}`);

				this.activeStreams.delete(channel);

				this.emit("stream:ended", {
					channel,
					code,
					error: code !== 0 ? errorBuffer : null
				});

				// If we haven't resolved yet, this is an error
				if (!resolved) {
					rejectError(new Error(`Streamlink exited with code ${code}: ${errorBuffer}`));
				}
			});

			// Assume success after a short delay if we don't see explicit confirmation
			setTimeout(() => {
				if (!resolved && !errorBuffer.includes("error")) {
					resolveSuccess();
				}
			}, 3000);
		});
	}

	stopStream(channel) {
		const streamData = this.activeStreams.get(channel);

		if (!streamData) {
			return {
				success: false,
				error: "Stream not running"
			};
		}

		console.log(`Stopping stream: ${channel}`);

		try {
			streamData.process.kill("SIGTERM");

			// Force kill after 5 seconds if not terminated
			setTimeout(() => {
				if (this.activeStreams.has(channel)) {
					console.log(`Force killing stream: ${channel}`);
					streamData.process.kill("SIGKILL");
				}
			}, 5000);

			return {
				success: true,
				channel
			};
		} catch (error) {
			console.error(`Error stopping stream ${channel}:`, error);
			return {
				success: false,
				error: error.message
			};
		}
	}

	stopAll() {
		console.log(`Stopping all ${this.activeStreams.size} active streams...`);

		for (const [channel] of this.activeStreams) {
			this.stopStream(channel);
		}
	}

	getActiveStreams() {
		return Array.from(this.activeStreams.values()).map((stream) => ({
			channel: stream.channel,
			quality: stream.quality,
			url: stream.url,
			port: stream.port,
			startedAt: stream.startedAt,
			uptime: Date.now() - stream.startedAt
		}));
	}

	isStreamActive(channel) {
		return this.activeStreams.has(channel);
	}
}

module.exports = StreamlinkManager;
