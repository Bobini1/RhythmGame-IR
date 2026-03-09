/**
 * BigInt-aware JSON parse / stringify helpers.
 *
 * Standard JSON cannot represent integers beyond Number.MAX_SAFE_INTEGER.
 * We use `json-bigint` configured to produce native BigInt values so that
 * fields like `randomSequence` (int64[]) survive a round-trip without
 * precision loss.
 *
 * - `parseBigIntJson(text)` — parse a JSON string, converting integers that
 *   exceed safe-integer range to `BigInt`.
 * - `bigIntJsonResponse(data, init?)` — build a `Response` whose body is
 *   JSON-stringified with BigInt support (bigints become bare integers in the
 *   output, *not* strings).
 */
import JSONBigInt from 'json-bigint';

const jsonBigInt = JSONBigInt({ useNativeBigInt: true, alwaysParseAsBig: false });

/** Parse a raw JSON string, promoting large integers to native BigInt. */
export function parseBigIntJson(text: string): unknown {
	return jsonBigInt.parse(text);
}

/**
 * Stringify a value that may contain BigInt fields.
 * BigInt values are serialised as bare integer literals (no quotes).
 */
export function stringifyBigInt(value: unknown): string {
	return jsonBigInt.stringify(value);
}

/**
 * Build a JSON `Response` that correctly serialises BigInt values.
 * Drop-in replacement for SvelteKit's `json()` when the payload contains
 * BigInt fields.
 */
export function bigIntJsonResponse(data: unknown, init?: ResponseInit): Response {
	return new Response(stringifyBigInt(data), {
		...init,
		headers: {
			'content-type': 'application/json',
			...Object.fromEntries(new Headers(init?.headers).entries())
		}
	});
}

