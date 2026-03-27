#!/usr/bin/env bun
/**
 * Marks all pending migrations as already applied without running them.
 * Use this when tables were created via `drizzle-kit push` but
 * `__drizzle_migrations` has no records, causing `drizzle-kit migrate` to fail.
 */

import { readFileSync } from 'fs';
import postgres from 'postgres';

const url = process.env.DATABASE_URL;
if (!url) {
	console.error('DATABASE_URL is not set');
	process.exit(1);
}

const journal = JSON.parse(
	readFileSync('./src/lib/server/database/migrations/meta/_journal.json', 'utf8')
);

const sql = postgres(url);

try {
	await sql`CREATE SCHEMA IF NOT EXISTS drizzle`;
	await sql`
		CREATE TABLE IF NOT EXISTS drizzle.__drizzle_migrations (
			id serial PRIMARY KEY,
			hash text NOT NULL,
			created_at bigint
		)
	`;

	for (const entry of journal.entries) {
		const existing = await sql`
			SELECT id FROM drizzle.__drizzle_migrations WHERE hash = ${entry.tag}
		`;
		if (existing.length === 0) {
			await sql`
				INSERT INTO drizzle.__drizzle_migrations (hash, created_at)
				VALUES (${entry.tag}, ${entry.when})
			`;
			console.log(`Marked as applied: ${entry.tag}`);
		} else {
			console.log(`Already recorded: ${entry.tag}`);
		}
	}

	console.log('Done.');
} finally {
	await sql.end();
}
