import type { Link } from '$lib/models/link';
import {
	BookLock,
	Cookie,
	Handshake,
	Settings,
	LogIn,
	Signature,
	Users,
	Music
} from '@lucide/svelte';

export interface GroupedRoutes {
	title: string;
	children: Link[];
	excludeFromMainMenu?: boolean;
}
export const AppRoutes: GroupedRoutes[] = [
	{
		title: 'common.application',
		children: [
			{
				label: 'common.players',
				path: '/players',
				icon: Users,
				authenticationRequired: false
			},
			{
				label: 'common.charts',
				path: '/charts',
				icon: Music,
				authenticationRequired: false
			},
			{
				label: 'common.settings',
				path: '/settings',
				icon: Settings,
				authenticationRequired: false
			}
		]
	},
	{
		title: 'common.site',
		excludeFromMainMenu: true,
		children: [
			{
				label: 'common.cookies_policy',
				path: '/policies/cookies',
				icon: Cookie
			},
			{
				label: 'common.privacy_policy',
				path: '/policies/privacy',
				icon: BookLock
			},
			{
				label: 'common.terms_of_service',
				path: '/policies/terms',
				icon: Handshake
			}
		]
	},
	{
		title: 'common.authentication',
		excludeFromMainMenu: true,
		children: [
			{
				label: 'common.signin',
				path: '/signin',
				icon: LogIn,
				authenticationRequired: false
			},
			{
				label: 'common.signup',
				path: '/signup',
				icon: Signature,
				authenticationRequired: false
			}
		]
	}
];
