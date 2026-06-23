/**
 * egress-probe.test.ts — the clean-IP gate (per-account egress distinctness + reputation).
 *
 * Reliability-critical: this gate stops you pinning an exit IP that shares an ASN/subnet with
 * another account (defeating per-account isolation) or that looks like a flagged datacenter/proxy.
 * All network is injected via ProbeDeps, so these run with NO live network — a queued fake fetch
 * gives deterministic per-account exit IPs (target is probed before the others' Promise.all, so
 * with exactly one "other" the call order is fixed).
 */
import { describe, expect, it } from 'vitest';
import { subnet24, probeEgress, testEgressForAccount, type IpReputation, type ProbeDeps } from './egress-probe';
import type { ClaudeAccount } from '../deployment/account-pool';

const acct = (id: string, egress?: { proxyUrl?: string; localAddress?: string }): ClaudeAccount =>
  ({ id, egress } as unknown as ClaudeAccount);

/** A fetch that returns the next IP in `ips` per call (the echo endpoint); null ⇒ throw (no route). */
function queuedFetch(ips: (string | null)[]): typeof fetch {
  let i = 0;
  return (async () => {
    const ip = ips[i++];
    if (ip == null) throw new Error('no route to echo');
    return {
      headers: { get: (k: string) => (k === 'content-type' ? 'application/json' : null) },
      json: async () => ({ ip }),
      text: async () => ip,
    } as unknown as Response;
  }) as unknown as typeof fetch;
}

/** Reputation keyed by exit IP; an unknown IP returns null (lookup miss). */
function repByIp(map: Record<string, { asn?: string; proxy?: boolean; hosting?: boolean }>): ProbeDeps['reputationLookup'] {
  return async (ip): Promise<IpReputation | null> => {
    const r = map[ip];
    if (!r) return null;
    return { proxy: !!r.proxy, hosting: !!r.hosting, flagged: !!(r.proxy || r.hosting), asn: r.asn, source: 'test' };
  };
}

describe('subnet24 — the /24 block of an IPv4', () => {
  it('extracts the first three octets', () => {
    expect(subnet24('1.2.3.4')).toBe('1.2.3');
    expect(subnet24('10.0.0.255')).toBe('10.0.0');
  });
  it('returns null for non-IPv4 or missing input', () => {
    expect(subnet24('1.2.3')).toBeNull(); // too few octets
    expect(subnet24('1.2.3.4.5')).toBeNull(); // too many
    expect(subnet24('1.2.3.x')).toBeNull(); // non-numeric octet
    expect(subnet24('')).toBeNull();
    expect(subnet24(null)).toBeNull();
    expect(subnet24(undefined)).toBeNull();
  });
});

describe('probeEgress — one account', () => {
  it('reports hasEgress=false for the default egress and resolves exit IP + reputation + asn', async () => {
    const probe = await probeEgress(acct('a'), {
      fetchImpl: queuedFetch(['203.0.113.7']),
      reputationLookup: repByIp({ '203.0.113.7': { asn: 'AS64500' } }),
    });
    expect(probe.hasEgress).toBe(false);
    expect(probe.exitIp).toBe('203.0.113.7');
    expect(probe.asn).toBe('AS64500');
    expect(probe.reputation?.flagged).toBe(false);
    expect(probe.error).toBeUndefined();
  });

  it('reports hasEgress=true and surfaces ignoredProxyUrl for a socks (non-http) proxy', async () => {
    const probe = await probeEgress(acct('a', { proxyUrl: 'socks5://p:1080' }), {
      fetchImpl: queuedFetch(['203.0.113.7']),
      reputationLookup: repByIp({ '203.0.113.7': { asn: 'AS1' } }),
    });
    expect(probe.hasEgress).toBe(true);
    expect(probe.ignoredProxyUrl).toBe('socks5://p:1080'); // socks ignored → default egress probed
    expect(probe.exitIp).toBe('203.0.113.7');
  });

  it('captures the error and leaves exitIp/reputation null when the echo fetch fails', async () => {
    const probe = await probeEgress(acct('a'), {
      fetchImpl: queuedFetch([null]), // throws
      reputationLookup: repByIp({}),
    });
    expect(probe.exitIp).toBeNull();
    expect(probe.reputation).toBeNull();
    expect(probe.asn).toBeNull();
    expect(probe.error).toBe('no route to echo');
  });

  it('leaves reputation null when the lookup misses', async () => {
    const probe = await probeEgress(acct('a'), {
      fetchImpl: queuedFetch(['198.51.100.9']),
      reputationLookup: repByIp({}), // no entry for this ip
    });
    expect(probe.exitIp).toBe('198.51.100.9');
    expect(probe.reputation).toBeNull();
    expect(probe.asn).toBeNull();
  });
});

