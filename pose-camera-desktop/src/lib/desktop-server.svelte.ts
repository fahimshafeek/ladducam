/**
 * Real Desktop Server State & Telemetry Store (Svelte 5 Runes)
 * Receives real network telemetry from Tokio WebSocket server on 0.0.0.0:8080
 */

export interface LogEntry {
	id: string;
	time: string;
	level: 'info' | 'warn' | 'success' | 'stream';
	message: string;
}

class DesktopServerStore {
	ip = $state('127.0.0.1');
	port = $state('8080');
	isServerRunning = $state(true);
	isClientConnected = $state(false);
	clientDeviceName = $state('—');
	clientIp = $state('—');
	latency = $state<number | null>(null);
	fps = $state(30);
	framesProcessed = $state(0);
	currentPoseSuggestion = $state('Tilt your chin down slightly (about 5°) and look at the upper lens.');
	lastVoiceEvent = $state<{
		type: string;
		time: string;
		message: string;
	} | null>(null);
	logs = $state<LogEntry[]>([
		{
			id: '1',
			time: new Date().toLocaleTimeString(),
			level: 'info',
			message: 'Compute service initialized on host'
		},
		{
			id: '2',
			time: new Date().toLocaleTimeString(),
			level: 'success',
			message: 'WebSocket server listening on 0.0.0.0:8080'
		},
		{
			id: '3',
			time: new Date().toLocaleTimeString(),
			level: 'info',
			message: 'Ready for incoming wireless camera connection from mobile device'
		}
	]);

	private ws: WebSocket | null = null;
	private reconnectTimer: ReturnType<typeof setInterval> | null = null;

	constructor() {
		if (typeof window !== 'undefined') {
			this.connectLocalMonitor();
		}
	}

	get fullUrl(): string {
		return `ws://${this.ip}:${this.port}`;
	}

	get httpUrl(): string {
		return `http://${this.ip}:${this.port}/status`;
	}

	startServer() {
		this.isServerRunning = true;
		this.addLog('info', `WebSocket server active on 0.0.0.0:${this.port}`);
		this.connectLocalMonitor();
	}

	stopServer() {
		this.isServerRunning = false;
		this.isClientConnected = false;
		this.clientDeviceName = '—';
		this.clientIp = '—';
		this.latency = null;
		if (this.ws) {
			this.ws.close();
			this.ws = null;
		}
		this.addLog('warn', 'Server stopped by user');
	}

	private connectLocalMonitor() {
		if (!this.isServerRunning || typeof window === 'undefined') return;

		try {
			if (this.ws) {
				this.ws.close();
				this.ws = null;
			}

			const monitorWsUrl = `ws://127.0.0.1:${this.port}`;
			const socket = new WebSocket(monitorWsUrl);

			socket.onopen = () => {
				this.ws = socket;
				socket.send(JSON.stringify({ type: 'identify', role: 'desktop_ui' }));
			};

			socket.onmessage = (event) => {
				try {
					const data = JSON.parse(event.data);

					if (data.type === 'welcome' && data.lan_ip) {
						this.ip = data.lan_ip;
					}

					if (data.type === 'client_state') {
						const wasConnected = this.isClientConnected;
						this.isClientConnected = data.connected;

						if (data.connected) {
							if (data.client_ip) this.clientIp = data.client_ip;
							if (data.device) this.clientDeviceName = data.device;
							if (data.latency !== undefined) this.latency = data.latency;

							if (!wasConnected) {
								this.addLog('success', `Mobile client connected: ${this.clientDeviceName} (${this.clientIp})`);
							}
						} else {
							this.isClientConnected = false;
							this.clientIp = '—';
							this.clientDeviceName = '—';
							this.latency = null;
							if (wasConnected) {
								this.addLog('info', 'Mobile client disconnected');
							}
						}
					}

					if (data.type === 'log_entry') {
						this.addLog(data.level || 'info', data.message);
						this.lastVoiceEvent = {
							type: data.level || 'info',
							time: data.time || new Date().toLocaleTimeString(),
							message: data.message
						};
					}

					if (data.type === 'pose_suggestion' || data.type === 'server_suggestion') {
						const suggestionText = data.clean_text || data.text || (Array.isArray(data.tips) ? data.tips.join(' • ') : null);
						if (suggestionText) {
							this.currentPoseSuggestion = suggestionText;
							this.addLog('success', `AI Suggestion: ${suggestionText}`);
						}
					}
				} catch (err) {
					// Ignore non-json frames
				}
			};

			socket.onclose = () => {
				this.ws = null;
				// Auto reconnect monitor after 3s if server is running
				if (this.isServerRunning && !this.reconnectTimer) {
					this.reconnectTimer = setTimeout(() => {
						this.reconnectTimer = null;
						this.connectLocalMonitor();
					}, 3000);
				}
			};

			socket.onerror = () => {
				// Silent error if local server is restarting
			};
		} catch (err) {
			// Ignore init error
		}
	}

	addLog(level: LogEntry['level'], message: string) {
		const entry: LogEntry = {
			id: Math.random().toString(36).substring(2, 9),
			time: new Date().toLocaleTimeString(),
			level,
			message
		};
		this.logs = [entry, ...this.logs.slice(0, 49)];
	}

	clearLogs() {
		this.logs = [];
	}
}

export const serverStore = new DesktopServerStore();
