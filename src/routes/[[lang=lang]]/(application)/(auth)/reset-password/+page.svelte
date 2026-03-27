<script lang="ts">
	import { page } from '$app/state';
	import BasePage from '$lib/components/base-page/base-page.svelte';
	import ResetPassword from '$lib/components/reset-password/reset-password.svelte';

	const token = $derived(page.url.searchParams.get('token') ?? '');

</script>

<BasePage>
	<ResetPassword {token} />
</BasePage>

