/**
 * Voice-to-Voice Service for PoseCam Mobile App (Svelte 5 Runes)
 * Handles press-and-hold voice recording, automatic hands-free voice query listening
 * with friendly acoustic chimes, transmission with attached White Box photo context,
 * and automatic playback of returned Malayalam AI audio / text responses.
 */

import { audioRecorder, type RecordingResult } from './audio-recorder.js';
import { serverState } from './server-state.svelte.js';
import { chime } from './chime.js';

export type VoiceState = 'idle' | 'recording' | 'sending' | 'processing' | 'playing' | 'error';

class VoiceService {
	state = $state<VoiceState>('idle');
	recordDurationMs = $state(0);
	statusMessage = $state('Hold mic to speak');
	lastResponseAudio = $state<string | null>(null);
	activeAudioElement: HTMLAudioElement | null = null;

	// Hands-Free Auto-Listen Window State
	isAutoListening = $state(false);
	autoListenRemaining = $state(0);

	private timerInterval: ReturnType<typeof setInterval> | null = null;
	private autoListenTimeoutId: ReturnType<typeof setTimeout> | null = null;
	private autoListenIntervalId: ReturnType<typeof setInterval> | null = null;
	private silenceCheckIntervalId: ReturnType<typeof setInterval> | null = null;
	private recordStartTime: number = 0;
	private isSubmittingVoice: boolean = false;

	constructor() {
		if (typeof window !== 'undefined') {
			serverState.onVoiceResponse = (audio, format) => {
				this.handleVoiceResponse(audio, format);
			};
			serverState.onVoiceStatus = (_status, message) => {
				if (this.state === 'processing' || this.state === 'sending') {
					this.statusMessage = message;
				}
			};
			serverState.onVoiceError = (error) => {
				this.state = 'error';
				this.statusMessage = error;
				setTimeout(() => {
					if (this.state === 'error') {
						this.state = 'idle';
						this.statusMessage = 'Hold mic to speak';
					}
				}, 4000);
			};
		}
	}

	get isRecording(): boolean {
		return this.state === 'recording';
	}

	get isProcessing(): boolean {
		return this.state === 'sending' || this.state === 'processing';
	}

	get isPlaying(): boolean {
		return this.state === 'playing';
	}

	get formattedDuration(): string {
		const totalSec = Math.floor(this.recordDurationMs / 1000);
		const mins = Math.floor(totalSec / 60);
		const secs = totalSec % 60;
		return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
	}

	/**
	 * Opens an automatic 5-6 second hands-free listening window.
	 * Plays a friendly, noticeable chime and listens for Malayalam questions
	 * like "Hey photo nallathano?" after a photo is taken or when thumbs-up is detected.
	 */
	async startHandsFreeListening(durationSeconds = 5) {
		if (this.isSubmittingVoice || this.state === 'recording' || this.isProcessing) return;

		this.stopPlayback();
		this.cancelHandsFreeListening();

		// Play noticeable, warm ascending major triad chime across the room
		chime.playVoiceListenChime();

		// Short 320ms guard so microphone doesn't capture the chime itself
		await new Promise((res) => setTimeout(res, 320));

		// Ensure server is connected
		if (serverState.status === 'disconnected') {
			serverState.connect();
		}

		try {
			this.isAutoListening = true;
			this.autoListenRemaining = durationSeconds;
			this.recordDurationMs = 0;
			this.recordStartTime = Date.now();
			this.state = 'recording';
			this.statusMessage = 'Listening in Malayalam... "Photo nallathano?"';

			await audioRecorder.start();

			// 1-second countdown ticker for Shadcn HUD
			this.autoListenIntervalId = setInterval(() => {
				if (this.autoListenRemaining > 1) {
					this.autoListenRemaining--;
				}
			}, 1000);

			// VAD Speech and Silence Monitor:
			// If speech occurred and was followed by 1.2s of trailing silence (after at least 1.5s total)
			this.silenceCheckIntervalId = setInterval(() => {
				if (this.state !== 'recording' || !this.isAutoListening || this.isSubmittingVoice) return;

				const hasSpoken = audioRecorder.speechDetected;
				const timeSinceSpeech = Date.now() - audioRecorder.lastSpeechTime;
				const totalRecorded = Date.now() - this.recordStartTime;

				if (hasSpoken && timeSinceSpeech > 1200 && totalRecorded > 1500) {
					console.log('[HandsFreeVoice] User finished asking question. Submitting voice query...');
					this.stopHandsFreeListeningAndSend();
				}
			}, 150);

			// 5-second mic timer ends -> pack .wav and send to n8n webhook
			this.autoListenTimeoutId = setTimeout(() => {
				if (this.state === 'recording' && this.isAutoListening && !this.isSubmittingVoice) {
					console.log('[HandsFreeVoice] 5s mic timer ended. Packing .wav and sending...');
					this.stopHandsFreeListeningAndSend();
				}
			}, durationSeconds * 1000);
		} catch (err: any) {
			console.error('Failed to start hands-free voice listening:', err);
			this.cancelHandsFreeListening();
			this.state = 'idle';
		}
	}

