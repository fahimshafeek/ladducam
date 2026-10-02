<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import { gsap } from 'gsap';
	import { greetings } from '$lib/greetings.js';
	import { serverState } from '$lib/server-state.svelte.js';
	import { Button, buttonVariants } from '$lib/components/ui/button/index.js';
	import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '$lib/components/ui/card/index.js';
	import { Input } from '$lib/components/ui/input/index.js';
	import logo from '$lib/assets/logo.png';

	let containerEl = $state<HTMLElement | null>(null);
	let greetingEl = $state<HTMLElement | null>(null);
	let selectedGreeting = $state('');
	let ctx: gsap.Context | null = null;

	onMount(() => {
		const randomIndex = Math.floor(Math.random() * greetings.length);
		selectedGreeting = greetings[randomIndex];

		if (containerEl) {
			ctx = gsap.context(() => {
				const tl = gsap.timeline({ defaults: { ease: 'power2.out' } });

				tl.from('.header-logo', {
					scale: 0.8,
					autoAlpha: 0,
					duration: 0.5,
					ease: 'back.out(1.5)'
				})
				.from('.greeting-box', {
					y: 20,
					autoAlpha: 0,
					duration: 0.5
				}, '-=0.2')
				.from('.status-card', {
					y: 25,
					autoAlpha: 0,
					duration: 0.55
				}, '-=0.3')
				.from('.camera-btn', {
					y: 15,
					autoAlpha: 0,
					duration: 0.45
				}, '-=0.2');
			}, containerEl);
		}
	});

	onDestroy(() => {
		ctx?.revert();
	});

	$effect(() => {
		if (selectedGreeting && greetingEl) {
			gsap.fromTo(
				greetingEl,
				{ y: 10, autoAlpha: 0 },
				{ y: 0, autoAlpha: 1, duration: 0.4, ease: 'power2.out' }
			);
		}
	});
</script>

<svelte:head>
	<title>PoseCam</title>
</svelte:head>

<div
	bind:this={containerEl}
	class="flex flex-col min-h-[100dvh] max-w-md mx-auto w-full px-6 pt-safe-top pb-safe-bottom safe-top safe-bottom"
>
	<!-- Header Bar -->
	<header class="header-logo pt-6 pb-2 flex items-center justify-start">
		<img src={logo} alt="Laddu Lens" class="size-16 rounded-2xl object-contain shadow-sm" />
	</header>

	<main class="flex-1 flex flex-col justify-between py-2 space-y-6">
		<div class="space-y-6">
			<!-- Prominent Greeting Message -->
			{#if selectedGreeting}
				<div bind:this={greetingEl} class="greeting-box space-y-1.5 pt-2">
					<h1 class="scroll-m-20 text-3xl font-extrabold tracking-tight text-foreground">
						{selectedGreeting}
					</h1>
					<p class="text-sm text-muted-foreground">
						Local compute camera assistant
					</p>
				</div>
			{/if}

			<!-- Network Status Card -->
			<div class="status-card">
				<Card>
					<CardHeader class="pb-3">
						<div class="flex items-center justify-between">
							<CardTitle class="text-base font-semibold">Local Server</CardTitle>
							{#if serverState.isConnected && serverState.latency}
								<span class="font-mono text-xs text-muted-foreground">
									{serverState.latency} ms
								</span>
							{/if}
						</div>
						<CardDescription>
							Connect to your local wireless compute node.
						</CardDescription>
					</CardHeader>
					<CardContent class="space-y-4">
						<div class="grid grid-cols-3 gap-3">
							<div class="col-span-2 space-y-1.5">
								<label for="server-ip" class="text-sm font-medium leading-none">
									Server IP
								</label>
								<Input
									id="server-ip"
									bind:value={serverState.ip}
									placeholder="192.168.1.105"
									disabled={serverState.isConnected}
									class="font-mono text-xs"
								/>
							</div>
							<div class="col-span-1 space-y-1.5">
								<label for="server-port" class="text-sm font-medium leading-none">
									Port
								</label>
								<Input
									id="server-port"
									bind:value={serverState.port}
									placeholder="8080"
									disabled={serverState.isConnected}
									class="font-mono text-xs"
								/>
							</div>
						</div>

						<div class="space-y-1.5 pt-1">
							<div class="flex items-center gap-2">
								<span class="size-2 rounded-full shrink-0 {serverState.isConnected ? 'bg-emerald-500 animate-pulse' : serverState.status === 'connecting' ? 'bg-amber-500 animate-pulse' : serverState.status === 'error' ? 'bg-destructive' : 'bg-muted-foreground/40'}"></span>
								<p class="text-xs font-semibold tracking-tight text-foreground">
									{#if serverState.status === 'connected'}
										Connected
									{:else if serverState.status === 'connecting'}
										Connecting...
									{:else if serverState.status === 'error'}
										Connection Failed
									{:else}
										Disconnected
									{/if}
								</p>
							</div>
							<p class="text-xs text-muted-foreground font-mono leading-relaxed">
								{serverState.statusMessage}
							</p>
						</div>

						<div class="flex items-center gap-2 pt-1">
							{#if !serverState.isConnected}
								<Button
									onclick={() => serverState.connect()}
									disabled={serverState.status === 'connecting'}
									class="w-full active:scale-[0.98] transition-transform"
								>
									{serverState.status === 'connecting' ? 'Connecting...' : 'Connect to Server'}
								</Button>
							{:else}
								<Button
									variant="outline"
									onclick={() => serverState.disconnect()}
									class="flex-1 active:scale-[0.98] transition-transform"
								>
									Disconnect
								</Button>
								<Button
									variant="secondary"
									onclick={() => serverState.ping()}
									class="flex-1 active:scale-[0.98] transition-transform"
								>
									Ping
								</Button>
							{/if}
						</div>
					</CardContent>
				</Card>
			</div>
		</div>

		<!-- Open Camera Window Action -->
		<div class="camera-btn pt-4 pb-2">
			<a
				href="/camera"
				class={buttonVariants({ size: 'lg', class: 'w-full text-base font-semibold active:scale-[0.98] transition-transform' })}
			>
				Open Camera
			</a>
		</div>
	</main>
</div>
