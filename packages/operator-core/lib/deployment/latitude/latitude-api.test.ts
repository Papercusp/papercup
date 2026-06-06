import { describe, it, expect, vi } from 'vitest';
import { createLatitudeApiClient, LatitudeApiError, pickInStockSite } from './latitude-api';

type Resp = { status: number; body: unknown };
function fetchMock(resp: Resp | ((url: string, init?: { method?: string; body?: string; headers?: Record<string, string> }) => Resp)) {
  return vi.fn(async (url: string, init?: { method?: string; body?: string; headers?: Record<string, string> }) => {
    const r = typeof resp === 'function' ? resp(url, init) : resp;
    return {
      status: r.status,
      async json() {
        return r.body;
      },
      async text() {
        return typeof r.body === 'string' ? r.body : JSON.stringify(r.body);
      },
    };
  });
}

const serverEnvelope = (over: Record<string, unknown> = {}) => ({
  data: { type: 'servers', id: 'sv_42', attributes: { status: 'on', primary_ipv4: '9.9.9.9', plan: { slug: 'c2-small-x86' }, ...over } },
});

describe('createLatitudeApiClient', () => {
  it('createServer POSTs the JSON:API envelope with Bearer auth and parses the response', async () => {
    const fetchImpl = fetchMock({ status: 201, body: serverEnvelope() });
    const client = createLatitudeApiClient({ apiKey: 'KEY', fetchImpl: fetchImpl as never });
    const server = await client.createServer({ project: 'p', plan: 'c2-small-x86', site: 'NYC', operating_system: 'ubuntu_22_04_x64_lts' });

    expect(server).toMatchObject({ id: 'sv_42', status: 'on', primary_ipv4: '9.9.9.9', planSlug: 'c2-small-x86' });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://api.latitude.sh/servers');
    expect(init?.method).toBe('POST');
    expect(init?.headers?.Authorization).toBe('Bearer KEY');
    expect(JSON.parse(init!.body!)).toEqual({
      data: { type: 'servers', attributes: { project: 'p', plan: 'c2-small-x86', site: 'NYC', operating_system: 'ubuntu_22_04_x64_lts' } },
    });
  });

  it('createServer throws LatitudeApiError on a non-2xx status', async () => {
    const client = createLatitudeApiClient({ apiKey: 'K', fetchImpl: fetchMock({ status: 422, body: { errors: ['bad plan'] } }) as never });
    await expect(client.createServer({ project: 'p', plan: 'x', site: 's', operating_system: 'o' })).rejects.toBeInstanceOf(LatitudeApiError);
  });

  it('getServer GETs /servers/{id} and parses', async () => {
    const fetchImpl = fetchMock({ status: 200, body: serverEnvelope({ status: 'deploying', primary_ipv4: undefined }) });
    const client = createLatitudeApiClient({ apiKey: 'K', fetchImpl: fetchImpl as never });
    const s = await client.getServer('sv_42');
    expect(s.status).toBe('deploying');
    expect(fetchImpl.mock.calls[0][0]).toBe('https://api.latitude.sh/servers/sv_42');
  });

  it('deleteServer DELETEs and accepts 204', async () => {
    const fetchImpl = fetchMock({ status: 204, body: '' });
    const client = createLatitudeApiClient({ apiKey: 'K', fetchImpl: fetchImpl as never });
    await expect(client.deleteServer('sv_42')).resolves.toBeUndefined();
    expect(fetchImpl.mock.calls[0][1]?.method).toBe('DELETE');
  });

  it('deleteServer throws on an unexpected status', async () => {
    const client = createLatitudeApiClient({ apiKey: 'K', fetchImpl: fetchMock({ status: 500, body: 'boom' }) as never });
    await expect(client.deleteServer('sv_42')).rejects.toBeInstanceOf(LatitudeApiError);
  });

  it('respects a custom baseUrl', async () => {
    const fetchImpl = fetchMock({ status: 201, body: serverEnvelope() });
    const client = createLatitudeApiClient({ apiKey: 'K', baseUrl: 'https://example.test/', fetchImpl: fetchImpl as never });
    await client.createServer({ project: 'p', plan: 'x', site: 's', operating_system: 'o' });
    expect(fetchImpl.mock.calls[0][0]).toBe('https://example.test/servers');
  });

  it('listPlans flattens regions[].locations.in_stock per plan slug', async () => {
    const fetchImpl = fetchMock({
      status: 200,
      body: {
        data: [
          {
            attributes: {
              slug: 'm4-metal-small',
              regions: [
                { name: 'United States', locations: { available: ['NYC', 'DAL'], in_stock: ['DAL'] } },
                { name: 'Germany', locations: { available: ['FRA'], in_stock: ['FRA'] } },
                { name: 'UK', locations: { available: ['LON'], in_stock: [] } },
              ],
            },
          },
          { attributes: { slug: 'no-regions' } },
        ],
      },
    });
    const client = createLatitudeApiClient({ apiKey: 'K', fetchImpl: fetchImpl as never });
    const plans = await client.listPlans();
    expect(fetchImpl.mock.calls[0][0]).toBe('https://api.latitude.sh/plans');
    expect(plans).toEqual([
      { slug: 'm4-metal-small', inStock: ['DAL', 'FRA'] },
      { slug: 'no-regions', inStock: [] },
    ]);
  });
});

describe('pickInStockSite', () => {
  const plans = [
    { slug: 'm4-metal-small', inStock: ['DAL', 'FRA', 'ASH'] },
    { slug: 'f4-metal-small', inStock: ['SAO2'] },
    { slug: 'dry-plan', inStock: [] },
  ];

  it('honors preference order among in-stock sites', () => {
    expect(pickInStockSite(plans, 'm4-metal-small', ['ASH', 'NYC', 'DAL'])).toBe('ASH');
  });

  it('falls back to the first in-stock site when no preferred site has stock', () => {
    expect(pickInStockSite(plans, 'm4-metal-small', ['NYC', 'CHI'])).toBe('DAL');
    expect(pickInStockSite(plans, 'f4-metal-small')).toBe('SAO2');
  });

  it('returns undefined for a dry or unknown plan', () => {
    expect(pickInStockSite(plans, 'dry-plan')).toBeUndefined();
    expect(pickInStockSite(plans, 'nope')).toBeUndefined();
  });
});
