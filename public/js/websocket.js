// WebSocket Client
class WSClient {
	constructor() {
		this.ws = null;
		this.reconnectInterval = 5000;
		this.reconnectTimer = null;
		this.handlers = new Map();
	}

	connect() {
		const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
		const wsUrl = `${protocol}//${window.location.host}`;

		console.log("Connecting to WebSocket:", wsUrl);

		this.ws = new WebSocket(wsUrl);

		this.ws.onopen = () => {
			console.log("✓ WebSocket connected");
			if (this.reconnectTimer) {
				clearTimeout(this.reconnectTimer);
				this.reconnectTimer = null;
			}
		};

		this.ws.onmessage = (event) => {
			try {
				const message = JSON.parse(event.data);
				this.handleMessage(message);
			} catch (error) {
				console.error("Error parsing WebSocket message:", error);
			}
		};

		this.ws.onerror = (error) => {
			console.error("WebSocket error:", error);
		};

		this.ws.onclose = () => {
			console.log("WebSocket disconnected, reconnecting...");
			this.scheduleReconnect();
		};
	}

	scheduleReconnect() {
		if (this.reconnectTimer) return;

		this.reconnectTimer = setTimeout(() => {
			this.connect();
		}, this.reconnectInterval);
	}

	handleMessage(message) {
		const { type, data } = message;

		console.log("WebSocket message:", type, data);

		// Call registered handlers
		if (this.handlers.has(type)) {
			this.handlers.get(type).forEach((handler) => {
				try {
					handler(data);
				} catch (error) {
					console.error(`Error in handler for ${type}:`, error);
				}
			});
		}
	}

	on(type, handler) {
		if (!this.handlers.has(type)) {
			this.handlers.set(type, []);
		}
		this.handlers.get(type).push(handler);
	}

	off(type, handler) {
		if (!this.handlers.has(type)) return;

		const handlers = this.handlers.get(type);
		const index = handlers.indexOf(handler);

		if (index !== -1) {
			handlers.splice(index, 1);
		}
	}

	disconnect() {
		if (this.reconnectTimer) {
			clearTimeout(this.reconnectTimer);
			this.reconnectTimer = null;
		}

		if (this.ws) {
			this.ws.close();
			this.ws = null;
		}
	}
}

// Export WebSocket client instance
window.wsClient = new WSClient();
