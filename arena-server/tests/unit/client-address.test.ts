import { describe, expect, test } from 'bun:test';

import {
	createClientAddressResolver,
	parseTrustedProxyCidrs
} from '../../src/transport/client-address.ts';

const fixedSalt = Uint8Array.from({ length: 32 }, (_, index) => index + 1);

describe('ClientAddressResolver', () => {
	test('canonicalizes equivalent IPv4 and IPv6 addresses before hashing', () => {
		const resolver = createClientAddressResolver([], { salt: fixedSalt });

		expect(resolver.resolve({ directPeer: '127.0.0.1', forwardedFor: null })).toBe(
			resolver.resolve({ directPeer: '127.0.0.1', forwardedFor: null })
		);
		expect(resolver.resolve({ directPeer: '2001:0db8:0:0:0:0:0:1', forwardedFor: null })).toBe(
			resolver.resolve({ directPeer: '2001:db8::1', forwardedFor: null })
		);
		expect(resolver.resolve({ directPeer: '127.0.0.1', forwardedFor: null })).toMatch(
			/^[0-9a-f]{64}$/
		);
		expect(resolver.resolve({ directPeer: '127.0.0.1', forwardedFor: null })).not.toContain(
			'127.0.0.1'
		);
	});

	test('uses a forwarded chain only from a trusted direct peer and strips trusted hops right-to-left', () => {
		const resolver = createClientAddressResolver(
			parseTrustedProxyCidrs('10.0.0.0/8, 2001:db8:ffff::/48'),
			{ salt: fixedSalt }
		);
		const expectedClient = resolver.resolve({ directPeer: '198.51.100.7', forwardedFor: null });

		expect(
			resolver.resolve({
				directPeer: '10.0.0.4',
				forwardedFor: '198.51.100.7, 10.1.0.2, 10.2.0.3'
			})
		).toBe(expectedClient);
		expect(
			resolver.resolve({
				directPeer: '2001:db8:ffff::2',
				forwardedFor: '198.51.100.7, 2001:db8:ffff::1'
			})
		).toBe(expectedClient);

		const untrusted = resolver.resolve({
			directPeer: '203.0.113.9',
			forwardedFor: '198.51.100.7'
		});
		expect(untrusted).toBe(resolver.resolve({ directPeer: '203.0.113.9', forwardedFor: null }));
	});

	test('accepts the exact forwarded bounds and falls back for malformed or ambiguous chains', () => {
		const resolver = createClientAddressResolver(parseTrustedProxyCidrs('10.0.0.0/8'), {
			salt: fixedSalt
		});
		const direct = resolver.resolve({ directPeer: '10.0.0.1', forwardedFor: null });
		const eight = Array.from({ length: 8 }, (_, index) => `198.51.100.${index + 1}`).join(',');
		const exactBytes = `198.51.100.1${' '.repeat(512 - '198.51.100.1'.length)}`;

		expect(resolver.resolve({ directPeer: '10.0.0.1', forwardedFor: eight })).not.toBe(direct);
		expect(resolver.resolve({ directPeer: '10.0.0.1', forwardedFor: exactBytes })).not.toBe(direct);

		for (const forwardedFor of [
			`${eight},198.51.100.9`,
			`${exactBytes} `,
			'198.51.100.1,,10.0.0.2',
			'198.51.100.1, not-an-ip',
			'198.51.100.1:443',
			'[2001:db8::1]',
			'fe80::1%eth0',
			'proxy.example.test'
		]) {
			expect(resolver.resolve({ directPeer: '10.0.0.1', forwardedFor })).toBe(direct);
		}
	});

	test('validates and canonicalizes configured CIDRs without reflecting bad input', () => {
		expect(parseTrustedProxyCidrs('')).toEqual([]);
		expect(parseTrustedProxyCidrs('10.1.2.3/8, 2001:0db8::/32')).toEqual([
			'10.0.0.0/8',
			'2001:db8::/32'
		]);

		for (const value of [
			'0.0.0.0/0',
			'::/0',
			'10.0.0.0/8,10.1.2.3/8',
			'10.0.0.1',
			'10.0.0.0/33',
			'2001:db8::/129',
			'proxy.example.test/24',
			'10.0.0.0/8,',
			'198.51.100.77/SECRET'
		]) {
			try {
				parseTrustedProxyCidrs(value);
				throw new Error('expected rejection');
			} catch (error) {
				expect(String(error)).not.toContain(value);
			}
		}
	});

	test('uses a process-specific salt by default', () => {
		const first = createClientAddressResolver([]);
		const second = createClientAddressResolver([]);
		const input = { directPeer: '192.0.2.42', forwardedFor: null } as const;

		expect(first.resolve(input)).not.toBe(second.resolve(input));
	});
});
