<script lang="ts">
	import { page } from '$app/state';
	import { Button } from '$lib/components/ui/button/index.js';
	import AlertCircle from '@lucide/svelte/icons/alert-circle';
	import Home from '@lucide/svelte/icons/home';
	import RefreshCw from '@lucide/svelte/icons/refresh-cw';
</script>

<div class="min-h-[100dvh] w-full bg-zinc-950 text-foreground flex flex-col items-center justify-center p-6 text-center select-none">
	<div class="max-w-md w-full space-y-6 bg-zinc-900/80 border border-zinc-800 rounded-2xl p-6 backdrop-blur shadow-xl">
		<div class="size-16 rounded-full bg-destructive/10 border border-destructive/20 flex items-center justify-center text-destructive mx-auto">
			<AlertCircle class="size-8" />
		</div>

		<div class="space-y-2">
			<h1 class="text-xl font-bold tracking-tight text-white">
				{page.status}: {page.error?.message || 'Unexpected Application State'}
			</h1>
			<p class="text-xs text-muted-foreground leading-relaxed">
				An issue occurred while initializing this screen. Tap below to refresh or return to the main dashboard.
			</p>
		</div>

		<div class="flex items-center justify-center gap-3 pt-2">
			<Button variant="outline" size="sm" onclick={() => window.location.reload()} class="flex items-center gap-1.5 text-xs">
				<RefreshCw class="size-3.5" />
				Reload App
			</Button>

			<Button size="sm" onclick={() => window.location.href = '/'} class="flex items-center gap-1.5 text-xs">
				<Home class="size-3.5" />
				Go Home
			</Button>
		</div>
	</div>
</div>
