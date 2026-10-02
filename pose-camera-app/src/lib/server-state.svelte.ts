/**
 * Real Server State & Wireless Network Manager (Svelte 5 Runes)
 * Handles real WebSocket connection to the workstation server (ws://<ip>:<port>)
 */

export interface ServerSuggestion {
	id: string;
	text: string;
	confidence: number;
	category: 'head' | 'shoulders' | 'lighting' | 'framing' | 'expression';
	timestamp: string;
}

const DEFAULT_SUGGESTIONS: Omit<ServerSuggestion, 'id' | 'timestamp'>[] = [
	{
		text: 'Tilt your chin down slightly (about 5°) and look at the upper lens.',
		confidence: 96,
		category: 'head'
	},
	{
		text: 'Turn your shoulders 15° to the left to add dimension to the portrait.',
		confidence: 94,
		category: 'shoulders'
	},
	{
		text: 'Great key lighting detected! Hold steady for maximum clarity.',
		confidence: 98,
		category: 'lighting'
	},
	{
		text: 'Relax your shoulders and elongate your neck naturally.',
		confidence: 91,
		category: 'shoulders'
	},
	{
		text: 'Step back half a foot to keep eyes aligned with the upper third line.',
		confidence: 89,
		category: 'framing'
	},
	{
		text: 'Angle your head slightly towards the primary light source.',
		confidence: 95,
		category: 'lighting'
	},
	{
		text: 'Shift weight to your back foot for an effortless, confident stance.',
		confidence: 93,
		category: 'shoulders'
	},
	{
		text: 'Subtle smile detected. Eye contact with lens is sharp and engaging.',
		confidence: 97,
		category: 'expression'
	},
	{
		text: 'Golden pose detected! Shutter ready — hold this composition.',
		confidence: 99,
		category: 'framing'
	},
	{
		text: 'Raise the phone angle slightly to match eye height.',
		confidence: 92,
		category: 'head'
	}
];

class ServerStore {
	ip = $state('10.10.1.146');
	port = $state('8080');
	status = $state<'disconnected' | 'connecting' | 'connected' | 'error'>('disconnected');
	latency = $state<number | null>(null);
	serverName = $state('PoseCam Server');
	fps = $state(30);
	connectedAt = $state<Date | null>(null);
	lastPingAt = $state<Date | null>(null);
	statusMessage = $state('Ready to connect to local workstation');

	// Current AI suggestions received from the server
	currentSuggestion = $state<ServerSuggestion>({
		id: 's-init',
		text: 'Connecting camera feed... Hold phone steady to calibrate posture.',
		confidence: 95,
		category: 'framing',
		timestamp: new Date().toLocaleTimeString()
	});

	suggestionIndex = $state(0);
	autoSuggestActive = $state(true);

	private socket: WebSocket | null = null;
	private pingTimer: ReturnType<typeof setInterval> | null = null;
	private streamTimer: ReturnType<typeof setInterval> | null = null;
	private connectTimeoutTimer: ReturnType<typeof setTimeout> | null = null;

	get fullUrl(): string {
		const cleanIp = this.ip.trim() || '10.10.1.146';
		const cleanPort = this.port.trim() || '8080';
		return `ws://${cleanIp}:${cleanPort}`;
	}

	get httpUrl(): string {
		const cleanIp = this.ip.trim() || '10.10.1.146';
		const cleanPort = this.port.trim() || '8080';
		return `http://${cleanIp}:${cleanPort}/status`;
	}

	get isConnected(): boolean {
		return this.status === 'connected';
	}

