import { query } from '$app/server';
import { z } from 'zod';
import { md5Schema, sha256Schema } from '$lib/server/scores/validation';
import { PUBLIC_BOKUTACHI_API } from '$env/static/public';

export const resolveTachiUrl = query(
	z.object({ keymode: z.int(), md5: md5Schema }),
	async ({ keymode, md5 }) => {
		const tachiGame =
			keymode === 5 || keymode === 7
				? 'bms-7k'
				: keymode === 10 || keymode === 14
					? 'bms-14k'
					: null;
		if (!tachiGame) return null;

		const resp = await fetch(`${PUBLIC_BOKUTACHI_API}/games/${tachiGame}/charts/resolve`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ matchType: 'bmsChartHash', identifier: md5.toLowerCase() })
		});
		if (!resp.ok) {
			return null;
		}
		const json = await resp.json();
		const id = json.body.chart.chartID;
		if (id) return `https://boku.tachi.ac/games/${tachiGame}/charts/${id}`;
		return null;
	}
);

export const checkLr2Url = query(md5Schema, async (md5) => {
	const url = `https://lr2ir.com/api/charts/${md5.toLowerCase()}`;
	const result = await fetch(url);
	return result.ok;
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
