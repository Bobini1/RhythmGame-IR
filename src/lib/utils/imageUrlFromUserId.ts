import { PUBLIC_AVATAR_SEED_SALT } from '$env/static/public';

export function imageUrlFromUserId(userId: number) {
	return 'https://api.dicebear.com/9.x/adventurer/svg?seed=' + PUBLIC_AVATAR_SEED_SALT + userId;
}
