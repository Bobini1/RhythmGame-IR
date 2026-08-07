import { defaultLocale, localeCookieName } from '$lib/api/configurations/common';
import { AvailableLocales } from '$lib/enums/available-locales';
import { json, type RequestHandler } from '@sveltejs/kit';

const isAvailableLocale = (value: string | undefined): value is AvailableLocales =>
	Object.values(AvailableLocales).includes(value as AvailableLocales);

export const POST: RequestHandler = async (event) => {
	const data = await event.request.formData();
	const newLocale = data.get(localeCookieName)?.toString();
	if (!isAvailableLocale(newLocale)) {
		return json({ success: false }, { status: 400 });
	}

	event.cookies.set(localeCookieName, newLocale, { path: '/' });
	return json({ success: true });
};

export const GET: RequestHandler = async (event) => {
	const storedLocale = event.cookies.get(localeCookieName);
	const locale = isAvailableLocale(storedLocale) ? storedLocale : defaultLocale;
	return json({ locale });
};
