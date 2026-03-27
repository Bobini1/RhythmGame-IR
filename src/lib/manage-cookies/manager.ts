import type { Cookies, RequestEvent } from '@sveltejs/kit';
import { CookieManagerConfiguration } from './configuration';
import type { CookieCategory } from '$lib/models/manage-cookies-configuration';
import { ManageCookies } from '../../routes/api';
import { browser } from '$app/environment';

export function getUserCookiesPreferences(event: { cookies: Cookies }) {
	const preferencesCookie = event.cookies.get(
		CookieManagerConfiguration['user-preference-cookie-name']
	);
	if (preferencesCookie) {
		return JSON.parse(preferencesCookie);
	}
	return getDefaultCookiesPreferences();
}

function getDefaultCookiesPreferences() {
	const preferences: { [key: string]: boolean } = {};
	CookieManagerConfiguration['cookies-categories'].forEach((category) => {
		if (category.optional) {
			preferences[category.name] = category.accepted;
		}
	});
	return preferences;
}

export function isAnalyticsAccepted(cookiePreferences: { [key: string]: boolean }): boolean {
	return cookiePreferences?.['analytics'] ?? false;
}

export function revokeAnalyticsCookies() {
	if (!browser) return;
	const gaCategories = CookieManagerConfiguration['cookies-categories'].find(
		(c) => c.name === 'analytics'
	);
	gaCategories?.cookies?.forEach((cookieName) => {
		document.cookie = `${cookieName}=; Max-Age=0; path=/; domain=${location.hostname}`;
	});
}

export function setCookie(
	event: RequestEvent,
	cookieCategory: CookieCategory['name'],
	cookie: { [key: string]: string }
) {
	const currentPreferences = getUserCookiesPreferences(event);
	if (!currentPreferences[cookieCategory]) {
		return;
	}
	return cookieSetRequest(cookie);
}

export function cookieSetRequest(cookie: { [key: string]: string }) {
	const body = new FormData();
	Object.keys(cookie).forEach((key) => {
		body.append(key, cookie[key]);
	});
	return fetch(ManageCookies, {
		method: 'POST',
		body
	});
}

export function getCookie(
	event: RequestEvent,
	cookieCategory: CookieCategory['name'],
	cookieName: string
): string | undefined {
	const currentPreferences = getUserCookiesPreferences(event);
	if (!currentPreferences[cookieCategory]) {
		return;
	}
	return event.cookies.get(cookieName);
}

export function hideBanner() {
	cookieSetRequest({ ['show-manage-cookies-banner']: JSON.stringify(false) });
}
