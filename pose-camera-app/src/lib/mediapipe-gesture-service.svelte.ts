/**
 * MediaPipe On-Device Gesture Shutter Service
 * Enables hands-free camera operation via hand gestures:
 * 1. User raises their hand (Open Palm detected).
 * 2. User clamps their fingers into a fist (Closed Fist detected).
 * 3. MediaPipe detects the sequence and triggers a shutter click (with optional countdown).
 * 
 * Runs on edge device using MediaPipe GestureRecognizer with zero external dependencies.
 */

import { FilesetResolver, GestureRecognizer, type GestureRecognizerResult } from '@mediapipe/tasks-vision';

export type GesturePhase = 'idle' | 'hand_raised' | 'fist_clamped' | 'counting_down' | 'cooldown';

class WebAudioBeeper {
	private audioCtx: AudioContext | null = null;

	private getContext(): AudioContext | null {
		if (typeof window === 'undefined') return null;
		try {
			if (!this.audioCtx) {
				const AudioCtxClass = window.AudioContext || (window as any).webkitAudioContext;
				if (AudioCtxClass) {
					this.audioCtx = new AudioCtxClass();
				}
			}
			if (this.audioCtx && this.audioCtx.state === 'suspended') {
				this.audioCtx.resume().catch(() => {});
			}
			return this.audioCtx;
		} catch (_) {
			return null;
		}
	}

	/**
	 * Play short tone
	 */
	playTone(freq = 880, duration = 0.08, type: OscillatorType = 'sine', volume = 0.15) {
		const ctx = this.getContext();
		if (!ctx) return;
		try {
			const osc = ctx.createOscillator();
			const gain = ctx.createGain();

			osc.type = type;
			osc.frequency.setValueAtTime(freq, ctx.currentTime);

			gain.gain.setValueAtTime(volume, ctx.currentTime);
			gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + duration);

			osc.connect(gain);
			gain.connect(ctx.destination);

			osc.start();
			osc.stop(ctx.currentTime + duration);
		} catch (_) {}
	}

	/**
	 * Hand armed beep (gentle two-tone)
	 */
	playHandArmed() {
		this.playTone(523.25, 0.07, 'sine', 0.12); // C5
		setTimeout(() => {
			this.playTone(659.25, 0.09, 'sine', 0.12); // E5
		}, 60);
	}

	/**
	 * Fist clenched trigger chime (crisp ascending chirp)
	 */
	playFistTrigger() {
		this.playTone(659.25, 0.08, 'triangle', 0.18); // E5
		setTimeout(() => {
			this.playTone(880, 0.12, 'triangle', 0.22); // A5
		}, 70);
	}

	/**
	 * Countdown tick beep
	 */
	playCountdownTick(isFinal = false) {
		if (isFinal) {
			this.playTone(1320, 0.15, 'sine', 0.25);
		} else {
			this.playTone(880, 0.08, 'sine', 0.18);
		}
	}

	/**
	 * Camera shutter click sound simulation
	 */
	playShutterClick() {
		const ctx = this.getContext();
		if (!ctx) return;
		try {
			// Click transient
			const osc = ctx.createOscillator();
			const gain = ctx.createGain();
			osc.type = 'triangle';
			osc.frequency.setValueAtTime(320, ctx.currentTime);
			osc.frequency.exponentialRampToValueAtTime(80, ctx.currentTime + 0.04);

			gain.gain.setValueAtTime(0.3, ctx.currentTime);
			gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.05);

			osc.connect(gain);
			gain.connect(ctx.destination);
			osc.start();
			osc.stop(ctx.currentTime + 0.05);

			// Noise burst
			const bufferSize = ctx.sampleRate * 0.03;
			const buffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
			const data = buffer.getChannelData(0);
			for (let i = 0; i < bufferSize; i++) {
				data[i] = Math.random() * 2 - 1;
			}
			const noise = ctx.createBufferSource();
			noise.buffer = buffer;
			const noiseGain = ctx.createGain();
			noiseGain.gain.setValueAtTime(0.2, ctx.currentTime);
			noiseGain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.03);
			noise.connect(noiseGain);
			noiseGain.connect(ctx.destination);
			noise.start();
		} catch (_) {}
	}
}