describe('testEgressForAccount — distinctness gate', () => {
  it('returns null for an unknown account id', async () => {
    expect(await testEgressForAccount([acct('a')], 'nope', {})).toBeNull();
  });

  it('compareOthers=false reports distinct without probing the others', async () => {
    const res = await testEgressForAccount([acct('a'), acct('b')], 'a', {
      compareOthers: false,
      fetchImpl: queuedFetch(['1.1.1.1']),
      reputationLookup: repByIp({ '1.1.1.1': { asn: 'AS1' } }),
    });
    expect(res?.comparedOthers).toBe(false);
    expect(res?.distinctFromOthers).toBe(true);
    expect(res?.collisions).toEqual([]);
    expect(res?.clean).toBe(true); // exit ip, not flagged, distinct
  });

  it('flags an ASN collision with another account', async () => {
    const res = await testEgressForAccount([acct('a'), acct('b')], 'a', {
      fetchImpl: queuedFetch(['1.1.1.1', '2.2.2.2']), // target then the one other
      reputationLookup: repByIp({ '1.1.1.1': { asn: 'AS1' }, '2.2.2.2': { asn: 'AS1' } }),
    });
    expect(res?.collisions).toEqual([{ accountId: 'b', exitIp: '2.2.2.2', asn: 'AS1', reason: 'asn' }]);
    expect(res?.distinctFromOthers).toBe(false);
    expect(res?.clean).toBe(false);
  });

  it('flags a /24 subnet collision (different ASN, same subnet)', async () => {
    const res = await testEgressForAccount([acct('a'), acct('b')], 'a', {
      fetchImpl: queuedFetch(['1.1.1.1', '1.1.1.9']),
      reputationLookup: repByIp({ '1.1.1.1': { asn: 'AS1' }, '1.1.1.9': { asn: 'AS2' } }),
    });
    expect(res?.collisions).toEqual([{ accountId: 'b', exitIp: '1.1.1.9', asn: 'AS2', reason: 'subnet' }]);
    expect(res?.clean).toBe(false);
  });

  it('passes when the target is a distinct ASN AND subnet from the others', async () => {
    const res = await testEgressForAccount([acct('a'), acct('b')], 'a', {
      fetchImpl: queuedFetch(['1.1.1.1', '2.2.2.2']),
      reputationLookup: repByIp({ '1.1.1.1': { asn: 'AS1' }, '2.2.2.2': { asn: 'AS2' } }),
    });
    expect(res?.collisions).toEqual([]);
    expect(res?.distinctFromOthers).toBe(true);
    expect(res?.clean).toBe(true);
  });

  it('a flagged (datacenter/proxy) target is never clean even when distinct', async () => {
    const res = await testEgressForAccount([acct('a'), acct('b')], 'a', {
      fetchImpl: queuedFetch(['1.1.1.1', '2.2.2.2']),
      reputationLookup: repByIp({ '1.1.1.1': { asn: 'AS1', hosting: true }, '2.2.2.2': { asn: 'AS2' } }),
    });
    expect(res?.reputation?.flagged).toBe(true);
    expect(res?.distinctFromOthers).toBe(true);
    expect(res?.clean).toBe(false);
  });
});
