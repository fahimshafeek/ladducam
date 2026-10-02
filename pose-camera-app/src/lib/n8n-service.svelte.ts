/**
 * n8n AI Webhook Service for PoseCam Mobile App
 * Sends captured camera frames to n8n webhook endpoint for Ollama vision analysis.
 */

import { serverState } from './server-state.svelte.js';

export const N8N_WEBHOOK_URL = 'https://fahim-n8n.laddu.cc/webhook/getimg';

export interface N8nAnalysisResponse {
	content?: string;
	message?: string;
	error?: string;
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

			const data: N8nAnalysisResponse = await response.json();
			const resultText = data.content || data.message || JSON.stringify(data);

			this.lastAnalysisResult = resultText;
			this.isAnalyzing = false;

			// Update UI suggestion bubble with Ollama analysis output
			serverState.currentSuggestion = {
				id: `s-n8n-${Date.now()}`,
				text: resultText,
				confidence: 99,
				category: 'framing',
				timestamp: new Date().toLocaleTimeString()
			};

			return resultText;
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
