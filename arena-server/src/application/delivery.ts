import type { ServerMessage } from '../protocol/messages.ts';

export type Delivery =
	| Readonly<{
			kind: 'send';
			connectionIds: readonly string[];
			message: ServerMessage;
	  }>
	| Readonly<{
			kind: 'close';
			connectionId: string;
			code: number;
			reason: string;
	  }>;
