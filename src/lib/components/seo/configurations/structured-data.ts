import { BaseUrl, AppName, SupportEmail, TwitterUsername } from '$lib/api/configurations/common';

export const FAQ = {
	'@type': 'FAQPage',
	mainEntity: [
		{
			'@type': 'Question',
			name: 'Does RhythmGame support Bokutachi?',
			acceptedAnswer: {
				'@type': 'Answer',
				text: 'Yes, you can link your Bokutachi profile to your RhythmGame account to automatically upload your scores.'
			}
		},
		{
			'@type': 'Question',
			name: 'Can I play the game without an account?',
			acceptedAnswer: {
				'@type': 'Answer',
				text: 'Yes, you can still see leaderboards in-game without an account, but you will not be able to submit scores.'
			}
		},
		{
			'@type': 'Question',
			name: 'Does RhythmGame upload scores to Lunatic Rave 2 Internet Ranking?',
			acceptedAnswer: {
				'@type': 'Answer',
				text: 'No, the in-game LR2IR ranking is read-only.'
			}
		},
		{
			'@type': 'Question',
			name: 'What internet rankings does RhythmGame support?',
			acceptedAnswer: {
				'@type': 'Answer',
				text: 'RhythmGame supports its own RhythmGame IR, Bokutachi and LR2IR (read-only).'
			}
		}
	]
};

// Minimal Organization + Website entries for richer search results
export const Organization = {
	'@id': `${BaseUrl}/#organization`,
	'@type': 'Organization',
	name: AppName,
	url: BaseUrl,
	logo: {
		'@type': 'ImageObject',
		url: `${BaseUrl}/favicon.svg`,
		width: 512,
		height: 512
	},
	contactPoint: [
		{
			'@type': 'ContactPoint',
			contactType: 'customer support',
			email: SupportEmail
		}
	],
	// include social profile if available
	sameAs: TwitterUsername ? [`https://twitter.com/${TwitterUsername.replace(/^@/, '')}`] : undefined
};

export const WebSite = {
	'@type': 'WebSite',
	name: AppName,
	url: BaseUrl,
	publisher: { '@id': `${BaseUrl}/#organization` },
	potentialAction: {
		'@type': 'SearchAction',
		target: `${BaseUrl}/search?q={search_term_string}`,
		'query-input': 'required name=search_term_string'
	}
};

export const DefaultGraph = [Organization, WebSite];

