import type { ServerLoadEvent } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { getUserCookiesPreferences } from '$lib/manage-cookies/manager';
import { createMetaTags } from '$lib/client/configurations/meta-tags';

export const load: PageServerLoad = (event: ServerLoadEvent) => {
	return {
		preferences: getUserCookiesPreferences(event),
		meta: createMetaTags('common.manage_cookies', 'seo.pages.manage_cookies.description', 'noindex, nofollow')
	};
};
