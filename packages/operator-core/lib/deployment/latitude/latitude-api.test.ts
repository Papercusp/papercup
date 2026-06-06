import { describe, it, expect, vi } from 'vitest';
import { createLatitudeApiClient, LatitudeApiError } from './latitude-api';

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
});
