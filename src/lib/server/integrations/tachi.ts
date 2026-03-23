import type { HitEvent } from '$lib/models/scores';
import type { ApiScore } from '../api/scores.queries';

export interface TachiJudgements {
	pgreat: number;
	great: number;
	good: number;
	bad: number;
	poor: number;
}

interface EarlyLateJudgements {
	epg: number;
	egr: number;
	egd: number;
	ebd: number;
	epr: number;
	lpg: number;
	lgr: number;
	lgd: number;
	lbd: number;
	lpr: number;
}
interface FastSlow {
	fast: number;
	slow: number;
}
type TachiScoreOptional = {
	bp: number;
	maxCombo: number;
} & EarlyLateJudgements &
	FastSlow;

export type TachiScore = {
	score: number;
	lamp: string; // our clear name, will be mapped to tachi lamp
	matchType: string; // e.g. 'bmsChartHash' or 'tachiSongID'
	identifier: string; // the matching value for matchType
	timeAchieved: number; // epoch ms
	judgements: TachiJudgements;
	optional: TachiScoreOptional;
	scoreMeta: Record<string, unknown>;
};

export function mapClearToTachiLamp(clear: string): string {
	switch (clear) {
		case 'NOPLAY':
			return 'NO PLAY';
		case 'FAILED':
			return 'FAILED';
		case 'AEASY':
			return 'ASSIST CLEAR';
		case 'EASY':
			return 'EASY CLEAR';
		case 'NORMAL':
			return 'CLEAR';
		case 'HARD':
			return 'HARD CLEAR';
		case 'EXHARD':
			return 'EX HARD CLEAR';
		case 'FC':
		case 'PERFECT':
		case 'MAX':
			return 'FULL COMBO';
	}
	throw new Error(`Unknown clear type: ${clear}`);
}

export function deriveEarlyLateFromReplay(replayData: HitEvent[]): FastSlow {
	let fast = 0;
	let slow = 0;
	for (const d of replayData) {
		if (!d.noteRemoved || !d.points) {
			continue;
		}
		if (d.points.deviation < 0) {
			fast++;
		} else {
			slow++;
		}
	}
	return { fast, slow };
}

enum Judgement {
	Poor,
	EmptyPoor,
	Bad,
	Good,
	Great,
	Perfect,
	MineHit,
	MineAvoided,
	LnEndSkip,
	LnBeginHit
}

export function deriveEarlyLateJudgementsFromReplay(replayData: HitEvent[]): EarlyLateJudgements {
	let epg = 0;
	let egr = 0;
	let egd = 0;
	let ebd = 0;
	let epr = 0;
	let lpg = 0;
	let lgr = 0;
	let lgd = 0;
	let lbd = 0;
	let lpr = 0;
	for (const d of replayData) {
		if (!d.noteRemoved || !d.points) {
			continue;
		}
		if (d.points.deviation < 0) {
			if (d.points.judgement === Judgement.Perfect) epg++;
			else if (d.points.judgement === Judgement.Great) egr++;
			else if (d.points.judgement === Judgement.Good) egd++;
			else if (d.points.judgement === Judgement.Bad) ebd++;
			else if (d.points.judgement === Judgement.Poor || d.points.judgement === Judgement.EmptyPoor)
				epr++;
		} else {
			if (d.points.judgement === Judgement.Perfect) lpg++;
			else if (d.points.judgement === Judgement.Great) lgr++;
			else if (d.points.judgement === Judgement.Good) lgd++;
			else if (d.points.judgement === Judgement.Bad) lbd++;
			else if (d.points.judgement === Judgement.Poor || d.points.judgement === Judgement.EmptyPoor)
				lpr++;
		}
	}
	return { epg, egr, egd, ebd, epr, lpg, lgr, lgd, lbd, lpr };
}