export class MediaPipeGestureService {
	// Svelte 5 Reactive States
	isEnabled = $state(true);
	isReady = $state(false);
	gesturePhase = $state<GesturePhase>('idle');
	countdownRemaining = $state(0);
	timerDuration = $state(3); // 3-second hands-free countdown by default (0 = instant)
	detectedGesture = $state<string | null>(null);
	statusMessage = $state<string>('');

	private recognizer: GestureRecognizer | null = null;
	private initPromise: Promise<boolean> | null = null;
	private isInitializing = false;
	private isRunning = false;
	private rafId: number | null = null;
	private videoEl: HTMLVideoElement | null = null;

	// Gesture state machine tracking
	private openPalmStreak = 0;
	private fistStreak = 0;
	private thumbUpStreak = 0;
	private handRaisedTimestamp = 0;
	private countdownTimerId: any = null;
	private cooldownTimeoutId: any = null;
	private lastProcessTime = 0;
	private readonly PROCESS_INTERVAL_MS = 90; // ~11 FPS for high responsiveness & low power
	private readonly HAND_RAISED_TIMEOUT_MS = 4000; // Reset if fist not clamped within 4s

	// Callback to invoke camera shutter
	public onShutterTrigger: (() => void) | null = null;
	// Callback to invoke Malayalam voice query (via Thumbs Up)
	public onVoiceQueryTrigger: (() => void) | null = null;

	private beeper = new WebAudioBeeper();

	constructor() {
		if (typeof window !== 'undefined') {
			(window as any).__mediapipeGestureService = this;
		}
	}

	/**
	 * Toggle hands-free gesture shutter feature on/off
	 */
	toggleEnabled() {
		this.isEnabled = !this.isEnabled;
		if (!this.isEnabled) {
			this.resetToIdle();
		}
	}

	/**
	 * Toggle between 3s timer and instant (0s) capture
	 */
	toggleTimer() {
		this.timerDuration = this.timerDuration === 3 ? 0 : 3;
	}

	/**
	 * Cancel any in-progress countdown or armed state
	 */
	cancel() {
		this.resetToIdle();
	}

	/**
	 * Initialize MediaPipe FilesetResolver and GestureRecognizer
	 */
	async initialize(): Promise<boolean> {
		if (this.isReady) return true;
		if (this.initPromise) return this.initPromise;

		this.initPromise = (async () => {
			this.isInitializing = true;
			console.log('[MediaPipeGesture] Initializing GestureRecognizer...');

			try {
				const wasmBase =
					typeof window !== 'undefined' && window.location.origin && window.location.origin !== 'null'
						? `${window.location.origin}/mediapipe/wasm`
						: '/mediapipe/wasm';

				const modelBase =
					typeof window !== 'undefined' && window.location.origin && window.location.origin !== 'null'
						? `${window.location.origin}/mediapipe/gesture_recognizer.task`
						: '/mediapipe/gesture_recognizer.task';

				let vision;
				try {
					vision = await FilesetResolver.forVisionTasks(wasmBase);
				} catch (wasmErr) {
					console.warn('[MediaPipeGesture] Local wasm load failed, trying CDN fallback:', wasmErr);
					vision = await FilesetResolver.forVisionTasks(
						'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@latest/wasm'
					);
				}

				// Try GPU delegate first, fallback to CPU
				try {
					this.recognizer = await GestureRecognizer.createFromOptions(vision, {
						baseOptions: {
							modelAssetPath: modelBase,
							delegate: 'GPU'
						},
						runningMode: 'VIDEO',
						numHands: 1,
						minHandDetectionConfidence: 0.5,
						minHandPresenceConfidence: 0.5,
						minTrackingConfidence: 0.5
					});
					console.log('[MediaPipeGesture] Initialized successfully with GPU delegate');
				} catch (gpuErr) {
					console.warn('[MediaPipeGesture] GPU delegate failed, falling back to CPU:', gpuErr);
					try {
						this.recognizer = await GestureRecognizer.createFromOptions(vision, {
							baseOptions: {
								modelAssetPath: modelBase,
								delegate: 'CPU'
							},
							runningMode: 'VIDEO',
							numHands: 1,
							minHandDetectionConfidence: 0.5,
							minHandPresenceConfidence: 0.5,
							minTrackingConfidence: 0.5
						});
						console.log('[MediaPipeGesture] Initialized successfully with CPU delegate');
					} catch (cpuErr) {
						console.warn('[MediaPipeGesture] Local model failed, trying CDN model:', cpuErr);
						this.recognizer = await GestureRecognizer.createFromOptions(vision, {
							baseOptions: {
								modelAssetPath:
									'https://storage.googleapis.com/mediapipe-models/gesture_recognizer/gesture_recognizer/float16/1/gesture_recognizer.task',
								delegate: 'CPU'
							},
							runningMode: 'VIDEO',
							numHands: 1,
							minHandDetectionConfidence: 0.5,
							minHandPresenceConfidence: 0.5,
							minTrackingConfidence: 0.5
						});
					}
				}

				this.isReady = !!this.recognizer;
				return this.isReady;
			} catch (err) {
				console.error('[MediaPipeGesture] Failed to initialize GestureRecognizer:', err);
				this.isReady = false;
				return false;
			} finally {
				this.isInitializing = false;
			}
		})();

		return this.initPromise;
	}

