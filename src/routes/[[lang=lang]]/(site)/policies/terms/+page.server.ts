import type { PageServerLoad } from './$types';
import { createMetaTags } from '$lib/client/configurations/meta-tags';

export const load: PageServerLoad = async () => {
    return { meta: createMetaTags('common.terms_of_service', 'seo.pages.terms_of_service.description', 'noindex, nofollow') };
};

