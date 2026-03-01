<script lang="ts">
	import { page } from '$app/state';
	import BasePage from '$lib/components/base-page/base-page.svelte';
	import Avatar from '$lib/components/avatar/avatar.svelte';
	import AppDataTable from '$lib/components/app-data-table/app-data-table.svelte';
	import { t } from '$lib/i18n';
	import { GET } from '$lib/api/helpers/request';
	import { userScores } from '../../../../api';
	import type { ScoreRow } from '$lib/server/scores/query';
	import type { TableConfiguration } from '$lib/models/table';
	import { columns, tableConfiguration } from './configurations';

	let profile = $derived(page.data.profile);
	let scores = $state<ScoreRow[]>(page.data.scores ?? []);
	let total = $state<number>(page.data.total ?? 0);
	let fetchInProgress = $state(false);

	let configuration = $derived<TableConfiguration<ScoreRow>>({
		...tableConfiguration,
		serverSide: {
			...tableConfiguration.serverSide,
			totalItems: total
		}
	});

	async function onPageIndexChanged(newIndex: number) {
		fetchInProgress = true;
		try {
			const limit = tableConfiguration.pageSize ?? 20;
			const offset = newIndex * limit;
			const result = await GET<{ scores: ScoreRow[]; total: number }>(
				userScores(profile.id),
				{ limit, offset }
			);
			scores = result.scores;
		} finally {
			fetchInProgress = false;
		}
	}
</script>

<BasePage title="players.profile.title" description="players.profile.description">
	<div class="flex flex-col gap-8">
		<!-- Profile header -->
		<div class="flex flex-col items-center gap-4 sm:flex-row sm:items-start">
			<Avatar src={profile.image ?? undefined} id={profile.id} size={96} styleClass="h-24 w-24 shrink-0" />
			<div class="flex flex-col justify-center">
				<h1 class="text-3xl font-bold">{profile.name}</h1>
			</div>
		</div>

		<!-- Scores table -->
		<section class="flex flex-col gap-4">
			<h2 class="text-xl font-semibold">{$t('players.profile.scores_title')}</h2>
			<AppDataTable
				{columns}
				data={scores}
				configuration={configuration}
				isLoading={fetchInProgress}
				pageIndexChanged={onPageIndexChanged}
			/>
		</section>
	</div>
</BasePage>

