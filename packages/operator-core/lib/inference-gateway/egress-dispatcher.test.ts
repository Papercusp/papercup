/**
 * egress-dispatcher.test.ts — the per-account egress dispatcher builder (per-account IP routing).
 *
 * Reliability-critical: a wrong dispatcher silently 502s EVERY request for an account. These pin
 * the scheme handling (http(s) AND socks5/socks proxies are honored — WI-284; any OTHER scheme is
 * IGNORED, not errored, and surfaced via ignoredProxyUrl), the cache-key shape, and every
 * construction branch. undici is injected (importUndici) so ProxyAgent/Socks5ProxyAgent/Agent
 * construction is exercised without a real network object.
 */
import { describe, expect, it } from 'vitest';
import { egressIsHttpProxy, egressIsSocks5Proxy, egressIsSupportedProxy, egressCacheKey, buildEgressDispatcher } from './egress-dispatcher';
import type { AccountEgress } from '../deployment/account-pool';

/** A fake undici module: ProxyAgent/Socks5ProxyAgent/Agent record their constructor args + tag the instance. */
function fakeUndici() {
  const proxyArgs: string[] = [];
  const socksArgs: string[] = [];
  const agentArgs: unknown[] = [];
  const mod = {
    ProxyAgent: class {
      kind = 'proxy' as const;
      constructor(public url: string) { proxyArgs.push(url); }
    },
    Socks5ProxyAgent: class {
      kind = 'socks5' as const;
      constructor(public url: string) { socksArgs.push(url); }
    },
    Agent: class {
      kind = 'agent' as const;
      constructor(public opts: unknown) { agentArgs.push(opts); }
    },
  };
  return { importUndici: async () => mod as never, proxyArgs, socksArgs, agentArgs };
}

describe('egressIsHttpProxy', () => {
  it('accepts http(s) schemes case-insensitively', () => {
    expect(egressIsHttpProxy('http://p:8080')).toBe(true);
    expect(egressIsHttpProxy('https://p:8080')).toBe(true);
    expect(egressIsHttpProxy('HTTP://p:8080')).toBe(true);
  });
  it('rejects socks5/socks, other non-http(s) schemes, and empty/undefined', () => {
    expect(egressIsHttpProxy('socks5://p:1080')).toBe(false);
    expect(egressIsHttpProxy('socks://p:1080')).toBe(false);
    expect(egressIsHttpProxy('ftp://p')).toBe(false);
    expect(egressIsHttpProxy('')).toBe(false);
    expect(egressIsHttpProxy(undefined)).toBe(false);
  });
});

describe('egressIsSocks5Proxy (WI-284)', () => {
  it('accepts socks5:// and the bare socks:// alias, case-insensitively', () => {
    expect(egressIsSocks5Proxy('socks5://p:1080')).toBe(true);
    expect(egressIsSocks5Proxy('socks://p:1080')).toBe(true);
    expect(egressIsSocks5Proxy('SOCKS5://p:1080')).toBe(true);
  });
  it('rejects http(s), other non-socks schemes, and empty/undefined', () => {
    expect(egressIsSocks5Proxy('http://p:8080')).toBe(false);
    expect(egressIsSocks5Proxy('https://p:8080')).toBe(false);
    expect(egressIsSocks5Proxy('ftp://p')).toBe(false);
    expect(egressIsSocks5Proxy('')).toBe(false);
    expect(egressIsSocks5Proxy(undefined)).toBe(false);
  });
});

describe('egressIsSupportedProxy — the union this module actually routes through', () => {
  it('true for http(s) and socks5/socks; false for anything else', () => {
    expect(egressIsSupportedProxy('http://p:8080')).toBe(true);
    expect(egressIsSupportedProxy('socks5://p:1080')).toBe(true);
    expect(egressIsSupportedProxy('socks://p:1080')).toBe(true);
    expect(egressIsSupportedProxy('ftp://p')).toBe(false);
    expect(egressIsSupportedProxy(undefined)).toBe(false);
  });
});

