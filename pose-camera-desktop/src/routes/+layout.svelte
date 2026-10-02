<script lang="ts">
	import './layout.css';
	import favicon from '$lib/assets/favicon.svg';

	let { children } = $props();
</script>

<svelte:head>
	<link rel="icon" href={favicon} />
</svelte:head>

<div class="dark min-h-screen w-full bg-background text-foreground flex flex-col font-sans select-none antialiased">
	{@render children()}
</div>
