<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import { gsap } from 'gsap';
	import { serverState } from '$lib/server-state.svelte.js';
	import { n8nService } from '$lib/n8n-service.svelte.js';
	import { voiceService } from '$lib/voice-service.svelte.js';
	import { mediapipePoseService } from '$lib/mediapipe-pose-service.js';
	import { mediapipeGestureService } from '$lib/mediapipe-gesture-service.svelte.js';
	import { Button } from '$lib/components/ui/button/index.js';

	import ArrowLeft from '@lucide/svelte/icons/arrow-left';
	import FlipHorizontal from '@lucide/svelte/icons/flip-horizontal';
	import CameraIcon from '@lucide/svelte/icons/camera';
	import RefreshCw from '@lucide/svelte/icons/refresh-cw';
	import Mic from '@lucide/svelte/icons/mic';
	import Volume2 from '@lucide/svelte/icons/volume-2';
	import Loader2 from '@lucide/svelte/icons/loader-2';
	import X from '@lucide/svelte/icons/x';
	import Sparkles from '@lucide/svelte/icons/sparkles';
	import Hand from '@lucide/svelte/icons/hand';
	import HandFist from '@lucide/svelte/icons/hand-fist';
	import Timer from '@lucide/svelte/icons/timer';
	import ScanLine from '@lucide/svelte/icons/scan-line';
	import RotateCcw from '@lucide/svelte/icons/rotate-ccw';
	import Check from '@lucide/svelte/icons/check';
	import { sceneWireframeService } from '$lib/scene-wireframe-service.svelte.js';
	import { chime } from '$lib/chime.js';

	let containerEl = $state<HTMLElement | null>(null);
	let videoElement = $state<HTMLVideoElement | null>(null);
	let shutterBtnEl = $state<HTMLButtonElement | null>(null);
	let flipBtnEl = $state<HTMLButtonElement | null>(null);
	let flashEl = $state<HTMLDivElement | null>(null);
	let suggestionTextEl = $state<HTMLParagraphElement | null>(null);

	// Experimental Empty Scene Wireframe Mode state
	let isSceneWireframeMode = $state(false);
	let wireframeState = $state<'idle' | 'processing' | 'revealed'>('idle');
	let frozenShotUrl = $state<string | null>(null);
	let wireframeResultUrl = $state<string | null>(null);
	let wireframeScopeEl = $state<HTMLDivElement | null>(null);
	let frozenImgEl = $state<HTMLImageElement | null>(null);
	let wireframeImgEl = $state<HTMLImageElement | null>(null);
	let scanBeamEl = $state<HTMLDivElement | null>(null);
	let wireframeCardEl = $state<HTMLDivElement | null>(null);
	let wireframeTimelineCtx: gsap.Context | null = null;

	let stream = $state<MediaStream | null>(null);
	let facingMode = $state<'user' | 'environment'>('user');
	let cameraLoading = $state(true);
	let cameraError = $state<string | null>(null);
	let isCapturing = $state(false);
	let ctx: gsap.Context | null = null;

	async function initCamera() {
		cameraLoading = true;
		cameraError = null;
		mediapipePoseService.stop();
		mediapipeGestureService.stop();

		if (stream) {
			stream.getTracks().forEach((track) => track.stop());
			stream = null;
		}

		try {
			if (navigator?.mediaDevices?.getUserMedia) {
				let mediaStream: MediaStream;
				try {
					mediaStream = await navigator.mediaDevices.getUserMedia({
						video: {
							facingMode: facingMode,
							width: { ideal: 1280 },
							height: { ideal: 720 }
						},
						audio: false
					});
				} catch (constraintErr) {
					console.warn('Retrying with basic video constraints:', constraintErr);
					mediaStream = await navigator.mediaDevices.getUserMedia({
						video: { facingMode: facingMode },
						audio: false
					});
				}

				stream = mediaStream;
				cameraLoading = false;

				if (videoElement) {
					videoElement.srcObject = mediaStream;
					videoElement.onloadedmetadata = async () => {
						try {
							await videoElement?.play();
							if (videoElement) {
								mediapipePoseService.start(videoElement);
								mediapipeGestureService.onShutterTrigger = () => {
									handleShutter();
								};
								mediapipeGestureService.onVoiceQueryTrigger = () => {
									if (!isSceneWireframeMode) {
										voiceService.startHandsFreeListening(6);
									}
								};
								mediapipeGestureService.start(videoElement);
							}
						} catch (e) {
							console.warn('Video play error on loadedmetadata:', e);
						}
					};
					videoElement.play().then(() => {
						if (videoElement) {
							mediapipePoseService.start(videoElement);
							mediapipeGestureService.onShutterTrigger = () => {
								handleShutter();
							};
							mediapipeGestureService.onVoiceQueryTrigger = () => {
								if (!isSceneWireframeMode) {
									voiceService.startHandsFreeListening(6);
								}
							};
							mediapipeGestureService.start(videoElement);
						}
					}).catch(() => {});
				}
			} else {
				throw new Error('Camera not supported');
			}
		} catch (err: any) {
			console.warn('Camera error:', err);
			cameraLoading = false;
			cameraError = err?.message || 'Unable to access camera';
		}
	}

	function toggleCameraFacing() {
		facingMode = facingMode === 'user' ? 'environment' : 'user';
		if (flipBtnEl) {
			gsap.fromTo(flipBtnEl, { rotation: 0 }, { rotation: 180, duration: 0.4, ease: 'power2.inOut' });
		}
		initCamera();
	}

	async function captureFrameBlob(): Promise<Blob | null> {
		if (!videoElement || videoElement.readyState < 2) return null;
		const canvas = document.createElement('canvas');
		canvas.width = videoElement.videoWidth || 1280;
		canvas.height = videoElement.videoHeight || 720;
		const ctx = canvas.getContext('2d');
		if (!ctx) return null;

		if (facingMode === 'user') {
			ctx.translate(canvas.width, 0);
			ctx.scale(-1, 1);
		}

		ctx.drawImage(videoElement, 0, 0, canvas.width, canvas.height);

		return new Promise<Blob | null>((resolve) => {
			canvas.toBlob((blob) => resolve(blob), 'image/jpeg', 0.9);
		});
	}

	function toggleSceneWireframeMode() {
		if (wireframeState === 'processing') return;
		if (wireframeState === 'revealed') {
			resetWireframeMode(false);
			return;
		}
		isSceneWireframeMode = !isSceneWireframeMode;
		// Completely silence & stop any audio/mic activities
		voiceService.stopPlayback();
		voiceService.cancelHandsFreeListening();
		serverState.dismissAiAnalysis();
		if (isSceneWireframeMode) {
			if (typeof window !== 'undefined' && 'vibrate' in navigator) {
				try { navigator.vibrate(30); } catch (_) {}
			}
		}
	}

	function resetWireframeMode(stayInSceneMode = true) {
		wireframeTimelineCtx?.revert();
		if (frozenShotUrl) {
			try { URL.revokeObjectURL(frozenShotUrl); } catch (_) {}
			frozenShotUrl = null;
		}
		wireframeResultUrl = null;
		wireframeState = 'idle';
		sceneWireframeService.cleanup();
		voiceService.stopPlayback();
		voiceService.cancelHandsFreeListening();
		serverState.dismissAiAnalysis();
		if (!stayInSceneMode) {
			isSceneWireframeMode = false;
		}
	}

	function triggerWireframeTransition() {
		if (!wireframeScopeEl) return;
		wireframeTimelineCtx?.revert();

		wireframeTimelineCtx = gsap.context(() => {
			const tl = gsap.timeline({
				defaults: { ease: 'power2.out' }
			});

			// Setup starting properties using GSAP best practices
			gsap.set(wireframeImgEl, {
				autoAlpha: 0,
				scale: 1.015,
				filter: 'brightness(1.15)'
			});
			gsap.set(wireframeCardEl, {
				autoAlpha: 0,
				y: 20
			});
			gsap.set(scanBeamEl, {
				autoAlpha: 0,
				yPercent: -100
			});

			// 1. Subtle scale punch on the frozen shot frame
			tl.to(frozenImgEl, {
				scale: 1.015,
				duration: 0.35,
				ease: 'power2.out'
			});

			// 2. Minimalist light sweep across the frame
			tl.fromTo(
				scanBeamEl,
				{ autoAlpha: 0.7, yPercent: -100 },
				{ autoAlpha: 1, yPercent: 220, duration: 0.75, ease: 'power1.inOut' },
				'-=0.15'
			);

			// 3. Smooth cross-dissolve & settle into the wireframe image
			tl.to(
				wireframeImgEl,
				{
					autoAlpha: 1,
					scale: 1.0,
					filter: 'brightness(1.0)',
					duration: 0.7,
					ease: 'power3.out'
				},
				'-=0.4'
			);

			// 4. Reveal recommendation action card and controls at the bottom
			tl.to(
				wireframeCardEl,
				{
					autoAlpha: 1,
					y: 0,
					duration: 0.45,
					ease: 'power3.out',
					clearProps: 'transform'
				},
				'-=0.2'
			);
		}, wireframeScopeEl);
	}

	let lastShutterTimestamp = 0;

	async function handleShutter() {
		const now = Date.now();
		if (now - lastShutterTimestamp < 2500) {
			console.warn('[Shutter] Rapid press debounced (< 2500ms)');
			return;
		}
		if (isCapturing || n8nService.isAnalyzing || sceneWireframeService.isGenerating) {
			console.warn('[Shutter] Shutter press ignored: capture or analysis already running');
			return;
		}

		// Empty Scene Wireframe Mode execution path (Audio/mic & AI text bubbles completely disabled)
		if (isSceneWireframeMode) {
			lastShutterTimestamp = now;
			isCapturing = true;

			try {
				if (shutterBtnEl) {
					gsap.fromTo(shutterBtnEl, { scale: 0.88 }, { scale: 1, duration: 0.3, ease: 'back.out(2)' });
				}

				if (flashEl) {
					gsap.fromTo(
						flashEl,
						{ autoAlpha: 0.85 },
						{ autoAlpha: 0, duration: 0.25, ease: 'power2.out' }
					);
				}

				if (typeof window !== 'undefined' && 'vibrate' in navigator) {
					try { navigator.vibrate(40); } catch (_) {}
				}

				const blob = await captureFrameBlob();
				if (!blob) {
					console.error('Could not capture scene frame');
					return;
				}

				// Immediately freeze the captured frame
				frozenShotUrl = URL.createObjectURL(blob);
				wireframeState = 'processing';

				const result = await sceneWireframeService.generateSceneWireframe(blob);
				if (result.success && result.imageUrl) {
					wireframeResultUrl = result.imageUrl;
					wireframeState = 'revealed';
					chime.playWhiteBoxArrivalChime();
					setTimeout(() => {
						triggerWireframeTransition();
					}, 60);
				} else {
					console.error('Wireframe generation failed:', result.error);
				}
			} finally {
				setTimeout(() => {
					isCapturing = false;
				}, 1500);
			}
			return;
		}

		lastShutterTimestamp = now;
		isCapturing = true;

		try {
			if (shutterBtnEl) {
				gsap.fromTo(shutterBtnEl, { scale: 0.88 }, { scale: 1, duration: 0.3, ease: 'back.out(2)' });
			}

			if (flashEl) {
				gsap.fromTo(
					flashEl,
					{ autoAlpha: 0.8 },
					{ autoAlpha: 0, duration: 0.25, ease: 'power2.out' }
				);
			}

			if (typeof window !== 'undefined' && 'vibrate' in navigator) {
				try {
					navigator.vibrate(40);
				} catch (_) {}
			}

			const blob = await captureFrameBlob();
			if (blob) {
				try {
					await n8nService.analyzeImage(blob);
				} catch (e) {
					console.error('Failed to submit captured photo to n8n:', e);
				}
			} else {
				serverState.currentSuggestion = {
					id: `s-err-${Date.now()}`,
					text: 'Could not capture photo frame. Ensure camera stream is active.',
					confidence: 0,
					category: 'framing',
					timestamp: new Date().toLocaleTimeString()
				};
			}
		} finally {
			// Enforce a strict 2s cooldown so rapid touches never trigger duplicate submissions
			setTimeout(() => {
				isCapturing = false;
			}, 2000);
		}
	}

	onMount(() => {
		initCamera();
		if (serverState.status === 'disconnected') {
			serverState.connect();
		}

		// Pipeline: white box response (with sound chime) -> mic turns on for 5 sec with the sound chime
		serverState.onAiAnalysisReceived = (analysisText: string) => {
			if (analysisText && !isSceneWireframeMode) {
				console.log('[Camera] White box response arrived! Opening 5-second mic listening window in 500ms...');
				setTimeout(() => {
					if (!voiceService.isRecording && !voiceService.isPlaying && !isSceneWireframeMode) {
						voiceService.startHandsFreeListening(5);
					}
				}, 500);
			}
		};

		mediapipeGestureService.onVoiceQueryTrigger = () => {
			if (!isSceneWireframeMode) {
				voiceService.startHandsFreeListening(5);
			}
		};

		if (containerEl) {
			ctx = gsap.context(() => {
				const tl = gsap.timeline({ defaults: { ease: 'power3.out' } });

				tl.from('.top-panel', {
					y: -20,
					opacity: 0.2,
					duration: 0.5,
					clearProps: 'all'
				})
				.from('.shutter-btn', {
					scale: 0.7,
					opacity: 0.2,
					duration: 0.5,
					ease: 'back.out(1.7)',
					clearProps: 'all'
				}, '-=0.3')
				.from('.flip-btn', {
					scale: 0.8,
					opacity: 0.2,
					duration: 0.4,
					clearProps: 'all'
				}, '-=0.3');
			}, containerEl);
		}
	});

	onDestroy(() => {
		ctx?.revert();
		wireframeTimelineCtx?.revert();
		sceneWireframeService.cleanup();
		if (frozenShotUrl) {
			try { URL.revokeObjectURL(frozenShotUrl); } catch (_) {}
		}
		voiceService.stopPlayback();
		voiceService.cancelHandsFreeListening();
		mediapipePoseService.stop();
		mediapipeGestureService.stop();
		if (stream) {
			stream.getTracks().forEach((track) => track.stop());
		}
	});

	$effect(() => {
		const currentText = serverState.currentSuggestion.text;
		if (currentText && suggestionTextEl) {
			gsap.fromTo(
				suggestionTextEl,
				{ y: 6, opacity: 0.4 },
				{ y: 0, opacity: 1, duration: 0.3, ease: 'power2.out', clearProps: 'transform,opacity' }
			);
		}
	});
