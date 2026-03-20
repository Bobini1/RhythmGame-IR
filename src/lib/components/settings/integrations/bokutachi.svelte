<script lang="ts">
  import { onMount } from 'svelte';
  import authClient from '$lib/client/auth/client';
  import { toast } from 'svelte-sonner';
  import { env } from '$env/dynamic/public';

  const session = authClient.useSession();

  let connected = false;
  let providerUser = null as null | { username?: string; id?: number };

  async function checkStatus() {
    const res = await fetch('/api/integrations/tachi/status');
    if (!res.ok) return;
    const data = await res.json();
    connected = !!data.connected;
    providerUser = data.user ?? null;
  }

  function startConnect() {
    const clientID = env.PUBLIC_BOKUTACHI_CLIENT_ID;
    if (!clientID) {
      toast.error('Tachi client ID not configured');
      return;
    }

    window.location.href = `https://boku.tachi.ac/oauth/request-auth?clientID=${encodeURIComponent(clientID)}`;
  }

  async function disconnect() {
    const res = await fetch('/api/integrations/tachi/remove', { method: 'POST' });
    if (res.ok) {
      toast.success('Disconnected');
      await checkStatus();
    } else {
      toast.error('Failed to disconnect');
    }
  }

  onMount(() => {
    checkStatus();
  });
</script>

<div class={`rounded-lg border p-4 ${connected ? 'border-green-500 bg-green-50/50' : ''}`}>
  <div class="flex items-center justify-between">
    <div class="flex items-center gap-3">
      <div class="h-8 w-8 rounded overflow-hidden flex items-center justify-center">
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
          {#if connected}
            <span class="ml-3 inline-flex items-center rounded-full bg-green-600 px-2 py-0.5 text-xs font-semibold text-white">Connected</span>
          {/if}
        </div>
        <p class="text-sm text-muted-foreground">Connect your Tachi/Bokutachi account to enable integrations.</p>
        {#if connected}
          <p class="mt-2 text-sm">Connected as {providerUser?.username ?? 'unknown'}</p>
        {/if}
      </div>
    </div>
    <div class="flex gap-2">
      {#if $session.data}
        {#if connected}
          <div class="flex gap-2 items-center">
            <a
              class="px-3 py-1 rounded bg-green-600 text-white"
              href={providerUser?.id ? `https://boku.tachi.ac/u/${providerUser.id}` : 'https://boku.tachi.ac'}
              target="_blank"
              rel="noopener noreferrer"
            >
              Manage
            </a>
            <button class="px-3 py-1 rounded border bg-red-600 text-white" on:click={disconnect}>Disconnect</button>
          </div>
        {:else}
          <button class="px-3 py-1 rounded bg-primary text-white" on:click={startConnect}>Connect</button>
        {/if}
      {/if}
    </div>
  </div>
</div>

<!-- Styling uses Tailwind utility classes in markup -->






