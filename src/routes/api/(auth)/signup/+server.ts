import { auth } from '$lib/server/auth/config';
import { json, type RequestHandler } from '@sveltejs/kit';
import { APIError } from 'better-auth';
import { env } from '$env/dynamic/private';

async function verifyTurnstile(token: string, ip: string | null): Promise<boolean> {
	const body = new URLSearchParams({
		secret: env.TURNSTILE_SECRET_KEY ?? '',
		response: token,
		...(ip ? { remoteip: ip } : {})
	});

	const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
		method: 'POST',
		body,
		headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
	});

	const data = (await res.json()) as { success: boolean };
	return data.success === true;
}

export const POST: RequestHandler = async ({ request }) => {
	try {
		const { name, email, password, turnstileToken } = await request.json();

		if (!name || !email || !password) {
			return json({ error: 'Name, email and password are required' }, { status: 400 });
		}

		if (!turnstileToken) {
			return json({ error: 'Captcha token missing' }, { status: 400 });
		}

		const ip = request.headers.get('CF-Connecting-IP') ?? request.headers.get('X-Forwarded-For');
		const valid = await verifyTurnstile(turnstileToken, ip);
		if (!valid) {
			return json({ error: 'Captcha verification failed' }, { status: 400 });
		}

		await auth.api.signUpEmail({
			body: { name, email, password }
		});

		return json({ success: true });
	} catch (error) {
		console.error('Sign-up error:', error);
		if (error instanceof APIError) {
			const status = typeof error.status === 'number' ? error.status : 400;
			return json({ error: error.message }, { status });
		}
		return json({ error: 'Internal server error' }, { status: 500 });
	}
};


