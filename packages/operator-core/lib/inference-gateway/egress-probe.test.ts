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

/**
 * EI-18664933641195210 — the probe MUST resolve egress the way the gateway routes: `egressPool` head
 * first, legacy singular `egress` as fallback. Reading `account.egress` alone made every pool-configured
 * account report `hasEgress:false` AND probe the box-default IP instead of its configured proxy — an
 * answer indistinguishable from a measured "this account has no egress / shares the box IP", which is
 * how four agents read a dead-proxy diagnosis off an instrument that never dialled a proxy.
 *
 * `proxyArgs` is the falsifier that prose cannot fake: it records the URL a ProxyAgent was actually
 * constructed with, so an empty array means the probe went direct.
 */
function fakeUndici() {
  const proxyArgs: string[] = [];
  const mod = {
    ProxyAgent: class {
      constructor(public url: string) { proxyArgs.push(url); }
    },
    Socks5ProxyAgent: class { constructor(public url: string) {} },
    Agent: class { constructor(public opts: unknown) {} },
  };
  return { importUndici: async () => mod as never, proxyArgs };
}

/** An account carrying the gateway's rotation pool rather than the legacy singular `egress`. */
const poolAcct = (id: string, pool: { proxyUrl?: string; localAddress?: string }[], legacy?: { proxyUrl?: string }): ClaudeAccount =>
  ({ id, egress: legacy, egressPool: pool } as unknown as ClaudeAccount);

describe('probeEgress — egressPool resolution (EI-18664933641195210)', () => {
  it('reports hasEgress=true and DIALS the pool head for a pool-configured account', async () => {
    const u = fakeUndici();
    const probe = await probeEgress(poolAcct('a', [{ proxyUrl: 'http://199.182.115.224:3128' }, {}]), {
      fetchImpl: queuedFetch(['203.0.113.9']),
      reputationLookup: repByIp({ '203.0.113.9': { asn: 'AS64500' } }),
      importUndici: u.importUndici,
    });
    expect(probe.hasEgress).toBe(true);
    // The probe went THROUGH the configured proxy, not direct. Empty ⇒ it silently used the box IP.
    expect(u.proxyArgs).toEqual(['http://199.182.115.224:3128']);
    expect(probe.egress).toEqual({ proxyUrl: 'http://199.182.115.224:3128' });
  });

  it('prefers the pool head over a legacy singular egress (the gateway routes on the pool)', async () => {
    const u = fakeUndici();
    const probe = await probeEgress(
      poolAcct('a', [{ proxyUrl: 'http://pool-head:3128' }, {}], { proxyUrl: 'http://legacy:3128' }),
      { fetchImpl: queuedFetch(['203.0.113.10']), reputationLookup: repByIp({}), importUndici: u.importUndici },
    );
    expect(u.proxyArgs).toEqual(['http://pool-head:3128']);
    expect(probe.egress).toEqual({ proxyUrl: 'http://pool-head:3128' });
  });

  it('falls back to the legacy singular egress when the pool is absent or empty', async () => {
    const u = fakeUndici();
    const probe = await probeEgress(poolAcct('a', [], { proxyUrl: 'http://legacy:3128' }), {
      fetchImpl: queuedFetch(['203.0.113.11']), reputationLookup: repByIp({}), importUndici: u.importUndici,
    });
    expect(probe.hasEgress).toBe(true);
    expect(u.proxyArgs).toEqual(['http://legacy:3128']);
  });

  it('still reports hasEgress=false when the pool head is the box-default `{}` entry', async () => {
    const u = fakeUndici();
    const probe = await probeEgress(poolAcct('a', [{}, { proxyUrl: 'http://second:3128' }]), {
      fetchImpl: queuedFetch(['203.0.113.12']), reputationLookup: repByIp({}), importUndici: u.importUndici,
    });
    // An empty head genuinely IS the box-default IP — this must stay false, or the alarm in (b) would
    // read "configured" for an account that really does exit bare.
    expect(probe.hasEgress).toBe(false);
    expect(u.proxyArgs).toEqual([]);
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

  it('reports hasEgress=true and does NOT ignore a socks5 proxy (WI-284: now routed, not skipped)', async () => {
    const probe = await probeEgress(acct('a', { proxyUrl: 'socks5://p:1080' }), {
      fetchImpl: queuedFetch(['203.0.113.7']),
      reputationLookup: repByIp({ '203.0.113.7': { asn: 'AS1' } }),
    });
    expect(probe.hasEgress).toBe(true);
    expect(probe.ignoredProxyUrl).toBeUndefined(); // socks5 is honored — the gate verifies the SAME
    // dispatcher the gateway would actually use, not a divergent copy that still treats it as unsupported
    expect(probe.exitIp).toBe('203.0.113.7');
  });

  it('reports hasEgress=true and surfaces ignoredProxyUrl for a genuinely unsupported scheme', async () => {
    const probe = await probeEgress(acct('a', { proxyUrl: 'ftp://p:1080' }), {
      fetchImpl: queuedFetch(['203.0.113.7']),
      reputationLookup: repByIp({ '203.0.113.7': { asn: 'AS1' } }),
    });
    expect(probe.hasEgress).toBe(true);
    expect(probe.ignoredProxyUrl).toBe('ftp://p:1080'); // unsupported scheme ignored → default egress probed
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
