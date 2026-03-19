import i18n from '@sveltekit-i18n/base';
import { Locale } from '../../routes/api';
import { AvailableLocales } from '$lib/enums/available-locales';
import { browser } from '$app/environment';
import { goto } from '$app/navigation';
import parser, { type Config } from '@sveltekit-i18n/parser-icu';

interface Params {
	year?: Date;
	number?: number;
	user?: string;
	author?: string;
	name?: string;
	chart?: string;
	player?: string;
}

const config: Config<Params> = {
	parser: parser(),
	loaders: [
		{
			locale: AvailableLocales.Polish,
			key: 'common',
			loader: async () => (await import('$lib/i18n/pl-PL/common.json')).default
		},
		{
			locale: AvailableLocales.Polish,
			key: 'seo',
			loader: async () => (await import('$lib/i18n/pl-PL/seo.json')).default
		},
		{
			locale: AvailableLocales.Polish,
			key: 'homepage',
			loader: async () => (await import('$lib/i18n/pl-PL/homepage.json')).default
		},
		{
			locale: AvailableLocales.Polish,
			key: 'players',
			loader: async () => (await import('$lib/i18n/pl-PL/players.json')).default
		},
		{
			locale: AvailableLocales.Polish,
			key: 'charts',
			loader: async () => (await import('$lib/i18n/pl-PL/charts.json')).default
		},
		{
			locale: AvailableLocales.English_US,
			key: 'common',
			loader: async () => (await import('./en-US/common.json')).default
		},
		{
			locale: AvailableLocales.English_US,
			key: 'seo',
			loader: async () => (await import('./en-US/seo.json')).default
		},
		{
			locale: AvailableLocales.English_US,
			key: 'homepage',
			loader: async () => (await import('./en-US/homepage.json')).default
		},
		{
			locale: AvailableLocales.English_US,
			key: 'players',
			loader: async () => (await import('./en-US/players.json')).default
		},
		{
			locale: AvailableLocales.English_US,
			key: 'charts',
			loader: async () => (await import('./en-US/charts.json')).default
		}
	]
};

export const { t, locale, locales, loading, loadTranslations, initialized } = new i18n(config);

export const changeLocale = async (newLocale: string): Promise<boolean> => {
	// validate against available locales
	const availableLocales = locales.get();
	if (!availableLocales.includes(newLocale)) {
		console.warn('Attempted to set unsupported locale:', newLocale);
		return false;
	}

	// update UI immediately
	locale.set(newLocale);

	// persist on server
	try {
		const formData = new FormData();
		formData.append('locale', newLocale);
		const res = await fetch(Locale, { method: 'POST', body: formData });
		if (!res.ok) {
			console.error('Failed to persist locale on server:', res.status);
			return false;
		}
	} catch (err) {
		console.error('Locale persistence request failed:', err);
		return false;
	}

	// If we're in the browser, check the current path's first segment. If the URL
	// is language-prefixed and the prefix no longer matches the new locale,
	// navigate to the same path without the prefix so the route and cookie agree.
	if (browser) {
		try {
			const { pathname, search, hash } = window.location;
			// split into segments, ignoring leading/trailing slashes
			const segments = pathname.split('/').filter(Boolean);
			if (segments.length > 0) {
				const first = segments[0];
				if (availableLocales.includes(first) && first !== newLocale) {
					// remove the first segment (language) and rebuild path
					const rest = segments.slice(1).join('/');
					const newPath = '/' + (rest ? rest : '');
					const url = newPath + (search || '') + (hash || '');
					// use client-side navigation; replace history entry so user isn't left with a back
					await goto(url, { replaceState: true });
				}
			}
		} catch (err) {
			// non-fatal: if redirect fails, don't block the locale change
			console.error('Redirect after locale change failed:', err);
		}
	}

	return true;
};
