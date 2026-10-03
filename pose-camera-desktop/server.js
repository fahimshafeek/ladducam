/**
 * LadduCam Workstation Compute & WebSocket Server
 * Listens on 0.0.0.0:8080
 * Coordinates communication between mobile app and local n8n AI audio workflow
 */

import http from 'node:http';
import os from 'node:os';
import { WebSocketServer, WebSocket } from 'ws';

const PORT = process.env.PORT || 8080;
const N8N_IMAGE_TEST_URL = process.env.N8N_IMAGE_TEST_URL || 'http://localhost:5678/webhook-test/getimg';
const N8N_IMAGE_PROD_URL = process.env.N8N_IMAGE_PROD_URL || 'http://localhost:5678/webhook/getimg';
const N8N_VOICE_TEST_URL = process.env.N8N_VOICE_TEST_URL || 'http://localhost:5678/webhook-test/getvoice';
const N8N_VOICE_PROD_URL = process.env.N8N_VOICE_PROD_URL || 'http://localhost:5678/webhook/getvoice';
const N8N_SCENE_POSE_URL = process.env.N8N_SCENE_POSE_URL || 'http://localhost:5678/webhook/scene-pose';
const SHUTTERMUSE_POSE_URL = process.env.SHUTTERMUSE_POSE_URL || 'http://localhost:8000/api/pose-upload?return_format=image';


/**
 * Discovers the host's primary non-internal IPv4 LAN address
 */
function getHostLanIp() {
	const ifaces = os.networkInterfaces();
	for (const name of Object.keys(ifaces)) {
		const iface = ifaces[name];
		if (!iface) continue;
		for (const addr of iface) {
			if (addr.family === 'IPv4' && !addr.internal) {
				// Prefer standard private LAN IP ranges (10.x, 192.168.x, 172.16-31.x)
				if (
					addr.address.startsWith('192.168.') ||
					addr.address.startsWith('10.') ||
					/^172\.(1[6-9]|2\d|3[01])\./.test(addr.address)
				) {
					return addr.address;
				}
			}
		}
	}
	return '127.0.0.1';
}

const lanIp = getHostLanIp();
console.log(`[LadduCam Desktop Server] Detected Workstation LAN IP: ${lanIp}`);

let activeImageWebhook = N8N_IMAGE_PROD_URL;
let activeVoiceWebhook = N8N_VOICE_PROD_URL;
let inFlightAnalyzePromise = null;
let lastDesktopAnalyzeTime = 0;
let inFlightVoicePromise = null;
let lastVoiceTime = 0;

