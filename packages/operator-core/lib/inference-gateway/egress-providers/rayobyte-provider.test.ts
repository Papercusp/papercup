/**
 * rayobyte-provider.test.ts — the Rayobyte REST EgressProvider (B-PROV, WI-288). All network calls go
 * through an injected `fetchImpl` mock — no live Rayobyte account is exercised (see the module doc's
 * "NOT YET EXERCISED AGAINST A LIVE RAYOBYTE ACCOUNT" caveat).
 * Run: cd packages/operator-core && npx vitest run lib/inference-gateway/egress-providers/rayobyte-provider.test.ts
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRayobyteProvider } from './rayobyte-provider';

const jsonRes = (body: unknown, ok = true, status = 200) =>
  ({
    ok,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  }) as unknown as Response;

afterEach(() => {
  delete process.env.RAYOBYTE_API_KEY;
  vi.restoreAllMocks();
});

describe('createRayobyteProvider', () => {
  it('resolves the API key via apiKeyRef (env:) and sends it as a Bearer header', async () => {
    process.env.RAYOBYTE_API_KEY = 'secret-123';
    const fetchImpl = vi.fn(async () => jsonRes([{ id: 'p1', ip: '203.0.113.1', port: 3128 }]));
    const provider = createRayobyteProvider({ fetchImpl: fetchImpl as unknown as typeof fetch });
    await provider.list();
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://api.rayobyte.com/v1/proxies',
      expect.objectContaining({ headers: expect.objectContaining({ Authorization: 'Bearer secret-123' }) }),
    );
  });

  it('throws a clear error when the api key env var is unset', async () => {
    const provider = createRayobyteProvider({ fetchImpl: vi.fn() as unknown as typeof fetch });
    await expect(provider.list()).rejects.toThrow(/RAYOBYTE_API_KEY.*not set/);
  });

  it('list maps proxy records to EgressAllocation', async () => {
    process.env.RAYOBYTE_API_KEY = 'k';
    const fetchImpl = vi.fn(async () => jsonRes([{ id: 'p1', ip: '203.0.113.1', port: 3128, label: 'acct-a' }]));
    const provider = createRayobyteProvider({ fetchImpl: fetchImpl as unknown as typeof fetch });
    const list = await provider.list();
    expect(list).toEqual([
      { id: 'p1', proxyUrl: 'http://203.0.113.1:3128', accountId: 'acct-a', meta: { ip: '203.0.113.1', port: 3128 } },
    ]);
  });

  it('allocate reuses an unlabeled existing proxy instead of ordering a new one', async () => {
    process.env.RAYOBYTE_API_KEY = 'k';
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url).endsWith('/proxies')) return jsonRes([{ id: 'p1', ip: '203.0.113.1', port: 3128, label: null }]);
      if (String(url).includes('/proxies/p1/label') && init?.method === 'PATCH') return jsonRes({ ok: true });
      throw new Error(`unexpected fetch ${url}`);
    });
    const provider = createRayobyteProvider({ fetchImpl: fetchImpl as unknown as typeof fetch });
    const allocation = await provider.allocate('acct-a');
    expect(allocation).toMatchObject({ id: 'p1', proxyUrl: 'http://203.0.113.1:3128', accountId: 'acct-a' });
    expect(fetchImpl).toHaveBeenCalledWith(
      expect.stringContaining('/proxies/p1/label'),
      expect.objectContaining({ method: 'PATCH', body: JSON.stringify({ label: 'acct-a' }) }),
    );
    // Never hit /proxies/order since a free proxy existed.
    expect(fetchImpl).not.toHaveBeenCalledWith(expect.stringContaining('/proxies/order'), expect.anything());
  });

  it('allocate orders a fresh proxy when none are free', async () => {
    process.env.RAYOBYTE_API_KEY = 'k';
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url).endsWith('/proxies') && (!init || init.method === undefined)) return jsonRes([]);
      if (String(url).endsWith('/proxies/order')) return jsonRes({ id: 'p2', ip: '203.0.113.2', port: 3128 });
      throw new Error(`unexpected fetch ${url} ${init?.method}`);
    });
    const provider = createRayobyteProvider({ fetchImpl: fetchImpl as unknown as typeof fetch });
    const allocation = await provider.allocate('acct-b');
    expect(allocation).toMatchObject({ id: 'p2', proxyUrl: 'http://203.0.113.2:3128', accountId: 'acct-b' });
  });

  it('release PATCHes the label to null', async () => {
    process.env.RAYOBYTE_API_KEY = 'k';
    const fetchImpl = vi.fn(async () => jsonRes({ ok: true }));
    const provider = createRayobyteProvider({ fetchImpl: fetchImpl as unknown as typeof fetch });
    await provider.release('p1');
    expect(fetchImpl).toHaveBeenCalledWith(
      expect.stringContaining('/proxies/p1/label'),
      expect.objectContaining({ method: 'PATCH', body: JSON.stringify({ label: null }) }),
    );
  });

  it('release is idempotent — a 404 does not throw', async () => {
    process.env.RAYOBYTE_API_KEY = 'k';
    const fetchImpl = vi.fn(async () => jsonRes({ error: 'not found' }, false, 404));
    const provider = createRayobyteProvider({ fetchImpl: fetchImpl as unknown as typeof fetch });
    await expect(provider.release('does-not-exist')).resolves.toBeUndefined();
  });

  it('a non-2xx response throws with the status + body', async () => {
    process.env.RAYOBYTE_API_KEY = 'k';
    const fetchImpl = vi.fn(async () => jsonRes({ error: 'boom' }, false, 500));
    const provider = createRayobyteProvider({ fetchImpl: fetchImpl as unknown as typeof fetch });
    await expect(provider.list()).rejects.toThrow(/HTTP 500/);
  });

  it('healthcheck on an unknown id returns egress_allocation_not_found', async () => {
    process.env.RAYOBYTE_API_KEY = 'k';
    const fetchImpl = vi.fn(async () => jsonRes([]));
    const provider = createRayobyteProvider({ fetchImpl: fetchImpl as unknown as typeof fetch });
    const health = await provider.healthcheck('nope');
    expect(health).toEqual({ reachable: false, error: 'egress_allocation_not_found' });
  });

  it('respects a baseUrl override', async () => {
    process.env.RAYOBYTE_API_KEY = 'k';
    const fetchImpl = vi.fn(async () => jsonRes([]));
    const provider = createRayobyteProvider({ fetchImpl: fetchImpl as unknown as typeof fetch, baseUrl: 'https://custom.example.com/v2/' });
    await provider.list();
    expect(fetchImpl).toHaveBeenCalledWith('https://custom.example.com/v2/proxies', expect.anything());
  });
});
