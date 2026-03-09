export const ogirinalJSONParse = JSON.parse;

export interface JSONReviverContext {
	source: string;
}

const INTEGER_REGEX = /^-?\d+$/;

function isInteger(value: string) {
	return INTEGER_REGEX.test(value);
}

/**
 * Parse a JSON string with potential BigInt values.
 */
const parse: typeof ogirinalJSONParse = (text, reviver) => {
	return ogirinalJSONParse(
		text,
		// cannot use arrow function because we want to keep `this` context
		function reviveWithBigInt(key, value, context?: JSONReviverContext) {
			// eslint-disable-next-line @typescript-eslint/no-this-alias
			const obj = this;
			// @ts-expect-error Expected 3 arguments, but got 4.
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			const finalize = (val: any) => (reviver ? reviver.call(obj, key, val, context) : val);
			if (
				context?.source &&
				typeof value === 'number' &&
				typeof context?.source === 'string' &&
				(value < Number.MIN_SAFE_INTEGER || value > Number.MAX_SAFE_INTEGER) &&
				isInteger(context.source) &&
				BigInt(value) !== BigInt(context.source)
			) {
				return finalize(BigInt(context.source));
			}
			return finalize(value);
		}
	);
};

// Patch the default JSON.parse to support BigInt values.
JSON.parse = parse;

// This PATCH makes `JSON.stringify` support BigInt values.
// @ts-expect-error Property 'toJSON' does not exist on type 'BigInt'.ts(2339)
BigInt.prototype.toJSON = function toJSON() {
	// @ts-expect-error Property 'rawJSON' does not exist on type 'JSON'.
	return JSON.rawJSON(this.toString());
};

// Named export makes auto-imports in IDE easier.
const JSONBigInt = {
	parse,
	stringify: JSON.stringify
};
export default JSONBigInt;

/** Parse a raw JSON string, promoting large integers to native BigInt. */
export function parseBigIntJson(text: string): unknown {
	return JSONBigInt.parse(text);
}

/**
 * Stringify a value that may contain BigInt fields.
 * BigInt values are serialised as bare integer literals (no quotes).
 */
export function stringifyBigInt(value: unknown): string {
	return JSONBigInt.stringify(value);
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