// Create HTTP server for health check, status & image analysis proxy
const server = http.createServer(async (req, res) => {
	res.setHeader('Access-Control-Allow-Origin', '*');
	res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
	res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

	if (req.method === 'OPTIONS') {
		res.writeHead(204);
		res.end();
		return;
	}

	if (req.url === '/status' || req.url === '/') {
		res.writeHead(200, { 'Content-Type': 'application/json' });
		res.end(
			JSON.stringify({
				status: 'running',
				server: 'LadduCam Compute Server',
				lan_ip: lanIp,
				port: PORT,
				n8n_image_test_webhook: N8N_IMAGE_TEST_URL,
				n8n_image_prod_webhook: N8N_IMAGE_PROD_URL,
				n8n_voice_test_webhook: N8N_VOICE_TEST_URL,
				n8n_voice_prod_webhook: N8N_VOICE_PROD_URL,
				connected_clients: wss.clients.size,
				timestamp: new Date().toISOString()
			})
		);
		return;
	}

	// HTTP Proxy Endpoint for Mobile Frame Analysis
	if (req.method === 'POST' && (req.url === '/api/analyze-image' || req.url === '/analyze')) {
		const now = Date.now();
		// If a frame analysis is currently running, await and reuse it to prevent concurrent n8n crashes
		if (inFlightAnalyzePromise && now - lastDesktopAnalyzeTime < 3000) {
			sendDesktopLog('info', `⏳ Reusing in-flight frame analysis (deduplicating concurrent request)`);
			try {
				const sharedResult = await inFlightAnalyzePromise;
				res.writeHead(200, { 'Content-Type': 'application/json' });
				res.end(JSON.stringify(sharedResult.raw || { clean_text: sharedResult.cleanText, tips: sharedResult.tips }));
			} catch (err) {
				res.writeHead(500, { 'Content-Type': 'application/json' });
				res.end(JSON.stringify({ error: err.message }));
			}
			return;
		}

		lastDesktopAnalyzeTime = now;

		try {
			const chunks = [];
			for await (const chunk of req) {
				chunks.push(chunk);
			}
			const bodyBuffer = Buffer.concat(chunks);
			const contentType = req.headers['content-type'] || 'image/jpeg';

			sendDesktopLog('info', `📸 Received camera frame from mobile (${Math.round(bodyBuffer.length / 1024)} KB)`);

			inFlightAnalyzePromise = (async () => {
				return await forwardToN8n(
					bodyBuffer,
					'data',
					'capture.jpg',
					contentType,
					activeImageWebhook,
					[activeImageWebhook === N8N_IMAGE_PROD_URL ? N8N_IMAGE_TEST_URL : N8N_IMAGE_PROD_URL]
				);
			})();

			const result = await inFlightAnalyzePromise;

			if (result.isJson && result.cleanText) {
				// Broadcast real AI suggestion to mobile and desktop
				broadcast({
					type: 'pose_suggestion',
					text: result.cleanText,
					tips: result.tips || [],
					category: 'framing',
					source: 'n8n_ai',
					timestamp: new Date().toLocaleTimeString()
				});
				sendDesktopLog('success', `AI Suggestion: ${result.cleanText.slice(0, 100)}...`);

				res.writeHead(200, { 'Content-Type': 'application/json' });
				res.end(JSON.stringify(result.raw || { clean_text: result.cleanText, tips: result.tips }));
			} else {
				res.writeHead(200, { 'Content-Type': 'application/json' });
				res.end(JSON.stringify(result.raw || { status: 'success' }));
			}
		} catch (err) {
			console.error('[ANALYZE ERROR]', err);
			sendDesktopLog('warn', `Frame analysis error: ${err.message}`);
			res.writeHead(500, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ error: err.message }));
		} finally {
			inFlightAnalyzePromise = null;
		}
		return;
	}

	// HTTP Proxy Endpoint for Mobile Voice Note Submission
	if (req.method === 'POST' && (req.url === '/api/voice' || req.url === '/webhook/getvoice')) {
		const now = Date.now();
		if (inFlightVoicePromise && now - lastVoiceTime < 2500) {
			sendDesktopLog('info', `⏳ Reusing in-flight voice query (deduplicating concurrent HTTP request)`);
			try {
				const shared = await inFlightVoicePromise;
				if (shared.isAudio && shared.mp3Buffer) {
					res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Access-Control-Allow-Origin': '*' });
					res.end(shared.mp3Buffer);
				} else {
					res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
					res.end(JSON.stringify(shared.raw || { clean_text: shared.cleanText }));
				}
			} catch (err) {
				res.writeHead(500, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
				res.end(JSON.stringify({ error: err.message }));
			}
			return;
		}

		lastVoiceTime = now;

		try {
			const chunks = [];
			for await (const chunk of req) {
				chunks.push(chunk);
			}
			const bodyBuffer = Buffer.concat(chunks);
			const contentType = req.headers['content-type'] || 'audio/wav';
			const photoContext = req.headers['x-photo-context'] || '';

			sendDesktopLog('info', `🎙️ Received voice note via HTTP (${Math.round(bodyBuffer.length / 1024)} KB)`);

			const extraFields = {
				photo_context: photoContext,
				context: photoContext,
				language: 'ml',
				user_prompt: 'User asking in Malayalam about the captured photo',
				system_prompt: 'You are a professional photography tutor fluent in Malayalam. Evaluate the photo based on the provided photo_context and answer concisely in Malayalam.'
			};

			inFlightVoicePromise = (async () => {
				return await forwardToN8n(
					bodyBuffer,
					'file',
					'voice.wav',
					contentType,
					activeVoiceWebhook,
					[activeVoiceWebhook === N8N_VOICE_PROD_URL ? N8N_VOICE_TEST_URL : N8N_VOICE_PROD_URL],
					extraFields
				);
			})();

			const result = await inFlightVoicePromise;

			if (result.isAudio && result.mp3Buffer) {
				res.writeHead(200, {
					'Content-Type': 'audio/mpeg',
					'Content-Length': result.mp3Buffer.length,
					'Access-Control-Allow-Origin': '*'
				});
				res.end(result.mp3Buffer);
			} else {
				res.writeHead(200, {
					'Content-Type': 'application/json',
					'Access-Control-Allow-Origin': '*'
				});
				res.end(JSON.stringify(result.raw || { clean_text: result.cleanText }));
			}
		} catch (err) {
			console.error('[HTTP VOICE ERROR]', err);
			res.writeHead(500, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
			res.end(JSON.stringify({ error: err.message }));
		} finally {
			inFlightVoicePromise = null;
		}
		return;
	}

	// HTTP Proxy Endpoint for Mobile Empty Scene Wireframe Pose Recommendation
	if (
		req.method === 'POST' &&
		(req.url.startsWith('/api/scene-wireframe') || req.url.startsWith('/api/scene-pose') || req.url.startsWith('/scene-wireframe'))
	) {
		try {
			const chunks = [];
			for await (const chunk of req) {
				chunks.push(chunk);
			}
			let bodyBuffer = Buffer.concat(chunks);
			const contentType = req.headers['content-type'] || 'image/jpeg';

			// If client sent multipart/form-data, extract clean binary buffer
			if (contentType.includes('multipart/form-data')) {
				const headerEnd = bodyBuffer.indexOf('\r\n\r\n');
				if (headerEnd !== -1) {
					const start = headerEnd + 4;
					const end = bodyBuffer.lastIndexOf('\r\n--');
					if (end > start) {
						bodyBuffer = bodyBuffer.subarray(start, end);
					}
				}
			}

			sendDesktopLog('info', `📐 Received empty scene frame (${Math.round(bodyBuffer.length / 1024)} KB)`);

			// 1. Try forwarding to user's n8n scene webhook first (if configured)
			let forwardResult = null;
			try {
				forwardResult = await forwardToN8n(
					bodyBuffer,
					'file',
					'scene.jpg',
					'image/jpeg',
					N8N_SCENE_POSE_URL,
					[SHUTTERMUSE_POSE_URL]
				);
			} catch (n8nErr) {
				sendDesktopLog('warn', `n8n scene pose failed (${n8nErr.message}), falling back directly to ShutterMuse on port 8000...`);
			}

			// If forwardResult produced an image buffer directly:
			if (forwardResult && forwardResult.isImage && forwardResult.imgBuffer) {
				res.writeHead(200, {
					'Content-Type': forwardResult.contentType || 'image/jpeg',
					'Access-Control-Allow-Origin': '*'
				});
				res.end(forwardResult.imgBuffer);
				return;
			}

			// 2. Fallback direct request to ShutterMuse server on port 8000
			const blob = new Blob([bodyBuffer], { type: 'image/jpeg' });
			const formData = new FormData();
			formData.append('file', blob, 'scene.jpg');

			const smRes = await fetch(SHUTTERMUSE_POSE_URL, {
				method: 'POST',
				body: formData
			});

			if (smRes.ok) {
				const smArrayBuffer = await smRes.arrayBuffer();
				const smBuffer = Buffer.from(smArrayBuffer);
				sendDesktopLog('success', `Generated wireframe pose image (${Math.round(smBuffer.length / 1024)} KB)`);
				res.writeHead(200, {
					'Content-Type': 'image/jpeg',
					'Access-Control-Allow-Origin': '*'
				});
				res.end(smBuffer);
			} else {
				const errText = await smRes.text().catch(() => '');
				throw new Error(`ShutterMuse returned HTTP ${smRes.status}: ${errText}`);
			}
		} catch (err) {
			console.error('[SCENE WIREFRAME ERROR]', err);
			sendDesktopLog('warn', `Scene wireframe error: ${err.message}`);
			res.writeHead(500, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
			res.end(JSON.stringify({ error: err.message }));
		}
		return;
	}

	res.writeHead(404, { 'Content-Type': 'text/plain' });
	res.end('Not found');
});

// Attach WebSocket server
const wss = new WebSocketServer({ server });

/**
 * Broadcasts a JSON message to all connected clients (or clients of a specific role)
 */
function broadcast(payload, targetRole = null) {
	const messageStr = typeof payload === 'string' ? payload : JSON.stringify(payload);
	for (const client of wss.clients) {
		if (client.readyState === WebSocket.OPEN) {
			if (!targetRole || client.role === targetRole) {
				client.send(messageStr);
			}
		}
	}
}

/**
 * Emits a structured log message to desktop UI clients
 */
function sendDesktopLog(level, message) {
	console.log(`[${level.toUpperCase()}] ${message}`);
	broadcast(
		{
			type: 'log_entry',
			level,
			message,
			time: new Date().toLocaleTimeString()
		},
		'desktop_ui'
	);
}

/**
 * Forwards payload buffer to n8n webhook and handles both JSON text and binary responses.
 * Avoids redundant requests by sticking to the known active webhook.
 */
async function forwardToN8n(buffer, fieldName, filename, mimeType, primaryUrl, fallbackUrls = [], extraFields = {}) {
	const startTime = Date.now();
	const candidateUrls = [primaryUrl, ...fallbackUrls.filter((u) => u !== primaryUrl)];
	let lastErr = null;

	for (const url of candidateUrls) {
		try {
			const blob = new Blob([buffer], { type: mimeType });
			const formData = new FormData();
			// Attach exactly one binary file under fieldName (e.g. 'file' for voice, 'data' for image)
			formData.append(fieldName || 'file', blob, filename);

			for (const [key, val] of Object.entries(extraFields)) {
				if (val !== undefined && val !== null && val !== '') {
					formData.append(key, typeof val === 'object' ? JSON.stringify(val) : String(val));
				}
			}

			sendDesktopLog('info', `Forwarding to n8n at ${url}...`);

			const response = await fetch(url, {
				method: 'POST',
				body: formData
			});

			if (!response.ok) {
				if (response.status === 404 && candidateUrls.indexOf(url) < candidateUrls.length - 1) {
					sendDesktopLog('warn', `Webhook at ${url} returned 404. Trying fallback...`);
					continue;
				}
				const errText = await response.text().catch(() => 'No details');
				throw new Error(`HTTP ${response.status} from ${url}: ${errText}`);
			}

			// Success! Remember this working endpoint so future calls don't hit 404 fallbacks
			if (url.includes('getimg')) {
				activeImageWebhook = url;
			}
			if (url.includes('getvoice')) {
				activeVoiceWebhook = url;
			}

			const elapsed = Date.now() - startTime;
			const contentType = response.headers.get('content-type') || '';

			// 1. If response is audio (.mp3 / audio/* / octet-stream)
			if (contentType.includes('audio') || contentType.includes('application/octet-stream')) {
				const audioArrayBuffer = await response.arrayBuffer();
				const mp3Buffer = Buffer.from(audioArrayBuffer);
				sendDesktopLog('success', `Received audio response (${Math.round(mp3Buffer.length / 1024)} KB) in ${elapsed}ms`);
				return {
					isAudio: true,
					mp3Buffer,
					elapsedMs: elapsed
				};
			}

			// 2. If response is binary image (.jpg / .png / image/*)
			if (contentType.includes('image')) {
				const imageArrayBuffer = await response.arrayBuffer();
				const imgBuffer = Buffer.from(imageArrayBuffer);
				sendDesktopLog('success', `Received image response (${Math.round(imgBuffer.length / 1024)} KB) in ${elapsed}ms`);
				return {
					isImage: true,
					imgBuffer,
					contentType,
					elapsedMs: elapsed
				};
			}

			// 3. If response is JSON or text
			const textBody = await response.text();
			let parsed = null;
			try {
				parsed = JSON.parse(textBody);
			} catch (_) {}

			// Check if JSON response wraps audio data (base64 mp3) or image data (base64)
			if (parsed && typeof parsed === 'object') {
				const possibleAudio = parsed.audio || parsed.mp3 || parsed.audio_base64 || (typeof parsed.data === 'string' && parsed.data.length > 500 && !parsed.data.startsWith('data:image/') ? parsed.data : null);
				if (possibleAudio) {
					const cleanB64 = possibleAudio.replace(/^data:audio\/\w+;base64,/, '');
					const mp3Buffer = Buffer.from(cleanB64, 'base64');
					sendDesktopLog('success', `Received JSON-wrapped MP3 audio (${Math.round(mp3Buffer.length / 1024)} KB) in ${elapsed}ms`);
					return {
						isAudio: true,
						mp3Buffer,
						cleanText: parsed.text || parsed.clean_text || '',
						elapsedMs: elapsed
					};
				}

				const possibleImage = parsed.rendered_image_base64 || parsed.image || (typeof parsed.data === 'string' && (parsed.data.startsWith('data:image/') || parsed.data.length > 1000) ? parsed.data : null);
				if (possibleImage) {
					const cleanB64 = possibleImage.replace(/^data:image\/\w+;base64,/, '');
					const imgBuffer = Buffer.from(cleanB64, 'base64');
					sendDesktopLog('success', `Received JSON-wrapped wireframe image (${Math.round(imgBuffer.length / 1024)} KB) in ${elapsed}ms`);
					return {
						isImage: true,
						imgBuffer,
						reason: parsed.reason || '',
						contentType: 'image/jpeg',
						elapsedMs: elapsed
					};
				}
			}


			let cleanText = '';
			let tips = [];

			if (Array.isArray(parsed) && parsed.length > 0) {
				const first = parsed[0];
				cleanText = first.clean_text || first.response || first.text || (typeof first === 'string' ? first : '');
				tips = Array.isArray(first.tips) ? first.tips : [];
			} else if (typeof parsed === 'object' && parsed !== null) {
				cleanText = parsed.clean_text || parsed.response || parsed.text || parsed.output || '';
				tips = Array.isArray(parsed.tips) ? parsed.tips : [];
			} else {
				cleanText = textBody;
			}

			// Unbox stringified JSON if needed (instanceinfo / reason)
			if (typeof cleanText === 'string' && (cleanText.trim().startsWith('{') || cleanText.trim().startsWith('['))) {
				try {
					const nested = JSON.parse(cleanText.trim());
					const nestedInfo = nested.instanceinfo || nested.instance_info;
					if (Array.isArray(nestedInfo) && nestedInfo.length > 0 && nestedInfo[0].reason) {
						cleanText = nestedInfo[0].reason;
					} else if (nested.reason) {
						cleanText = nested.reason;
					}
				} catch (_) {}
			}

			// Clean any residual markdown tags
			cleanText = cleanText
				.replace(/```(?:json)?[\s\S]*?```/g, '')
				.replace(/\*\*([^*]+)\*\*/g, '$1')
				.replace(/\*([^*]+)\*/g, '$1')
				.replace(/`([^`]+)`/g, '$1')
				.replace(/[\r\n]{3,}/g, '\n\n')
				.trim();

			sendDesktopLog('success', `n8n Pipeline Completed in ${elapsed}ms`);

			return {
				isJson: true,
				cleanText,
				tips,
				raw: parsed || textBody,
				elapsedMs: elapsed
			};
		} catch (err) {
			lastErr = err;
			if (candidateUrls.indexOf(url) < candidateUrls.length - 1) {
				continue;
			}
		}
	}

	throw lastErr || new Error('Failed to reach n8n webhook.');
}

/**
 * Sends a WAV audio buffer to n8n webhook and returns either MP3 buffer or clean JSON text.
 * Automatically forwards attached photo context from the mobile app's white box.
 */
async function processVoiceWithN8n(wavBuffer, extraFields = {}) {
	return await forwardToN8n(
		wavBuffer,
		'file',
		'voice.wav',
		'audio/wav',
		activeVoiceWebhook,
		[activeVoiceWebhook === N8N_VOICE_PROD_URL ? N8N_VOICE_TEST_URL : N8N_VOICE_PROD_URL],
		extraFields
	);
}

wss.on('connection', (ws, req) => {
	const remoteIp = req.socket.remoteAddress || '127.0.0.1';
	const isLoopback = remoteIp === '127.0.0.1' || remoteIp === '::1' || remoteIp === '::ffff:127.0.0.1';
	const clientIp = remoteIp.replace(/^.*:/, '');

	ws.clientIp = clientIp;
	ws.isLoopback = isLoopback;
	ws.role = isLoopback ? 'desktop_ui' : 'mobile';

	console.log(`[WS] New client connected from ${remoteIp} (assumed role: ${ws.role})`);

	// Send initial welcome message
	ws.send(
		JSON.stringify({
			type: 'welcome',
			status: 'connected',
			server: 'LadduCam Compute Server',
			client_ip: clientIp,
			lan_ip: lanIp
		})
	);

	if (!isLoopback) {
		broadcast({
			type: 'client_state',
			connected: true,
			client_ip: clientIp,
			device: 'LadduCam Mobile'
		});
		sendDesktopLog('success', `Mobile client connected: ${clientIp}`);
	}

	ws.on('message', async (messageRaw) => {
		try {
			const text = messageRaw.toString();
			const data = JSON.parse(text);

			// 1. Identification Handshake
			if (data.type === 'identify') {
				if (data.role) ws.role = data.role;
				if (data.device) ws.device = data.device;

				if (ws.role === 'mobile') {
					broadcast({
						type: 'client_state',
						connected: true,
						client_ip: clientIp,
						device: data.device || 'LadduCam Mobile'
					});
					sendDesktopLog('success', `Mobile device identified: ${data.device || 'LadduCam Mobile'} (${clientIp})`);
				}
				return;
			}

			// 2. Ping / Pong Latency Check
			if (data.type === 'ping') {
				ws.send(
					JSON.stringify({
						type: 'pong',
						timestamp: data.timestamp || 0,
						server: 'LadduCam Compute Server',
						status: 'connected'
					})
				);

				if (ws.role === 'mobile') {
					broadcast({
						type: 'client_state',
						connected: true,
						client_ip: clientIp,
						device: ws.device || 'LadduCam Mobile'
					});
				}
				return;
			}

			// 3. Voice Note from Mobile App (.wav) with attached Photo Context
			if (data.type === 'voice_note') {
				const now = Date.now();
				if (inFlightVoicePromise && now - lastVoiceTime < 2500) {
					sendDesktopLog('info', `⏳ Ignoring duplicate voice note received within 2.5s window`);
					return;
				}
				lastVoiceTime = now;

				sendDesktopLog('info', `🎙️ Incoming voice note from ${ws.device || 'mobile app'}`);

				if (!data.audio) {
					ws.send(
						JSON.stringify({
							type: 'voice_error',
							error: 'Missing audio payload in voice note'
						})
					);
					return;
				}

				// Extract attached photo context (the White Box result)
				const rawContext = data.photo_context || data.context || null;
				let contextString = '';
				if (rawContext) {
					contextString = typeof rawContext === 'string' ? rawContext : (rawContext.text || JSON.stringify(rawContext));
					sendDesktopLog('info', `📸 Attached White Box Photo Context: "${contextString.slice(0, 90)}..."`);
				}

				// Inform mobile that compute has begun
				ws.send(
					JSON.stringify({
						type: 'voice_status',
						status: 'processing',
						message: 'Analyzing Malayalam query with photo context...'
					})
				);

				try {
					const wavBuffer = Buffer.from(data.audio, 'base64');
					const extraFields = {
						photo_context: contextString,
						context: contextString,
						language: 'ml',
						user_prompt: 'User asking in Malayalam about the captured photo',
						system_prompt: 'You are a professional photography tutor fluent in Malayalam. Evaluate the photo based on the provided photo_context and answer concisely in Malayalam.'
					};

					inFlightVoicePromise = processVoiceWithN8n(wavBuffer, extraFields);
					const result = await inFlightVoicePromise;

					if (result.isAudio && result.mp3Buffer) {
						const base64Mp3 = result.mp3Buffer.toString('base64');
						ws.send(
							JSON.stringify({
								type: 'voice_response',
								audio: base64Mp3,
								text: result.cleanText || '',
								clean_text: result.cleanText || '',
								format: 'mp3',
								duration_ms: result.elapsedMs,
								timestamp: Date.now()
							})
						);
						sendDesktopLog('success', `✅ Audio response dispatched to mobile app (${Math.round(result.mp3Buffer.length / 1024)} KB MP3)`);
					} else if (result.isJson && result.cleanText) {
						// JSON / Text response from shortened n8n workflow
						ws.send(
							JSON.stringify({
								type: 'voice_response',
								text: result.cleanText,
								clean_text: result.cleanText,
								tips: result.tips || [],
								duration_ms: result.elapsedMs,
								timestamp: Date.now()
							})
						);

						ws.send(
							JSON.stringify({
								type: 'voice_status',
								status: 'completed',
								message: 'Analysis completed.'
							})
						);

						// Also broadcast to desktop UI
						broadcast(
							{
								type: 'pose_suggestion',
								text: result.cleanText,
								tips: result.tips || [],
								source: 'n8n_ai',
								timestamp: new Date().toLocaleTimeString()
							},
							'desktop_ui'
						);

						sendDesktopLog('success', `AI Malayalam Response dispatched: ${result.cleanText.slice(0, 100)}...`);
					}
				} catch (procErr) {
					console.error('[VOICE ERROR]', procErr);
					sendDesktopLog('warn', `Voice processing error: ${procErr.message}`);
					ws.send(
						JSON.stringify({
							type: 'voice_error',
							error: procErr.message || 'Compute failed in n8n pipeline'
						})
					);
				} finally {
					inFlightVoicePromise = null;
				}
				return;
			}

			// 4. Image / Camera Frame Analysis over WebSocket
			if (data.type === 'analyze_frame') {
				if (!data.image) return;
				sendDesktopLog('info', `📸 Frame analysis requested by ${ws.device || 'mobile app'}`);
				try {
					let imgBuffer;
					let b64 = data.image;
					if (b64.includes(',')) b64 = b64.split(',')[1];
					imgBuffer = Buffer.from(b64, 'base64');

					const result = await forwardToN8n(
						imgBuffer,
						'data',
						'capture.jpg',
						'image/jpeg',
						activeImageWebhook,
						[activeImageWebhook === N8N_IMAGE_PROD_URL ? N8N_IMAGE_TEST_URL : N8N_IMAGE_PROD_URL]
					);

					if (result.isJson && result.cleanText) {
						broadcast({
							type: 'pose_suggestion',
							text: result.cleanText,
							tips: result.tips || [],
							category: 'framing',
							source: 'n8n_ai',
							timestamp: new Date().toLocaleTimeString()
						});
						sendDesktopLog('success', `AI Suggestion: ${result.cleanText.slice(0, 100)}...`);
					}
				} catch (frameErr) {
					console.error('[FRAME WS ERROR]', frameErr);
					sendDesktopLog('warn', `Frame analysis error: ${frameErr.message}`);
				}
				return;
			}
		} catch (err) {
			console.warn('[WS] Error parsing incoming frame:', err.message);
		}
	});

	ws.on('close', () => {
		console.log(`[WS] Client disconnected: ${clientIp} (${ws.role})`);
		if (ws.role === 'mobile' || !ws.isLoopback) {
			broadcast({
				type: 'client_state',
				connected: false,
				client_ip: clientIp
			});
			sendDesktopLog('info', `Mobile client disconnected: ${clientIp}`);
		}
	});

	ws.on('error', (err) => {
		console.error('[WS Error]', err.message);
	});
});

server.listen(PORT, '0.0.0.0', () => {
	console.log(`=======================================================`);
	console.log(`🚀 LadduCam Compute WebSocket Server running on 0.0.0.0:${PORT}`);
	console.log(`📡 Workstation URL: ws://${lanIp}:${PORT}`);
	console.log(`🔗 n8n Image Target: ${N8N_IMAGE_TEST_URL}`);
	console.log(`🔗 n8n Voice Target: ${N8N_VOICE_TEST_URL}`);
	console.log(`=======================================================`);
});

process.on('SIGTERM', () => {
	console.log('Shutting down WebSocket server...');
	server.close();
});
