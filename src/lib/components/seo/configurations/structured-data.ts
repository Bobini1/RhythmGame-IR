import { BaseUrl } from '$lib/api/configurations/common';

export const Breadcrumbs = {
	'@type': 'BreadcrumbList',
	itemListElement: [
		{
			'@type': 'ListItem',
			position: 1,
			name: 'Home',
			item: `${BaseUrl}`
		},
		{
			'@type': 'ListItem',
			position: 2,
			name: 'Settings',
			item: `${BaseUrl}/settings`
		}
	]
};

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
