import type { RequestHandler } from '@sveltejs/kit';
import { json } from '@sveltejs/kit';
import { db } from '$lib/server/database/client';
import { integrations } from '$lib/server/database/schemas/integrations';
import { eq, and } from 'drizzle-orm';

export const GET: RequestHandler = async (event) => {
	try {
		const session = event.locals.session;
		if (!session) return json({ connected: false });

		const rows = await db
			.select()
			.from(integrations)
			.where(
				and(
					eq(integrations.userId, Number(event.locals.user.id)),
					eq(integrations.provider, 'tachi')
				)
			)
			.limit(1);

		if (!rows || rows.length === 0) return json({ connected: false });

		return json({ connected: true, user: rows[0].data?.user ?? null });
	} catch (err) {
		console.error(err);
		return json({ connected: false });
	}
};
