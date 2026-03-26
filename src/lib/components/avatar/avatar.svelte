<script lang="ts">
	import { createAvatar, type Style } from '@dicebear/core';
	import { adventurer } from '@dicebear/collection';
	import * as Avatar from '../ui/avatar';
	import { PUBLIC_AVATAR_SEED_SALT } from '$env/static/public';

	let {
		id,
		size,
		src,
		collection,
		styleClass
	}: {
		id?: string;
		size?: number;
		src?: string;
		collection?: Style<{
			size: number;
			seed: string;
		}>;
		styleClass?: string;
	} = $props();
	const avatar = $derived(
		src ??
			createAvatar(collection ?? adventurer, {
				size: size ?? 128,
				seed: PUBLIC_AVATAR_SEED_SALT + (id ?? crypto.randomUUID())
			}).toDataUri()
	);
</script>

<Avatar.Root class={styleClass} {id}>
	<Avatar.Image src={avatar} alt="Avatar" />
	<Avatar.Fallback></Avatar.Fallback>
</Avatar.Root>
