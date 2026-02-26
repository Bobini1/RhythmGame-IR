import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/database/client';
import { redirect_token } from '$lib/server/database/schemas/redirect_tokens';
import { auth } from '$lib/server/auth/config';
import crypto from 'crypto';

export const POST: RequestHandler = async ({ request }) => {
	const body = await request.json().catch(() => ({}));
	const appRedirect = body?.app_redirect;

	// get current session using better-auth
	const sessionRes = await auth.api.getSession({ headers: request.headers as any }).catch(() => null);
	if (!sessionRes || !sessionRes.session) {
		return json({ error: 'no_session' }, { status: 401 });
	}
	const session = sessionRes.session;

	const token = crypto.randomBytes(24).toString('hex');
	const expiresAt = new Date(Date.now() + 60 * 1000); // 60s TTL

	await db.insert(redirect_token).values({
		token,
		sessionId: session.id,
		redirectUri: appRedirect || '',
		expiresAt
	}).execute();

	return json({ rt: token, appRedirect });
};