	/**
	 * Start gesture detection on the camera video element
	 */
	async start(videoEl: HTMLVideoElement) {
		this.videoEl = videoEl;
		this.isRunning = true;

		if (!this.isReady) {
			const success = await this.initialize();
			if (!success || !this.isRunning) return;
		}

		console.log('[MediaPipeGesture] Starting gesture recognition loop');
		if (this.rafId === null) {
			this.loop();
		}
	}

	/**
	 * Stop gesture detection
	 */
	stop() {
		this.isRunning = false;
		if (this.rafId !== null) {
			cancelAnimationFrame(this.rafId);
			this.rafId = null;
		}
		this.videoEl = null;
		this.resetToIdle();
	}

	private loop = () => {
		if (!this.isRunning || !this.videoEl) return;

		const now = performance.now();
		if (now - this.lastProcessTime >= this.PROCESS_INTERVAL_MS) {
			this.lastProcessTime = now;
			this.processCurrentFrame();
		}

		this.rafId = requestAnimationFrame(this.loop);
	};

	private processCurrentFrame() {
		if (!this.recognizer || !this.videoEl || !this.isEnabled) return;
		if (
			this.videoEl.readyState < 2 ||
			this.videoEl.paused ||
			this.videoEl.ended ||
			this.videoEl.videoWidth < 50 ||
			this.videoEl.videoHeight < 50
		) {
			return;
		}

		// Don't process gestures while currently counting down or in cooldown
		if (this.gesturePhase === 'counting_down' || this.gesturePhase === 'cooldown') {
			return;
		}

		try {
			const nowMs = performance.now();
			const result: GestureRecognizerResult = this.recognizer.recognizeForVideo(this.videoEl, nowMs);

			this.evaluateGestures(result);
		} catch (e) {
			console.warn('[MediaPipeGesture] Recognition error:', e);
		}
	}

