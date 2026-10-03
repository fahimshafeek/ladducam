<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import { gsap } from 'gsap';
	import { serverStore } from '$lib/desktop-server.svelte.js';
	import { Button } from '$lib/components/ui/button/index.js';
	import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '$lib/components/ui/card/index.js';
	import { Input } from '$lib/components/ui/input/index.js';
	import logo from '$lib/assets/logo.png';

	import Copy from '@lucide/svelte/icons/copy';
	import Check from '@lucide/svelte/icons/check';
	import Power from '@lucide/svelte/icons/power';

	let containerEl = $state<HTMLElement | null>(null);
	let statusHeadingEl = $state<HTMLHeadingElement | null>(null);
	let copied = $state(false);
	let ctx: gsap.Context | null = null;

	function copyUrl() {
		if (typeof navigator !== 'undefined' && navigator.clipboard) {
			navigator.clipboard.writeText(serverStore.fullUrl);
			copied = true;
			setTimeout(() => {
				copied = false;
			}, 2000);
		}
	}

	onMount(() => {
		if (containerEl) {
			ctx = gsap.context(() => {
				const tl = gsap.timeline({ defaults: { ease: 'power2.out' } });

				tl.from('.header-brand', {
					x: -20,
					autoAlpha: 0,
					duration: 0.5
				})
				.from('.header-status', {
					x: 20,
					autoAlpha: 0,
					duration: 0.5
				}, '-=0.4')
				.from('.main-card', {
					y: 25,
					autoAlpha: 0,
					duration: 0.55,
					stagger: 0.15
				}, '-=0.2');
			}, containerEl);
		}
	});

	onDestroy(() => {
		ctx?.revert();
	});

	$effect(() => {
		const stateKey = `${serverStore.isServerRunning}-${serverStore.isClientConnected}`;
		if (stateKey && statusHeadingEl) {
			gsap.fromTo(
				statusHeadingEl,
				{ y: -10, autoAlpha: 0 },
				{ y: 0, autoAlpha: 1, duration: 0.35, ease: 'power2.out' }
			);
		}
	});
</script>

<svelte:head>
	<title>LadduCam Desktop Server</title>
</svelte:head>

<div
	bind:this={containerEl}
	class="min-h-screen max-w-4xl mx-auto p-6 md:p-10 flex flex-col justify-between space-y-8"
