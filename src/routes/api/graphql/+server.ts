import { createYoga } from 'graphql-yoga';
import { schema } from '$lib/server/graphql/schema';
import type { RequestHandler } from '@sveltejs/kit';
import type { GraphQLContext } from '$lib/server/graphql/builder';

const yoga = createYoga<GraphQLContext>({
	schema,
	graphqlEndpoint: '/api/graphql',
	graphiql: import.meta.env.DEV,
	fetchAPI: globalThis
});

const handler: RequestHandler = async (event) => {
	const context: GraphQLContext = {
		session: event.locals.session ?? null,
		user: event.locals.user
			? { ...event.locals.user, id: Number(event.locals.user.id) }
			: null
	};

	return yoga.handle(event.request, context) as Promise<Response>;
};

export const GET = handler;
export const POST = handler;
