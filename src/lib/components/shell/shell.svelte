<script lang="ts">
	import * as Sidebar from '../ui/sidebar';
	import Footer from './footer.svelte';
	import Header from './header.svelte';
	import AppSidebar from './sidebar/sidebar.svelte';
	import ScrollToTop from '../scroll-to-top/scroll-to-top.svelte';
	import { Elements } from '$lib/enums/elements';
	import { page } from '$app/stores';

	let { children } = $props();

	// Check if current page is homepage (with or without language prefix)
	const isHomepage = $derived($page.url.pathname === '/' || $page.url.pathname.match(/^\/[a-z]{2}-[A-Z]{2}\/?$/));

	const scrollableClasses = $derived(
		isHomepage
			? "relative flex grow flex-col overflow-x-hidden overflow-y-auto overflow-hidden bg-[url('/favicon.svg')] bg-no-repeat bg-local bg-position-[right_-5vw_bottom_10vh] bg-size-[120vh]"
			: "relative flex grow flex-col overflow-x-hidden overflow-y-auto overflow-hidden"
	);

	const mainClasses = $derived(
		isHomepage
			? "flex flex-auto grow flex-col items-center gap-8 p-4 bg-background/92 dark:bg-background/92 backdrop-blur-xs"
			: "flex flex-auto grow flex-col items-center gap-8 p-4"
	);
</script>


<Sidebar.Provider>
	<AppSidebar />
	<div class="flex h-svh w-full flex-col">
		<Header />
		<div
			id={Elements.ScrollableContent}
			class={scrollableClasses}
		>
			<main class={mainClasses}>
				{@render children?.()}
			</main>
			<Footer />
		</div>
		<ScrollToTop />
	</div>
</Sidebar.Provider>
