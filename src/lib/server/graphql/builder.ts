import SchemaBuilder from '@pothos/core';
import ScopeAuthPlugin from '@pothos/plugin-scope-auth';
import type { Session, User } from 'better-auth';

// ---------------------------------------------------------------------------
// Context — populated from SvelteKit's event.locals
// ---------------------------------------------------------------------------

export interface GraphQLContext {
	session: Session | null;
	user: (User & { id: number }) | null;
}

// ---------------------------------------------------------------------------
// Builder
// ---------------------------------------------------------------------------

const builder = new SchemaBuilder<{
	Context: GraphQLContext;
	AuthScopes: {
		isAuthenticated: boolean;
	};
}>({
	plugins: [ScopeAuthPlugin],
	authScopes: (ctx) => ({
		isAuthenticated: !!ctx.session && !!ctx.user
	})
});

builder.queryType({});
builder.mutationType({});

export default builder;
