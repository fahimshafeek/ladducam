/**
 * MediaPipe On-Device Native Pose Service
 * Evaluates real-time pose geometric rules from pose_correction_top20.md
 * with landmark smoothing, jitter suppression, and robust metric evaluation.
 * Runs silently in the background on the edge device with zero UI changes.
 */

import { FilesetResolver, PoseLandmarker } from '@mediapipe/tasks-vision';
import { serverState } from './server-state.svelte.js';
import {
	createEvaluationContext,
	evaluateTopRule,
	type PoseRule,
	type NormalizedLandmark
} from './pose-rules.js';

class MediaPipePoseService {
	private landmarker: PoseLandmarker | null = null;
	private initPromise: Promise<boolean> | null = null;
	private isInitializing = false;
	public isReady = false;
	public isRunning = false;
	private rafId: number | null = null;
	private videoEl: HTMLVideoElement | null = null;

	// Landmark smoothing & noise suppression
	private smoothedLandmarks: NormalizedLandmark[] | null = null;
	private candidateRuleId: string | null = null;
	private candidateRuleStreak = 0;

	// Hysteresis & debounce state
	private activeRuleIds = new Set<string>();
	public currentRuleId: string | null = null;
	private ruleSetTime = 0;
	private lastProcessTime = 0;
	private consecutiveGoodFrames = 0;
	private consecutiveEmptyFrames = 0;
	private frameCount = 0;

	// Target processing interval: ~10 FPS (100ms) for high mobile battery efficiency
	private readonly PROCESS_INTERVAL_MS = 100;
	// Minimum time to keep displaying a suggestion before switching (2.5 seconds)
	private readonly MIN_DISPLAY_DURATION_MS = 2500;

	constructor() {
		if (typeof window !== 'undefined') {
			(window as any).__mediapipePoseService = this;
		}
	}

	/**
	 * Initialize MediaPipe FilesetResolver and PoseLandmarker with offline-first fallbacks
	 */
	async initialize(): Promise<boolean> {
		if (this.isReady) return true;
		if (this.initPromise) return this.initPromise;

		this.initPromise = (async () => {
			this.isInitializing = true;
			console.log('[MediaPipePose] Initializing MediaPipe Pose Landmarker...');

			try {
				// Resolve wasm path
				const wasmBase =
					typeof window !== 'undefined' && window.location.origin && window.location.origin !== 'null'
						? `${window.location.origin}/mediapipe/wasm`
						: '/mediapipe/wasm';

				const modelBase =
					typeof window !== 'undefined' && window.location.origin && window.location.origin !== 'null'
						? `${window.location.origin}/mediapipe/pose_landmarker_lite.task`
						: '/mediapipe/pose_landmarker_lite.task';

				let vision;
				try {
					vision = await FilesetResolver.forVisionTasks(wasmBase);
				} catch (localWasmErr) {
					console.warn('[MediaPipePose] Local wasm load failed, trying CDN fallback:', localWasmErr);
					vision = await FilesetResolver.forVisionTasks(
						'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@latest/wasm'
					);
				}

				// Try GPU delegate first, fallback to CPU if WebGL fails on mobile/emulator
				try {
					this.landmarker = await PoseLandmarker.createFromOptions(vision, {
						baseOptions: {
							modelAssetPath: modelBase,
							delegate: 'GPU'
						},
						runningMode: 'VIDEO',
						numPoses: 1,
						minPoseDetectionConfidence: 0.5,
						minPosePresenceConfidence: 0.5,
						minTrackingConfidence: 0.5
					});
					console.log('[MediaPipePose] Initialized successfully with GPU delegate');
				} catch (gpuErr) {
					console.warn('[MediaPipePose] GPU delegate failed, falling back to CPU:', gpuErr);
					try {
						this.landmarker = await PoseLandmarker.createFromOptions(vision, {
							baseOptions: {
								modelAssetPath: modelBase,
								delegate: 'CPU'
							},
							runningMode: 'VIDEO',
							numPoses: 1,
							minPoseDetectionConfidence: 0.5,
							minPosePresenceConfidence: 0.5,
							minTrackingConfidence: 0.5
						});
						console.log('[MediaPipePose] Initialized successfully with CPU delegate');
					} catch (cpuErr) {
						console.warn('[MediaPipePose] Local model failed, trying CDN model:', cpuErr);
						this.landmarker = await PoseLandmarker.createFromOptions(vision, {
							baseOptions: {
								modelAssetPath:
									'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task',
								delegate: 'CPU'
							},
							runningMode: 'VIDEO',
							numPoses: 1,
							minPoseDetectionConfidence: 0.5,
							minPosePresenceConfidence: 0.5,
							minTrackingConfidence: 0.5
						});
					}
				}

				this.isReady = !!this.landmarker;
				return this.isReady;
			} catch (err) {
				console.error('[MediaPipePose] Failed to initialize MediaPipe Pose Landmarker:', err);
				this.isReady = false;
				return false;
			} finally {
				this.isInitializing = false;
			}
		})();

		return this.initPromise;
	}

