import type { RequestHandler } from '@sveltejs/kit';
import { json } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

// This endpoint returns a presigned PUT URL for an S3-compatible storage (Backblaze B2)
// It expects { filename, contentType } in the POST body and requires an authenticated user.

export const POST: RequestHandler = async (event) => {
	try {
		const session = event.locals.session;
		if (!session) return json({ error: 'Unauthorized' }, { status: 401 });

		const body = await event.request.json();

		const key = `user+${event.locals.user.id}+avatar`;

		const endpoint = env.B2_ENDPOINT;
		const bucket = env.B2_BUCKET;

		if (!bucket) {
			return json({ error: 'Bucket not configured (B2_BUCKET)' }, { status: 500 });
		}

		const accessKey = env.B2_ACCESS_KEY_ID;
		const secretKey = env.B2_SECRET_ACCESS_KEY;

		if (!accessKey || !secretKey) {
			return json({ error: 'Storage credentials not configured' }, { status: 500 });
		}

		// Create S3 client configured for Backblaze's S3-compatible endpoint
		const s3 = new S3Client({
			region: env.B2_REGION,
			endpoint,
			credentials: {
				accessKeyId: accessKey,
				secretAccessKey: secretKey
			},
			forcePathStyle: false
		});

		const publicUrl = `${env.CDN_URL}/${encodeURIComponent(key)}`;

		// Prepare a PutObjectCommand to sign
		const cmd = new PutObjectCommand({
			Bucket: bucket,
			Key: key,
			ContentType: body.contentType ?? 'application/octet-stream'
		});

		// Generate a presigned URL (default expiration 15 minutes)
		const signedUrl = await getSignedUrl(s3, cmd, { expiresIn: 15 * 60 });

		return json({ url: signedUrl, publicUrl });
	} catch (err) {
		console.error(err);
		return json({ error: 'Internal server error' }, { status: 500 });
	}
};
