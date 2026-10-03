/**
 * Scene Wireframe Service for PoseCam Mobile App
 * Sends empty background scene photos to the AI pose engine (n8n / ShutterMuse),
 * receives the wireframe-annotated pose recommendation image, and creates object URLs for display.
 */

import { serverState } from './server-state.svelte.js';

class SceneWireframeService {
	isGenerating = $state(false);
	statusMessage = $state<string>('');
	error = $state<string | null>(null);
	activeObjectUrls: string[] = [];

	private preferredEndpoint: string | null = null;

	/**
	 * Sends empty background image Blob to wireframe generation backend.
	 * Returns an object URL for the resulting wireframe-annotated image.
	 */
	async generateSceneWireframe(imageBlob: Blob): Promise<{ success: boolean; imageUrl?: string; error?: string }> {
		this.isGenerating = true;
		this.error = null;
		this.statusMessage = 'Analyzing space & calculating aesthetic pose...';

		try {
			const lanIp = serverState.ip ? serverState.ip.trim() : '';
			const desktopPort = serverState.port ? serverState.port.trim() : '8080';

			const candidateUrls: string[] = [];

			// 1. Desktop proxy (handles fallback to ShutterMuse or n8n automatically)
			if (lanIp && lanIp !== '—') {
				candidateUrls.push(`http://${lanIp}:${desktopPort}/api/scene-wireframe`);
				candidateUrls.push(`http://${lanIp}:5678/webhook/scene-pose`);
				candidateUrls.push(`http://${lanIp}:8000/api/pose-upload?return_format=image`);
			} else {
				// Local dev browser or fallback
				candidateUrls.push(`http://localhost:${desktopPort}/api/scene-wireframe`);
				candidateUrls.push('/api/scene-wireframe');
				candidateUrls.push('http://localhost:8000/api/pose-upload?return_format=image');
			}

			const urlsToTry = this.preferredEndpoint ? [this.preferredEndpoint, ...candidateUrls.filter(u => u !== this.preferredEndpoint)] : candidateUrls;

			let lastErrorMsg = 'Unknown error';

			for (const targetUrl of urlsToTry) {
				try {
					this.statusMessage = 'Generating wireframe pose...';
					const formData = new FormData();
					formData.append('file', imageBlob, 'scene.jpg');

					const controller = new AbortController();
					// Allow 45s for model forward pass
					const timeoutId = setTimeout(() => controller.abort(), 45000);

					const res = await fetch(targetUrl, {
						method: 'POST',
						body: formData,
						signal: controller.signal
					});
					clearTimeout(timeoutId);

					if (!res.ok) {
						if (this.preferredEndpoint === targetUrl) {
							this.preferredEndpoint = null;
						}
						const errText = await res.text().catch(() => '');
						lastErrorMsg = `Server returned ${res.status}: ${errText.slice(0, 100)}`;
						continue;
					}

					// Successfully reached backend
					this.preferredEndpoint = targetUrl;
					const contentType = res.headers.get('content-type') || '';

					// Case A: Binary image response
					if (contentType.includes('image') || contentType.includes('application/octet-stream')) {
						const blob = await res.blob();
						const objectUrl = URL.createObjectURL(blob);
						this.activeObjectUrls.push(objectUrl);
						this.isGenerating = false;
						this.statusMessage = 'Pose generated!';
						return { success: true, imageUrl: objectUrl };
					}

					// Case B: JSON containing base64 image
					const data = await res.json();
					const possibleB64 = data.image || data.image_base64 || data.wireframe || data.data;
					if (typeof possibleB64 === 'string') {
						const cleanB64 = possibleB64.startsWith('data:') ? possibleB64 : `data:image/jpeg;base64,${possibleB64}`;
						this.isGenerating = false;
						this.statusMessage = 'Pose generated!';
						return { success: true, imageUrl: cleanB64 };
					}

					throw new Error('Response did not contain an image');
				} catch (err: any) {
					console.warn(`[SceneWireframe] Failed with ${targetUrl}:`, err.message);
					lastErrorMsg = err.message;
				}
			}

			throw new Error(lastErrorMsg);
		} catch (err: any) {
			console.error('[SceneWireframe] Generation failed:', err);
			this.error = err.message || 'Failed to generate scene wireframe';
			this.isGenerating = false;
			this.statusMessage = 'Failed to generate wireframe';
			return { success: false, error: this.error ?? 'Unknown error' };
		}
	}

	/**
	 * Revokes all allocated blob object URLs to free memory
	 */
	cleanup() {
		for (const url of this.activeObjectUrls) {
			try {
				URL.revokeObjectURL(url);
			} catch (_) {}
		}
		this.activeObjectUrls = [];
		this.isGenerating = false;
		this.error = null;
	}
}

export const sceneWireframeService = new SceneWireframeService();
