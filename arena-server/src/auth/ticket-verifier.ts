import type { VerifiedArenaTicket } from './identity.ts';

export type TicketVerificationErrorCode = 'invalid_ticket' | 'ticket_replayed';

const ticketVerificationErrorMessages = {
	invalid_ticket: 'The Arena identity ticket is invalid.',
	ticket_replayed: 'The Arena identity ticket is invalid.'
} as const satisfies Record<TicketVerificationErrorCode, string>;

export class TicketVerificationError extends Error {
	readonly code: TicketVerificationErrorCode;

	constructor(code: TicketVerificationErrorCode) {
		super(ticketVerificationErrorMessages[code]);
		this.name = 'TicketVerificationError';
		this.code = code;
	}

	toJSON(): Readonly<{ name: string; code: TicketVerificationErrorCode }> {
		return { name: this.name, code: this.code };
	}
}

export interface TicketVerifier {
	verify(ticket: string, now: Date): Promise<VerifiedArenaTicket>;
}