	/**
	 * Start silent background pose detection on the given camera video element
	 */
	async start(videoEl: HTMLVideoElement) {
		this.videoEl = videoEl;
		this.isRunning = true;

		// Disable mock auto-suggestions so real pose detection takes control of the bubble
		serverState.autoSuggestActive = false;

		serverState.currentSuggestion = {
			id: 'mp-calibrating',
			text: 'MediaPipe Vision Active · Detecting posture and framing...',
			confidence: 98,
			category: 'framing',
			timestamp: new Date().toLocaleTimeString()
		};

		if (!this.isReady) {
			const success = await this.initialize();
			if (!success || !this.isRunning) {
				if (!success) {
					console.warn('[MediaPipePose] Reverting to fallback suggestions due to initialization failure');
					serverState.autoSuggestActive = true;
				}
				return;
			}
		}

		console.log('[MediaPipePose] Starting real-time silent pose analysis loop');
		if (this.rafId === null) {
			this.loop();
		}
	}

	/**
	 * Stop background pose detection
	 */
	stop() {
		this.isRunning = false;
		if (this.rafId !== null) {
			cancelAnimationFrame(this.rafId);
			this.rafId = null;
		}
		this.videoEl = null;
		this.activeRuleIds.clear();
		this.currentRuleId = null;
		this.smoothedLandmarks = null;
		this.candidateRuleId = null;
		this.candidateRuleStreak = 0;
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
		if (!this.landmarker || !this.videoEl) return;
		if (
			this.videoEl.readyState < 2 ||
			this.videoEl.paused ||
			this.videoEl.ended ||
			this.videoEl.videoWidth < 50 ||
			this.videoEl.videoHeight < 50
		) {
			return;
		}

		try {
			const nowMs = performance.now();
			const result = this.landmarker.detectForVideo(this.videoEl, nowMs);

			if (result.landmarks && result.landmarks.length > 0) {
				this.consecutiveEmptyFrames = 0;
				const rawLandmarks = result.landmarks[0] as NormalizedLandmark[];

				// Exponential Moving Average smoothing (alpha = 0.55) to eliminate single-frame coordinate jitter
				if (!this.smoothedLandmarks || this.smoothedLandmarks.length !== rawLandmarks.length) {
					this.smoothedLandmarks = rawLandmarks.map((l) => ({ ...l }));
				} else {
					const alpha = 0.55;
					for (let i = 0; i < rawLandmarks.length; i++) {
						this.smoothedLandmarks[i].x =
							this.smoothedLandmarks[i].x * (1 - alpha) + rawLandmarks[i].x * alpha;
						this.smoothedLandmarks[i].y =
							this.smoothedLandmarks[i].y * (1 - alpha) + rawLandmarks[i].y * alpha;
						this.smoothedLandmarks[i].z =
							(this.smoothedLandmarks[i].z ?? 0) * (1 - alpha) + (rawLandmarks[i].z ?? 0) * alpha;
						this.smoothedLandmarks[i].visibility = rawLandmarks[i].visibility;
					}
				}

				const width = this.videoEl.videoWidth || 720;
				const height = this.videoEl.videoHeight || 1280;

				const ctx = createEvaluationContext(this.smoothedLandmarks, width, height, this.activeRuleIds);
				const triggeredRule = evaluateTopRule(ctx);

				this.frameCount++;
				if (this.frameCount % 20 === 0) {
					console.log('[MediaPipePose Live]', {
						rule: triggeredRule ? triggeredRule.id : 'GOOD_POSE',
						view: ctx.view,
						sw: Math.round(ctx.SW),
						tl: Math.round(ctx.TL)
					});
				}

				if (triggeredRule) {
					this.consecutiveGoodFrames = 0;

					// Require candidate rule to hold for at least 2 consecutive checks before switching
					if (this.candidateRuleId === triggeredRule.id) {
						this.candidateRuleStreak++;
					} else {
						this.candidateRuleId = triggeredRule.id;
						this.candidateRuleStreak = 1;
					}

					if (this.candidateRuleStreak >= 2) {
						this.applyTriggeredRule(triggeredRule);
					}
				} else {
					this.candidateRuleId = null;
					this.candidateRuleStreak = 0;
					this.consecutiveGoodFrames++;
					// After 8 consecutive good frames (~800ms), confirm good pose
					if (this.consecutiveGoodFrames >= 8) {
						this.applyGoodPose();
					}
				}
			} else {
				this.consecutiveEmptyFrames++;
				this.consecutiveGoodFrames = 0;
				this.smoothedLandmarks = null;
				this.candidateRuleId = null;
				this.candidateRuleStreak = 0;

				if (this.consecutiveEmptyFrames >= 15) {
					// ~1.5s without subject detected
					this.applyNoSubject();
				}
			}
		} catch (e) {
			console.warn('[MediaPipePose] Frame analysis warning:', e);
		}
	}

