/**
 * vanity-proxy.test.ts — wildcard *.<VANITY_HOST> reverse-proxy routing.
 *
 * handleVanity is the externally-reachable edge that maps a vanity hostname to
 * a project's hidden *.pages.dev origin. The pure, security-relevant part is
 * the HOST GATING + subdomain extraction (anything not under VANITY_HOST is a
 * 404; the apex with no subdomain is a 404; an unknown/unprovisioned project is
 * a 404) and the upstream request construction (target host, hop-by-hop header
 * stripping, GET/HEAD bodyless rule). The DB lookup and the upstream fetch are
 * mocked, so no network/DB is touched — only the routing branches are pinned.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  getProjectByVanity: vi.fn(),
}));

vi.mock('./db.ts', () => ({ getProjectByVanity: h.getProjectByVanity }));

import { handleVanity } from './vanity-proxy.ts';

const VANITY_HOST = 'preview.papercuspai.com';
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const env = { VANITY_HOST, DB: {} as any } as any;

let fetchMock: ReturnType<typeof vi.fn>;
let lastTarget: string | undefined;
let lastInit: RequestInit | undefined;

beforeEach(() => {
  vi.clearAllMocks();
  lastTarget = undefined;
  lastInit = undefined;
  fetchMock = vi.fn(async (target: string, init: RequestInit) => {
    lastTarget = target;
    lastInit = init;
    return new Response('upstream-body', {
      status: 207,
      headers: { 'x-upstream': 'yes' },
    });
  });
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

const reqTo = (host: string, path = '/', method = 'GET', init: RequestInit = {}) =>
  handleVanity(new Request(`https://${host}${path}`, { method, ...init }), env);

describe('handleVanity host gating', () => {
  it('404s a host not under the vanity domain', async () => {
    const res = await reqTo('evil.example.com');
    expect(res.status).toBe(404);
    expect(h.getProjectByVanity).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('404s the apex vanity host itself (no subdomain to look up)', async () => {
    const res = await reqTo(VANITY_HOST);
    expect(res.status).toBe(404);
    expect(h.getProjectByVanity).not.toHaveBeenCalled();
  });

  it('404s a host that only suffix-matches without the dot boundary', async () => {
    // "notpreview.papercuspai.com" ends with the host string but not ".host"
    const res = await reqTo('x' + VANITY_HOST);
    expect(res.status).toBe(404);
    expect(h.getProjectByVanity).not.toHaveBeenCalled();
  });
});

describe('handleVanity project resolution', () => {
  it('404s when the project is unknown', async () => {
    h.getProjectByVanity.mockResolvedValue(null);
    const res = await reqTo(`my-app.${VANITY_HOST}`);
    expect(res.status).toBe(404);
    expect(h.getProjectByVanity).toHaveBeenCalledWith(env.DB, 'my-app');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('404s when the project has no cf_subdomain (not yet provisioned)', async () => {
    h.getProjectByVanity.mockResolvedValue({ cf_subdomain: null });
    const res = await reqTo(`my-app.${VANITY_HOST}`);
    expect(res.status).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('extracts a multi-label subdomain correctly', async () => {
    h.getProjectByVanity.mockResolvedValue(null);
    await reqTo(`a.b.${VANITY_HOST}`);
    expect(h.getProjectByVanity).toHaveBeenCalledWith(env.DB, 'a.b');
  });
});

describe('handleVanity upstream proxying', () => {
  beforeEach(() => {
    h.getProjectByVanity.mockResolvedValue({ cf_subdomain: 'proj-123.pages.dev' });
  });

  it('proxies to the project cf_subdomain, preserving path + query', async () => {
    const res = await reqTo(`my-app.${VANITY_HOST}`, '/foo/bar?q=1');
    expect(lastTarget).toBe('https://proj-123.pages.dev/foo/bar?q=1');
    // Upstream response is mirrored through.
    expect(res.status).toBe(207);
    expect(res.headers.get('x-upstream')).toBe('yes');
    expect(await res.text()).toBe('upstream-body');
  });

  it('forwards the request method to upstream', async () => {
    await reqTo(`my-app.${VANITY_HOST}`, '/', 'DELETE');
    expect(lastInit?.method).toBe('DELETE');
  });

  it('strips hop-by-hop + host headers before forwarding', async () => {
    await reqTo(`my-app.${VANITY_HOST}`, '/', 'GET', {
      headers: {
        connection: 'keep-alive',
        'transfer-encoding': 'chunked',
        upgrade: 'websocket',
        'x-keep-me': 'present',
      },
    });
    const fwd = lastInit!.headers as Headers;
    expect(fwd.get('connection')).toBeNull();
    expect(fwd.get('transfer-encoding')).toBeNull();
    expect(fwd.get('upgrade')).toBeNull();
    // host is always stripped (Request normalizes the URL host onto it)
    expect(fwd.get('host')).toBeNull();
    // non-hop-by-hop headers survive
    expect(fwd.get('x-keep-me')).toBe('present');
  });

  it('sends no body for GET (and HEAD) requests', async () => {
    await reqTo(`my-app.${VANITY_HOST}`, '/', 'GET');
    expect(lastInit?.body).toBeUndefined();
    await reqTo(`my-app.${VANITY_HOST}`, '/', 'HEAD');
    expect(lastInit?.body).toBeUndefined();
  });

  it('forwards a body for non-GET/HEAD methods', async () => {
    await reqTo(`my-app.${VANITY_HOST}`, '/', 'POST', { body: 'payload' });
    // body is forwarded (the original request body stream / value, not undefined)
    expect(lastInit?.body).not.toBeUndefined();
    expect(lastInit?.redirect).toBe('manual');
  });
});
