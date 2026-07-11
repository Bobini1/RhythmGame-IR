import { describe, expect, test } from 'bun:test';

import {
	BACKPRESSURE_LIMIT_BYTES,
	blocksEphemeralAfterSend,
	classifySocketDelivery
} from '../../src/transport/start-server.ts';

describe('Arena gateway delivery policy', () => {
	test('drops only ephemeral events while blocked and resumes after drain clears the flag', () => {
		expect(classifySocketDelivery(true, true, 0, 1)).toBe('drop');
		expect(classifySocketDelivery(false, true, 0, 1)).toBe('send');
		expect(classifySocketDelivery(true, false, 0, 1)).toBe('send');
	});

	test('blocks ephemeral traffic after backpressure or a dropped send until drain resets state', () => {
		expect(blocksEphemeralAfterSend(-1)).toBe(true);
		expect(blocksEphemeralAfterSend(0)).toBe(true);
		expect(blocksEphemeralAfterSend(1)).toBe(false);
		expect(classifySocketDelivery(true, false, 0, 1)).toBe('send');
	});

	test('fits a four-MiB reliable message in an empty socket and closes before reliable overflow', () => {
		expect(classifySocketDelivery(false, false, 0, 4 * 1024 * 1024)).toBe('send');
		expect(classifySocketDelivery(false, false, BACKPRESSURE_LIMIT_BYTES - 10, 10)).toBe('send');
		expect(classifySocketDelivery(false, false, BACKPRESSURE_LIMIT_BYTES - 10, 11)).toBe('close');
	});

	test('drops an ephemeral event that would cross five MiB without closing the socket', () => {
		expect(classifySocketDelivery(true, false, BACKPRESSURE_LIMIT_BYTES - 10, 11)).toBe('drop');
	});
});
