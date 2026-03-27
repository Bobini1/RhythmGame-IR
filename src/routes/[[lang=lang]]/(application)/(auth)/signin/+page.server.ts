import type { PageServerLoad } from './$types';
import { createMetaTags } from '$lib/client/configurations/meta-tags';

export const load: PageServerLoad = async () => {
    return { meta: createMetaTags('common.signin', 'seo.pages.signin.description') };
};

