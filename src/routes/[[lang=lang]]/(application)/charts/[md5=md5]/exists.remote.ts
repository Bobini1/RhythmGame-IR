import { query } from '$app/server';
import { z } from 'zod';
import { md5Schema, sha256Schema } from '$lib/server/scores/validation';

export const resolveTachiUrl = query(
	z.object({ keymode: z.int(), md5: md5Schema }),
	async ({ keymode, md5 }) => {
		// convert 5k to 7k and 10k to 14k
		const tachiKeymode = keymode === 5 ? 7 : keymode === 10 ? 14 : keymode;
		const resp = await fetch(
			`https://boku.tachi.ac/api/v1/games/bms/${tachiKeymode}K/charts/resolve`,
			{
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ matchType: 'bmsChartHash', identifier: md5.toLowerCase() })
			}
		);
		if (!resp.ok) {
			return null;
		}
		const json = await resp.json();
		const id = json.body.chart.chartID;
		if (id) return `https://boku.tachi.ac/games/bms/${tachiKeymode}K/charts/${id}`;
		return null;
	}
);

export const checkLr2Url = query(md5Schema, async (md5) => {
	const url = `http://www.dream-pro.info/~lavalse/LR2IR/search.cgi?mode=ranking&bmsmd5=${md5}`;
	// fetch
	const result = await fetch(url);
	if (!result.ok) {
		return false;
	}
	return !(await result.text()).includes('この曲は登録されていません。');
});

export const checkViewerUrl = query(md5Schema, async (md5) => {
	const url = `https://bms-score-viewer-backend.sayakaisbaka.workers.dev/bms/score/get?md5=${md5.toLowerCase()}`;
	const result = await fetch(url, { method: 'HEAD' });
	return result.ok;
});

export const checkMochaUrl = query(sha256Schema, async (sha256) => {
	const url = `https://mocha-repository.info/song.php?sha256=${sha256}`;
	const result = await fetch(url);
	if (!result.ok) {
		return false;
	}
	const text = await result.text();
	return text.includes('ranking_table');
});