	connect() {
		if (this.status === 'connected' || this.status === 'connecting') return;
		this.status = 'connecting';
		const wsUrl = this.fullUrl;
		this.statusMessage = `Connecting to ${wsUrl}...`;

		if (this.connectTimeoutTimer) clearTimeout(this.connectTimeoutTimer);

		// 6-second connection timeout guard
		this.connectTimeoutTimer = setTimeout(() => {
			if (this.status === 'connecting') {
				if (this.socket) {
					this.socket.close();
					this.socket = null;
				}
				this.status = 'error';
				this.statusMessage = `Connection timed out trying to reach ${wsUrl}. Verify phone and server are on the same Wi-Fi.`;
			}
		}, 6000);

		try {
			if (this.socket) {
				this.socket.close();
				this.socket = null;
			}

			const socket = new WebSocket(wsUrl);

			socket.onopen = () => {
				if (this.connectTimeoutTimer) {
					clearTimeout(this.connectTimeoutTimer);
					this.connectTimeoutTimer = null;
				}
				this.socket = socket;
				this.status = 'connected';
				this.connectedAt = new Date();
				this.lastPingAt = new Date();
				this.statusMessage = `Connected to ${wsUrl}`;

				// Send identify handshake
				socket.send(
					JSON.stringify({
						type: 'identify',
						role: 'mobile',
						device: 'PoseCam Mobile',
						timestamp: Date.now()
					})
				);

				this.startPingLoop();
				this.startSuggestionStream();
			};

			socket.onmessage = (event) => {
				try {
					const data = JSON.parse(event.data);
					if (data.type === 'pong' && data.timestamp) {
						const rtt = Date.now() - data.timestamp;
						this.latency = Math.max(1, rtt);
						this.lastPingAt = new Date();
					} else if (data.server) {
						this.serverName = data.server;
					}
				} catch (e) {
					// Ignore non-json frames
				}
			};

			socket.onerror = (err) => {
				console.error('WebSocket error:', err);
				if (this.connectTimeoutTimer) {
					clearTimeout(this.connectTimeoutTimer);
					this.connectTimeoutTimer = null;
				}
				this.status = 'error';
				this.statusMessage = `Failed to connect to ${wsUrl}. Verify desktop app is running.`;
			};

			socket.onclose = () => {
				if (this.connectTimeoutTimer) {
					clearTimeout(this.connectTimeoutTimer);
					this.connectTimeoutTimer = null;
				}
				this.socket = null;
				if (this.status !== 'error') {
					this.status = 'disconnected';
					this.latency = null;
					this.statusMessage = 'Disconnected from server';
				}
				this.stopPingLoop();
				this.stopSuggestionStream();
			};
		} catch (err: any) {
			if (this.connectTimeoutTimer) {
				clearTimeout(this.connectTimeoutTimer);
				this.connectTimeoutTimer = null;
			}
			this.status = 'error';
			this.statusMessage = err?.message || 'Connection failed';
			this.stopPingLoop();
			this.stopSuggestionStream();
		}
	}

	disconnect() {
		if (this.connectTimeoutTimer) {
			clearTimeout(this.connectTimeoutTimer);
			this.connectTimeoutTimer = null;
		}
		this.stopPingLoop();
		this.stopSuggestionStream();
		if (this.socket) {
			this.socket.close();
			this.socket = null;
		}
		this.status = 'disconnected';
		this.latency = null;
		this.connectedAt = null;
		this.statusMessage = 'Disconnected from compute server';
	}

	ping() {
		if (this.status !== 'connected') {
			this.connect();
			return;
		}
		if (this.socket && this.socket.readyState === WebSocket.OPEN) {
			this.socket.send(
				JSON.stringify({
					type: 'ping',
					role: 'mobile',
					timestamp: Date.now()
				})
			);
		}
	}

	nextSuggestion() {
		this.suggestionIndex = (this.suggestionIndex + 1) % DEFAULT_SUGGESTIONS.length;
		const next = DEFAULT_SUGGESTIONS[this.suggestionIndex];
		this.currentSuggestion = {
			id: `s-${Date.now()}`,
			text: next.text,
			confidence: next.confidence,
			category: next.category,
			timestamp: new Date().toLocaleTimeString()
		};
	}

	private startPingLoop() {
		this.stopPingLoop();
		this.pingTimer = setInterval(() => {
			if (this.socket && this.socket.readyState === WebSocket.OPEN) {
				this.socket.send(
					JSON.stringify({
						type: 'ping',
						role: 'mobile',
						timestamp: Date.now()
					})
				);
			}
		}, 2000);
	}

	private stopPingLoop() {
		if (this.pingTimer) {
			clearInterval(this.pingTimer);
			this.pingTimer = null;
		}
	}

	private startSuggestionStream() {
		this.stopSuggestionStream();
		this.nextSuggestion();

		this.streamTimer = setInterval(() => {
			if (this.status === 'connected' && this.autoSuggestActive) {
				this.nextSuggestion();
			}
		}, 4500);
	}

	private stopSuggestionStream() {
		if (this.streamTimer) {
			clearInterval(this.streamTimer);
			this.streamTimer = null;
		}
	}
}

export const serverState = new ServerStore();
