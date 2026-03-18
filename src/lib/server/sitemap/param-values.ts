import { queryScoreSummaries } from '$lib/server/api/score-summaries.queries';
import type { ParamValues } from 'super-sitemap';

async function getScoreSummaries() {
	return (await queryScoreSummaries({})).map((r) => {
		return { userId: r.userId, md5: r.md5 }
	});
}

export async function getSitemapParamValues(): Promise<ParamValues> {
    const summaries = await getScoreSummaries();
	  const md5s = new Set(summaries.map((r) => r.md5));
		const playerIds = new Set(summaries.map((r) => r.userId.toString()));
		const arrays = summaries.map((r) => [r.md5, r.userId.toString()]);


    return {
			'/[[lang=lang]]/charts/[md5=md5]': Array.from(md5s),
			'/[[lang=lang]]/players/[user_id=id]': Array.from(playerIds),
			'/[[lang=lang]]/charts/[md5=md5]/players/[user_id=id]/scores': arrays
		};
}


