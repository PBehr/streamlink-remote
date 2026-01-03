const { spawn } = require("child_process");
const EventEmitter = require("events");
const os = require("os");

class YtDlpManager extends EventEmitter {
	constructor(serverConfig) {
		super();
		this.serverConfig = serverConfig;
		this.activeStreams = new Map();
		this.nextPort = serverConfig.ytdlpPortStart || serverConfig.streamPortStart;
		this.portEnd = serverConfig.ytdlpPortEnd || serverConfig.streamPortEnd;
		// Client tracking for auto-stop
		this.clientConnections = new Map();
		this.autoStopTimeout = 120000; // 2 minutes without clients before auto-stop
		this.autoStopCheckInterval = 30000;
		this._startAutoStopChecker();
	}

	_startAutoStopChecker() {
		setInterval(() => {
			this._checkAutoStop();
		}, this.autoStopCheckInterval);
	}

	_checkAutoStop() {
		const now = Date.now();
		for (const [videoId, streamData] of this.activeStreams) {
			const clientInfo = this.clientConnections.get(videoId);

			if (now - streamData.startedAt < this.autoStopTimeout) {
				continue;
			}

			if (!clientInfo || (now - clientInfo.lastActivity > this.autoStopTimeout)) {
				console.log(`[YtDlp-AutoStop] No client activity for ${videoId} in ${this.autoStopTimeout/1000}s, stopping stream`);
				this.stopStream(videoId);
				this.clientConnections.delete(videoId);
			}
		}
	}

	trackClientConnect(videoId) {
		const existing = this.clientConnections.get(videoId);
		if (existing) {
			existing.count++;
			existing.lastActivity = Date.now();
		} else {
			this.clientConnections.set(videoId, {
				count: 1,
				lastActivity: Date.now()
			});
		}
		console.log(`[YtDlp-Client] Connected to ${videoId}, active clients: ${this.clientConnections.get(videoId).count}`);
	}

	trackClientDisconnect(videoId) {
		const existing = this.clientConnections.get(videoId);
		if (existing && existing.count > 0) {
			existing.count--;
			existing.lastActivity = Date.now();
			console.log(`[YtDlp-Client] Disconnected from ${videoId}, active clients: ${existing.count}`);
		}
	}

	getLocalIpAddress() {
		const interfaces = os.networkInterfaces();
		let fallbackIp = null;

		for (const name of Object.keys(interfaces)) {
			for (const iface of interfaces[name]) {
				if (iface.family === "IPv4" && !iface.internal) {
					if (iface.address.startsWith("192.168.")) {
						return iface.address;
					}
					if (iface.address.startsWith("10.") ||
					    /^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(iface.address)) {
						fallbackIp = iface.address;
					}
				}
			}
		}

		return fallbackIp || "localhost";
	}

	getNextPort() {
		const port = this.nextPort;
		this.nextPort++;

		if (this.nextPort > this.portEnd) {
			this.nextPort = this.serverConfig.ytdlpPortStart || this.serverConfig.streamPortStart;
		}

		return port;
	}

	getOldestStreamWithoutClients() {
		const now = Date.now();
		let oldestId = null;
		let oldestTime = Infinity;

		for (const [videoId, streamData] of this.activeStreams) {
			const clientInfo = this.clientConnections.get(videoId);
			const hasRecentActivity = clientInfo && (now - clientInfo.lastActivity < 60000);

			if (!hasRecentActivity && streamData.startedAt < oldestTime) {
				oldestTime = streamData.startedAt;
				oldestId = videoId;
			}
		}

		return oldestId;
	}

	async startStream(videoId, quality = null) {
		// Check if stream already running
		if (this.activeStreams.has(videoId)) {
			const existing = this.activeStreams.get(videoId);
			return {
				success: true,
				alreadyRunning: true,
				videoId,
				url: existing.url,
				port: existing.port
			};
		}

		const port = this.getNextPort();
		const streamHost = process.env.EXTERNAL_HOST ||
		                   (this.serverConfig.host === "0.0.0.0" ? this.getLocalIpAddress() : this.serverConfig.host);
		const url = `http://${streamHost}:${port}/`;

		const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;

		// yt-dlp arguments to serve HTTP stream
		// Using --no-part to avoid partial downloads and -o - to output to stdout
		// Then pipe through a simple HTTP server using ffmpeg
		const ytdlpQuality = quality || "best";

		// Use yt-dlp to get the direct URL first, then serve it via a simple HTTP redirect
		// Or use yt-dlp with ffmpeg to re-stream
		const args = [
			"-f", ytdlpQuality === "best" ? "best[ext=mp4]/best" : `best[height<=${ytdlpQuality.replace('p', '')}][ext=mp4]/best`,
			"--no-warnings",
			"-g", // Get URL only
			videoUrl
		];

		console.log(`[YtDlp] Getting stream URL for: ${videoId} (${ytdlpQuality})`);
		console.log(`[YtDlp] Command: yt-dlp ${args.join(" ")}`);

		return new Promise((resolve, reject) => {
			const ytdlpProcess = spawn("yt-dlp", args);

			let outputBuffer = "";
			let errorBuffer = "";

			ytdlpProcess.stdout.on("data", (data) => {
				outputBuffer += data.toString();
			});

			ytdlpProcess.stderr.on("data", (data) => {
				errorBuffer += data.toString();
				console.error(`[YtDlp][${videoId}] ${data.toString().trim()}`);
			});

			ytdlpProcess.on("close", (code) => {
				if (code === 0 && outputBuffer.trim()) {
					// yt-dlp returned the direct URL(s)
					const urls = outputBuffer.trim().split("\n");
					const streamUrl = urls[0]; // Use the first URL (video)

					console.log(`[YtDlp] Got direct URL for ${videoId}`);

					// Now start ffmpeg to serve this as HTTP
					this._startHttpServer(videoId, streamUrl, port, streamHost)
						.then((result) => {
							resolve(result);
						})
						.catch((err) => {
							reject(err);
						});
				} else {
					console.error(`[YtDlp] Failed to get URL for ${videoId}: ${errorBuffer}`);
					reject(new Error(`yt-dlp failed: ${errorBuffer || 'Unknown error'}`));
				}
			});

			ytdlpProcess.on("error", (error) => {
				console.error(`[YtDlp] Process error:`, error);
				reject(error);
			});

			// Timeout after 30 seconds
			setTimeout(() => {
				if (!this.activeStreams.has(videoId)) {
					ytdlpProcess.kill();
					reject(new Error("yt-dlp timeout after 30s"));
				}
			}, 30000);
		});
	}

