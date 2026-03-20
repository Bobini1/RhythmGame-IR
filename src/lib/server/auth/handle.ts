import { svelteKitHandler } from 'better-auth/svelte-kit';
import { auth } from './config';
import { building } from '$app/environment';
import { redirect } from '@sveltejs/kit';
import { AppRoutes } from '$lib/client/configurations/routes';
import type { RequestEvent } from '@sveltejs/kit';
import { db } from '$lib/server/database/client';
import { integrations } from '$lib/server/database/schemas/integrations';
import { and, eq } from 'drizzle-orm';

export async function handle({
	event,
	resolve
}: {
	event: RequestEvent;
	resolve: (event: RequestEvent) => Promise<Response>;
}): Promise<Response> {
	const session = await auth.api.getSession({
		headers: event.request.headers
	});
	const requestedPath = event.url.pathname;
	if (session) {
		event.locals.session = session.session;
		event.locals.user = session.user;

		// Load bokutachi/tachi integration for the current user so it's
		// available during SSR via event.locals.tachi
		try {
			if (session.user && session.user.id != null) {
				const res = await db
					.select({data: integrations.data})
					.from(integrations)
					.where(and(
						eq(integrations.userId, Number(session.user.id)),
						eq(integrations.provider, 'tachi'))
					);

				if (res && res.length > 0) {
					event.locals.tachi = res[0].data;
				} else {
					event.locals.tachi = null;
				}
			} else {
				event.locals.tachi = null;
			}
		} catch (err) {
			console.warn('Failed to load tachi integration in handle', err);
			event.locals.tachi = null;
		}
	} else {
		if (isRouteRequiresAuthentication(requestedPath)) {
			redirect(302, `/signin?ref=${requestedPath}`);
		}
	}

	return svelteKitHandler({ event, resolve, auth, building });
}

function isRouteRequiresAuthentication(path: string): boolean {
	if (pathIsHome(path)) return false;
	if (path.startsWith('/api')) return false;
	return !!AppRoutes.find((group) => {
		return group.children.find((child) => {
			return (
				(child.path.includes(path) || path.includes(child.path)) &&
				child.authenticationRequired !== false
			);
		});
	});
}

function pathIsHome(path: string): boolean {
	return path === '' || path === '/';
}
