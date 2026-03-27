import type { LayoutServerLoad } from './$types';
import { getUserCookiesPreferences } from '$lib/manage-cookies/manager';

export const load: LayoutServerLoad = async (event) => {
	return {
		cookiePreferences: getUserCookiesPreferences(event)
	};
};
