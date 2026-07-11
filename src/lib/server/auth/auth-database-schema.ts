import { account, jwks, session, user, verification } from '../database/schemas/auth';

export const authDatabaseSchema = {
	user,
	session,
	account,
	verification,
	jwks
} as const;
