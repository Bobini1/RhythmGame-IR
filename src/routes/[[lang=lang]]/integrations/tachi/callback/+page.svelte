<script lang="ts">
  import { t } from '$lib/i18n';
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';

  onMount(async () => {
    const params = new URLSearchParams(window.location.search);
    const code = params.get('code');
    if (!code) {
      goto('/settings');
      return;
    }

    // Exchange the intermediate code on server and ignore response here
    await fetch('/api/integrations/tachi/exchange', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code })
    });

    // Redirect back to settings page (will show updated state)
    goto('/settings');
  });
</script>

<div class="p-8">
  <p>${$t("common.processing")}</p>
</div>


