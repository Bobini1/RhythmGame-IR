import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApiScore } from '../api/scores.queries';
import { prepareTachiScore, uploadScoresToTachi } from './tachi';

vi.mock('$env/static/public', () => ({ PUBLIC_BOKUTACHI_API: 'https://boku.tachi.ac/api/v1' }));

function score(overrides: Partial<ApiScore> = {}): ApiScore {
	return {
		guid: 'test-score',
		userId: 1,
		md5: 'AB'.repeat(16),
		sha256: 'AB'.repeat(32),
		points: 100,
		maxPoints: 200,
		maxCombo: 50,
		maxHits: 100,
		judgementCounts: [0, 0, 0, 0, 100, 0],
		mineHits: 0,
		normalNoteCount: 100,
		scratchCount: 0,
		lnCount: 0,
		bssCount: 0,
		mineCount: 0,
		clearType: 'NORMAL',
		randomSequence: [],
		randomSeed: 0n,
		noteOrderAlgorithm: 0,
		noteOrderAlgorithmP2: 0,
		dpOptions: 0,
		keymode: 7,
		gameVersion: 0,
		length: 1000,
		unixTimestamp: 1788580000,
		replayData: [],
		gaugeHistory: [],
		...overrides
	};
}

function response(body: unknown = { success: true, body: { errors: [] } }, status = 200) {
	return new Response(JSON.stringify(body), { status });
}

describe('Bokutachi forwarding', () => {
	const fetchMock = vi.fn<typeof fetch>();
	beforeEach(() => {
		fetchMock.mockReset().mockImplementation(async () => response());
		vi.stubGlobal('fetch', fetchMock);
		vi.spyOn(console, 'warn').mockImplementation(() => {});
		vi.spyOn(console, 'error').mockImplementation(() => {});
	});
	afterEach(() => {
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
	});

	it.each([
		[0, 'NONRAN'],
		[1, 'MIRROR'],
		[2, 'RANDOM'],
		[3, 'S-RANDOM'],
		[4, 'R-RANDOM'],
		[7, 'RANDOM'],
		[9, 'RANDOM']
	])('maps random option %i', (option, expected) => {
		expect(prepareTachiScore(score({ noteOrderAlgorithm: Number(option) })).scoreMeta.random).toBe(
			expected
		);
	});
	it('preserves DP random options and accepts LR2 flip', () => {
		expect(
			prepareTachiScore(
				score({ keymode: 10, noteOrderAlgorithm: 9, noteOrderAlgorithmP2: 1, dpOptions: 3 })
			).scoreMeta.random
		).toEqual(['RANDOM', 'MIRROR']);
	});
	it('does not convert the unused second-side random in SP', () => {
		expect(prepareTachiScore(score({ noteOrderAlgorithmP2: 999 })).scoreMeta.random).toBe('NONRAN');
	});
	it.each([5, 6, 8, 10, 999])('does not mislabel unsupported random option %i', (option) => {
		expect(() => prepareTachiScore(score({ noteOrderAlgorithm: option }))).toThrow(
			'Unsupported note order algorithm'
		);
	});
	it.each([2, 999])('rejects unsupported DP option %i', (dpOptions) => {
		expect(() => prepareTachiScore(score({ dpOptions }))).toThrow();
	});
	it('posts to the root IR endpoint with the BMS batch-manual payload', async () => {
		expect(await uploadScoresToTachi([score({ noteOrderAlgorithm: 9 })], 'test-token')).toBe(true);
		const [url, init] = fetchMock.mock.calls[0];
		expect(String(url)).toBe('https://boku.tachi.ac/ir/direct-manual/import');
		expect(init?.headers).toMatchObject({ Authorization: 'Bearer test-token' });
		expect(JSON.parse(String(init?.body))).toMatchObject({
			meta: { game: 'bms', playtype: '7K', service: 'RhythmGame' },
			scores: [{ scoreMeta: { random: 'RANDOM' } }]
		});
	});
	it('skips unsupported scores without aborting either valid keymode batch', async () => {
		expect(
			await uploadScoresToTachi(
				[
					score({ noteOrderAlgorithm: 5 }),
					score({ dpOptions: 2 }),
					score({ keymode: 9 }),
					score(),
					score({ keymode: 14 })
				],
				'token'
			)
		).toBe(false);
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});
	it('continues the 14K batch when the 7K request fails', async () => {
		fetchMock.mockResolvedValueOnce(response({ success: false }, 404));
		expect(await uploadScoresToTachi([score(), score({ keymode: 14 })], 'token')).toBe(false);
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});
	it.each([false, true])(
		'reports HTTP-200 import failures (score errors: %s)',
		async (scoreErrors) => {
			fetchMock.mockResolvedValueOnce(
				response(
					scoreErrors
						? { success: true, body: { errors: [{ message: 'Chart not found' }] } }
						: { success: false }
				)
			);
			expect(await uploadScoresToTachi([score()], 'token')).toBe(false);
		}
	);
	it('contains network failures', async () => {
		fetchMock.mockRejectedValueOnce(new Error('Network failure'));
		expect(await uploadScoresToTachi([score()], 'token')).toBe(false);
	});
	it('does not send an empty batch when all scores are unsupported', async () => {
		expect(await uploadScoresToTachi([score({ dpOptions: 2 })], 'token')).toBe(false);
		expect(fetchMock).not.toHaveBeenCalled();
	});
	it('bounds the initial upload attempt with a timeout and does not retry', async () => {
		const controller = new AbortController();
		vi.spyOn(AbortSignal, 'timeout').mockReturnValue(controller.signal);
		fetchMock.mockImplementationOnce(async (_url, init) => {
			expect(init?.signal).toBe(controller.signal);
			controller.abort();
			throw new Error('Request timed out');
		});
		expect(await uploadScoresToTachi([score()], 'token')).toBe(false);
		expect(AbortSignal.timeout).toHaveBeenCalledWith(15_000);
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});
	it('accepts queued uploads without polling or requiring an import ID', async () => {
		fetchMock.mockResolvedValueOnce(
			response({ success: true, body: { url: 'https://untrusted.example/' } }, 202)
		);
		expect(await uploadScoresToTachi([score()], 'token')).toBe(true);
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});
});
