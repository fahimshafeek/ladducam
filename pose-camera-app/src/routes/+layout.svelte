<script lang="ts">
	import './layout.css';
	import favicon from '$lib/assets/favicon.svg';

	let { children } = $props();
</script>

<svelte:head>
	<link rel="icon" href={favicon} />
</svelte:head>

<div class="dark min-h-[100dvh] w-full bg-zinc-950 text-zinc-100 flex flex-col font-sans select-none antialiased overflow-x-hidden">
	{@render children()}
</div>