	/**
	 * Concludes the 5-second hands-free window and dispatches WAV audio
	 */
	async stopHandsFreeListeningAndSend() {
		if (this.isSubmittingVoice) return;
		this.cancelHandsFreeTimers();
		this.isAutoListening = false;

		// Play gentle acknowledgment resolve chime
		chime.playVoiceAckChime();

		await this.stopRecordingAndSend();
	}

	/**
	 * Aborts hands-free listening
	 */
	cancelHandsFreeListening() {
		this.cancelHandsFreeTimers();
		if (this.isAutoListening && this.state === 'recording') {
			this.isAutoListening = false;
			audioRecorder.cancel();
			this.state = 'idle';
			this.statusMessage = 'Hold mic to speak';
		}
		this.isAutoListening = false;
	}

	private cancelHandsFreeTimers() {
		if (this.autoListenTimeoutId) {
			clearTimeout(this.autoListenTimeoutId);
			this.autoListenTimeoutId = null;
		}
		if (this.autoListenIntervalId) {
			clearInterval(this.autoListenIntervalId);
			this.autoListenIntervalId = null;
		}
		if (this.silenceCheckIntervalId) {
			clearInterval(this.silenceCheckIntervalId);
			this.silenceCheckIntervalId = null;
		}
	}

	/**
	 * Called immediately when user presses down on the mic button
	 */
	async startRecording() {
		if (this.isSubmittingVoice || this.state === 'recording' || this.isProcessing) return;

		this.cancelHandsFreeListening();
		this.stopPlayback();

		if (serverState.status === 'disconnected') {
			serverState.connect();
		}

		try {
			this.recordDurationMs = 0;
			this.recordStartTime = Date.now();
			this.state = 'recording';
			this.statusMessage = 'Recording voice note... Release to send';

			if (typeof window !== 'undefined' && 'vibrate' in navigator) {
				try { navigator.vibrate(35); } catch (_) {}
			}

			this.startTimer();
			await audioRecorder.start();
		} catch (err: any) {
			console.error('Failed to start recording:', err);
			this.stopTimer();
			this.state = 'error';
			this.statusMessage = err?.message || 'Could not access microphone';

			setTimeout(() => {
				if (this.state === 'error') {
					this.state = 'idle';
					this.statusMessage = 'Hold mic to speak';
				}
			}, 3500);
		}
	}

