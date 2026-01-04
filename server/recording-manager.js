const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");

class RecordingManager {
	constructor(config, twitchAPI, db) {
		this.config = config;
		this.twitchAPI = twitchAPI;
		this.db = db;
		this.activeRecordings = new Map(); // channelLogin -> recording info
		this.checkInterval = null;
		this.cleanupInterval = null;

		// Default settings
		this.recordingsDir = process.env.RECORDINGS_DIR || "/recordings";
		this.checkIntervalMs = 60000; // Check every minute
		this.maxRecordingAgeDays = 7; // Auto-delete after 7 days
	}

	/**
	 * Initialize the recording manager
	 */
	init() {
		// Ensure recordings directory exists
		if (!fs.existsSync(this.recordingsDir)) {
			fs.mkdirSync(this.recordingsDir, { recursive: true });
		}

		// Start checking for streams to record
		this.startMonitoring();

		// Start cleanup scheduler
		this.startCleanupScheduler();

		console.log(`✓ Recording Manager initialized (dir: ${this.recordingsDir})`);
	}

	/**
	 * Start monitoring streams for recording
	 */
	startMonitoring() {
		// Initial check
		this.checkRecordingRules();

		// Schedule regular checks
		this.checkInterval = setInterval(() => {
			this.checkRecordingRules();
		}, this.checkIntervalMs);
	}

	/**
	 * Stop monitoring
	 */
	stopMonitoring() {
		if (this.checkInterval) {
			clearInterval(this.checkInterval);
			this.checkInterval = null;
		}
	}

	/**
	 * Check all recording rules and start/stop recordings as needed
	 */
	async checkRecordingRules() {
		if (!this.twitchAPI.isAuthenticated()) {
			return;
		}

		try {
			const rules = this.db.getRecordingRules();
			if (rules.length === 0) {
				return;
			}

			// Get all live streams we're interested in
			const channelLogins = [...new Set(rules.map(r => r.channel_login))];
			const liveStreams = await this.getLiveStatusForChannels(channelLogins);

			for (const rule of rules) {
				if (!rule.enabled) continue;

				const stream = liveStreams.get(rule.channel_login.toLowerCase());
				const isRecording = this.activeRecordings.has(rule.channel_login.toLowerCase());

				if (stream && this.shouldRecord(rule, stream)) {
					// Stream matches rule criteria - start recording if not already
					if (!isRecording) {
						await this.startRecording(rule, stream);
					}
				} else {
					// Stream doesn't match or is offline - stop recording if active
					if (isRecording) {
						const recording = this.activeRecordings.get(rule.channel_login.toLowerCase());
						// Only stop if this recording was started by this rule
						if (recording.ruleId === rule.id) {
							await this.stopRecording(rule.channel_login);
						}
					}
				}
			}
		} catch (error) {
			console.error("[Recording] Error checking rules:", error.message);
		}
	}

	/**
	 * Get live status for multiple channels
	 */
	async getLiveStatusForChannels(channelLogins) {
		const result = new Map();

		try {
			// Use Twitch API to get stream info
			const streams = await this.twitchAPI.getStreamsByLogins(channelLogins);

			for (const stream of streams) {
				result.set(stream.user_login.toLowerCase(), stream);
			}
		} catch (error) {
			console.error("[Recording] Error fetching stream status:", error.message);
		}

		return result;
	}

	/**
	 * Check if a stream matches the recording rule criteria
	 */
	shouldRecord(rule, stream) {
		// If no game filter, record any stream
		if (!rule.game_name || rule.game_name === "*") {
			return true;
		}

		// Check if game matches (case-insensitive)
		const streamGame = (stream.game_name || "").toLowerCase();
		const ruleGame = rule.game_name.toLowerCase();

		return streamGame.includes(ruleGame) || ruleGame.includes(streamGame);
	}

