/**
 * Unit tests for defguard-client.ts.
 *
 * Two surfaces:
 *   1. The `deviceUsername` slug sanitizer (module-PRIVATE). It is observable
 *      through the public functions: `mintDefguardEnrollment` returns
 *      `defguardUsername`, and both mint/revoke build the request path as
 *      `/api/v1/user/<username>/…`. We assert the slug via that returned value
 *      and the captured fetch URL — no export needed.  (See `.property.test.ts`
 *      for the no-unsafe-char invariant over arbitrary deviceIds.)
 *   2. The no-token short-circuit: `DEFGUARD_API_TOKEN` is read into a
 *      module-level const at load time, so `mintDefguardEnrollment` /
 *      `revokeDefguardUser` return null / no-op without ANY fetch when it's
 *      unset. Because the const is load-time, env is set BEFORE import and the
 *      module is re-loaded per scenario via `vi.resetModules()`.
 *
 * Hermetic: global `fetch` is stubbed; no network, no real Defguard.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Mod = typeof import('./defguard-client');

const fetchMock = vi.fn();

/** A Response-ish stub for the `dg()` helper (reads res.ok/.status/.text()). */
function res(opts: { ok?: boolean; status?: number; body?: unknown }): Response {
  const text = opts.body === undefined ? '' : JSON.stringify(opts.body);
  return {
    ok: opts.ok ?? true,
    status: opts.status ?? 200,
    text: async () => text,
  } as unknown as Response;
}

/** Set env, reset module cache, re-import so module-level consts re-read env. */
async function loadWith(env: { token?: string; url?: string }): Promise<Mod> {
  if (env.token === undefined) delete process.env.DEFGUARD_API_TOKEN;
  else process.env.DEFGUARD_API_TOKEN = env.token;
  if (env.url === undefined) delete process.env.DEFGUARD_URL;
  else process.env.DEFGUARD_URL = env.url;
  // DEFGUARD_CONTROL_URL is a secondary source — clear it so it can't bleed in.
  delete process.env.DEFGUARD_CONTROL_URL;
  vi.resetModules();
  return import('./defguard-client');
}

const ORIGINAL_TOKEN = process.env.DEFGUARD_API_TOKEN;
const ORIGINAL_URL = process.env.DEFGUARD_URL;
const ORIGINAL_CTRL = process.env.DEFGUARD_CONTROL_URL;

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
  // Restore env exactly.
  if (ORIGINAL_TOKEN === undefined) delete process.env.DEFGUARD_API_TOKEN;
  else process.env.DEFGUARD_API_TOKEN = ORIGINAL_TOKEN;
  if (ORIGINAL_URL === undefined) delete process.env.DEFGUARD_URL;
  else process.env.DEFGUARD_URL = ORIGINAL_URL;
  if (ORIGINAL_CTRL === undefined) delete process.env.DEFGUARD_CONTROL_URL;
  else process.env.DEFGUARD_CONTROL_URL = ORIGINAL_CTRL;
});

