<script lang="ts">
import CardRoot from '$lib/components/ui/card/card.svelte';
import CardHeader from '$lib/components/ui/card/card-header.svelte';
import CardTitle from '$lib/components/ui/card/card-title.svelte';
import CardDescription from '$lib/components/ui/card/card-description.svelte';

interface Props {
  id?: number;
  user?: string;
  onDisconnect: () => void;
  onConnect: () => void;
  manageHref: string;
}

let { id, user, onDisconnect, onConnect, manageHref }: Props = $props();
</script>

<!-- Card header holds both description and actions; actions sit to the right on md+ and stack on small screens -->
<CardRoot class="w-full">
  <CardHeader>
  <div class="w-full">
	  <div class="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
		<!-- Left: logo + title + description -->
		<div class="flex items-start md:items-center gap-3 flex-1 min-w-0">
				<div class="h-12 w-12 rounded-lg overflow-hidden flex items-center justify-center shrink-0">
				  <img
					src="https://cdn-boku.tachi.ac/logos/logo-mark.png"
					alt="Bokutachi logo"
					class="h-12 w-12 object-contain"
					loading="lazy"
				  />
				</div>
		  <div class="min-w-0">
			<CardTitle>
			  <h3 class="text-lg font-medium">Bokutachi Integration</h3>
			</CardTitle>
			<CardDescription>
			  Connect your Bokutachi account to enable integrations.
			  {#if id}
				<div class="mt-2 text-sm">Connected as {user ?? 'unknown'}</div>
			  {/if}
			</CardDescription>
		  </div>
		</div>

		<!-- Right: actions (aligned to right on wide screens) -->
		<div class="flex items-center justify-end md:shrink-0">
		  {#if id}
			<div class="flex gap-2 items-center">
			  <a
				class="rounded-md px-3 py-1 text-sm font-semibold transition-colors duration-150 border hover:bg-muted/90 bg-muted text-muted-foreground border-transparent"
				href={manageHref}
				target="_blank"
				rel="noopener noreferrer"
			  >
				Manage
			  </a>

			  <button
				class="rounded-md px-3 py-1 text-sm font-semibold transition-colors duration-150 border bg-destructive/20 text-destructive-foreground border-destructive"
				on:click={onDisconnect}
				aria-label="Disconnect Bokutachi"
			  >
				Disconnect
			  </button>
			</div>
		  {:else}
			<button
			  class="rounded-md px-3 py-1 text-sm font-semibold transition-colors duration-150 shadow-sm bg-primary text-primary-foreground"
			  on:click={onConnect}
			  aria-label="Connect Bokutachi"
			>
			  Connect
			</button>
		  {/if}
		</div>
	  </div>
	</div>
  </CardHeader>
</CardRoot>