</script>

<svelte:head>
	<title>Camera - LadduCam</title>
</svelte:head>

<div
	bind:this={containerEl}
	class="relative w-full h-[100dvh] bg-black overflow-hidden flex flex-col justify-between select-none"
>
	<!-- Shutter Flash -->
	<div
		bind:this={flashEl}
		class="absolute inset-0 z-50 bg-white opacity-0 pointer-events-none"
	></div>

	<!-- Camera Stream -->
	<div class="absolute inset-0 z-0 bg-zinc-950 flex items-center justify-center overflow-hidden">
		{#if cameraLoading}
			<div class="flex flex-col items-center gap-2 text-muted-foreground">
				<RefreshCw class="size-6 animate-spin" />
				<p class="text-xs">Initializing camera feed...</p>
			</div>
		{:else if cameraError}
			<div class="flex flex-col items-center justify-center p-6 text-center max-w-xs space-y-3">
				<div class="size-12 rounded-xl bg-muted flex items-center justify-center text-muted-foreground">
					<CameraIcon class="size-6" />
				</div>
				<div class="space-y-1">
					<h3 class="text-sm font-semibold text-foreground">Camera Unavailable</h3>
					<p class="text-xs text-muted-foreground">{cameraError}</p>
				</div>
				<Button size="sm" variant="outline" onclick={initCamera} class="text-xs">
					Retry
				</Button>
			</div>
		{/if}

		<video
			bind:this={videoElement}
			playsinline
			autoplay
			muted
			class="w-full h-full object-cover {facingMode === 'user' ? '-scale-x-100' : ''} {cameraLoading || cameraError ? 'opacity-0' : 'opacity-100'} transition-opacity duration-200"
		></video>

		<!-- Empty Scene Wireframe Scope: Frozen Shot & Wireframe Image (Exact Same Aspect Ratio) -->
		{#if wireframeState !== 'idle' && frozenShotUrl}
			<div
				bind:this={wireframeScopeEl}
				class="absolute inset-0 z-10 overflow-hidden flex items-center justify-center pointer-events-none"
			>
				<!-- Frozen Captured Background Image -->
				{#if frozenShotUrl}
					<img
						bind:this={frozenImgEl}
						src={frozenShotUrl}
						alt="Captured empty background"
						class="absolute inset-0 w-full h-full object-cover will-change-transform"
					/>
				{/if}

				<!-- Holographic Scanning Beam Effect -->
				<div
					bind:this={scanBeamEl}
					class="absolute inset-x-0 h-28 bg-gradient-to-b from-transparent via-white/20 to-transparent pointer-events-none z-20 will-change-transform opacity-0"
				>
					<div class="h-px w-full bg-white/60 shadow-[0_0_8px_rgba(255,255,255,0.8)]"></div>
				</div>

				<!-- AI Wireframe Skeleton Recommendation Image -->
				{#if wireframeResultUrl}
					<img
						bind:this={wireframeImgEl}
						src={wireframeResultUrl}
						alt="AI pose wireframe suggestion"
						class="absolute inset-0 w-full h-full object-cover z-15 opacity-0 will-change-transform"
					/>
				{/if}
			</div>
		{/if}

		<!-- Empty Scene Viewfinder HUD Framing Guides -->
		{#if isSceneWireframeMode && wireframeState === 'idle'}
			<div class="absolute inset-0 z-10 pointer-events-none p-6 flex flex-col justify-between transition-opacity duration-300">
				<!-- Corner ticks -->
				<div class="flex justify-between w-full">
					<div class="size-5 border-t border-l border-white/40 rounded-tl-xs"></div>
					<div class="size-5 border-t border-r border-white/40 rounded-tr-xs"></div>
				</div>
				<div class="flex justify-between w-full mb-24">
					<div class="size-5 border-b border-l border-white/40 rounded-bl-xs"></div>
					<div class="size-5 border-b border-r border-white/40 rounded-br-xs"></div>
				</div>
			</div>
		{/if}
	</div>

	<!-- Top Panel: Back Button, Toolbar & Empty Scene Wireframe Toggle -->
	<header class="top-panel relative z-20 safe-top px-4 pt-3 space-y-2">
		<div class="flex items-center justify-between">
			<!-- Back Navigation Button -->
			<a
				href="/"
				class="size-8 rounded-md bg-black border border-zinc-800 shadow-xs text-white hover:bg-zinc-900 active:bg-zinc-900 flex items-center justify-center transition-colors"
				aria-label="Back"
			>
				<ArrowLeft class="size-4" />
			</a>

			<!-- Right Action Controls -->
			<div class="flex items-center gap-1.5">
				<!-- Hands-Free Gesture Shutter & Timer Controls (Shadcn Segmented Toolbar) -->
				{#if !isSceneWireframeMode}
					<div class="inline-flex items-center gap-1 rounded-lg border border-zinc-800 bg-black p-0.5 shadow-xs transition-opacity duration-200">
						<!-- Hands-Free Toggle Button -->
						<button
							type="button"
							onclick={() => mediapipeGestureService.toggleEnabled()}
							class="h-7 px-2.5 rounded-md text-xs font-medium gap-1.5 flex items-center transition-colors {mediapipeGestureService.isEnabled ? 'bg-zinc-800 text-white' : 'text-zinc-400 hover:text-white hover:bg-zinc-900'}"
							aria-label="Toggle Gesture Shutter"
						>
							<Hand class="size-3.5 shrink-0" />
							<span class="tracking-tight font-sans">Hands-Free</span>
							<span
								class="size-1.5 rounded-full {mediapipeGestureService.isEnabled ? 'bg-emerald-500 ring-2 ring-emerald-500/20' : 'bg-zinc-600'}"
							></span>
						</button>

						<div class="h-3.5 w-px bg-zinc-800"></div>

						<!-- Countdown Timer Toggle Button -->
						<button
							type="button"
							onclick={() => mediapipeGestureService.toggleTimer()}
							class="h-7 px-2 rounded-md font-mono text-xs gap-1 flex items-center transition-colors {mediapipeGestureService.timerDuration > 0 ? 'bg-zinc-800 text-white' : 'text-zinc-400 hover:text-white hover:bg-zinc-900'}"
							aria-label="Toggle Countdown Timer"
						>
							<Timer class="size-3.5 shrink-0" />
							<span class="tabular-nums font-semibold">
								{mediapipeGestureService.timerDuration > 0 ? `${mediapipeGestureService.timerDuration}s` : 'Off'}
							</span>
						</button>
					</div>
				{/if}

				<!-- Scene Pose Mode Toggle Button (Clean Icon Button) -->
				<button
					type="button"
					onclick={toggleSceneWireframeMode}
					class="size-8 rounded-md flex items-center justify-center transition-colors {isSceneWireframeMode ? 'bg-zinc-800 text-white border border-zinc-700' : 'bg-black text-zinc-300 border border-zinc-800 hover:bg-zinc-900 hover:text-white'} shadow-xs"
					aria-label="Toggle Scene Pose Mode"
					title="Scene Pose Mode"
				>
					<ScanLine class="size-4" />
				</button>
			</div>
		</div>

		<!-- Server Suggestion Box (Disabled in Scene Pose Mode) -->
		{#if !isSceneWireframeMode}
			<div class="w-full rounded-lg bg-zinc-950 border border-zinc-800 p-3 shadow-xs">
				<div class="flex items-center justify-between mb-1">
					<span class="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-1.5 font-sans">
						{#if n8nService.isAnalyzing}
							<RefreshCw class="size-3 animate-spin text-primary" />
							<span class="text-primary font-medium">Analyzing...</span>
						{:else}
							<span>AI Suggestion</span>
						{/if}
					</span>
					{#if serverState.isConnected}
						<span class="text-[11px] font-mono tabular-nums text-muted-foreground">
							{serverState.latency}ms
						</span>
					{/if}
				</div>
				<p bind:this={suggestionTextEl} class="text-sm font-normal leading-relaxed text-card-foreground max-h-36 overflow-y-auto pr-1">
					{serverState.currentSuggestion.text}
				</p>
			</div>
		{/if}
	</header>

	<!-- Gesture Status Callout Card (Shadcn Notification) -->
	{#if mediapipeGestureService.isEnabled && (mediapipeGestureService.gesturePhase === 'hand_raised' || mediapipeGestureService.gesturePhase === 'fist_clamped')}
		<div class="absolute top-44 left-1/2 -translate-x-1/2 z-30 pointer-events-none">
			<div
				class="flex items-center gap-2.5 rounded-lg border border-border/80 bg-background/95 px-3 py-1.5 shadow-md backdrop-blur-md text-foreground transition-all duration-200 animate-in fade-in slide-in-from-top-1"
			>
				{#if mediapipeGestureService.gesturePhase === 'hand_raised'}
					<span class="relative flex size-2 shrink-0">
						<span class="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-500 opacity-75"></span>
						<span class="relative inline-flex size-2 rounded-full bg-emerald-500"></span>
					</span>
					<div class="flex items-center gap-1.5 text-xs">
						<span class="font-mono text-[10px] uppercase font-semibold text-muted-foreground tracking-wider">Hand Detected</span>
						<span class="text-border">·</span>
						<span class="font-medium text-foreground">Clench fist to snap</span>
					</div>
				{:else if mediapipeGestureService.gesturePhase === 'fist_clamped'}
					<span class="relative flex size-2 shrink-0">
						<span class="relative inline-flex size-2 rounded-full bg-primary"></span>
					</span>
					<div class="flex items-center gap-1.5 text-xs">
						<span class="font-mono text-[10px] uppercase font-semibold text-primary tracking-wider">Fist Clenched</span>
						<span class="text-border">·</span>
						<span class="font-medium text-foreground">Capturing photo</span>
					</div>
				{/if}
			</div>
		</div>
	{/if}

	<!-- Fullscreen Countdown Overlay (Shadcn Typography & Aesthetics) -->
	{#if mediapipeGestureService.gesturePhase === 'counting_down'}
		<div class="absolute inset-0 z-40 flex flex-col items-center justify-center bg-background/60 backdrop-blur-xs animate-in fade-in duration-150">
			<div class="rounded-xl border border-border/80 bg-card/95 backdrop-blur-md p-6 shadow-2xl flex flex-col items-center gap-4 text-center max-w-[240px] w-full animate-in zoom-in-95 fade-in duration-200">
				<div class="flex items-center gap-1.5 text-[11px] font-mono font-medium uppercase tracking-wider text-muted-foreground">
					<CameraIcon class="size-3.5" />
					<span>Hands-Free</span>
				</div>

				<div class="py-1">
					<span class="text-7xl font-mono font-bold tracking-tighter text-foreground tabular-nums select-none leading-none">
						{mediapipeGestureService.countdownRemaining}
					</span>
				</div>

				<div class="w-full space-y-2">
					<div class="flex items-center justify-between text-[11px] text-muted-foreground font-mono">
						<span>Pose ready</span>
						<span>{mediapipeGestureService.countdownRemaining}s</span>
					</div>
					<!-- Minimal Progress Indicator -->
					<div class="h-1 w-full overflow-hidden rounded-xs bg-muted">
						<div
							class="h-full bg-primary transition-all duration-300 ease-out"
							style="width: {((mediapipeGestureService.countdownRemaining) / (mediapipeGestureService.timerDuration || 3)) * 100}%"
						></div>
					</div>
				</div>

				<Button
					variant="outline"
					size="sm"
					onclick={() => mediapipeGestureService.cancel()}
					class="w-full h-7 rounded-md text-xs font-medium border-border/80 text-muted-foreground hover:text-foreground"
				>
					Cancel
				</Button>
			</div>
		</div>
	{/if}

	<!-- Bottom Panel: Shutter, Mic & Camera Switch -->
	<footer class="relative z-20 safe-bottom px-6 pb-6 flex flex-col items-center gap-3">
		<!-- Floating Voice Status (Hidden in Scene Pose Mode) -->
		{#if !isSceneWireframeMode}
			{#if voiceService.isAutoListening}
				<div
					class="flex items-center gap-2.5 px-3 py-1.5 rounded-lg bg-background/95 backdrop-blur-md border border-border/80 shadow-lg text-foreground transition-all animate-in fade-in slide-in-from-bottom-2"
				>
					<span class="relative flex size-2 shrink-0">
						<span class="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-500 opacity-75"></span>
						<span class="relative inline-flex rounded-full size-2 bg-emerald-500"></span>
					</span>
					<div class="flex items-center gap-2 text-xs">
						<span class="font-mono text-[10px] uppercase font-semibold text-emerald-500 tracking-wider">Listening</span>
						<span class="text-border">·</span>
						<span class="font-medium text-foreground">"Hey photo nallathano?"</span>
						<span class="text-border">·</span>
						<span class="font-mono text-[11px] tabular-nums text-muted-foreground">{voiceService.autoListenRemaining}s</span>
					</div>
				</div>
			{:else if voiceService.isPlaying}
				<div
					class="flex items-center gap-2.5 px-3 py-1.5 rounded-lg bg-background/95 backdrop-blur-md border border-border/80 shadow-md text-foreground transition-all animate-in fade-in slide-in-from-bottom-2"
				>
					<Volume2 class="size-3.5 text-primary animate-pulse shrink-0" />
					<div class="flex items-center gap-1.5 text-xs">
						<span class="font-mono text-[10px] uppercase font-semibold text-primary tracking-wider">Responding</span>
						<span class="text-border">·</span>
						<span class="font-medium text-foreground">Malayalam voice advice</span>
					</div>
				</div>
			{:else if voiceService.isProcessing}
				<div
					class="flex items-center gap-2.5 px-3 py-1.5 rounded-lg bg-background/95 backdrop-blur-md border border-border/80 shadow-md text-foreground transition-all animate-in fade-in slide-in-from-bottom-2"
				>
					<Loader2 class="size-3.5 text-primary animate-spin shrink-0" />
					<span class="text-xs font-medium text-foreground">{voiceService.statusMessage}</span>
				</div>
			{:else if voiceService.isRecording}
				<div
					class="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-background/95 backdrop-blur-md border border-destructive/40 shadow-md text-destructive transition-all animate-in fade-in slide-in-from-bottom-2"
				>
					<span class="relative flex size-2 shrink-0">
						<span class="animate-ping absolute inline-flex h-full w-full rounded-full bg-destructive opacity-75"></span>
						<span class="relative inline-flex rounded-full size-2 bg-destructive"></span>
					</span>
					<span class="text-xs font-semibold uppercase tracking-wider font-mono">
						Recording {voiceService.formattedDuration}
					</span>
					<span class="text-[11px] text-muted-foreground font-normal">(Release to send)</span>
				</div>
			{:else if voiceService.state === 'error'}
				<div
					class="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-background/95 backdrop-blur-md border border-destructive/40 shadow-md transition-all animate-in fade-in slide-in-from-bottom-2"
				>
					<span class="text-xs font-medium text-destructive">
						{voiceService.statusMessage}
					</span>
				</div>
			{/if}
		{/if}

		<!-- Persistent Whiter AI Analysis Bubble (Hidden in Scene Pose Mode) -->
		{#if !isSceneWireframeMode && serverState.aiAnalysis && serverState.aiAnalysis.visible}
			<div
				class="w-full rounded-2xl bg-white text-zinc-950 border border-zinc-200 shadow-2xl p-4 transition-all duration-300 animate-in fade-in slide-in-from-bottom-3 backdrop-blur-md dark:bg-zinc-100 dark:text-zinc-900 dark:border-zinc-300 select-text"
			>
				<div class="flex items-center justify-between pb-1.5 border-b border-zinc-200/80 mb-2">
					<div class="flex items-center gap-1.5">
						<Sparkles class="size-3.5 text-amber-500 fill-amber-500/20" />
						<span class="text-xs font-bold uppercase tracking-wider text-zinc-800 font-mono">
							AI Composition Advice
						</span>
					</div>
					<div class="flex items-center gap-2">
						<span class="text-[10px] text-zinc-500 font-mono">
							{serverState.aiAnalysis.timestamp}
						</span>
						<button
							type="button"
							onclick={() => serverState.dismissAiAnalysis()}
							class="size-6 rounded-md hover:bg-zinc-200/80 active:scale-95 flex items-center justify-center text-zinc-500 hover:text-zinc-900 transition-colors"
							aria-label="Close AI advice"
						>
							<X class="size-3.5" />
						</button>
					</div>
				</div>
				<p class="text-xs sm:text-sm font-medium leading-relaxed text-zinc-900 max-h-48 overflow-y-auto pr-1">
					{serverState.aiAnalysis.text}
				</p>
			</div>
		{/if}

		<!-- Post-Generation Wireframe Action Card (Revealed state - Strict Shadcn Typography & Layout) -->
		{#if wireframeState === 'revealed'}
			<div
				bind:this={wireframeCardEl}
				class="w-full max-w-sm rounded-xl border border-zinc-800 bg-zinc-950 p-4 shadow-lg text-zinc-100 space-y-3 pointer-events-auto"
			>
				<div class="flex items-center justify-between pb-2 border-b border-zinc-800">
					<div class="flex items-center gap-2">
						<ScanLine class="size-4 text-zinc-100" />
						<span class="text-xs font-semibold tracking-tight text-zinc-100 font-sans">
							Pose Recommendation
						</span>
					</div>
					<span class="inline-flex items-center rounded-md border border-zinc-800 bg-zinc-900 px-2 py-0.5 font-mono text-[10px] font-medium text-zinc-400">
						Wireframe Ready
					</span>
				</div>

				<p class="text-xs text-zinc-400 leading-relaxed font-sans">
					Aesthetic pose skeleton plotted for this scene. Position yourself or your subject matching the guide.
				</p>

				<div class="grid grid-cols-2 gap-2 pt-1">
					<button
						type="button"
						onclick={() => resetWireframeMode(true)}
						class="h-8 rounded-md text-xs font-medium gap-1.5 bg-zinc-900 border border-zinc-700 text-white hover:bg-zinc-800 flex items-center justify-center shadow-xs"
					>
						<RotateCcw class="size-3.5" />
						<span>Retake</span>
					</button>

					<button
						type="button"
						onclick={() => resetWireframeMode(false)}
						class="h-8 rounded-md text-xs font-medium gap-1.5 shadow-xs bg-white text-black hover:bg-zinc-200 flex items-center justify-center"
					>
						<Check class="size-3.5" />
						<span>Back to Camera</span>
					</button>
				</div>
			</div>
		{:else if wireframeState === 'processing'}
			<div
				class="w-full max-w-xs rounded-lg border border-zinc-800 bg-zinc-950 p-3.5 shadow-md text-zinc-100 flex items-center gap-3 animate-in fade-in slide-in-from-bottom-2"
			>
				<Loader2 class="size-4 animate-spin text-zinc-400 shrink-0" />
				<div class="space-y-0.5">
					<p class="text-xs font-semibold leading-none tracking-tight text-zinc-100 font-sans">Analyzing Scene</p>
					<p class="text-[11px] text-zinc-400 leading-normal">Generating recommended pose wireframe...</p>
				</div>
			</div>
		{:else}
			<div class="w-full flex items-center justify-between">
				<!-- Mic Button (Disabled & Hidden in Scene Pose mode) -->
				{#if !isSceneWireframeMode}
					<div class="relative size-12 shrink-0 flex items-center justify-center">
						{#if voiceService.isRecording}
							<span class="absolute inset-0 rounded-lg bg-destructive/30 animate-ping"></span>
						{/if}
						<button
							type="button"
							aria-label="Hold to record voice note"
							onpointerdown={(e) => {
								try { e.currentTarget.setPointerCapture(e.pointerId); } catch (_) {}
								voiceService.startRecording();
							}}
							onpointerup={(e) => {
								try { e.currentTarget.releasePointerCapture(e.pointerId); } catch (_) {}
								voiceService.stopRecordingAndSend();
							}}
							onpointercancel={(e) => {
								try { e.currentTarget.releasePointerCapture(e.pointerId); } catch (_) {}
								voiceService.stopRecordingAndSend();
							}}
							class="mic-btn size-11 shrink-0 rounded-lg border border-zinc-800 flex items-center justify-center select-none touch-none focus:outline-none transition-all active:scale-95 {voiceService.isRecording ? 'bg-destructive border-destructive text-white scale-105 shadow-md shadow-destructive/40' : voiceService.isProcessing ? 'bg-amber-950 border-amber-600 text-amber-400' : voiceService.isPlaying ? 'bg-emerald-950 border-emerald-600 text-emerald-400' : 'bg-black text-white shadow-xs hover:bg-zinc-900'}"
						>
							{#if voiceService.isRecording}
								<Mic class="size-5 animate-pulse text-white" />
							{:else if voiceService.isProcessing}
								<Loader2 class="size-5 animate-spin" />
							{:else if voiceService.isPlaying}
								<Volume2 class="size-5 animate-bounce" />
							{:else}
								<Mic class="size-5 text-white" />
							{/if}
						</button>
					</div>
				{:else}
					<div class="size-11 shrink-0"></div>
				{/if}

				<!-- Shutter Button (Clean Shadcn Styling) -->
				<button
					bind:this={shutterBtnEl}
					onclick={handleShutter}
					disabled={isCapturing || n8nService.isAnalyzing || sceneWireframeService.isGenerating}
					class="shutter-btn size-18 rounded-full border-4 border-white p-1 flex items-center justify-center active:scale-95 transition-all focus:outline-none {isCapturing || n8nService.isAnalyzing || sceneWireframeService.isGenerating ? 'opacity-50 pointer-events-none' : ''}"
					aria-label="Shutter"
				>
					<span class="size-full rounded-full bg-white active:bg-zinc-200 flex items-center justify-center transition-colors">
						{#if isCapturing || n8nService.isAnalyzing || sceneWireframeService.isGenerating}
							<Loader2 class="size-6 animate-spin text-zinc-900" />
						{:else if isSceneWireframeMode}
							<ScanLine class="size-5 text-zinc-900" />
						{/if}
					</span>
				</button>

				<!-- Flip Camera Button -->
				<button
					type="button"
					bind:this={flipBtnEl}
					onclick={toggleCameraFacing}
					class="flip-btn size-11 rounded-lg bg-black border border-zinc-800 shadow-xs text-white hover:bg-zinc-900 active:scale-95 flex items-center justify-center transition-all"
					aria-label="Flip Camera"
				>
					<FlipHorizontal class="size-5" />
				</button>
			</div>
		{/if}
	</footer>
</div>
