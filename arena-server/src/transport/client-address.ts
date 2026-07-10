import { createHmac, randomBytes } from 'node:crypto';
import { isIP } from 'node:net';

export type AddressKey = string & { readonly __addressKey: unique symbol };

export interface ClientAddressResolver {
	resolve(input: Readonly<{ directPeer: string; forwardedFor: string | null }>): AddressKey;
}

type IpFamily = 4 | 6;
type ParsedIp = Readonly<{
	family: IpFamily;
	canonical: string;
	value: bigint;
}>;
type TrustedNetwork = Readonly<{
	family: IpFamily;
	prefix: number;
	network: bigint;
	canonical: string;
}>;

const MAX_FORWARDED_BYTES = 512;
const MAX_FORWARDED_ENTRIES = 8;
const INVALID_DIRECT_PEER = 'invalid-direct-peer';
const CIDR_ERROR = 'Invalid TRUSTED_PROXY_CIDRS configuration.';

export function parseTrustedProxyCidrs(value: string): readonly string[] {
	if (value.trim().length === 0) return [];
	try {
		const parts = value.split(',');
		if (parts.some((part) => part.trim().length === 0)) throw new Error(CIDR_ERROR);
		const networks = parts.map((part) => parseNetwork(part.trim()));
		const seen = new Set<string>();
		for (const network of networks) {
			if (seen.has(network.canonical)) throw new Error(CIDR_ERROR);
			seen.add(network.canonical);
		}
		return networks.map((network) => network.canonical);
	} catch {
		throw new Error(CIDR_ERROR);
	}
}

export function createClientAddressResolver(
	trustedProxyCidrs: readonly string[],
	options: Readonly<{ salt?: Uint8Array }> = {}
): ClientAddressResolver {
	const trustedNetworks = trustedProxyCidrs.map((cidr) => {
		try {
			return parseNetwork(cidr);
		} catch {
			throw new Error(CIDR_ERROR);
		}
	});
	const salt = Uint8Array.from(options.salt ?? randomBytes(32));
	if (salt.byteLength < 16) throw new Error('Client address salt is too short.');

	return {
		resolve(input): AddressKey {
			const direct = parseIp(input.directPeer);
			let selected = direct;
			if (
				direct !== undefined &&
				isTrusted(direct, trustedNetworks) &&
				input.forwardedFor !== null
			) {
				const forwarded = parseForwardedChain(input.forwardedFor);
				if (forwarded !== undefined) {
					for (let index = forwarded.length - 1; index >= 0; index -= 1) {
						if (selected === undefined || !isTrusted(selected, trustedNetworks)) break;
						selected = forwarded[index];
					}
				}
			}

			return createHmac('sha256', salt)
				.update(selected?.canonical ?? INVALID_DIRECT_PEER)
				.digest('hex') as AddressKey;
		}
	};
}

function parseForwardedChain(value: string): readonly ParsedIp[] | undefined {
	if (Buffer.byteLength(value, 'utf8') > MAX_FORWARDED_BYTES) return undefined;
	const parts = value.split(',');
	if (parts.length === 0 || parts.length > MAX_FORWARDED_ENTRIES) return undefined;
	const addresses: ParsedIp[] = [];
	for (const rawPart of parts) {
		const part = rawPart.trim();
		if (part.length === 0) return undefined;
		const parsed = parseIp(part);
		if (parsed === undefined) return undefined;
		addresses.push(parsed);
	}
	return addresses;
}

function parseNetwork(value: string): TrustedNetwork {
	const separator = value.lastIndexOf('/');
	if (separator <= 0 || separator === value.length - 1) throw new Error(CIDR_ERROR);
	const address = parseIp(value.slice(0, separator));
	const prefixText = value.slice(separator + 1);
	if (address === undefined || !/^\d+$/.test(prefixText)) throw new Error(CIDR_ERROR);
	const prefix = Number(prefixText);
	const bits = address.family === 4 ? 32 : 128;
	if (!Number.isSafeInteger(prefix) || prefix <= 0 || prefix > bits) throw new Error(CIDR_ERROR);
	const hostBits = BigInt(bits - prefix);
	const network = hostBits === 0n ? address.value : (address.value >> hostBits) << hostBits;
	const canonicalAddress = formatIp(address.family, network);
	return {
		family: address.family,
		prefix,
		network,
		canonical: `${canonicalAddress}/${prefix}`
	};
}

function parseIp(value: string): ParsedIp | undefined {
	const family = isIP(value);
	if (family === 4) {
		const octets = value.split('.').map(Number);
		if (octets.length !== 4) return undefined;
		let numeric = 0n;
		for (const octet of octets) numeric = (numeric << 8n) | BigInt(octet);
		return { family: 4, canonical: octets.join('.'), value: numeric };
	}
	if (family !== 6) return undefined;
	let canonical: string;
	try {
		const hostname = new URL(`http://[${value}]/`).hostname;
		canonical = hostname.slice(1, -1).toLowerCase();
	} catch {
		return undefined;
	}
	const groups = expandIpv6(canonical);
	if (groups === undefined) return undefined;
	let numeric = 0n;
	for (const group of groups) numeric = (numeric << 16n) | BigInt(group);
	return { family: 6, canonical, value: numeric };
}

function expandIpv6(value: string): readonly number[] | undefined {
	const halves = value.split('::');
	if (halves.length > 2) return undefined;
	const left = halves[0] === '' ? [] : halves[0]!.split(':');
	const right = halves.length === 1 || halves[1] === '' ? [] : halves[1]!.split(':');
	const missing = 8 - left.length - right.length;
	if ((halves.length === 1 && missing !== 0) || (halves.length === 2 && missing < 1)) {
		return undefined;
	}
	const groups = [...left, ...Array.from({ length: missing }, () => '0'), ...right];
	if (groups.length !== 8 || groups.some((group) => !/^[0-9a-f]{1,4}$/i.test(group))) {
		return undefined;
	}
	return groups.map((group) => Number.parseInt(group, 16));
}

function formatIp(family: IpFamily, value: bigint): string {
	if (family === 4) {
		return [24n, 16n, 8n, 0n].map((shift) => Number((value >> shift) & 0xffn)).join('.');
	}
	const groups = Array.from({ length: 8 }, (_, index) =>
		Number((value >> BigInt((7 - index) * 16)) & 0xffffn)
	);
	let bestStart = -1;
	let bestLength = 0;
	for (let index = 0; index < groups.length; ) {
		if (groups[index] !== 0) {
			index += 1;
			continue;
		}
		let end = index + 1;
		while (end < groups.length && groups[end] === 0) end += 1;
		if (end - index > bestLength) {
			bestStart = index;
			bestLength = end - index;
		}
		index = end;
	}
	if (bestLength < 2) return groups.map((group) => group.toString(16)).join(':');
	const left = groups
		.slice(0, bestStart)
		.map((group) => group.toString(16))
		.join(':');
	const right = groups
		.slice(bestStart + bestLength)
		.map((group) => group.toString(16))
		.join(':');
	return `${left}::${right}`;
}

function isTrusted(address: ParsedIp, networks: readonly TrustedNetwork[]): boolean {
	return networks.some((network) => {
		if (network.family !== address.family) return false;
		const bits = address.family === 4 ? 32 : 128;
		const hostBits = BigInt(bits - network.prefix);
		return (address.value >> hostBits) << hostBits === network.network;
	});
}