function convertJudgements(judgementCounts: number[]): TachiJudgements {
	return {
		pgreat: judgementCounts[Judgement.Perfect],
		great: judgementCounts[Judgement.Great],
		good: judgementCounts[Judgement.Good],
		bad: judgementCounts[Judgement.Bad],
		poor: judgementCounts[Judgement.Poor] + judgementCounts[Judgement.EmptyPoor]
	};
}

function convertRandom(noteOrderAlgorithm: number) {
	switch (noteOrderAlgorithm) {
		case 0:
			return 'NONRAN';
		case 1:
			return 'MIRROR';
		case 2:
			return 'RANDOM';
		case 3:
			return 'S-RANDOM';
		case 4:
			return 'R-RANDOM';
		default:
			throw new Error(`Unsupported note order algorithm: ${noteOrderAlgorithm}`);
	}
}

export function prepareTachiScore(score: ApiScore): TachiScore {
	const lamp = mapClearToTachiLamp(score.clearType);

	const fastSlow = deriveEarlyLateFromReplay(score.replayData);
	const earlyLate = deriveEarlyLateJudgementsFromReplay(score.replayData);

	const judgements = convertJudgements(score.judgementCounts);
	const random = convertRandom(score.noteOrderAlgorithm);
	const random2 = convertRandom(score.noteOrderAlgorithmP2);

	return {
		score: Number(score.points ?? 0),
		lamp,
		matchType: 'bmsChartHash',
		identifier: score.md5.toLowerCase(),
		timeAchieved: score.unixTimestamp * 1000,
		judgements,
		optional: {
			...fastSlow,
			...earlyLate,
			bp: Number(judgements.bad + judgements.poor),
			maxCombo: Number(score.maxCombo ?? 0)
		},
		scoreMeta: {
			random: score.keymode === 10 || score.keymode === 14 ? [random, random2] : random
			// client: "RhythmGame",
		}
	};
}

interface TachiImport {
	meta: {
		game: string;
		playtype: string;
		service: string;
	};
	scores: TachiScore[];
}

async function uploadScoresToTachiForKeymode(scores: ApiScore[], token: string, keymode: '7K' | '14K') {
	const payload: TachiImport = {
		meta: {
			game: 'bms',
			playtype: keymode,
			service: 'RhythmGame'
		},
		scores: scores.map(prepareTachiScore)
	};

	const headers: Record<string, string> = {};
	headers['Content-Type'] = 'application/json';
	headers['Authorization'] = `Bearer ${token}`;
	headers['X-User-Intent'] = 'false';
	headers['X-Infer-Score-TimeAchieved'] = 'false';

	const url = `https://boku.tachi.ac/ir/direct-manual/import`;
	try {
		const res = await fetch(url, {
			method: 'POST',
			headers,
			body: JSON.stringify(payload)
		});

		const text = await res.text();
		let jsonBody: unknown;
		try {
			jsonBody = text ? JSON.parse(text) : undefined;
		} catch {
			jsonBody = text;
		}

		if (!res.ok) {
			return { success: false, status: res.status, body: jsonBody };
		}

		return { success: true, status: res.status, body: jsonBody };
	} catch (err) {
		console.error('[uploadScoreToTachi] upload failed', err);
		return { success: false, status: 0, error: String(err) };
	}
}

export async function uploadScoresToTachi(scores: ApiScore[], token: string) {
	const k7 : ApiScore[] = [];
	const k14 : ApiScore[] = [];
	for (const score of scores) {
		switch (score.keymode) {
			case 5:
			case 7:
				k7.push(score);
				break;
			case 10:
			case 14:
				k14.push(score);
				break;
			default:
		}
	}
	if (k7.length > 0) {
		const res = await uploadScoresToTachiForKeymode(k7, token, '7K');
		if (!res.success) {
			console.error('[uploadScoresToTachi] 7K upload failed', res);
		}
	}
	if (k14.length > 0) {
		const res = await uploadScoresToTachiForKeymode(k14, token, '14K');
		if (!res.success) {
			console.error('[uploadScoresToTachi] 14K upload failed', res);
		}
	}
}
