import type { Session, User } from 'better-auth';
import type { TachiUser } from '$lib/models/tachi';

// See https://svelte.dev/docs/kit/types#app.d.ts
// for information about these interfaces
declare global {
	namespace App {
		// interface Error {}
		interface Locals {
			session: Session;
			user: User;
			/**
			 * Optional bokutachi / tachi integration record attached during auth handling.
			 * This may contain provider-specific data and should not be sent to the
			 * client unfiltered (tokens/secrets must be removed in server loads).
			 */
			// {"_id": "69bd4dd46baee180ad3d3725", "token": "faa3632f64dd234e6df5e007d06d899ebcda5b00", "userID": 51, "identifier": "RhythmGame-local Token", "permissions": {"submit_score": true}, "fromAPIClient": "CI00fb4334daec063326570981c4e6e1a504887012"}
			tachi: TachiUser | null;
		}
		// interface PageData {}
		// interface PageState {}
		// interface Platform {}
	}
}

export {};