describe('egressCacheKey — accountId|proxy|localAddress (an unsupported-scheme proxy collapses to empty)', () => {
  it('keys an http proxy', () => {
    expect(egressCacheKey('acc-1', { proxyUrl: 'http://p:8080' } as AccountEgress)).toBe('acc-1|http://p:8080|');
  });
  it('keys a socks5 proxy (WI-284: now honored, so it MUST partition the cache like an http proxy does)', () => {
    expect(egressCacheKey('acc-1', { proxyUrl: 'socks5://p:1080' } as AccountEgress)).toBe('acc-1|socks5://p:1080|');
  });
  it('omits an unsupported-scheme proxy from the key (so it does not falsely partition the cache)', () => {
    expect(egressCacheKey('acc-1', { proxyUrl: 'ftp://p' } as AccountEgress)).toBe('acc-1||');
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

  it('an unsupported-scheme proxy alone is ignored (no dispatcher) and surfaced via ignoredProxyUrl', async () => {
    const u = fakeUndici();
    const res = await buildEgressDispatcher({ proxyUrl: 'ftp://p' } as AccountEgress, u);
    expect(res).toEqual({ ignoredProxyUrl: 'ftp://p' });
    expect(u.proxyArgs).toHaveLength(0); // never constructed a dispatcher
    expect(u.socksArgs).toHaveLength(0);
    expect(u.agentArgs).toHaveLength(0);
  });

  it('an http proxy builds a ProxyAgent and reports httpProxy (localAddress dropped)', async () => {
    const u = fakeUndici();
    const res = await buildEgressDispatcher({ proxyUrl: 'http://p:8080', localAddress: '10.0.0.7' } as AccountEgress, u);
    expect((res.dispatcher as unknown as { kind: string }).kind).toBe('proxy');
    expect(u.proxyArgs).toEqual(['http://p:8080']);
    expect(res.httpProxy).toBe('http://p:8080');
    expect(res.socks5Proxy).toBeUndefined();
    expect(res.localAddress).toBeUndefined(); // proxy wins; bound IP not used
    expect(res.ignoredProxyUrl).toBeUndefined();
  });

  it('a socks5 proxy builds a Socks5ProxyAgent and reports socks5Proxy (localAddress dropped) — WI-284', async () => {
    const u = fakeUndici();
    const res = await buildEgressDispatcher({ proxyUrl: 'socks5://p:1080', localAddress: '10.0.0.7' } as AccountEgress, u);
    expect((res.dispatcher as unknown as { kind: string }).kind).toBe('socks5');
    expect(u.socksArgs).toEqual(['socks5://p:1080']);
    expect(res.socks5Proxy).toBe('socks5://p:1080');
    expect(res.httpProxy).toBeUndefined();
    expect(res.localAddress).toBeUndefined(); // proxy wins; bound IP not used
    expect(res.ignoredProxyUrl).toBeUndefined();
  });

  it('the bare socks:// alias also builds a Socks5ProxyAgent', async () => {
    const u = fakeUndici();
    const res = await buildEgressDispatcher({ proxyUrl: 'socks://p:1080' } as AccountEgress, u);
    expect((res.dispatcher as unknown as { kind: string }).kind).toBe('socks5');
    expect(res.socks5Proxy).toBe('socks://p:1080');
  });

  it('a localAddress alone builds a bound Agent', async () => {
    const u = fakeUndici();
    const res = await buildEgressDispatcher({ localAddress: '10.0.0.7' } as AccountEgress, u);
    expect((res.dispatcher as unknown as { kind: string }).kind).toBe('agent');
    expect(u.agentArgs).toEqual([{ connect: { localAddress: '10.0.0.7' } }]);
    expect(res.localAddress).toBe('10.0.0.7');
    expect(res.httpProxy).toBeUndefined();
    expect(res.socks5Proxy).toBeUndefined();
  });

  it('an unsupported-scheme proxy + a localAddress: binds the IP AND surfaces the ignored proxy', async () => {
    const u = fakeUndici();
    const res = await buildEgressDispatcher(
      { proxyUrl: 'ftp://p', localAddress: '10.0.0.7' } as AccountEgress,
      u,
    );
    expect((res.dispatcher as unknown as { kind: string }).kind).toBe('agent');
    expect(res.localAddress).toBe('10.0.0.7');
    expect(res.ignoredProxyUrl).toBe('ftp://p');
    expect(res.httpProxy).toBeUndefined();
    expect(res.socks5Proxy).toBeUndefined();
  });
});