describe('no DEFGUARD_API_TOKEN → null / no-op, never fetches', () => {
  it('mintDefguardEnrollment returns null without calling fetch', async () => {
    const { mintDefguardEnrollment } = await loadWith({ token: '' });
    const out = await mintDefguardEnrollment({
      deviceId: 'dev-123',
      userEmail: 'a@b.c',
      workspaceId: 'ws',
    });
    expect(out).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('mintDefguardEnrollment returns null when DEFGUARD_API_TOKEN is entirely unset', async () => {
    const { mintDefguardEnrollment } = await loadWith({ token: undefined });
    const out = await mintDefguardEnrollment({
      deviceId: 'dev-123',
      userEmail: '',
      workspaceId: 'ws',
    });
    expect(out).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('revokeDefguardUser is a no-op (resolves, no fetch) without a token', async () => {
    const { revokeDefguardUser } = await loadWith({ token: '' });
    await expect(revokeDefguardUser('dev-123')).resolves.toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('mintDefguardEnrollment — happy path + slug in URL/return', () => {
  it('creates the user then mints enrollment, returning the slugged username', async () => {
    // call 1: POST /api/v1/user → ok (empty body). call 2: start_enrollment → tokens.
    fetchMock
      .mockResolvedValueOnce(res({ ok: true, body: undefined }))
      .mockResolvedValueOnce(
        res({
          ok: true,
          body: { enrollment_token: 'tok-xyz', enrollment_url: 'https://mesh/enroll' },
        }),
      );

    const { mintDefguardEnrollment } = await loadWith({
      token: 'admin-bearer',
      url: 'https://mesh.example',
    });

    const out = await mintDefguardEnrollment({
      deviceId: 'ABCDEF0123456789extra', // 21 chars; slice(0,12) = ABCDEF012345
      userEmail: 'owner@example.com',
      workspaceId: 'ws-9',
    });

    expect(out).toEqual({
      controlUrl: 'https://mesh.example',
      enrollmentUrl: 'https://mesh/enroll',
      enrollmentToken: 'tok-xyz',
      defguardUsername: 'pcusp-ABCDEF012345',
    });

    // Two fetches: user create, then enrollment — both bear the slug + bearer.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [createUrl, createInit] = fetchMock.mock.calls[0];
    const [enrolUrl] = fetchMock.mock.calls[1];
    expect(createUrl).toBe('https://mesh.example/api/v1/user');
    expect((createInit as RequestInit).method).toBe('POST');
    expect((createInit as RequestInit).headers).toMatchObject({
      authorization: 'Bearer admin-bearer',
      'content-type': 'application/json',
    });
    // start_enrollment path embeds the slugged username.
    expect(enrolUrl).toBe('https://mesh.example/api/v1/user/pcusp-ABCDEF012345/start_enrollment');
  });

  it('strips unsafe characters out of the slug (only [A-Za-z0-9-] survive)', async () => {
    fetchMock
      .mockResolvedValueOnce(res({ ok: true }))
      .mockResolvedValueOnce(
        res({ ok: true, body: { enrollment_token: 't', enrollment_url: 'u' } }),
      );

    const { mintDefguardEnrollment } = await loadWith({ token: 'tk' });
    // deviceId with dots/slashes/spaces in the first 12 chars.
    const out = await mintDefguardEnrollment({
      deviceId: 'a.b/c d:e_f!ghijk',
      userEmail: '',
      workspaceId: 'w',
    });
    // slice(0,12) = "a.b/c d:e_f!" → strip non [A-Za-z0-9-] → "abcdef"
    expect(out?.defguardUsername).toBe('pcusp-abcdef');
    expect(out?.defguardUsername).toMatch(/^pcusp-[A-Za-z0-9-]*$/);
  });

  it('ignores a 409 on user-create (re-pair) and still mints enrollment', async () => {
    fetchMock
      // user create → 409 conflict (already exists)
      .mockResolvedValueOnce(res({ ok: false, status: 409, body: { error: 'exists' } }))
      // start_enrollment → ok
      .mockResolvedValueOnce(
        res({ ok: true, body: { enrollment_token: 't2', enrollment_url: 'u2' } }),
      );

    const { mintDefguardEnrollment } = await loadWith({ token: 'tk' });
    const out = await mintDefguardEnrollment({
      deviceId: 'dev0',
      userEmail: 'x@y.z',
      workspaceId: 'w',
    });
    expect(out?.enrollmentToken).toBe('t2');
    expect(out?.enrollmentUrl).toBe('u2');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('propagates a non-409 user-create failure (e.g. 500)', async () => {
    fetchMock.mockResolvedValueOnce(res({ ok: false, status: 500, body: { error: 'boom' } }));

    const { mintDefguardEnrollment } = await loadWith({ token: 'tk' });
    await expect(
      mintDefguardEnrollment({ deviceId: 'dev0', userEmail: '', workspaceId: 'w' }),
    ).rejects.toThrow(/500/);
    // Only the create was attempted; enrollment never reached.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('revokeDefguardUser — with token', () => {
  it('DELETEs the slugged user path', async () => {
    fetchMock.mockResolvedValueOnce(res({ ok: true }));

    const { revokeDefguardUser } = await loadWith({ token: 'tk', url: 'https://m' });
    await expect(revokeDefguardUser('Device#99zz!!')).resolves.toBeUndefined();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    // slice(0,12) = "Device#99zz!" → strip → "Device99zz"
    expect(url).toBe('https://m/api/v1/user/pcusp-Device99zz');
    expect((init as RequestInit).method).toBe('DELETE');
  });

  it('swallows a 404 on delete (already gone)', async () => {
    fetchMock.mockResolvedValueOnce(res({ ok: false, status: 404, body: { error: 'gone' } }));

    const { revokeDefguardUser } = await loadWith({ token: 'tk' });
    await expect(revokeDefguardUser('dev')).resolves.toBeUndefined();
  });

  it('propagates a non-404 delete failure', async () => {
    fetchMock.mockResolvedValueOnce(res({ ok: false, status: 500, body: { error: 'x' } }));

    const { revokeDefguardUser } = await loadWith({ token: 'tk' });
    await expect(revokeDefguardUser('dev')).rejects.toThrow(/500/);
  });
});
