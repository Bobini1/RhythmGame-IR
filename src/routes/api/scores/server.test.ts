import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { POST } from './+server';

const mocks = vi.hoisted(() => ({ save: vi.fn(), getScore: vi.fn(), forward: vi.fn() }));
vi.mock('$lib/server/api/service', () => ({ submitScore: mocks.save }));
vi.mock('$lib/server/api/scores.queries', () => ({ getScoreById: mocks.getScore }));
vi.mock('$lib/server/integrations/tachi', () => ({ uploadScoresToTachi: mocks.forward }));
vi.mock('$lib/server/api/utils', () => ({}));
vi.mock('$lib/server/api/json-bigint', () => ({ parseBigIntJson: JSON.parse }));
vi.mock('$lib/server/scores/validation', () => ({
	scoreSubmissionPayloadSchema: { safeParse: (data: unknown) => ({ success: true, data }) }
}));

function event(connected = true): Parameters<typeof POST>[0] {
	return {
		request: new Request('https://ranking.example/api/scores', {
			method: 'POST',
			body: JSON.stringify({ scoreData: { guid: 'saved-guid' } })
		}),
		locals: {
			session: {},
			user: { id: '1' },
			tachi: connected ? { token: 'test-token' } : undefined
		}
	} as unknown as Parameters<typeof POST>[0];
}

describe('Ranking submission with optional Bokutachi forwarding', () => {
	beforeEach(() => {
		vi.resetAllMocks();
		mocks.save.mockResolvedValue(undefined);
		mocks.getScore.mockResolvedValue({ guid: 'saved-guid' });
		mocks.forward.mockResolvedValue(true);
		vi.spyOn(console, 'log').mockImplementation(() => {});
		vi.spyOn(console, 'warn').mockImplementation(() => {});
		vi.spyOn(console, 'error').mockImplementation(() => {});
	});
	afterEach(() => vi.restoreAllMocks());
	it('saves then forwards a successful submission', async () => {
		expect((await POST(event())).status).toBe(201);
		expect(mocks.save.mock.invocationCallOrder[0]).toBeLessThan(
			mocks.forward.mock.invocationCallOrder[0]
		);
	});
	it.each(['Unsupported note order algorithm: 9', 'DUPLICATE_SCORE', 'timeout'])(
		'preserves 201 after forwarding throws %s',
		async (message) => {
			mocks.forward.mockRejectedValue(new Error(message));
			expect((await POST(event())).status).toBe(201);
		}
	);
	it('preserves 201 when forwarding returns false', async () => {
		mocks.forward.mockResolvedValue(false);
		expect((await POST(event())).status).toBe(201);
		expect(console.warn).toHaveBeenCalled();
	});
	it('preserves 201 when the post-save lookup fails', async () => {
		mocks.getScore.mockRejectedValue(new Error('lookup failed'));
		expect((await POST(event())).status).toBe(201);
	});
	it('does not forward without a connection', async () => {
		expect((await POST(event(false))).status).toBe(201);
		expect(mocks.forward).not.toHaveBeenCalled();
	});
	it.each([
		['database failed', 500],
		['DUPLICATE_SCORE', 409]
	])('still reports ranking failures: %s', async (message, status) => {
		mocks.save.mockRejectedValue(new Error(String(message)));
		expect((await POST(event())).status).toBe(status);
		expect(mocks.forward).not.toHaveBeenCalled();
	});
});
