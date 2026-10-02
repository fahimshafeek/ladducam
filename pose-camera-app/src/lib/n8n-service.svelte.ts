/**
 * n8n AI Webhook Service for PoseCam Mobile App
 * Sends captured camera frames to n8n webhook endpoint for Ollama vision analysis,
 * cleans and formats the text, and updates the suggestion bubble UI.
 */

import { serverState } from './server-state.svelte.js';

export const N8N_WEBHOOK_URL = 'https://fahim-n8n.laddu.cc/webhook/getimg';

export interface N8nAnalysisResponse {
	content?: string;
	message?: string;
	text?: string;
	output?: string;
	response?: string;
	suggestion?: string;
	error?: string;
}

/**
 * Filters out conversational LLM preambles, strips markdown syntax,
 * extracts raw analysis text, and cleans whitespace for the suggestion bubble.
 */
export function cleanN8nResponseText(input: any): string {
	if (!input) return 'No posture analysis feedback returned.';

	let text = '';
	if (typeof input === 'string') {
		text = input;
	} else if (typeof input === 'object') {
		text = input.content || input.message || input.text || input.output || input.response || input.suggestion || JSON.stringify(input);
	} else {
		text = String(input);
	}

	// 1. If text is stringified JSON, attempt to parse and extract main content field
	if (text.trim().startsWith('{') || text.trim().startsWith('[')) {
		try {
			const parsed = JSON.parse(text);
			if (typeof parsed === 'object' && parsed !== null) {
				if (Array.isArray(parsed) && parsed.length > 0) {
					text = parsed.map((item) => (typeof item === 'object' ? item.content || item.message || item.text || JSON.stringify(item) : String(item))).join(' ');
				} else {
					text = parsed.content || parsed.message || parsed.text || parsed.output || parsed.response || text;
				}
			}
		} catch (_) {}
	}

	// 2. Remove fenced code blocks
	text = text.replace(/```[\s\S]*?```/g, '');

	// 3. Remove conversational intros / LLM filler preambles
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

	// 4. Strip Markdown formatting characters (*, #, _, `, ~)
	text = text
		.replace(/[\#\*\_`~]+/g, '')
		.replace(/\[([^\]]+)\]\([^\)]+\)/g, '$1') // [text](url) -> text
		.replace(/^[-\*\+]\s+/gm, '• ')           // bullet points
		.replace(/^\d+\.\s+/gm, '• ');            // numbered items -> bullets

	// 5. Replace multiple line breaks with single spaces
	text = text
		.split('\n')
		.map((line) => line.trim())
		.filter((line) => line.length > 0)
		.join(' ');

	// 6. Normalize double whitespace and outer quotes
	text = text.replace(/\s+/g, ' ').trim();
	text = text.replace(/^["'\s]+|["'\s]+$/g, '');

	// 7. Capitalize first letter
	if (text.length > 0) {
		text = text.charAt(0).toUpperCase() + text.slice(1);
	}

	return text || 'Analysis completed.';
}

export class N8nService {
	isAnalyzing = $state(false);
	lastAnalysisResult = $state<string | null>(null);

	/**
	 * Sends an image Blob to the n8n webhook endpoint
	 */
	async analyzeImage(imageBlob: Blob): Promise<string> {
		this.isAnalyzing = true;

		// Update UI suggestion bubble to reflect loading status
		serverState.currentSuggestion = {
			id: `s-loading-${Date.now()}`,
			text: 'Uploading frame to n8n AI engine... Analyzing posture with Ollama...',
			confidence: 100,
			category: 'framing',
			timestamp: new Date().toLocaleTimeString()
		};

		try {
			const formData = new FormData();
			// The webhook expects the image in the 'data' field
			formData.append('data', imageBlob, 'capture.jpg');

			const response = await fetch(N8N_WEBHOOK_URL, {
				method: 'POST',
				body: formData
			});

			if (!response.ok) {
				const errorText = await response.text().catch(() => 'Unknown network error');
				throw new Error(`Server returned HTTP ${response.status}: ${errorText}`);
			}

			const rawData: N8nAnalysisResponse = await response.json();
			
			// Filter and clean the text response
			const cleanedText = cleanN8nResponseText(rawData);

			this.lastAnalysisResult = cleanedText;
			this.isAnalyzing = false;

			// Update UI suggestion bubble with cleaned output
			serverState.currentSuggestion = {
				id: `s-n8n-${Date.now()}`,
				text: cleanedText,
				confidence: 99,
				category: 'framing',
				timestamp: new Date().toLocaleTimeString()
			};

			return cleanedText;
		} catch (err: any) {
			console.error('n8n Webhook Error:', err);
			const errorMsg = err?.message || 'Failed to connect to n8n webhook endpoint.';

			this.isAnalyzing = false;

			serverState.currentSuggestion = {
				id: `s-err-${Date.now()}`,
				text: `Analysis Error: ${errorMsg}`,
				confidence: 0,
				category: 'framing',
				timestamp: new Date().toLocaleTimeString()
			};

			throw err;
		}
	}
}

export const n8nService = new N8nService();
