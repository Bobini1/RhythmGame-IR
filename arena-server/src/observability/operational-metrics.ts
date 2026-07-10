import { commandErrorCodes, type CommandErrorCode } from '../protocol/errors.ts';
import {
	launchCancellationReasonSchema,
	type LaunchCancellationReason
} from '../protocol/messages.ts';

export type AuthFailureMetricReason = 'invalid_ticket' | 'ticket_replayed' | 'other';
export type MetricCommandCode = CommandErrorCode | 'other';
export type WebSocketCloseClass = 'normal' | 'policy' | 'overload' | 'restart' | 'error';

export interface OperationalMetrics {
	connectionOpened(): void;
	connectionClosed(closeClass: WebSocketCloseClass): void;
	setRooms(value: number): void;
	setReservedSeats(value: number): void;
	setRoundsActive(value: number): void;
	roundStarted(): void;
	roundFinalized(): void;
	roundCancelled(reason: LaunchCancellationReason): void;
	authFailure(reason: AuthFailureMetricReason): void;
	commandRejected(code: MetricCommandCode): void;
	setInventoryCommittedBytes(value: number): void;
	observeInventoryUpload(seconds: number): void;
	standingsDropped(): void;
	renderPrometheus(): string;
}

const launchReasons = [...launchCancellationReasonSchema.options, 'other'] as const;
const authReasons = ['invalid_ticket', 'ticket_replayed', 'other'] as const;
const commandCodes = [...commandErrorCodes, 'other'] as const;
const closeClasses = ['normal', 'policy', 'overload', 'restart', 'error'] as const;
const uploadBuckets = [0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60] as const;

class InMemoryOperationalMetrics implements OperationalMetrics {
	#connectionsCurrent = 0;
	#connectionsTotal = 0;
	#roomsCurrent = 0;
	#reservedSeatsCurrent = 0;
	#roundsActive = 0;
	#roundsStarted = 0;
	#roundsFinalized = 0;
	readonly #roundsCancelled = zeroMap(launchReasons);
	readonly #authFailures = zeroMap(authReasons);
	readonly #commandRejections = zeroMap(commandCodes);
	#inventoryCommittedBytes = 0;
	readonly #uploadBucketCounts = uploadBuckets.map(() => 0);
	#uploadCount = 0;
	#uploadSum = 0;
	#standingsDropped = 0;
	readonly #websocketCloses = zeroMap(closeClasses);

	connectionOpened(): void {
		this.#connectionsCurrent += 1;
		this.#connectionsTotal = increment(this.#connectionsTotal);
	}