	/**
	 * Start recording a stream
	 */
	async startRecording(rule, stream) {
		const channelLogin = rule.channel_login.toLowerCase();

		if (this.activeRecordings.has(channelLogin)) {
			return; // Already recording
		}

		// Generate filename with timestamp
		const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
		const gameName = (stream.game_name || "unknown").replace(/[^a-zA-Z0-9]/g, "_");
		const filename = `${channelLogin}_${gameName}_${timestamp}.ts`;
		const filepath = path.join(this.recordingsDir, filename);

		console.log(`[Recording] Starting: ${channelLogin} (${stream.game_name})`);

		// Use streamlink to record
		const args = [
			`twitch.tv/${channelLogin}`,
			rule.quality || "best",
			"-o", filepath,
			"--twitch-disable-ads",
			"--twitch-proxy-playlist=https://eu.luminous.dev,https://lb-eu.cdn-perfprod.com"
		];

		const process = spawn("streamlink", args);

		const recordingInfo = {
			ruleId: rule.id,
			channelLogin,
			gameName: stream.game_name,
			streamTitle: stream.title,
			filepath,
			filename,
			process,
			startedAt: Date.now(),
			pid: process.pid
		};

		this.activeRecordings.set(channelLogin, recordingInfo);

		// Save to database
		this.db.addRecording({
			rule_id: rule.id,
			channel_login: channelLogin,
			channel_name: stream.user_name,
			game_name: stream.game_name,
			stream_title: stream.title,
			filename,
			filepath,
			started_at: Date.now(),
			status: "recording"
		});

		process.stdout.on("data", (data) => {
			// Streamlink output (optional logging)
		});

		process.stderr.on("data", (data) => {
			const msg = data.toString();
			if (msg.includes("error") || msg.includes("Error")) {
				console.error(`[Recording] ${channelLogin}: ${msg}`);
			}
		});

		process.on("close", (code) => {
			console.log(`[Recording] Ended: ${channelLogin} (exit code: ${code})`);
			this.activeRecordings.delete(channelLogin);

			// Update database
			const fileSize = fs.existsSync(filepath) ? fs.statSync(filepath).size : 0;
			this.db.updateRecordingStatus(filepath, {
				status: code === 0 ? "completed" : "failed",
				ended_at: Date.now(),
				file_size: fileSize
			});
		});

		process.on("error", (error) => {
			console.error(`[Recording] Process error for ${channelLogin}:`, error.message);
			this.activeRecordings.delete(channelLogin);
			this.db.updateRecordingStatus(filepath, {
				status: "failed",
				ended_at: Date.now(),
				error: error.message
			});
		});
	}

	/**
	 * Stop recording a stream
	 */
	async stopRecording(channelLogin) {
		const recording = this.activeRecordings.get(channelLogin.toLowerCase());
		if (!recording) {
			return;
		}

		console.log(`[Recording] Stopping: ${channelLogin}`);

		// Send SIGTERM to gracefully stop streamlink
		if (recording.process && !recording.process.killed) {
			recording.process.kill("SIGTERM");
		}

		// Will be cleaned up in the 'close' event handler
	}

	/**
	 * Stop all active recordings
	 */
	async stopAllRecordings() {
		for (const [channelLogin] of this.activeRecordings) {
			await this.stopRecording(channelLogin);
		}
	}

	/**
	 * Get all active recordings
	 */
	getActiveRecordings() {
		const recordings = [];
		for (const [channelLogin, info] of this.activeRecordings) {
			recordings.push({
				channelLogin,
				gameName: info.gameName,
				streamTitle: info.streamTitle,
				filename: info.filename,
				startedAt: info.startedAt,
				duration: Date.now() - info.startedAt
			});
		}
		return recordings;
	}

	/**
	 * Start cleanup scheduler
	 */
	startCleanupScheduler() {
		// Run cleanup once at startup
		this.cleanupOldRecordings();

		// Schedule daily cleanup
		this.cleanupInterval = setInterval(() => {
			this.cleanupOldRecordings();
		}, 24 * 60 * 60 * 1000); // Every 24 hours
	}

	/**
	 * Clean up old recordings
	 */
	cleanupOldRecordings() {
		const maxAgeDays = this.db.getSetting("recording_max_age_days", this.maxRecordingAgeDays);
		const maxAgeMs = maxAgeDays * 24 * 60 * 60 * 1000;
		const cutoffTime = Date.now() - maxAgeMs;

		console.log(`[Recording] Cleaning up recordings older than ${maxAgeDays} days`);

		try {
			// Get old recordings from database
			const oldRecordings = this.db.getRecordingsOlderThan(cutoffTime);

			for (const recording of oldRecordings) {
				// Delete file if it exists
				if (recording.filepath && fs.existsSync(recording.filepath)) {
					fs.unlinkSync(recording.filepath);
					console.log(`[Recording] Deleted: ${recording.filename}`);
				}

				// Remove from database
				this.db.deleteRecording(recording.id);
			}

			// Also scan recordings directory for orphaned files
			const files = fs.readdirSync(this.recordingsDir);
			for (const file of files) {
				const filepath = path.join(this.recordingsDir, file);
				const stats = fs.statSync(filepath);

				if (stats.mtimeMs < cutoffTime) {
					// File is old, check if it's tracked in database
					const inDb = this.db.getRecordingByFilepath(filepath);
					if (!inDb) {
						fs.unlinkSync(filepath);
						console.log(`[Recording] Deleted orphaned file: ${file}`);
					}
				}
			}
		} catch (error) {
			console.error("[Recording] Cleanup error:", error.message);
		}
	}

	/**
	 * Shutdown the recording manager
	 */
	async shutdown() {
		this.stopMonitoring();

		if (this.cleanupInterval) {
			clearInterval(this.cleanupInterval);
		}

		await this.stopAllRecordings();
	}
}

module.exports = RecordingManager;
