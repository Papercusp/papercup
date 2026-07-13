/**
 * static-list-provider.test.ts — the StaticListProvider EgressProvider backend (B-PROV, WI-288).
 * Run: cd packages/operator-core && npx vitest run lib/inference-gateway/egress-providers/static-list-provider.test.ts
 */
import { describe, expect, it, vi } from 'vitest';
import { createStaticListProvider } from './static-list-provider';

describe('createStaticListProvider', () => {
  it('throws on an empty entries list', () => {
    expect(() => createStaticListProvider({ entries: [] })).toThrow(/non-empty/);
  });

  it('allocate hands out the next free entry and marks it assigned', async () => {
    const provider = createStaticListProvider({
      entries: [
        { id: 'ip-1', proxyUrl: 'http://10.0.0.1:3128' },
        { id: 'ip-2', proxyUrl: 'http://10.0.0.2:3128' },
      ],
    });
    const a1 = await provider.allocate('acct-a');
    expect(a1).toMatchObject({ id: 'ip-1', proxyUrl: 'http://10.0.0.1:3128', accountId: 'acct-a' });
    const a2 = await provider.allocate('acct-b');
    expect(a2).toMatchObject({ id: 'ip-2', accountId: 'acct-b' });
  });

  it('allocate is idempotent per accountId — a repeat call returns the SAME entry', async () => {
    const provider = createStaticListProvider({
      entries: [{ id: 'ip-1', proxyUrl: 'http://10.0.0.1:3128' }, { id: 'ip-2', proxyUrl: 'http://10.0.0.2:3128' }],
    });
    const first = await provider.allocate('acct-a');
    const second = await provider.allocate('acct-a');
    expect(second).toEqual(first);
  });

  it('allocate throws when the pool is exhausted', async () => {
    const provider = createStaticListProvider({ entries: [{ id: 'ip-1', proxyUrl: 'http://10.0.0.1:3128' }] });
    await provider.allocate('acct-a');
    await expect(provider.allocate('acct-b')).rejects.toThrow(/exhausted/);
  });

  it('release frees the entry back for reallocation', async () => {
    const provider = createStaticListProvider({ entries: [{ id: 'ip-1', proxyUrl: 'http://10.0.0.1:3128' }] });
    await provider.allocate('acct-a');
    await provider.release('ip-1');
    const reallocated = await provider.allocate('acct-b');
    expect(reallocated).toMatchObject({ id: 'ip-1', accountId: 'acct-b' });
  });

  it('release of an unknown/unassigned id does not throw (idempotent)', async () => {
    const provider = createStaticListProvider({ entries: [{ id: 'ip-1', proxyUrl: 'http://10.0.0.1:3128' }] });
    await expect(provider.release('ip-does-not-exist')).resolves.toBeUndefined();
  });

  it('list reports every entry with its current assignment (undefined = free)', async () => {
    const provider = createStaticListProvider({
      entries: [{ id: 'ip-1', proxyUrl: 'http://10.0.0.1:3128' }, { id: 'ip-2', proxyUrl: 'http://10.0.0.2:3128' }],
    });
    await provider.allocate('acct-a');
    const list = await provider.list();
    expect(list).toEqual([
      { id: 'ip-1', proxyUrl: 'http://10.0.0.1:3128', localAddress: undefined, accountId: 'acct-a', meta: undefined },
      { id: 'ip-2', proxyUrl: 'http://10.0.0.2:3128', localAddress: undefined, accountId: undefined, meta: undefined },
    ]);
  });

  it('healthcheck on an unknown id returns egress_allocation_not_found', async () => {
    const provider = createStaticListProvider({ entries: [{ id: 'ip-1', proxyUrl: 'http://10.0.0.1:3128' }] });
    const health = await provider.healthcheck('nope');
    expect(health).toEqual({ reachable: false, error: 'egress_allocation_not_found' });
  });

  it('healthcheck routes through the injected health-probe deps (echo mock)', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ ip: '9.9.9.9' }), { headers: { 'content-type': 'application/json' } }));
    const provider = createStaticListProvider(
      { entries: [{ id: 'ip-1', proxyUrl: 'http://10.0.0.1:3128' }] },
      { fetchImpl: fetchImpl as unknown as typeof fetch, importUndici: async () => ({ ProxyAgent: class {}, Socks5ProxyAgent: class {}, Agent: class {} }) as never },
    );
    const health = await provider.healthcheck('ip-1');
    expect(health).toEqual({ reachable: true, exitIp: '9.9.9.9' });
  });
});