	connectionClosed(closeClass: WebSocketCloseClass): void {
		this.#connectionsCurrent = Math.max(0, this.#connectionsCurrent - 1);
		incrementMap(this.#websocketCloses, normalize(closeClass, closeClasses));
	}

	setRooms(value: number): void {
		this.#roomsCurrent = metricInteger(value);
	}

	setReservedSeats(value: number): void {
		this.#reservedSeatsCurrent = metricInteger(value);
	}

	setRoundsActive(value: number): void {
		this.#roundsActive = metricInteger(value);
	}

	roundStarted(): void {
		this.#roundsStarted = increment(this.#roundsStarted);
	}

	roundFinalized(): void {
		this.#roundsFinalized = increment(this.#roundsFinalized);
	}

	roundCancelled(reason: LaunchCancellationReason): void {
		incrementMap(this.#roundsCancelled, normalize(reason, launchReasons));
	}

	authFailure(reason: AuthFailureMetricReason): void {
		incrementMap(this.#authFailures, normalize(reason, authReasons));
	}

	commandRejected(code: MetricCommandCode): void {
		incrementMap(this.#commandRejections, normalize(code, commandCodes));
	}

	setInventoryCommittedBytes(value: number): void {
		this.#inventoryCommittedBytes = metricInteger(value);
	}

	observeInventoryUpload(seconds: number): void {
		metricNumber(seconds);
		for (let index = 0; index < uploadBuckets.length; index += 1) {
			if (seconds <= uploadBuckets[index]!) {
				this.#uploadBucketCounts[index] = increment(this.#uploadBucketCounts[index]!);
			}
		}
		this.#uploadCount = increment(this.#uploadCount);
		this.#uploadSum += seconds;
	}

	standingsDropped(): void {
		this.#standingsDropped = increment(this.#standingsDropped);
	}

	renderPrometheus(): string {
		const lines: string[] = [];
		plain(lines, 'arena_connections_current', 'gauge', this.#connectionsCurrent);
		plain(lines, 'arena_connections_total', 'counter', this.#connectionsTotal);
		plain(lines, 'arena_rooms_current', 'gauge', this.#roomsCurrent);
		plain(lines, 'arena_reserved_seats_current', 'gauge', this.#reservedSeatsCurrent);
		plain(lines, 'arena_rounds_active', 'gauge', this.#roundsActive);
		plain(lines, 'arena_rounds_started_total', 'counter', this.#roundsStarted);
		plain(lines, 'arena_rounds_finalized_total', 'counter', this.#roundsFinalized);
		labeled(
			lines,
			'arena_rounds_cancelled_total',
			'counter',
			'reason',
			launchReasons,
			this.#roundsCancelled
		);
		labeled(
			lines,
			'arena_auth_failures_total',
			'counter',
			'reason',
			authReasons,
			this.#authFailures
		);
		labeled(
			lines,
			'arena_command_rejections_total',
			'counter',
			'code',
			commandCodes,
			this.#commandRejections
		);
		plain(lines, 'arena_inventory_committed_bytes', 'gauge', this.#inventoryCommittedBytes);
		lines.push('# TYPE arena_inventory_upload_seconds histogram');
		for (let index = 0; index < uploadBuckets.length; index += 1) {
			lines.push(
				`arena_inventory_upload_seconds_bucket{le="${uploadBuckets[index]}"} ${this.#uploadBucketCounts[index]}`
			);
		}
		lines.push(`arena_inventory_upload_seconds_bucket{le="+Inf"} ${this.#uploadCount}`);
		lines.push(`arena_inventory_upload_seconds_sum ${this.#uploadSum}`);
		lines.push(`arena_inventory_upload_seconds_count ${this.#uploadCount}`);
		plain(lines, 'arena_standings_dropped_total', 'counter', this.#standingsDropped);
		labeled(
			lines,
			'arena_websocket_closes_total',
			'counter',
			'class',
			closeClasses,
			this.#websocketCloses
		);
		return `${lines.join('\n')}\n`;
	}
}

export function createOperationalMetrics(): OperationalMetrics {
	return new InMemoryOperationalMetrics();
}

export const NOOP_OPERATIONAL_METRICS: OperationalMetrics = Object.freeze({
	connectionOpened: () => undefined,
	connectionClosed: () => undefined,
	setRooms: () => undefined,
	setReservedSeats: () => undefined,
	setRoundsActive: () => undefined,
	roundStarted: () => undefined,
	roundFinalized: () => undefined,
	roundCancelled: () => undefined,
	authFailure: () => undefined,
	commandRejected: () => undefined,
	setInventoryCommittedBytes: () => undefined,
	observeInventoryUpload: () => undefined,
	standingsDropped: () => undefined,
	renderPrometheus: () => ''
});

function zeroMap<const T extends readonly string[]>(values: T): Map<T[number], number> {
	return new Map(values.map((value) => [value, 0]));
}

function normalize<const T extends readonly string[]>(value: string, allowed: T): T[number] {
	return (allowed.includes(value as T[number]) ? value : 'other') as T[number];
}

function increment(value: number): number {
	return Math.min(Number.MAX_SAFE_INTEGER, value + 1);
}

function incrementMap<T extends string>(values: Map<T, number>, key: T): void {
	values.set(key, increment(values.get(key) ?? 0));
}

function metricNumber(value: number): number {
	if (!Number.isFinite(value) || value < 0) throw new Error('Invalid Arena metric value.');
	return value;
}

function metricInteger(value: number): number {
	metricNumber(value);
	if (!Number.isSafeInteger(value)) throw new Error('Invalid Arena metric value.');
	return value;
}

function plain(lines: string[], name: string, type: 'counter' | 'gauge', value: number): void {
	lines.push(`# TYPE ${name} ${type}`, `${name} ${value}`);
}

function labeled<const T extends readonly string[]>(
	lines: string[],
	name: string,
	type: 'counter',
	label: string,
	labels: T,
	values: ReadonlyMap<T[number], number>
): void {
	lines.push(`# TYPE ${name} ${type}`);
	for (const value of labels) lines.push(`${name}{${label}="${value}"} ${values.get(value) ?? 0}`);
}