>
	<!-- Top Navigation / Header -->
	<header class="flex items-center justify-between border-b border-border/60 pb-5">
		<div class="header-brand flex items-center gap-4">
			<img src={logo} alt="Laddu Lens" class="size-14 rounded-2xl object-contain shadow-sm" />
			<div>
				<h1 class="scroll-m-20 text-2xl font-bold tracking-tight text-foreground">
					LadduCam Server
				</h1>
				<p class="text-sm text-muted-foreground">
					Local compute node for LadduCam Mobile
				</p>
			</div>
		</div>

		<div class="header-status text-right">
			<p class="text-sm font-semibold tracking-tight text-foreground">
				{#if !serverStore.isServerRunning}
					Server stopped
				{:else if serverStore.isClientConnected}
					Phone connected
				{:else}
					Listening on port {serverStore.port}
				{/if}
			</p>
			<p class="text-xs text-muted-foreground font-mono mt-0.5">
				{#if !serverStore.isServerRunning}
					offline
				{:else if serverStore.isClientConnected}
					{serverStore.clientDeviceName}
				{:else}
					ws://{serverStore.ip}:{serverStore.port}
				{/if}
			</p>
		</div>
	</header>

	<!-- Main Workspace -->
	<main class="grid grid-cols-1 md:grid-cols-2 gap-6 flex-1">
		<!-- Left Column: Server Status & IP Address -->
		<div class="main-card space-y-6">
			<Card>
				<CardHeader class="pb-3">
					<CardTitle class="text-base font-semibold">Network Configuration</CardTitle>
					<CardDescription>
						Local wireless interface for mobile camera streaming.
					</CardDescription>
				</CardHeader>
				<CardContent class="space-y-4">
					<!-- IP & Port Inputs -->
					<div class="grid grid-cols-3 gap-3">
						<div class="col-span-2 space-y-1.5">
							<label for="server-ip" class="text-sm font-medium leading-none">
								Workstation IP
							</label>
							<Input
								id="server-ip"
								bind:value={serverStore.ip}
								placeholder="192.168.1.105"
								disabled={serverStore.isServerRunning}
								class="font-mono text-xs"
							/>
						</div>
						<div class="col-span-1 space-y-1.5">
							<label for="server-port" class="text-sm font-medium leading-none">
								Port
							</label>
							<Input
								id="server-port"
								bind:value={serverStore.port}
								placeholder="8080"
								disabled={serverStore.isServerRunning}
								class="font-mono text-xs"
							/>
						</div>
					</div>

					<!-- WebSocket Stream Address -->
					<div class="space-y-1.5">
						<span class="text-sm font-medium leading-none">WebSocket Stream URL</span>
						<div class="flex items-center gap-2">
							<Input
								readonly
								value={serverStore.fullUrl}
								class="font-mono text-xs bg-muted/50 select-all"
							/>
							<Button variant="outline" size="sm" onclick={copyUrl} class="px-2.5 shrink-0 active:scale-95 transition-transform">
								{#if copied}
									<Check class="size-3.5 text-emerald-500" />
								{:else}
									<Copy class="size-3.5" />
								{/if}
							</Button>
						</div>
					</div>

					<!-- Server Controls -->
					<div class="pt-2">
						{#if serverStore.isServerRunning}
							<Button
								variant="outline"
								onclick={() => serverStore.stopServer()}
								class="w-full text-xs gap-1.5 active:scale-[0.98] transition-transform"
							>
								<Power class="size-3.5 text-destructive" />
								Stop Server
							</Button>
						{:else}
							<Button
								onclick={() => serverStore.startServer()}
								class="w-full text-xs gap-1.5 active:scale-[0.98] transition-transform"
							>
								<Power class="size-3.5" />
								Start Server
							</Button>
						{/if}
					</div>
				</CardContent>
			</Card>
		</div>

		<!-- Right Column: Simple Connection Status -->
		<div class="main-card space-y-6">
			<Card class="h-full flex flex-col justify-between">
				<CardHeader class="pb-3">
					<CardTitle class="text-base font-semibold">Connection Status</CardTitle>
					<CardDescription>
						Status of the link between this compute host and your phone.
					</CardDescription>
				</CardHeader>

				<CardContent class="space-y-6 flex-1 flex flex-col justify-between">
					<div class="space-y-1">
						<h2 bind:this={statusHeadingEl} class="text-2xl font-semibold tracking-tight text-foreground">
							{#if !serverStore.isServerRunning}
								Offline
							{:else if serverStore.isClientConnected}
								Connected
							{:else}
								Waiting for connection
							{/if}
						</h2>
						<p class="text-sm text-muted-foreground">
							{#if !serverStore.isServerRunning}
								Server is stopped. Start the server to accept connections from LadduCam Mobile.
							{:else if serverStore.isClientConnected}
								Receiving camera stream from {serverStore.clientDeviceName}.
							{:else}
								Connect from the mobile app using ws://{serverStore.ip}:{serverStore.port}
							{/if}
						</p>
					</div>

					<div class="border-t border-border/60 pt-4 space-y-3 text-sm">
						<div class="flex items-center justify-between">
							<span class="text-muted-foreground">Device</span>
							<span class="font-medium text-foreground">
								{serverStore.isClientConnected ? serverStore.clientDeviceName : '—'}
							</span>
						</div>
						<div class="flex items-center justify-between">
							<span class="text-muted-foreground">Client IP</span>
							<span class="font-mono text-xs text-foreground">
								{serverStore.isClientConnected ? serverStore.clientIp : '—'}
							</span>
						</div>
						<div class="flex items-center justify-between">
							<span class="text-muted-foreground">Latency</span>
							<span class="font-mono text-xs text-foreground">
								{serverStore.isClientConnected && serverStore.latency ? `${serverStore.latency} ms` : '—'}
							</span>
						</div>
					</div>
				</CardContent>
			</Card>
		</div>

	</main>
</div>