	private applyTriggeredRule(rule: PoseRule) {
		const now = Date.now();
		const isSameRule = this.currentRuleId === rule.id;
		const canSwitch = !this.currentRuleId || now - this.ruleSetTime >= this.MIN_DISPLAY_DURATION_MS;

		if (isSameRule) {
			this.activeRuleIds.add(rule.id);
			return;
		}

		if (canSwitch) {
			this.activeRuleIds.clear();
			this.activeRuleIds.add(rule.id);
			this.currentRuleId = rule.id;
			this.ruleSetTime = now;

			serverState.currentSuggestion = {
				id: `mp-${rule.id}-${now}`,
				text: rule.fix,
				confidence: 96,
				category: rule.category,
				timestamp: new Date().toLocaleTimeString()
			};
		}
	}

	private applyGoodPose() {
		const now = Date.now();
		if (this.currentRuleId === 'good_pose') return;
		if (this.currentRuleId && now - this.ruleSetTime < this.MIN_DISPLAY_DURATION_MS) return;

		this.activeRuleIds.clear();
		this.currentRuleId = 'good_pose';
		this.ruleSetTime = now;

		serverState.currentSuggestion = {
			id: `mp-good-${now}`,
			text: 'Pose and framing look great! Hold steady for the shot.',
			confidence: 99,
			category: 'framing',
			timestamp: new Date().toLocaleTimeString()
		};
	}

	private applyNoSubject() {
		const now = Date.now();
		if (this.currentRuleId === 'no_subject') return;
		if (this.currentRuleId && now - this.ruleSetTime < this.MIN_DISPLAY_DURATION_MS) return;

		this.activeRuleIds.clear();
		this.currentRuleId = 'no_subject';
		this.ruleSetTime = now;

		serverState.currentSuggestion = {
			id: `mp-empty-${now}`,
			text: 'MediaPipe Vision Active · Bring subject into frame to evaluate posture.',
			confidence: 90,
			category: 'framing',
			timestamp: new Date().toLocaleTimeString()
		};
	}
}

export const mediapipePoseService = new MediaPipePoseService();