	/**
	 * Called when user releases the mic button or hands-free timer completes
	 */
	async stopRecordingAndSend() {
		if (this.state !== 'recording' || this.isSubmittingVoice) return;
		this.isSubmittingVoice = true;

		this.cancelHandsFreeTimers();
		this.isAutoListening = false;
		this.stopTimer();
		const elapsed = Date.now() - this.recordStartTime;

		if (typeof window !== 'undefined' && 'vibrate' in navigator) {
			try { navigator.vibrate(25); } catch (_) {}
		}

		// Guard: If press was too brief (< 350ms), discard to prevent accidental clicks
		if (elapsed < 350) {
			audioRecorder.cancel();
			this.state = 'idle';
			this.statusMessage = 'Hold mic to speak';
			this.isSubmittingVoice = false;
			return;
		}

		try {
			this.state = 'sending';
			this.statusMessage = 'Packing .wav audio note...';

			const recording: RecordingResult = await audioRecorder.stop();
			console.log(`[VoiceService] Packed WAV: ${recording.sizeBytes} bytes, duration: ${recording.durationMs}ms`);

			this.state = 'processing';
			this.statusMessage = 'Waiting for Malayalam .mp3 response from server...';

			const photoContext = serverState.aiAnalysis?.text || serverState.currentSuggestion?.text || '';

			// 1. Send to desktop WebSocket compute server (which forwards directly to http://localhost:5678/webhook/getvoice)
			const sentWs = serverState.sendVoiceNote(recording.base64, recording.durationMs);
			if (!sentWs) {
				console.log('[VoiceService] WebSocket not open, dispatching via HTTP directly to n8n...');
				await this.sendDirectToN8n(recording.blob, photoContext);
			}
		} catch (err: any) {
			console.error('Error stopping or transmitting voice note:', err);
			this.state = 'error';
			this.statusMessage = err?.message || 'Failed to send voice note';

			setTimeout(() => {
				if (this.state === 'error') {
					this.state = 'idle';
					this.statusMessage = 'Hold mic to speak';
				}
			}, 4000);
		} finally {
			setTimeout(() => {
				this.isSubmittingVoice = false;
			}, 2500);
		}
	}

	/**
	 * Direct HTTP submission to n8n webhook at http://localhost:5678/webhook/getvoice
	 * or desktop server HTTP proxy
	 */
	async sendDirectToN8n(wavBlob: Blob, photoContext: string): Promise<boolean> {
		const formData = new FormData();
		// Only attach exactly ONE binary field named 'file' (matching n8n STT inputDataFieldName: file)
		formData.append('file', wavBlob, 'voice.wav');
		formData.append('photo_context', photoContext);
		formData.append('context', photoContext);
		formData.append('language', 'ml');

		const candidateUrls = [
			'http://localhost:5678/webhook/getvoice',
			`http://${serverState.ip || '10.10.1.146'}:8080/api/voice`,
			`http://${serverState.ip || '10.10.1.146'}:8080/webhook/getvoice`
		];

		let lastError: any = null;
		for (const url of candidateUrls) {
			try {
				const res = await fetch(url, {
					method: 'POST',
					body: formData
				});
				if (!res.ok) continue;

				const contentType = res.headers.get('content-type') || '';
				if (contentType.includes('audio') || contentType.includes('octet-stream')) {
					const arrayBuffer = await res.arrayBuffer();
					const base64Mp3 = btoa(
						new Uint8Array(arrayBuffer).reduce((data, byte) => data + String.fromCharCode(byte), '')
					);
					this.handleVoiceResponse(base64Mp3, 'mp3');
					return true;
				} else {
					const text = await res.text();
					let parsed: any = null;
					try { parsed = JSON.parse(text); } catch (_) {}
					if (parsed && (parsed.audio || parsed.mp3)) {
						this.handleVoiceResponse(parsed.audio || parsed.mp3, 'mp3', parsed.text);
					} else {
						const cleanText = parsed?.clean_text || parsed?.response || parsed?.text || text;
						this.handleVoiceResponse('', 'mp3', cleanText);
					}
					return true;
				}
			} catch (e) {
				lastError = e;
			}
		}
		if (lastError) throw lastError;
		return false;
	}

