import { describe, expect, test } from 'bun:test';

import { commandErrorCodes } from '../../src/protocol/errors.ts';
import { launchCancellationReasonSchema } from '../../src/protocol/messages.ts';
import { createOperationalMetrics } from '../../src/observability/operational-metrics.ts';

function value(rendered: string, sample: string): number {
	const match = rendered.match(
		new RegExp(`^${sample.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} ([^\\r\\n]+)$`, 'm')
	);
	if (match?.[1] === undefined) throw new Error(`Missing metric sample: ${sample}`);
	return Number(match[1]);
}

describe('OperationalMetrics', () => {
	test('renders every exact metric name and Prometheus type from bounded zero state', () => {
		const rendered = createOperationalMetrics().renderPrometheus();

		for (const [name, type] of [
			['arena_connections_current', 'gauge'],
			['arena_connections_total', 'counter'],
			['arena_rooms_current', 'gauge'],
			['arena_reserved_seats_current', 'gauge'],
			['arena_rounds_active', 'gauge'],
			['arena_rounds_started_total', 'counter'],
			['arena_rounds_finalized_total', 'counter'],
			['arena_rounds_cancelled_total', 'counter'],
			['arena_auth_failures_total', 'counter'],
			['arena_command_rejections_total', 'counter'],
			['arena_inventory_committed_bytes', 'gauge'],
			['arena_inventory_upload_seconds', 'histogram'],
			['arena_standings_dropped_total', 'counter'],
			['arena_websocket_closes_total', 'counter']
		] as const) {
			expect(rendered).toContain(`# TYPE ${name} ${type}\n`);
		}
		expect(value(rendered, 'arena_connections_current')).toBe(0);
		expect(value(rendered, 'arena_inventory_upload_seconds_count')).toBe(0);
	});

	test('updates monotonic counters and current gauges without dynamic labels', () => {
		const metrics = createOperationalMetrics();
		metrics.connectionOpened();
		metrics.connectionOpened();
		metrics.connectionClosed('normal');
		metrics.connectionClosed('policy');
		metrics.connectionClosed('overload');
		metrics.connectionClosed('restart');
		metrics.connectionClosed('error');
		metrics.setRooms(7);
		metrics.setReservedSeats(3);
		metrics.setRoundsActive(2);
		metrics.roundStarted();
		metrics.roundFinalized();
		metrics.roundCancelled('probe_timeout');
		metrics.authFailure('ticket_replayed');
		metrics.commandRejected('room_full');
		metrics.setInventoryCommittedBytes(4096);
		metrics.standingsDropped();
		const rendered = metrics.renderPrometheus();

		expect(value(rendered, 'arena_connections_current')).toBe(0);
		expect(value(rendered, 'arena_connections_total')).toBe(2);
		expect(value(rendered, 'arena_rooms_current')).toBe(7);
		expect(value(rendered, 'arena_reserved_seats_current')).toBe(3);
		expect(value(rendered, 'arena_rounds_active')).toBe(2);
		expect(value(rendered, 'arena_rounds_started_total')).toBe(1);
		expect(value(rendered, 'arena_rounds_finalized_total')).toBe(1);
		expect(value(rendered, 'arena_rounds_cancelled_total{reason="probe_timeout"}')).toBe(1);
		expect(value(rendered, 'arena_auth_failures_total{reason="ticket_replayed"}')).toBe(1);
		expect(value(rendered, 'arena_command_rejections_total{code="room_full"}')).toBe(1);
		expect(value(rendered, 'arena_inventory_committed_bytes')).toBe(4096);
		expect(value(rendered, 'arena_standings_dropped_total')).toBe(1);
		for (const closeClass of ['normal', 'policy', 'overload', 'restart', 'error']) {
			expect(value(rendered, `arena_websocket_closes_total{class="${closeClass}"}`)).toBe(1);
		}
	});

	test('initializes every closed label and maps runtime-unknown values to other', () => {
		const metrics = createOperationalMetrics();
		metrics.roundCancelled('SENTINEL-ROOM' as never);
		metrics.authFailure('SENTINEL-TICKET' as never);
		metrics.commandRejected('SENTINEL-COMMAND' as never);
		const rendered = metrics.renderPrometheus();

		for (const reason of [...launchCancellationReasonSchema.options, 'other']) {
			expect(rendered).toContain(`arena_rounds_cancelled_total{reason="${reason}"}`);
		}
		for (const reason of ['invalid_ticket', 'ticket_replayed', 'other']) {
			expect(rendered).toContain(`arena_auth_failures_total{reason="${reason}"}`);
		}
		for (const code of [...commandErrorCodes, 'other']) {
			expect(rendered).toContain(`arena_command_rejections_total{code="${code}"}`);
		}
		expect(value(rendered, 'arena_rounds_cancelled_total{reason="other"}')).toBe(1);
		expect(value(rendered, 'arena_auth_failures_total{reason="other"}')).toBe(1);
		expect(value(rendered, 'arena_command_rejections_total{code="other"}')).toBe(1);
		for (const sentinel of ['SENTINEL-ROOM', 'SENTINEL-TICKET', 'SENTINEL-COMMAND']) {
			expect(rendered).not.toContain(sentinel);
		}
	});

	test('records the fixed cumulative upload histogram buckets, count, and sum', () => {
		const metrics = createOperationalMetrics();
		for (const seconds of [0, 0.1, 0.2, 0.5, 3, 60, 61]) metrics.observeInventoryUpload(seconds);
		const rendered = metrics.renderPrometheus();

		for (const [bucket, expected] of [
			['0.1', 2],
			['0.25', 3],
			['0.5', 4],
			['1', 4],
			['2.5', 4],
			['5', 5],
			['10', 5],
			['30', 5],
			['60', 6],
			['+Inf', 7]
		] as const) {
			expect(value(rendered, `arena_inventory_upload_seconds_bucket{le="${bucket}"}`)).toBe(
				expected
			);
		}
		expect(value(rendered, 'arena_inventory_upload_seconds_count')).toBe(7);
		expect(value(rendered, 'arena_inventory_upload_seconds_sum')).toBeCloseTo(124.8);
	});

	test('rejects invalid gauge and observation values without reflecting them', () => {
		const metrics = createOperationalMetrics();
		for (const invalid of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
			expect(() => metrics.setRooms(invalid)).toThrow('Invalid Arena metric value.');
			expect(() => metrics.observeInventoryUpload(invalid)).toThrow('Invalid Arena metric value.');
		}
	});
});
