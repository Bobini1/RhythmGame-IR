import { handle as authHandle } from '$lib/server/auth/handle';
import { defaultLocale, getDirection, localeCookieName } from '$lib/api/configurations/common';
import { AvailableLocales } from '$lib/enums/available-locales';
import type { Handle } from '@sveltejs/kit';

const isAvailableLocale = (value: string | undefined): value is AvailableLocales =>
	Object.values(AvailableLocales).includes(value as AvailableLocales);

export const handle: Handle = ({ event, resolve }) => {
	const routeLocale = event.params.lang;
	const storedLocale = event.cookies.get(localeCookieName);
	const requestLocale = isAvailableLocale(routeLocale)
		? routeLocale
		: isAvailableLocale(storedLocale)
			? storedLocale
			: defaultLocale;
	const direction = getDirection(requestLocale) === 'lr' ? 'ltr' : 'rtl';

	return authHandle({
		event,
		resolve: (event) =>
			Promise.resolve(
				resolve(event, {
					transformPageChunk: ({ html }) =>
						html.replace('%lang%', requestLocale).replace('%dir%', direction)
				})
			)
	});
};
