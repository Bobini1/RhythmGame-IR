import { PUBLIC_AVATAR_SEED_SALT } from '$env/static/public';

export function imageUrlFromUserId(userId: number, format: 'svg' | 'png' = 'svg') {
	return `https://api.dicebear.com/9.x/adventurer/${format}?seed=${PUBLIC_AVATAR_SEED_SALT}${userId}`;
}
