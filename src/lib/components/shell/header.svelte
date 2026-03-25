<script lang="ts">
	import { t } from '$lib/i18n';
	import Icon from '@iconify/svelte';
	import ThemeSwitcher from '../theme-switcher/theme-switcher.svelte';
	import Button from '../ui/button/button.svelte';
	import SidebarTrigger from '../ui/sidebar/sidebar-trigger.svelte';
	import * as Tooltip from '../ui/tooltip';
	import { langHref } from '$lib/utils';
</script>

<header class="grid w-full grid-cols-2 border-b p-2">
	<div class="flex flex-row items-center gap-4">
		<Tooltip.Provider>
			<Tooltip.Root>
				<Tooltip.Trigger>
					<SidebarTrigger />
				</Tooltip.Trigger>
				<Tooltip.Content>
					<p>{$t('common.toggle_menu')}</p>
				</Tooltip.Content>
			</Tooltip.Root>
		</Tooltip.Provider>
		<h1 class="flex flex-row items-center gap-3 text-xl">
			<a href={langHref('/')}>{$t('common.brand.name')}</a>
		</h1>
	</div>
	<div class="flex flex-row items-center justify-end gap-2">
		<a href="https://discord.gg/bDxmuSzXBW" target="_blank">
			<Button variant="outline" size="icon">
				<Icon icon="simple-icons:discord" />
			</Button>
		</a>
		<a href="https://github.com/Bobini1/RhythmGame" target="_blank">
			<Button variant="outline" size="icon">
				<Icon icon="simple-icons:github" />
			</Button>
		</a>
		<ThemeSwitcher></ThemeSwitcher>
	</div>
</header>
