import { createMetaTags } from '$lib/client/configurations/meta-tags';

export const load = async ({ locals }) => {
	const tachiId = locals?.tachi?.userID ?? null;

	return { tachiId, meta: createMetaTags('common.settings', 'seo.pages.settings.description', 'noindex, follow') };
};
