<script lang="ts">
	import { t } from '$lib/i18n';
	import Card from '$lib/components/ui/card/card.svelte';
	import CardContent from '$lib/components/ui/card/card-content.svelte';
	import CardDescription from '$lib/components/ui/card/card-description.svelte';
	import CardHeader from '$lib/components/ui/card/card-header.svelte';
	import CardTitle from '$lib/components/ui/card/card-title.svelte';
	import AppDataTable from '$lib/components/app-data-table/app-data-table.svelte';
	import { homepageConfig, type HomepageConfig } from './configurations/homepage.js';
	import { latestScoresColumns } from './latest-scores-columns.js';
	import type { LatestScoreRow } from '$lib/server/scores/query';
	import type { TableConfiguration } from '$lib/models/table';
	import { Download } from '@lucide/svelte';
	import Icon from '@iconify/svelte';

	interface GitHubRelease {
		tag_name: string;
		name: string;
		published_at: string;
		html_url: string;
	}

	interface Props {
		config?: HomepageConfig;
		latestScores?: LatestScoreRow[];
		total?: number;
		currentPage?: number;
		pageSize?: number;
		latestRelease?: GitHubRelease | null;
		pageIndexChanged?: (i: number) => void;
		pageSizeChanged?: (s: number) => void;
	}

	let {
		config = homepageConfig,
		latestScores = [],
		total = 0,
		currentPage = 0,
		pageSize = 20,
		latestRelease = null,
		pageIndexChanged,
		pageSizeChanged
	}: Props = $props();

	function formatDate(dateString: string): string {
		const date = new Date(dateString);
		const now = new Date();
		const diffInMs = now.getTime() - date.getTime();
		const diffInDays = Math.floor(diffInMs / (1000 * 60 * 60 * 24));

		if (diffInDays === 0) return $t('common.time.today');
		if (diffInDays === 1) return $t('common.time.yesterday');
		if (diffInDays < 7) {
			return $t('common.time.days_ago', { number: diffInDays });
		}
		if (diffInDays < 30) {
			const weeks = Math.floor(diffInDays / 7);
			return $t('common.time.weeks_ago', { number: weeks });
		}
		if (diffInDays < 365) {
			const months = Math.floor(diffInDays / 30);
			return $t('common.time.months_ago', { number: months });
		}
		const years = Math.floor(diffInDays / 365);
		return $t('common.time.years_ago', { number: years });
	}

	const tableConfiguration = $derived<TableConfiguration<LatestScoreRow>>({
		serverSide: { enabled: true, manualPagination: true, totalItems: total },
		pageSize,
		pageIndex: currentPage,
		sortingState: [{ id: 'date', desc: true }]
	});
</script>

<div class="container mx-auto max-w-6xl px-4 py-8">
	<div class="mb-16 text-center">
		<div class="mb-6">
			<h1
				class="from-primary to-primary/60 inline-block bg-linear-to-r bg-clip-text pb-3 -mb-3 text-4xl font-bold text-transparent md:text-6xl"
			>
				{$t(config.hero.title)}
			</h1>
		</div>
		<p class="text-muted-foreground mx-auto mb-8 max-w-3xl text-xl md:text-2xl">
			{$t(config.hero.description)}
		</p>
	</div>

	<!-- Download Section -->
	<div class="mb-16">
		<div class="mx-auto max-w-4xl space-y-8">
			<!-- Main Download Button -->
			<div class="flex flex-col items-center gap-3">
				<a
					href="https://github.com/Bobini1/RhythmGame/releases/latest"
					target="_blank"
					rel="noopener noreferrer"
					class="bg-primary text-primary-foreground hover:bg-primary/90 hover:scale-105 group flex items-center justify-center gap-3 rounded-xl px-10 py-5 text-xl font-bold shadow-lg transition-all"
				>
					<Download class="h-6 w-6 transition-transform group-hover:translate-y-0.5" />
					{$t('homepage.download.download_latest')}
				</a>
				{#if latestRelease}
					<div class="text-muted-foreground flex items-center gap-2 text-sm">
						<span class="font-medium">{latestRelease.tag_name}</span>
						<span>•</span>
						<span>{formatDate(latestRelease.published_at)}</span>
					</div>
				{/if}
				<p class="text-muted-foreground text-xs">
					{$t('homepage.download.available_for_windows_linux')}
				</p>
			</div>

			<!-- Alternative Installation Methods -->
			<Card>
				<CardHeader>
					<CardTitle>{$t('homepage.download.alternative_methods')}</CardTitle>
					<CardDescription>{$t('homepage.download.alternative_methods_description')}</CardDescription>
				</CardHeader>
				<CardContent>
					<div class="space-y-3">
						<!-- Nix Flake -->
						<div class="border-border flex items-center justify-between rounded-lg border p-4">
							<div class="flex items-center gap-3">
								<Icon icon="mdi:nix" class="text-primary h-7 w-7" />
								<div>
									<div class="font-medium">Nix Flake</div>
									<code class="text-muted-foreground text-sm">nix run github:Bobini1/RhythmGame</code>
								</div>
							</div>
						</div>

						<!-- AUR Package -->
						<div class="border-border flex items-center justify-between rounded-lg border p-4">
							<div class="flex items-center gap-3">
								<Icon icon="mdi:arch"  class="text-primary h-7 w-7" />
								<div>
									<div class="font-medium">{$t('homepage.download.aur')}</div>
									<code class="text-muted-foreground text-sm">paru -S rhythm-game-git</code>
								</div>
							</div>
						</div>
					</div>
				</CardContent>
			</Card>
		</div>
	</div>

	<!-- Latest scores -->
	{#if latestScores.length > 0 || total > 0}
		<div class="mb-16">
			<AppDataTable
				columns={latestScoresColumns}
				data={latestScores}
				configuration={tableConfiguration}
				pageIndexChanged={pageIndexChanged}
				pageSizeChanged={pageSizeChanged}
			>
				{#snippet headerLeft()}
					<h2 class="mb-4 text-2xl font-bold">{$t('homepage.latest_scores.latest_scores')}</h2>
				{/snippet}
			</AppDataTable>
		</div>
	{/if}
</div>
