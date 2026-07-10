import { describe, expect, test } from 'bun:test';
import path from 'node:path';

const smokePath = path.join(import.meta.dir, '..', '..', 'scripts', 'phase2-smoke.ts');

describe('Phase 2 scripted smoke', () => {
	test('runs the complete credential-free two-client contract', async () => {
		const smoke = Bun.spawn([process.execPath, smokePath], {
			cwd: path.join(import.meta.dir, '..', '..'),
			stdout: 'pipe',
			stderr: 'pipe'
		});
		const [exitCode, stdout, stderr] = await Promise.all([
			smoke.exited,
			Bun.readableStreamToText(smoke.stdout),
			Bun.readableStreamToText(smoke.stderr)
		]);

		expect(exitCode, stderr).toBe(0);
		expect(stdout).toContain('1. Anonymous protocol 1.0 browse');
		expect(stdout).toContain('6. Last accepted common selection is authoritative');
		expect(stdout).toContain('9. Targeted schedules reach Playing');
		expect(stdout).toContain('10. Hash mismatch cancels back to Selecting');
		expect(stdout).toContain('Phase 2 Arena smoke passed through WebSocket/JOSE.');
		expect(stderr).toBe('');
	}, 15_000);
});
