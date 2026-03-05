/**
 * GraphQL type definitions for User.
 */
import builder from '../builder';
import { db } from '$lib/server/database/client';
import { scores } from '$lib/server/database/schemas/scores';
import { user } from '$lib/server/database/schemas/auth';
import { eq, count } from 'drizzle-orm';

// Shape returned by our DB queries — no scoreCount; it's a resolver field
export interface UserShape {
	id: number;
	name: string;
	email: string;
	image: string | null;
	createdAt: Date;
}

export const UserType = builder.objectRef<UserShape>('User').implement({
	fields: (t) => ({
		id: t.exposeInt('id'),
		name: t.exposeString('name'),
		image: t.string({ nullable: true, resolve: (u) => u.image }),
		createdAt: t.string({ resolve: (u) => u.createdAt.toISOString() }),
		scoreCount: t.int({
			description: 'Total number of scores by this user (computed dynamically)',
			resolve: async (parent) => {
				const result = await db
					.select({ count: count() })
					.from(scores)
					.where(eq(scores.userId, parent.id));
				return result[0]?.count ?? 0;
			}
		})
	})
});
