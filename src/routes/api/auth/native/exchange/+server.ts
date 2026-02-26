import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/database/client';
import { redirect_token } from '$lib/server/database/schemas/redirect_tokens';
import { session as sessionTable } from '$lib/server/database/schemas/auth';
import { eq } from 'drizzle-orm';

export const POST: RequestHandler = async ({ request }) => {
	const body = await request.json();
	const { rt } = body;
	if (!rt || typeof rt !== 'string') {
		return json({ error: 'missing rt' }, { status: 400 });
	}

	// find token
	const row = await db
		.select()
		.from(redirect_token)
		.where(eq(redirect_token.token, rt))
		.limit(1);
	if (!row || row.length === 0) return json({ error: 'invalid' }, { status: 404 });
	const tokenRow = row[0] as any;
	if (tokenRow.used) return json({ error: 'used' }, { status: 410 });
	if (new Date(tokenRow.expiresAt) < new Date()) return json({ error: 'expired' }, { status: 410 });

	// mark as used
	await db
		.update(redirect_token)
		.set({ used: true })
		.where(eq(redirect_token.token, rt));

	// fetch session
	const sessions = await db
		.select()
		.from(sessionTable)
		.where(eq(sessionTable.id, tokenRow.sessionId))
		.limit(1);
	if (!sessions || sessions.length === 0) return json({ error: 'session_not_found' }, { status: 404 });
	const sess = sessions[0];

	return json({ session: sess });
};
