/**
 * n8n AI Webhook Service for PoseCam Mobile App
 * Sends captured camera frames to n8n webhook endpoint for Ollama vision analysis,
 * cleans and formats the text, and updates the suggestion bubble UI.
 */

import { serverState } from './server-state.svelte.js';

export const N8N_WEBHOOK_URL = 'https://fahim-n8n.laddu.cc/webhook/getimg';

export interface N8nAnalysisResponse {
	clean_text?: string;
	tips?: string[];
	raw_text?: string;
	content?: string;
	message?: string | { content?: string };
	text?: string;
	output?: string;
	response?: string;
	suggestion?: string;
	success?: boolean;
	error?: string;
}

/**
 * Filters out conversational LLM preambles, strips markdown syntax,
 * extracts raw analysis text, and cleans whitespace for the suggestion bubble.
 */
export function cleanN8nResponseText(input: any): string {
	if (!input) return 'No posture analysis feedback returned.';

	let target = input;

	// 1. If text is stringified JSON, parse it
	if (typeof target === 'string') {
		const trimmed = target.trim();
		if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
			try {
				target = JSON.parse(trimmed);
			} catch (_) {}
		}
	}

	// 2. If array (like n8n allIncomingItems), extract the primary item
	if (Array.isArray(target)) {
		if (target.length === 0) return 'No posture analysis feedback returned.';
		target = target[0];
	}

	// 3. Extract text from target object
	let text = '';
	if (typeof target === 'object' && target !== null) {
		const info = target.instanceinfo || target.instance_info || target.instanceInfo;
		if (Array.isArray(info) && info.length > 0) {
			text = info[0].reason || info[0].suggestion || info[0].text || '';
		} else if (target.reason) {
			text = target.reason;
		} else if (target.clean_text) {
			text = target.clean_text;
		} else if (Array.isArray(target.tips) && target.tips.length > 0) {
			text = target.tips.join(' • ');
		} else if (target.response) {
			text = target.response;
		} else if (target.text) {
			text = target.text;
		} else if (target.output) {
			text = target.output;
		} else if (target.content) {
			text = target.content;
		} else if (target.message) {
			text = typeof target.message === 'string' ? target.message : (target.message.content || JSON.stringify(target.message));
		} else if (target.suggestion) {
			text = target.suggestion;
		} else {
			text = target.raw_text || JSON.stringify(target);
		}
	} else {
		text = String(target);
	}

	// 3b. If extracted text is still stringified JSON with instanceinfo/reason, unpack it
	if (typeof text === 'string' && (text.trim().startsWith('{') || text.trim().startsWith('['))) {
		try {
			const nested = JSON.parse(text.trim());
			const nestedInfo = nested.instanceinfo || nested.instance_info;
			if (Array.isArray(nestedInfo) && nestedInfo.length > 0 && nestedInfo[0].reason) {
				text = nestedInfo[0].reason;
			} else if (nested.reason) {
				text = nested.reason;
			}
		} catch (_) {}
	}

	// 4. Remove fenced code blocks
	text = text.replace(/```[\s\S]*?```/g, '');

	// 5. Remove conversational intros / LLM filler preambles
	const intros = [
		/^(here is|here's)\s+(a\s+|the\s+)?(posture\s+)?(analysis|suggestion|feedback|description|summary)(\s+of\s+the\s+image)?[:\s]*/i,
		/^based on the (image|photo|picture)\s*(provided|analyzed)?[:\s,]*/i,
		/^(sure|certainly|of course)[!.,]*\s*(here is|here's)?[:\s]*/i,
		/^the image shows[:\s]*/i,
		/^this image features[:\s]*/i
	];

	for (const pattern of intros) {
		text = text.replace(pattern, '');
	}

	// 6. Strip Markdown formatting characters (*, #, _, `, ~)
	text = text
		.replace(/[\#\*\_`~]+/g, '')
		.replace(/\[([^\]]+)\]\([^\)]+\)/g, '$1') // [text](url) -> text
		.replace(/^[-\*\+]\s+/gm, '• ')           // bullet points
		.replace(/^\d+[\.\)]\s+/gm, '• ');        // numbered items -> bullets

	// 7. Clean whitespace and bullets
	text = text
		.split('\n')
		.map((line) => line.trim())
		.filter((line) => line.length > 0)
		.join(' • ');

	text = text.replace(/•\s*•/g, '•');
	text = text.replace(/\s+/g, ' ').trim();
	text = text.replace(/^["'\s•]+|["'\s]+$/g, '');

	// 8. Capitalize first letter
	if (text.length > 0) {
		text = text.charAt(0).toUpperCase() + text.slice(1);
	}

	return text || 'Analysis completed.';
}

export class N8nService {
	isAnalyzing = $state(false);
	lastAnalysisResult = $state<string | null>(null);
	private inFlightPromise: Promise<string> | null = null;
	private lastCallTime = 0;
	private preferredEndpoint: string | null = null;

	/**
	 * Sends an image Blob to n8n webhook endpoint with local & remote fallbacks.
	 * Protects against duplicate simultaneous calls, avoids probing multiple URLs,
	 * and remembers the single active working endpoint.
	 */
	async analyzeImage(imageBlob: Blob): Promise<string> {
		const now = Date.now();
		// If an analysis is already running, wait for and reuse the same in-flight promise
		if (this.inFlightPromise) {
			return this.inFlightPromise;
		}
		// Strict 2.5-second debounce against rapid repeated presses
		if (now - this.lastCallTime < 2500) {
			if (this.lastAnalysisResult) return this.lastAnalysisResult;
			return 'Analysis in cooldown...';
		}

		this.lastCallTime = now;
		this.isAnalyzing = true;

		// Set persistent bottom bubble to analyzing status
		serverState.setAiAnalysis('Analyzing frame with AI composition engine...', 0);

		this.inFlightPromise = (async () => {
			const lanIp = serverState.ip ? serverState.ip.trim() : '';
			const desktopPort = serverState.port ? serverState.port.trim() : '8080';

			// Build endpoints: default to production webhook first!
			const candidateUrls: string[] = [];
			if (lanIp && lanIp !== '—') {
				candidateUrls.push(`http://${lanIp}:5678/webhook/getimg`);
				candidateUrls.push(`http://${lanIp}:5678/webhook-test/getimg`);
				candidateUrls.push(`http://${lanIp}:${desktopPort}/api/analyze-image`);
			}
			if (!candidateUrls.includes(N8N_WEBHOOK_URL)) {
				candidateUrls.push(N8N_WEBHOOK_URL);
			}

			// If we already know the working endpoint, ONLY use that single endpoint!
			const urlsToTry = this.preferredEndpoint ? [this.preferredEndpoint] : candidateUrls;

			let lastError: any = null;

			for (const targetUrl of urlsToTry) {
				try {
					const formData = new FormData();
					formData.append('data', imageBlob, 'capture.jpg');

					const controller = new AbortController();
					const timeoutId = setTimeout(() => controller.abort(), 30000);

					const response = await fetch(targetUrl, {
						method: 'POST',
						body: formData,
						signal: controller.signal
					});
					clearTimeout(timeoutId);

					if (!response.ok) {
						// If 404 on preferred endpoint, invalidate it so we can re-discover
						if (this.preferredEndpoint === targetUrl) {
							this.preferredEndpoint = null;
						}
						// 404 indicates this route is not registered, try next candidate
						if (response.status === 404 && urlsToTry.indexOf(targetUrl) < urlsToTry.length - 1) {
							continue;
						}
						const errorText = await response.text().catch(() => 'Workflow execution error');
						const httpErr = new Error(`HTTP ${response.status} from ${targetUrl}: ${errorText}`);
						(httpErr as any).isHttpServerResponse = true;
						throw httpErr;
					}

					const rawData = await response.json();
					const cleanedText = cleanN8nResponseText(rawData);

					// Lock onto this working endpoint for all future frames
					this.preferredEndpoint = targetUrl;
					this.lastAnalysisResult = cleanedText;

					// Update persistent bottom AI analysis bubble
					serverState.setAiAnalysis(cleanedText);

					return cleanedText;
				} catch (err: any) {
					lastError = err;
					// If the server answered with an HTTP error (e.g. 500), STOP immediately!
					// Do not cascade and trigger duplicate executions on other endpoints.
					if (err.isHttpServerResponse) {
						break;
					}
					// Only retry on connection failure / network offline
					if (urlsToTry.indexOf(targetUrl) < urlsToTry.length - 1) {
						continue;
					}
				}
			}

			console.error('n8n Analysis Error:', lastError);
			const errorMsg = lastError?.message || 'Failed to connect to AI webhook endpoint.';
			serverState.setAiAnalysis(`Analysis Error: ${errorMsg}`, 15000);
			throw lastError;
		})();

		try {
			return await this.inFlightPromise;
		} finally {
			this.isAnalyzing = false;
			this.inFlightPromise = null;
		}
	}
}

export const n8nService = new N8nService();
