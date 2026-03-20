<script lang="ts">
	interface Props {
		status?: {
			id: number;
			user?: string;
		};
		onDisconnect?: () => void;
		onStartConnect?: () => void;
	}

	let {
		status, onDisconnect = () => {}, onStartConnect = () => {}
	}: Props = $props();

	const user = $derived(status?.user);
	const id = $derived(status?.id);

	// derived helper for whether parent provided a session user (undefined = not provided)
	const hasSession = $derived(user === undefined ? undefined : !!user);
</script>

<!-- Use neutral container background to match other settings cards; connected state gets a subtle success tint -->
<div class={
  `rounded-lg border p-4 transition-colors duration-150 border-border ${
    id
      ? 'bg-success/20 text-success-foreground border-success-600 ring-1 ring-success/20'
      : 'bg-transparent text-muted-foreground border-border'
  }`
}>
	<div class="flex items-center justify-between">
		<div class="flex items-center gap-3">
			<div class="h-12 w-12 rounded-lg overflow-hidden flex items-center justify-center">
				<img
					src="https://cdn-boku.tachi.ac/logos/logo-mark.png"
					alt="Bokutachi logo"
					class="h-full w-full object-contain"
					loading="lazy"
				/>
			</div>
			<div>
				<div class="flex items-center">
					<h3 class="text-lg font-medium">Bokutachi Integration</h3>
					{#if id}
						<!-- Connected badge uses success tokens; subtle background with readable foreground -->
						<span
							class="ml-3 inline-flex items-center rounded-full px-2 py-0.5 text-xs font-semibold transition-colors duration-150 bg-success text-success-foreground border border-success-600"
							aria-hidden="true"
						>
              Connected
            </span>
					{/if}
				</div>
				<p class="text-sm text-muted-foreground">Connect your Bokutachi account to enable integrations.</p>
				{#if id}
					<p class="mt-2 text-sm">Connected as {user ?? 'unknown'}</p>
				{/if}
			</div>
		</div>
		<div class="flex gap-2">
			{#if hasSession}
				{#if id}
					<div class="flex gap-2 items-center">
						<!-- Manage: subtle variant when connected -->
						<a
							class="rounded-md px-3 py-1 text-sm font-semibold transition-colors duration-150 border hover:bg-muted/90 bg-muted text-muted-foreground border-transparent"
							href={`https://boku.tachi.ac/u/${id}`}
							target="_blank"
							rel="noopener noreferrer"
						>
							Manage
						</a>

						<!-- Disconnect: destructive token usage, subtle background and matching foreground -->
						<button
							class="rounded-md px-3 py-1 text-sm font-semibold transition-colors duration-150 border bg-destructive/20 text-destructive-foreground border-destructive"
							onclick={onDisconnect}
							aria-label="Disconnect Bokutachi"
						>
							Disconnect
						</button>
					</div>
				{:else}
					<!-- Connect uses primary tokens and consistent sizing -->
					<button
						class="rounded-md px-3 py-1 text-sm font-semibold transition-colors duration-150 shadow-sm bg-primary text-primary-foreground"
						onclick={onStartConnect}
						aria-label="Connect Bokutachi"
					>
						Connect
					</button>
				{/if}
			{/if}
		</div>
	</div>
</div>

<!-- No component-scoped styles required; Tailwind utility classes handle styling -->
