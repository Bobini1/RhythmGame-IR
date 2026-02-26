<script lang="ts">
	import { onMount } from 'svelte';
	export let data: { rt: string | null; appRedirect: string | null };

	let rt: string | null = null;
	const appRedirect = data?.appRedirect || null;
	let error: string | null = null;

	async function createRt() {
		try {
			const res = await fetch('/api/auth/native/create-rt', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ app_redirect: appRedirect })
			});
			if (!res.ok) {
				const body = await res.json().catch(() => ({}));
				error = body?.error || `create-rt failed: ${res.status}`;
				return null;
			}
			const body = await res.json();
			rt = body.rt;
			return rt;
		} catch (e) {
			console.error(e);
			error = String(e instanceof Error ? e.message : e);
			return null;
		}
	}

	function tryPostMessage(token: string) {
		if (window.opener && typeof window.opener.postMessage === 'function') {
			window.opener.postMessage({ type: 'oauth-success', rt: token }, '*');
			tryClose();
			return true;
		}
		return false;
	}

	function trySchemeRedirect(token: string) {
		if (!appRedirect) return false;
		try {
			const url = new URL(appRedirect);
			url.searchParams.set('rt', token);
			window.location.href = url.toString();
			return true;
		} catch (err) {
			console.warn('Could not parse appRedirect as URL, falling back to string concat');
			const separator = appRedirect.includes('?') ? '&' : '?';
			window.location.href = `${appRedirect}${separator}rt=${encodeURIComponent(token)}`;
			return true;
		}
	}

	function tryClose() {
		setTimeout(() => {
			try { window.close(); } catch (err) { console.warn('window.close failed', err); }
		}, 500);
	}

	onMount(async () => {
		const token = await createRt();
		if (!token) return;
		// first, notify opener (in-app webview)
		if (tryPostMessage(token)) return;
		// otherwise, try scheme/universal link
		trySchemeRedirect(token);
	});

	function openApp() {
		if (!rt || !appRedirect) return;
		const separator = appRedirect.includes('?') ? '&' : '?';
		window.location.href = `${appRedirect}${separator}rt=${encodeURIComponent(rt)}`;
	}
</script>

<svelte:head>
	<meta name="referrer" content="no-referrer" />
</svelte:head>

<main>
	<h1>Return to app</h1>
	{#if error}
		<p class="error">{error}</p>
	{:else}
		{#if rt}
			<p>If your app didn't open automatically, tap the button below to return to the app.</p>
			{#if appRedirect}
				<button on:click={openApp}>Open app</button>
			{:else}
				<p>No app redirect configured. Please return to your app and complete the flow.</p>
			{/if}
		{:else}
			<p>Preparing to return to the app…</p>
		{/if}
	{/if}
</main>

<style>
	main { padding: 1rem; font-family: system-ui, sans-serif; }
	.error { color: #c00 }
	button { padding: .5rem 1rem; border-radius: 6px; border: 1px solid #ccc; background: #fff }
</style>
