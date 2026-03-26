<script lang="ts">
	import authClient from '$lib/client/auth/client';
	import * as Card from '$lib/components/ui/card';
	import { t } from '$lib/i18n';
	import { LoaderCircle } from '@lucide/svelte';
	import * as Alert from '../ui/alert';
	import Button from '../ui/button/button.svelte';
	import Input from '../ui/input/input.svelte';
	import Label from '../ui/label/label.svelte';
	import { toast } from 'svelte-sonner';
	import { Turnstile } from 'svelte-turnstile';
	import { PUBLIC_TURNSTILE_SITE_KEY } from '$env/static/public';

	let name = $state('');
	let email = $state('');
	let password = $state('');
	let isLoading = $state(false);
	let turnstileToken = $state('');
	let resetTurnstile = $state<() => void>();
	let signedUp = $state(false);

	async function signup() {
		if (!turnstileToken) {
			toast.error(t.get('common.captcha_required'));
			return;
		}

		isLoading = true;
		try {
			const { error } = await authClient.signUp.email({
				name,
				email,
				password,
				fetchOptions: { headers: { 'x-captcha-response': turnstileToken } },
				callbackURL: '/'
			});
			if (error) {
				toast.error(t.get(`common.auth_errors.${error.code ?? 'UNKNOWN_ERROR'}`));
				resetTurnstile?.();
				turnstileToken = '';
			} else {
				signedUp = true;
			}
		} catch {
			toast.error(t.get('common.auth_errors.UNKNOWN_ERROR'));
			resetTurnstile?.();
			turnstileToken = '';
		}
		isLoading = false;
	}
</script>

<div class="flex items-center justify-center p-4">
	{#if signedUp}
		<Alert.Root>
			<Alert.Title>{$t('common.signed_up_successfully')}</Alert.Title>
			<Alert.Description>{$t('common.check_inbox_to_verify')}</Alert.Description>
		</Alert.Root>
	{:else}
		<Card.Root>
			<Card.Header>
				<Card.Title>{$t('common.signup_title')}</Card.Title>
				<Card.Description>{$t('common.signup_description')}</Card.Description>
			</Card.Header>
			<Card.Content class="flex flex-col gap-4">
				<form onsubmit={signup} class="space-y-4">
					<div class="space-y-2">
						<Label for="email">{$t('common.email')}</Label>
						<Input
							id="email"
							type="email"
							placeholder={t.get('common.enter_email')}
							bind:value={email}
							required
							disabled={isLoading}
						/>
					</div>

					<div class="space-y-2">
						<Label for="name">{$t('common.name')}</Label>
						<Input
							id="name"
							type="name"
							placeholder={t.get('common.enter_name')}
							bind:value={name}
							required
							disabled={isLoading}
						/>
					</div>

					<div class="space-y-2">
						<Label for="password">{$t('common.password')}</Label>
						<Input
							id="password"
							type="password"
							placeholder={t.get('common.enter_password')}
							bind:value={password}
							required
							disabled={isLoading}
						/>
					</div>

					<Turnstile
						siteKey={PUBLIC_TURNSTILE_SITE_KEY}
						on:turnstile-callback={(e) => (turnstileToken = e.detail.token)}
						on:turnstile-expired={() => (turnstileToken = '')}
						on:turnstile-error={() => (turnstileToken = '')}
						bind:reset={resetTurnstile}
					/>

					<Button type="submit" class="w-full" disabled={isLoading || !turnstileToken}>
						{#if isLoading}
							<LoaderCircle class="animate-spin" size={18} />
						{/if}
						{$t('common.signup')}
					</Button>
				</form>
			</Card.Content>
		</Card.Root>
	{/if}
</div>