	/**
	 * Evaluates MediaPipe gestures and coordinates state transitions
	 * State 1: Open_Palm (Hand Raised)
	 * State 2: Closed_Fist (Fingers Clamped) -> Registers Shutter Click
	 */
	private evaluateGestures(result: GestureRecognizerResult) {
		const now = Date.now();

		// Check if hand raised state has timed out
		if (this.gesturePhase === 'hand_raised' && now - this.handRaisedTimestamp > this.HAND_RAISED_TIMEOUT_MS) {
			console.log('[MediaPipeGesture] Hand raised timed out (> 4s), resetting to idle');
			this.resetToIdle();
			return;
		}

		const hasHands = result.landmarks && result.landmarks.length > 0;
		if (!hasHands) {
			this.detectedGesture = null;
			this.openPalmStreak = 0;
			this.fistStreak = 0;
			return;
		}

		// Read top recognized gesture category
		const topCategory = result.gestures?.[0]?.[0];
		const gestureName = topCategory?.categoryName || 'None';
		const gestureScore = topCategory?.score ?? 0;
		this.detectedGesture = gestureName;

		const landmarks = result.landmarks[0];
		const wrist = landmarks[0];

		// Check if hand is raised in upper portion of camera frame (wrist.y < 0.88)
		const isHandRaisedInFrame = wrist && wrist.y < 0.88;

		// Calculate geometric finger curl as a backup/validation for fist
		const isGeometricFist = this.checkGeometricFist(landmarks);

		// STATE MACHINE:
		// 1. IDLE -> Check for Raised Open Palm (Shutter) OR Thumbs Up (Malayalam Voice Query)
		if (this.gesturePhase === 'idle') {
			// Check for Thumbs-Up gesture to ask questions in Malayalam (e.g. "Photo nallathano?")
			const isThumbUp = gestureName === 'Thumb_Up' && gestureScore >= 0.55;
			if (isThumbUp && isHandRaisedInFrame) {
				this.thumbUpStreak++;
				if (this.thumbUpStreak >= 2) {
					this.triggerVoiceQuery();
					return;
				}
			} else {
				this.thumbUpStreak = 0;
			}

			const isOpenPalm =
				(gestureName === 'Open_Palm' && gestureScore >= 0.55) ||
				this.checkGeometricOpenPalm(landmarks);

			if (isOpenPalm && isHandRaisedInFrame) {
				this.openPalmStreak++;
				// Require 2 consecutive frames (~180ms) to prevent accidental flickers
				if (this.openPalmStreak >= 2) {
					this.armHandRaised();
				}
			} else {
				this.openPalmStreak = 0;
			}
		}
		// 2. HAND_RAISED -> Check for Clamped Fist
		else if (this.gesturePhase === 'hand_raised') {
			const isFist =
				(gestureName === 'Closed_Fist' && gestureScore >= 0.5) ||
				isGeometricFist;

			if (isFist) {
				this.fistStreak++;
				// Require at least 1-2 frames of confirmed fist
				if (this.fistStreak >= 1) {
					this.triggerFistClamped();
				}
			} else {
				this.fistStreak = 0;
			}
		}
	}

	/**
	 * Geometric check: All 4 main fingers extended (Open Palm)
	 */
	private checkGeometricOpenPalm(landmarks: { x: number; y: number; z?: number }[]): boolean {
		if (!landmarks || landmarks.length < 21) return false;
		const wrist = landmarks[0];

		// Compare distance from wrist to fingertip vs wrist to MCP joint
		// Index (8 vs 5), Middle (12 vs 9), Ring (16 vs 13), Pinky (20 vs 17)
		const fingerPairs = [
			{ tip: 8, mcp: 5 },
			{ tip: 12, mcp: 9 },
			{ tip: 16, mcp: 13 },
			{ tip: 20, mcp: 17 }
		];

		let extendedCount = 0;
		for (const { tip, mcp } of fingerPairs) {
			const dTip = Math.hypot(landmarks[tip].x - wrist.x, landmarks[tip].y - wrist.y);
			const dMcp = Math.hypot(landmarks[mcp].x - wrist.x, landmarks[mcp].y - wrist.y);
			if (dTip > dMcp * 1.3) {
				extendedCount++;
			}
		}

		return extendedCount >= 3;
	}

	/**
	 * Geometric check: All 4 fingers curled tightly towards palm (Closed Fist)
	 */
	private checkGeometricFist(landmarks: { x: number; y: number; z?: number }[]): boolean {
		if (!landmarks || landmarks.length < 21) return false;
		const wrist = landmarks[0];

		const fingerPairs = [
			{ tip: 8, mcp: 5 },
			{ tip: 12, mcp: 9 },
			{ tip: 16, mcp: 13 },
			{ tip: 20, mcp: 17 }
		];

		let curledCount = 0;
		for (const { tip, mcp } of fingerPairs) {
			const dTip = Math.hypot(landmarks[tip].x - wrist.x, landmarks[tip].y - wrist.y);
			const dMcp = Math.hypot(landmarks[mcp].x - wrist.x, landmarks[mcp].y - wrist.y);
			// In a fist, the fingertip is curled close to or inside the MCP joint radius
			if (dTip < dMcp * 1.15) {
				curledCount++;
			}
		}

		return curledCount >= 3;
	}

