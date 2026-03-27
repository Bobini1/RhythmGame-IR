import { AppName } from '$lib/api/configurations/common';
import { locale, t } from '$lib/i18n';
import type { MetaTagsProps } from 'svelte-meta-tags';

export const getBaseMetaTags = ({ url }: { url: URL }) => {
	const brandName = t.get('common.brand.name');
	const brandDescription = t.get('seo.description');
	return {
		title: brandName,
		description: brandDescription,
		canonical: new URL(url.pathname, url.origin).href,
		openGraph: {
			type: 'website',
			url: new URL(url.pathname, url.origin).href,
			locale: locale.get(),
			title: brandName,
			description: brandDescription,
			siteName: AppName,
			images: [
				{
					url: 'https://f003.backblazeb2.com/file/cdn-rhythmgame/static/icon.png',
					width: 1200,
					height: 630,
					alt: brandName
				}
			]
		}
	} satisfies MetaTagsProps;
};

export const getTitleTemplate = () => {
	return `%s • ${t.get('common.brand.name')}`;
};

export const createMetaTags = (
	title: string,
	description: string,
	robots?: string,
	options?: { titleIsKey?: boolean; descriptionIsKey?: boolean; image?: string; vars?: Record<string, string | number> }
): MetaTagsProps => {
	const titleValue = options?.titleIsKey === false ? title : t.get(title, options?.vars ?? undefined);
	const descriptionValue = options?.descriptionIsKey === false ? description : t.get(description, options?.vars ?? undefined);

	const meta: MetaTagsProps = {
		title: titleValue,
		titleTemplate: getTitleTemplate(),
		robots: robots ?? 'index, follow',
		description: descriptionValue,
		openGraph: {
			title: titleValue,
			description: descriptionValue
		}
	};

	if (options?.image) {
		meta.openGraph = { ...meta.openGraph, images: [{ url: options.image }] };
	}

	return meta;
};

