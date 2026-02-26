import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ url }) => {
	// Accept a one-time redirect token (rt) and an optional app_redirect (native scheme or universal link)
	const rt = url.searchParams.get('rt');
	const appRedirect = url.searchParams.get('app_redirect');
	return { rt, appRedirect };
};