	/**
	 * User raised hand with open palm
	 */
	private armHandRaised() {
		this.gesturePhase = 'hand_raised';
		this.handRaisedTimestamp = Date.now();
		this.openPalmStreak = 0;
		this.fistStreak = 0;
		this.statusMessage = '✋ Hand detected · Clench fist to snap!';
		console.log('[MediaPipeGesture] Hand Raised Armed! Waiting for fist...');

		// Audio & haptic feedback
		this.beeper.playHandArmed();
		if (typeof window !== 'undefined' && 'vibrate' in navigator) {
			try { navigator.vibrate(35); } catch (_) {}
		}
	}

	/**
	 * User clamped fingers into a fist -> Register Shutter Click!
	 */
	private triggerFistClamped() {
		this.gesturePhase = 'fist_clamped';
		this.fistStreak = 0;
		this.openPalmStreak = 0;
		this.statusMessage = '✊ Fist detected!';
		console.log('[MediaPipeGesture] Fist Clamped! Registering shutter action...');

		this.beeper.playFistTrigger();
		if (typeof window !== 'undefined' && 'vibrate' in navigator) {
			try { navigator.vibrate([60, 40, 80]); } catch (_) {}
		}

		if (this.timerDuration > 0) {
			this.startCountdown(this.timerDuration);
		} else {
			this.executeShutter();
		}
	}

	/**
	 * Hands-free countdown before capturing photo (e.g. 3, 2, 1)
	 */
	private startCountdown(seconds: number) {
		this.gesturePhase = 'counting_down';
		this.countdownRemaining = seconds;
		this.beeper.playCountdownTick(false);

		const tick = () => {
			if (this.gesturePhase !== 'counting_down') return;

			this.countdownRemaining--;
			if (this.countdownRemaining > 0) {
				this.beeper.playCountdownTick(false);
				if (typeof window !== 'undefined' && 'vibrate' in navigator) {
					try { navigator.vibrate(30); } catch (_) {}
				}
				this.countdownTimerId = setTimeout(tick, 1000);
			} else {
				this.beeper.playCountdownTick(true);
				this.executeShutter();
			}
		};

		this.countdownTimerId = setTimeout(tick, 1000);
	}

	/**
	 * Dispatches shutter click to the camera page
	 */
	private executeShutter() {
		this.clearTimers();
		this.gesturePhase = 'cooldown';
		this.statusMessage = '📸 Photo Captured!';
		this.beeper.playShutterClick();

		if (typeof window !== 'undefined' && 'vibrate' in navigator) {
			try { navigator.vibrate(100); } catch (_) {}
		}

		try {
			if (this.onShutterTrigger) {
				this.onShutterTrigger();
			}
		} catch (e) {
			console.error('[MediaPipeGesture] Error invoking shutter trigger:', e);
		}

		// Cooldown lock for 3.5 seconds to prevent accidental repeat captures
		this.cooldownTimeoutId = setTimeout(() => {
			this.resetToIdle();
		}, 3500);
	}

	/**
	 * Thumbs-Up detected -> trigger hands-free Malayalam voice query
	 */
	private triggerVoiceQuery() {
		this.thumbUpStreak = 0;
		console.log('[MediaPipeGesture] Thumbs-Up detected! Invoking voice query trigger');
		if (this.onVoiceQueryTrigger) {
			this.onVoiceQueryTrigger();
		}
	}

	private clearTimers() {
		if (this.countdownTimerId) {
			clearTimeout(this.countdownTimerId);
			this.countdownTimerId = null;
		}
		if (this.cooldownTimeoutId) {
			clearTimeout(this.cooldownTimeoutId);
			this.cooldownTimeoutId = null;
		}
	}

	private resetToIdle() {
		this.clearTimers();
		this.gesturePhase = 'idle';
		this.countdownRemaining = 0;
		this.openPalmStreak = 0;
		this.fistStreak = 0;
		this.thumbUpStreak = 0;
		this.detectedGesture = null;
		this.statusMessage = '';
	}
}

export const mediapipeGestureService = new MediaPipeGestureService();
