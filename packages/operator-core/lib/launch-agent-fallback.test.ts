/**
 * Unit tests for launchAgent's ENDPOINT-FALLBACK behavior (launch-agent.ts).
 *
 * The sibling `launch-agent.test.ts` already covers body-threading + the
 * happy path + the psu_not_installed → omp_not_installed remap. This file
 * fills the renderer-entry gaps that stub leaves open:
 *   - the same-origin → :3070 → :3055 endpoint ORDER (incl. the
 *     window-protocol gate on the same-origin prepend)
 *   - fall-through when an earlier endpoint connection-fails
 *   - last-error AGGREGATION across all endpoints failing (connection error,
 *     non-ok JSON body, and an unparseable "no body" response)
 *   - the psu_not_installed remap short-circuiting the remaining endpoints
 *
 * Hermetic: global `fetch` is mocked (no network). `window` is absent in the
 * vitest node env, so the same-origin endpoint is only present when a test
 * installs a stub `window.location`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { launchAgent } from './launch-agent';

const EP_3070 = 'http://localhost:3070/api/adv/sessions/launch-su';
const EP_3055 = 'http://localhost:3055/api/adv/sessions/launch-su';
const EP_SAME = '/api/adv/sessions/launch-su';

/** A Response-ish stub launchAgent's `r.json()` + `r.ok`/`r.status` consume. */
function res(opts: { ok?: boolean; status?: number; body: unknown }): Response {
  return {
    ok: opts.ok ?? true,
    status: opts.status ?? 200,
    json: async () => opts.body,
  } as unknown as Response;
}

let fetchMock: ReturnType<typeof vi.fn>;
const originalWindow = (globalThis as { window?: unknown }).window;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  if (originalWindow === undefined) delete (globalThis as { window?: unknown }).window;
  else (globalThis as { window?: unknown }).window = originalWindow;
  vi.clearAllMocks();
});

function urlsCalled(): string[] {
  return fetchMock.mock.calls.map((c) => c[0] as string);
}

describe('launchAgent — endpoint fallback ordering', () => {
  it('hits :3070 first and stops there on success (window absent → no same-origin)', async () => {
    fetchMock.mockResolvedValueOnce(res({ body: { status: 'ok' } }));

    const r = await launchAgent({ agent: 'claude', slug: 'papercup' });

    expect(r).toEqual({ ok: true });
    expect(urlsCalled()).toEqual([EP_3070]);
  });

  it('falls through :3070 → :3055 when the first endpoint connection-fails', async () => {
    fetchMock
      .mockRejectedValueOnce(new Error('ECONNREFUSED :3070'))
      .mockResolvedValueOnce(res({ body: { status: 'ok' } }));

    const r = await launchAgent({ agent: 'omp', slug: 'papercup' });

    expect(r.ok).toBe(true);
    expect(urlsCalled()).toEqual([EP_3070, EP_3055]);
  });

  it('prepends the same-origin endpoint FIRST under a http(s) window.location', async () => {
    (globalThis as { window?: unknown }).window = { location: { protocol: 'https:', host: 'app.example' } };
    fetchMock.mockResolvedValueOnce(res({ body: { status: 'ok' } }));

    await launchAgent({ agent: 'claude', slug: 'papercup' });

    // Relative path → browser resolves it against the current origin.
    expect(urlsCalled()).toEqual([EP_SAME]);
  });

  it('orders same-origin → :3070 → :3055 when the same-origin endpoint fails', async () => {
    (globalThis as { window?: unknown }).window = { location: { protocol: 'http:', host: 'localhost:3055' } };
    fetchMock
      .mockRejectedValueOnce(new Error('same-origin down'))
      .mockRejectedValueOnce(new Error(':3070 down'))
      .mockResolvedValueOnce(res({ body: { status: 'ok' } }));

    const r = await launchAgent({ agent: 'claude', slug: 'papercup' });

    expect(r.ok).toBe(true);
    expect(urlsCalled()).toEqual([EP_SAME, EP_3070, EP_3055]);
  });

  it('does NOT add the same-origin endpoint for a non-http window protocol (tauri/file)', async () => {
    (globalThis as { window?: unknown }).window = { location: { protocol: 'tauri:', host: 'localhost' } };
    fetchMock.mockResolvedValueOnce(res({ body: { status: 'ok' } }));

    await launchAgent({ agent: 'claude', slug: 'papercup' });

    expect(urlsCalled()).toEqual([EP_3070]);
  });
});

describe('launchAgent — last-error aggregation', () => {
  it('returns the LAST endpoint connection error when every endpoint throws', async () => {
    fetchMock
      .mockRejectedValueOnce(new Error('boom :3070'))
      .mockRejectedValueOnce(new Error('boom :3055'));

    const r = await launchAgent({ agent: 'claude', slug: 'papercup' });

    expect(r.ok).toBe(false);
    expect(r.error).toBe('boom :3055');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('surfaces the LAST server error message from non-ok JSON bodies', async () => {
    fetchMock
      .mockResolvedValueOnce(res({ ok: false, status: 500, body: { status: 'error', error: 'spawn failed' } }))
      .mockResolvedValueOnce(res({ ok: false, status: 500, body: { status: 'error', error: 'still failed' } }));

    const r = await launchAgent({ agent: 'omp', slug: 'papercup' });

    expect(r.ok).toBe(false);
    expect(r.error).toBe('still failed');
  });

  it('aggregates a "no body" HTTP error when the response is not JSON', async () => {
    const noBody = (status: number): Response =>
      ({ ok: false, status, json: async () => { throw new Error('not json'); } } as unknown as Response);
    fetchMock.mockResolvedValueOnce(noBody(502)).mockResolvedValueOnce(noBody(503));

    const r = await launchAgent({ agent: 'claude', slug: 'papercup' });

    expect(r.ok).toBe(false);
    expect(r.error).toBe('launch-su HTTP 503 (no body)');
  });

  it('keeps probing past a non-ok body and reports the connection error from the final endpoint', async () => {
    fetchMock
      .mockResolvedValueOnce(res({ ok: false, status: 500, body: { error: 'first failed' } }))
      .mockRejectedValueOnce(new Error('second unreachable'));

    const r = await launchAgent({ agent: 'claude', slug: 'papercup' });

    expect(r.ok).toBe(false);
    expect(r.error).toBe('second unreachable');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe('launchAgent — psu_not_installed short-circuits the remaining endpoints', () => {
  it('remaps + returns immediately on the FIRST endpoint (no further probes)', async () => {
    fetchMock.mockResolvedValueOnce(
      res({ ok: false, status: 200, body: { status: 'error', code: 'psu_not_installed', error: 'psu missing' } }),
    );

    const r = await launchAgent({ agent: 'codex', slug: 'papercup' });

    expect(r).toEqual({
      ok: false,
      code: 'omp_not_installed',
      error: 'psu missing',
      installCmd: 'bash apps/operator/scripts/install-standalone-mcp.sh',
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('remaps psu_not_installed when it arrives on a LATER endpoint', async () => {
    fetchMock
      .mockRejectedValueOnce(new Error('down'))
      .mockResolvedValueOnce(res({ body: { status: 'error', code: 'psu_not_installed', error: 'nope' } }));

    const r = await launchAgent({ agent: 'claude', slug: 'papercup' });

    expect(r.code).toBe('omp_not_installed');
    expect(r.installCmd).toBe('bash apps/operator/scripts/install-standalone-mcp.sh');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
