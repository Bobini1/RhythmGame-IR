import { ProtocolError } from './errors.ts';
import {
	clientMessageSchema,
	MAX_CLIENT_MESSAGE_BYTES,
	MAX_SERVER_MESSAGE_BYTES,
	PROTOCOL_MAJOR,
	PROTOCOL_MINOR,
	REQUIRED_CAPABILITY,
	serverMessageSchema,
	type ClientMessage,
	type ServerMessage
} from './messages.ts';

const utf8Encoder = new TextEncoder();

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function rejectKnownNegotiationMismatch(value: unknown): void {
	if (!isRecord(value) || value.type !== 'client_hello' || !isRecord(value.data)) {
		return;
	}

	const { protocolMajor, protocolMinor, capabilities } = value.data;
	if (
		(typeof protocolMajor === 'number' && protocolMajor !== PROTOCOL_MAJOR) ||
		(typeof protocolMinor === 'number' && protocolMinor !== PROTOCOL_MINOR)
	) {
		throw new ProtocolError('protocol_incompatible');
	}

	if (
		Array.isArray(capabilities) &&
		capabilities.every((capability) => typeof capability === 'string') &&
		!capabilities.includes(REQUIRED_CAPABILITY)
	) {
		throw new ProtocolError('capability_required');
	}
}

export function decodeClientMessage(text: string): ClientMessage {
	if (typeof text !== 'string' || utf8Encoder.encode(text).byteLength > MAX_CLIENT_MESSAGE_BYTES) {
		throw new ProtocolError(typeof text === 'string' ? 'frame_too_large' : 'malformed_message');
	}

	let value: unknown;
	try {
		value = JSON.parse(text) as unknown;
	} catch {
		throw new ProtocolError('malformed_message');
	}

	rejectKnownNegotiationMismatch(value);

	const result = clientMessageSchema.safeParse(value);
	if (!result.success) {
		throw new ProtocolError('malformed_message');
	}

	return result.data;
}

export function encodeServerMessage(message: ServerMessage): string {
	const result = serverMessageSchema.safeParse(message);
	if (!result.success) {
		throw new ProtocolError('malformed_message');
	}

	const encoded = JSON.stringify(result.data);
	if (utf8Encoder.encode(encoded).byteLength > MAX_SERVER_MESSAGE_BYTES) {
		throw new ProtocolError('frame_too_large');
	}

	return encoded;
}
