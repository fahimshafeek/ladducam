<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import { gsap } from 'gsap';
	import { serverState } from '$lib/server-state.svelte.js';
	import { Button } from '$lib/components/ui/button/index.js';

	import ArrowLeft from '@lucide/svelte/icons/arrow-left';
	import FlipHorizontal from '@lucide/svelte/icons/flip-horizontal';
	import CameraIcon from '@lucide/svelte/icons/camera';
	import RefreshCw from '@lucide/svelte/icons/refresh-cw';

	let containerEl = $state<HTMLElement | null>(null);
	let videoElement = $state<HTMLVideoElement | null>(null);
	let shutterBtnEl = $state<HTMLButtonElement | null>(null);
	let flipBtnEl = $state<HTMLButtonElement | null>(null);
	let flashEl = $state<HTMLDivElement | null>(null);
	let suggestionTextEl = $state<HTMLParagraphElement | null>(null);

	let stream = $state<MediaStream | null>(null);
	let facingMode = $state<'user' | 'environment'>('user');
	let cameraLoading = $state(true);
	let cameraError = $state<string | null>(null);
	let ctx: gsap.Context | null = null;

	async function initCamera() {
		cameraLoading = true;
		cameraError = null;

		if (stream) {
			stream.getTracks().forEach((track) => track.stop());
			stream = null;
		}

		try {
			if (navigator?.mediaDevices?.getUserMedia) {
				const mediaStream = await navigator.mediaDevices.getUserMedia({
					video: {
						facingMode: facingMode,
						width: { ideal: 1920 },
						height: { ideal: 1080 }
					},
					audio: false
				});

				stream = mediaStream;
				if (videoElement) {
					videoElement.srcObject = mediaStream;
					await videoElement.play().catch(() => {});
				}
				cameraLoading = false;
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

	function handleShutter() {
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
	}

	onMount(() => {
		initCamera();
		if (serverState.status === 'disconnected') {
			serverState.connect();
		}

		if (containerEl) {
			ctx = gsap.context(() => {
				const tl = gsap.timeline({ defaults: { ease: 'power3.out' } });

				tl.from('.top-panel', {
					y: -30,
					autoAlpha: 0,
					duration: 0.6
				})
				.from('.shutter-btn', {
					scale: 0.7,
					autoAlpha: 0,
					duration: 0.5,
					ease: 'back.out(1.7)'
				}, '-=0.3')
				.from('.flip-btn', {
					scale: 0.8,
					autoAlpha: 0,
					duration: 0.4
				}, '-=0.3');
			}, containerEl);
		}
	});

	onDestroy(() => {
		ctx?.revert();
		if (stream) {
			stream.getTracks().forEach((track) => track.stop());
		}
	});

	$effect(() => {
		const currentText = serverState.currentSuggestion.text;
		if (currentText && suggestionTextEl) {
			gsap.fromTo(
				suggestionTextEl,
				{ y: 8, autoAlpha: 0 },
				{ y: 0, autoAlpha: 1, duration: 0.35, ease: 'power2.out' }
			);
		}
	});
</script>

<svelte:head>
	<title>Camera - PoseCam</title>
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
				<div class="size-14 rounded-full bg-muted flex items-center justify-center text-muted-foreground">
					<CameraIcon class="size-7" />
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
			class="w-full h-full object-cover {facingMode === 'user' ? '-scale-x-100' : ''} {cameraLoading || cameraError ? 'hidden' : 'block'}"
		></video>
	</div>

	<!-- Top Panel: Back Button & Server Suggestion Text -->
	<header class="top-panel relative z-20 safe-top px-4 pt-3 space-y-2">
		<div class="flex items-center justify-start">
			<a
				href="/"
				class="size-9 rounded-full bg-background/80 backdrop-blur border border-border flex items-center justify-center text-foreground hover:bg-muted transition-colors"
				aria-label="Back"
			>
				<ArrowLeft class="size-4" />
			</a>
		</div>

		<!-- Server Suggestion Box -->
		<div class="w-full rounded-xl bg-background/85 backdrop-blur-md border border-border p-3.5 shadow-lg">
			<div class="flex items-center justify-between mb-1">
				<span class="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
					Suggestion
				</span>
				{#if serverState.isConnected}
					<span class="text-[11px] font-mono text-muted-foreground">
						{serverState.latency} ms
					</span>
				{/if}
			</div>
			<p bind:this={suggestionTextEl} class="text-sm font-medium leading-relaxed text-foreground">
				{serverState.currentSuggestion.text}
			</p>
		</div>
	</header>

	<!-- Bottom Panel: Shutter & Camera Switch -->
	<footer class="relative z-20 safe-bottom px-8 pb-6 flex items-center justify-between">
		<div class="size-11"></div>

		<!-- Simple Shutter Button -->
		<button
			bind:this={shutterBtnEl}
			onclick={handleShutter}
			class="shutter-btn size-18 rounded-full border-4 border-white p-1 flex items-center justify-center active:scale-95 transition-transform focus:outline-none"
			aria-label="Shutter"
		>
			<span class="size-full rounded-full bg-white active:bg-zinc-200"></span>
		</button>

		<!-- Flip Camera -->
		<button
			bind:this={flipBtnEl}
			onclick={toggleCameraFacing}
			class="flip-btn size-11 rounded-full bg-background/80 backdrop-blur border border-border flex items-center justify-center text-foreground active:scale-95 transition-transform"
			aria-label="Flip Camera"
		>
			<FlipHorizontal class="size-5" />
		</button>
	</footer>
</div>
