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
	  }>
	| Readonly<{
			kind: 'send_binary';
			connectionIds: readonly string[];
			bytes: Uint8Array;
	  }>
	| Readonly<{
			kind: 'send_ephemeral';
			connectionIds: readonly string[];
			message: Extract<ServerMessage, { type: 'round_standings' }>;
	  }>;
