<script lang="ts">
	import '../app.css';
	import { onMount } from 'svelte';
	import { locale } from '$lib/i18n';
	import type { AvailableLocales } from '$lib/enums/available-locales';
	import { analyticsAllowed, direction } from '$lib/stores';
	import { directionMap } from '$lib/api/configurations/common';
	import SEO from '$lib/components/seo/seo.svelte';
	import { ModeWatcher } from 'mode-watcher';
	import { Toaster } from '$lib/components/ui/sonner/index.js';
	import { deepMerge } from 'svelte-meta-tags';
	import { page } from '$app/state';
	import { changeTheme, getTheme } from '$lib/theme/manager';
	import { isAnalyticsAccepted, revokeAnalyticsCookies } from '$lib/manage-cookies/manager';
	import { browser } from '$app/environment';
	import type { LayoutProps } from './$types';

	const googleTagManagerId = 'GTM-NH6TLDJF';

	let { children, data }: LayoutProps = $props();
	let mergedMetaTags = $derived(deepMerge(data.baseMetaTags, page.data.meta));

	onMount(() => {
		changeTheme(getTheme());
		locale.subscribe((seletedLocale) => {
			updateDirection(seletedLocale as AvailableLocales);
		});
	});

	function updateDirection(locale: AvailableLocales) {
		if (!locale) {
			return;
		}
		if (document) {
			const dir = directionMap[locale] ?? $direction;
			document.dir = dir === 'lr' ? 'ltr' : 'rtl';
			direction.set(dir);
		}
	}

	function ensureGoogleTag() {
		window.dataLayer = window.dataLayer || [];
		window.gtag =
			window.gtag ||
			function gtag(...args: unknown[]) {
				window.dataLayer.push(args);
			};
	}

	function loadGoogleTagManager(analyticsConsent: boolean) {
		if (!browser || window.gtmLoaded) {
			return;
		}

		ensureGoogleTag();
		window.gtag('consent', 'default', {
			analytics_storage: analyticsConsent ? 'granted' : 'denied',
			ad_storage: 'denied',
			ad_user_data: 'denied',
			ad_personalization: 'denied'
		});
		window.dataLayer.push({
			'gtm.start': new Date().getTime(),
			event: 'gtm.js'
		});

		const script = document.createElement('script');
		script.src = `https://www.googletagmanager.com/gtm.js?id=${googleTagManagerId}`;
		script.async = true;
		document.head.appendChild(script);
		window.gtmLoaded = true;
		updateAnalyticsConsent(analyticsConsent);
	}

	function updateAnalyticsConsent(allowed: boolean) {
		if (!browser) {
			return;
		}

		ensureGoogleTag();
		window.gtag('consent', 'update', {
			analytics_storage: allowed ? 'granted' : 'denied'
		});

		if (!allowed) {
			revokeAnalyticsCookies();
		}
	}

	$effect(() => {
		$analyticsAllowed = isAnalyticsAccepted(page.data.cookiePreferences);
	});

	$effect(() => {
		if (browser && $analyticsAllowed !== undefined) {
			if ($analyticsAllowed) {
				loadGoogleTagManager(true);
				updateAnalyticsConsent(true);
			} else {
				updateAnalyticsConsent(false);
			}
		}
	});
</script>

<Toaster expand={true} richColors={true} dir={$direction === 'lr' ? 'ltr' : 'rtl'} />
<SEO data={mergedMetaTags} />
<ModeWatcher />
{@render children?.()}