	/**
	 * Called when an audio response or text is received over the WebSocket
	 */
	handleVoiceResponse(audioBase64: string, format = 'mp3', fallbackText?: string) {
		if (audioBase64) {
			this.lastResponseAudio = audioBase64;
			this.state = 'playing';
			this.statusMessage = 'Playing Malayalam response...';
			this.playMp3Audio(audioBase64);
		} else if (fallbackText) {
			// Instant client-side Malayalam TTS fallback if n8n returned text
			this.speakMalayalamText(fallbackText);
		} else {
			this.state = 'idle';
			this.statusMessage = '';
		}
	}

	/**
	 * Client-side SpeechSynthesis fallback for Malayalam
	 */
	speakMalayalamText(text: string) {
		if (typeof window === 'undefined' || !('speechSynthesis' in window)) return;
		try {
			window.speechSynthesis.cancel();
			const utterance = new SpeechSynthesisUtterance(text);
			utterance.lang = 'ml-IN';
			utterance.rate = 0.92;
			utterance.pitch = 1.0;

			const voices = window.speechSynthesis.getVoices();
			const mlVoice = voices.find((v) => v.lang === 'ml-IN' || v.lang.startsWith('ml'));
			if (mlVoice) utterance.voice = mlVoice;

			utterance.onstart = () => {
				this.state = 'playing';
				this.statusMessage = 'Speaking Malayalam advice...';
			};

			utterance.onend = () => {
				this.state = 'idle';
				this.statusMessage = 'Hold mic to speak';
			};

			utterance.onerror = () => {
				this.state = 'idle';
				this.statusMessage = 'Hold mic to speak';
			};

			window.speechSynthesis.speak(utterance);
		} catch (e) {
			console.warn('[Voice] Client Malayalam TTS error:', e);
		}
	}

	/**
	 * Decodes base64 MP3 and automatically plays it over the speaker
	 */
	private playMp3Audio(base64: string) {
		this.stopPlayback();

		try {
			const audioSrc = `data:audio/mp3;base64,${base64}`;
			const audio = new Audio(audioSrc);
			this.activeAudioElement = audio;

			audio.onplay = () => {
				this.state = 'playing';
				this.statusMessage = 'Playing voice response...';
			};

			audio.onended = () => {
				this.state = 'idle';
				this.statusMessage = 'Voice note completed. Hold mic to speak';
				this.activeAudioElement = null;
			};

			audio.onerror = (e) => {
				console.error('Audio playback error:', e);
				this.state = 'idle';
				this.statusMessage = 'Audio playback error';
				this.activeAudioElement = null;
			};

			const playPromise = audio.play();
			if (playPromise !== undefined) {
				playPromise.catch((error) => {
					console.warn('Auto-play prevented or failed:', error);
					this.state = 'idle';
					this.statusMessage = 'Tap to play response audio';
				});
			}
		} catch (err) {
			console.error('Failed to construct audio element:', err);
			this.state = 'idle';
			this.statusMessage = 'Hold mic to speak';
		}
	}

	stopPlayback() {
		if (this.activeAudioElement) {
			try {
				this.activeAudioElement.pause();
				this.activeAudioElement.currentTime = 0;
			} catch (_) {}
			this.activeAudioElement = null;
		}
		if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
			try { window.speechSynthesis.cancel(); } catch (_) {}
		}
		if (this.state === 'playing') {
			this.state = 'idle';
			this.statusMessage = 'Hold mic to speak';
		}
	}

	private startTimer() {
		this.stopTimer();
		this.timerInterval = setInterval(() => {
			this.recordDurationMs = Date.now() - this.recordStartTime;
		}, 100);
	}

	private stopTimer() {
		if (this.timerInterval) {
			clearInterval(this.timerInterval);
			this.timerInterval = null;
		}
	}
}

export const voiceService = new VoiceService();
