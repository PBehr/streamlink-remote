const xml2js = require("xml2js");

class YouTubeService {
	constructor() {
		this.parser = new xml2js.Parser();
	}

	/**
	 * Extract channel ID from various YouTube URL formats
	 * Supports:
	 * - https://www.youtube.com/channel/UCxxxxxx
	 * - https://www.youtube.com/@handle
	 * - https://www.youtube.com/c/ChannelName
	 * - https://www.youtube.com/user/Username
	 * - Direct channel ID
	 */
	async resolveChannelId(input) {
		// Already a channel ID (starts with UC and is 24 chars)
		if (/^UC[\w-]{22}$/.test(input)) {
			return { channelId: input, channelName: null };
		}

		// Extract from URL
		let url;
		try {
			url = new URL(input);
		} catch {
			// Not a URL, treat as handle (with or without @)
			const handle = input.startsWith("@") ? input : `@${input}`;
			return this.resolveHandle(handle);
		}

		const pathname = url.pathname;

		// /channel/UCxxxxxx format
		const channelMatch = pathname.match(/\/channel\/(UC[\w-]{22})/);
		if (channelMatch) {
			return { channelId: channelMatch[1], channelName: null };
		}

		// /@handle format
		const handleMatch = pathname.match(/\/@([\w-]+)/);
		if (handleMatch) {
			return this.resolveHandle("@" + handleMatch[1]);
		}

		// /c/ChannelName or /user/Username format - need to fetch page to get channel ID
		const customMatch = pathname.match(/\/(c|user)\/([\w-]+)/);
		if (customMatch) {
			return this.resolveFromPage(input);
		}

		throw new Error("Could not parse YouTube channel URL");
	}

	/**
	 * Resolve @handle to channel ID by fetching the page
	 */
	async resolveHandle(handle) {
		const url = `https://www.youtube.com/${handle}`;
		return this.resolveFromPage(url);
	}

	/**
	 * Fetch YouTube page and extract channel ID and name
	 */
	async resolveFromPage(url) {
		try {
			const response = await fetch(url, {
				headers: {
					"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
					"Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
					"Accept-Language": "en-US,en;q=0.5",
					"Accept-Encoding": "gzip, deflate, br",
					"Connection": "keep-alive",
					"Upgrade-Insecure-Requests": "1"
				}
			});

			if (!response.ok) {
				throw new Error(`Failed to fetch YouTube page: ${response.status}`);
			}

			const html = await response.text();

			// Extract channel ID from page - try multiple patterns
			// IMPORTANT: Order matters! Some patterns may match linked/featured channels instead of the main channel
			let channelId = null;
			let channelName = null;

			// Pattern 1: Canonical URL - most reliable, always the main channel
			const canonicalMatch = html.match(/<link rel="canonical" href="[^"]*\/channel\/(UC[\w-]{22})"/);
			if (canonicalMatch) {
				channelId = canonicalMatch[1];
			}

			// Pattern 2: browseId - usually the main channel
			if (!channelId) {
				const browseIdMatch = html.match(/"browseId":"(UC[\w-]{22})"/);
				if (browseIdMatch) {
					channelId = browseIdMatch[1];
				}
			}

			// Pattern 3: /channel/UCxxxxxx in any URL (less reliable)
			if (!channelId) {
				const channelMatch = html.match(/\/channel\/(UC[\w-]{22})/);
				if (channelMatch) {
					channelId = channelMatch[1];
				}
			}

			if (!channelId) {
				console.error("Could not find channel ID. HTML length:", html.length);
				throw new Error("Could not find channel ID on page");
			}

			// Extract channel name
			const nameMatch = html.match(/"author":"([^"]+)"/);
			if (nameMatch) {
				channelName = nameMatch[1];
			} else {
				// Try title pattern
				const titleMatch = html.match(/<title>([^<]+)<\/title>/);
				if (titleMatch) {
					channelName = titleMatch[1].replace(" - YouTube", "").trim();
				}
			}

			return {
				channelId,
				channelName
			};
		} catch (error) {
			console.error("Error resolving YouTube channel:", error.message);
			throw error;
		}
	}

	/**
	 * Get RSS feed URL for a channel
	 */
	getRssFeedUrl(channelId) {
		return `https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`;
	}

	/**
	 * Check if a video is a YouTube Short by checking aspect ratio via oEmbed
	 * Shorts have portrait orientation (height > width), regular videos are landscape
	 */
	async isShort(videoId) {
		try {
			const response = await fetch(
				`https://www.youtube.com/oembed?url=https://www.youtube.com/shorts/${videoId}&format=json`,
				{
					headers: {
						"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
					}
				}
			);

			if (response.status !== 200) {
				return false;
			}

			const data = await response.json();
			// Shorts return portrait dimensions (height > width) when queried with /shorts/ URL
			// Regular videos return landscape dimensions (width > height)
			return data.height > data.width;
		} catch (error) {
			return false;
		}
	}

	/**
	 * Fetch and parse RSS feed for a channel
	 */
	async fetchChannelVideos(channelId) {
		const feedUrl = this.getRssFeedUrl(channelId);

		try {
			const response = await fetch(feedUrl, {
				headers: {
					"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
				}
			});

			if (!response.ok) {
				throw new Error(`Failed to fetch RSS feed: ${response.status}`);
			}

			const xml = await response.text();
			const result = await this.parser.parseStringPromise(xml);

			if (!result.feed || !result.feed.entry) {
				return [];
			}

			const videos = result.feed.entry.map((entry) => ({
				videoId: entry["yt:videoId"][0],
				title: entry.title[0],
				channelId: entry["yt:channelId"][0],
				channelName: entry.author[0].name[0],
				published: new Date(entry.published[0]),
				updated: new Date(entry.updated[0]),
				url: entry.link[0].$.href,
				thumbnail: `https://i.ytimg.com/vi/${entry["yt:videoId"][0]}/mqdefault.jpg`,
				description: entry["media:group"]?.[0]?.["media:description"]?.[0] || "",
				isShort: false // Will be detected separately
			}));

			// Check which videos are Shorts (in parallel, max 5 at a time)
			const batchSize = 5;
			for (let i = 0; i < videos.length; i += batchSize) {
				const batch = videos.slice(i, i + batchSize);
				await Promise.all(batch.map(async (video) => {
					video.isShort = await this.isShort(video.videoId);
				}));
			}

			return videos;
		} catch (error) {
			console.error(`Error fetching videos for channel ${channelId}:`, error.message);
			return [];
		}
	}

	/**
	 * Fetch videos from multiple channels and combine them
	 */
	async fetchAllChannelVideos(channels, limit = 25) {
		const allVideos = [];

		// Fetch all channels in parallel
		const results = await Promise.all(
			channels.map((channel) => this.fetchChannelVideos(channel.channel_id))
		);

		// Flatten results
		results.forEach((videos) => {
			allVideos.push(...videos);
		});

		// Sort by published date (newest first) and limit
		return allVideos
			.sort((a, b) => b.published - a.published)
			.slice(0, limit);
	}
}

module.exports = YouTubeService;