	async _startHttpServer(videoId, sourceUrl, port, streamHost) {
		return new Promise((resolve, reject) => {
			// Use ffmpeg to re-stream the video as HLS/HTTP
			const args = [
				"-re", // Read input at native frame rate
				"-i", sourceUrl,
				"-c", "copy", // Copy codecs, no re-encoding
				"-f", "mpegts", // MPEG-TS format for HTTP streaming
				"-listen", "1",
				`http://0.0.0.0:${port}/`
			];

			console.log(`[YtDlp] Starting ffmpeg HTTP server on port ${port}`);

			const ffmpegProcess = spawn("ffmpeg", args, {
				detached: false,
				stdio: ['pipe', 'pipe', 'pipe']
			});

			const url = `http://${streamHost}:${port}/`;

			const streamData = {
				videoId,
				port,
				url,
				process: ffmpegProcess,
				startedAt: Date.now(),
				pid: ffmpegProcess.pid
			};

			let resolved = false;

			ffmpegProcess.stderr.on("data", (data) => {
				const output = data.toString();
				// FFmpeg outputs progress info to stderr
				if (output.includes("Opening") || output.includes("Stream mapping") || output.includes("Output")) {
					if (!resolved) {
						resolved = true;
						this.activeStreams.set(videoId, streamData);
						this.emit("stream:started", { videoId, url, port });
						resolve({
							success: true,
							videoId,
							url,
							port
						});
					}
				}
				// Only log errors, not progress
				if (output.includes("error") || output.includes("Error")) {
					console.error(`[YtDlp-FFmpeg][${videoId}] ${output.trim()}`);
				}
			});

			ffmpegProcess.on("error", (error) => {
				console.error(`[YtDlp-FFmpeg] Process error:`, error);
				if (!resolved) {
					resolved = true;
					reject(error);
				}
			});

			ffmpegProcess.on("close", (code) => {
				console.log(`[YtDlp-FFmpeg][${videoId}] Process exited with code ${code}`);
				this.activeStreams.delete(videoId);
				this.emit("stream:ended", { videoId, code });

				if (!resolved) {
					resolved = true;
					reject(new Error(`FFmpeg exited with code ${code}`));
				}
			});

			// Give ffmpeg time to start listening
			setTimeout(() => {
				if (!resolved) {
					resolved = true;
					this.activeStreams.set(videoId, streamData);
					this.emit("stream:started", { videoId, url, port });
					resolve({
						success: true,
						videoId,
						url,
						port
					});
				}
			}, 2000);
		});
	}

	stopStream(videoId) {
		const streamData = this.activeStreams.get(videoId);

		if (!streamData) {
			return {
				success: false,
				error: "Stream not running"
			};
		}

		console.log(`[YtDlp] Stopping stream: ${videoId}`);

		try {
			streamData.process.kill("SIGTERM");

			setTimeout(() => {
				if (this.activeStreams.has(videoId)) {
					console.log(`[YtDlp] Force killing stream: ${videoId}`);
					streamData.process.kill("SIGKILL");
				}
			}, 5000);

			return {
				success: true,
				videoId
			};
		} catch (error) {
			console.error(`[YtDlp] Error stopping stream ${videoId}:`, error);
			return {
				success: false,
				error: error.message
			};
		}
	}

	stopAll() {
		console.log(`[YtDlp] Stopping all ${this.activeStreams.size} active streams...`);

		for (const [videoId] of this.activeStreams) {
			this.stopStream(videoId);
		}
	}

	getActiveStreams() {
		return Array.from(this.activeStreams.values()).map((stream) => ({
			videoId: stream.videoId,
			url: stream.url,
			port: stream.port,
			startedAt: stream.startedAt,
			uptime: Date.now() - stream.startedAt
		}));
	}

	isStreamActive(videoId) {
		return this.activeStreams.has(videoId);
	}
}

module.exports = YtDlpManager;
