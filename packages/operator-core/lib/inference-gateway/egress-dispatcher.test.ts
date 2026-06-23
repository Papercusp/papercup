/**
 * egress-dispatcher.test.ts — the per-account egress dispatcher builder (per-account IP routing).
 *
 * Reliability-critical: a wrong dispatcher silently 502s EVERY request for an account. These pin
 * the scheme handling (only http(s) proxies are honored; a socks/non-http url is IGNORED, not
 * errored, and surfaced via ignoredProxyUrl), the cache-key shape, and every construction branch.
 * undici is injected (importUndici) so ProxyAgent/Agent construction is exercised without a real
 * network object.
 */
import { describe, expect, it } from 'vitest';
import { egressIsHttpProxy, egressCacheKey, buildEgressDispatcher } from './egress-dispatcher';
import type { AccountEgress } from '../deployment/account-pool';

/** A fake undici module: ProxyAgent/Agent record their constructor args + tag the instance. */
function fakeUndici() {
  const proxyArgs: string[] = [];
  const agentArgs: unknown[] = [];
  const mod = {
    ProxyAgent: class {
      kind = 'proxy' as const;
      constructor(public url: string) { proxyArgs.push(url); }
    },
    Agent: class {
      kind = 'agent' as const;
      constructor(public opts: unknown) { agentArgs.push(opts); }
    },
  };
  return { importUndici: async () => mod as never, proxyArgs, agentArgs };
}

describe('egressIsHttpProxy', () => {
  it('accepts http(s) schemes case-insensitively', () => {
    expect(egressIsHttpProxy('http://p:8080')).toBe(true);
    expect(egressIsHttpProxy('https://p:8080')).toBe(true);
    expect(egressIsHttpProxy('HTTP://p:8080')).toBe(true);
  });
  it('rejects non-http(s) schemes and empty/undefined', () => {
    expect(egressIsHttpProxy('socks5://p:1080')).toBe(false);
    expect(egressIsHttpProxy('ftp://p')).toBe(false);
    expect(egressIsHttpProxy('')).toBe(false);
    expect(egressIsHttpProxy(undefined)).toBe(false);
  });
});

describe('egressCacheKey — accountId|httpProxy|localAddress (non-http proxy collapses to empty)', () => {
  it('keys an http proxy', () => {
    expect(egressCacheKey('acc-1', { proxyUrl: 'http://p:8080' } as AccountEgress)).toBe('acc-1|http://p:8080|');
  });
  it('omits a non-http proxy from the key (so it does not falsely partition the cache)', () => {
    expect(egressCacheKey('acc-1', { proxyUrl: 'socks5://p:1080' } as AccountEgress)).toBe('acc-1||');
  });
  it('keys a bound source IP', () => {
    expect(egressCacheKey('acc-1', { localAddress: '10.0.0.7' } as AccountEgress)).toBe('acc-1||10.0.0.7');
  });
  it('keys both an http proxy and a localAddress', () => {
    expect(egressCacheKey('acc-1', { proxyUrl: 'http://p:8080', localAddress: '10.0.0.7' } as AccountEgress))
      .toBe('acc-1|http://p:8080|10.0.0.7');
  });
  it('keys an absent egress as just the accountId', () => {
    expect(egressCacheKey('acc-1', undefined)).toBe('acc-1||');
  });
});

describe('buildEgressDispatcher — construction branches', () => {
  it('returns {} (default shared egress) when egress is absent', async () => {
    expect(await buildEgressDispatcher(undefined, fakeUndici())).toEqual({});
  });

  it('returns {} when egress has neither proxy nor localAddress', async () => {
    expect(await buildEgressDispatcher({} as AccountEgress, fakeUndici())).toEqual({});
  });

  it('a non-http proxy alone is ignored (no dispatcher) and surfaced via ignoredProxyUrl', async () => {
    const u = fakeUndici();
    const res = await buildEgressDispatcher({ proxyUrl: 'socks5://p:1080' } as AccountEgress, u);
    expect(res).toEqual({ ignoredProxyUrl: 'socks5://p:1080' });
    expect(u.proxyArgs).toHaveLength(0); // never constructed a dispatcher
    expect(u.agentArgs).toHaveLength(0);
  });

  it('an http proxy builds a ProxyAgent and reports httpProxy (localAddress dropped)', async () => {
    const u = fakeUndici();
    const res = await buildEgressDispatcher({ proxyUrl: 'http://p:8080', localAddress: '10.0.0.7' } as AccountEgress, u);
    expect((res.dispatcher as unknown as { kind: string }).kind).toBe('proxy');
    expect(u.proxyArgs).toEqual(['http://p:8080']);
    expect(res.httpProxy).toBe('http://p:8080');
    expect(res.localAddress).toBeUndefined(); // proxy wins; bound IP not used
    expect(res.ignoredProxyUrl).toBeUndefined();
  });

  it('a localAddress alone builds a bound Agent', async () => {
    const u = fakeUndici();
    const res = await buildEgressDispatcher({ localAddress: '10.0.0.7' } as AccountEgress, u);
    expect((res.dispatcher as unknown as { kind: string }).kind).toBe('agent');
    expect(u.agentArgs).toEqual([{ connect: { localAddress: '10.0.0.7' } }]);
    expect(res.localAddress).toBe('10.0.0.7');
    expect(res.httpProxy).toBeUndefined();
  });

  it('a non-http proxy + a localAddress: binds the IP AND surfaces the ignored proxy', async () => {
    const u = fakeUndici();
    const res = await buildEgressDispatcher(
      { proxyUrl: 'socks5://p:1080', localAddress: '10.0.0.7' } as AccountEgress,
      u,
    );
    expect((res.dispatcher as unknown as { kind: string }).kind).toBe('agent');
    expect(res.localAddress).toBe('10.0.0.7');
    expect(res.ignoredProxyUrl).toBe('socks5://p:1080');
    expect(res.httpProxy).toBeUndefined();
  });
});
