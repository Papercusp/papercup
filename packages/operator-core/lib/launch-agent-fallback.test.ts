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

/**
 * Both operator-selection env vars are cleared per test. Without this the
 * ORDER assertions below silently depend on the runner's environment — and a
 * vitest launched from inside an operator really does carry
 * `PAPERCUSP_HONO_PORT`, which is the whole point of the fallback under test.
 */
const ENV_KEYS = ['PAPERCUSP_OPERATOR_BASE', 'PAPERCUSP_HONO_PORT'] as const;
const savedEnv: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  for (const k of ENV_KEYS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  vi.unstubAllGlobals();
  if (originalWindow === undefined) delete (globalThis as { window?: unknown }).window;
  else (globalThis as { window?: unknown }).window = originalWindow;
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
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

  it('keeps probing past a non-ok body but reports the operator answer, not a later connection error', async () => {
    fetchMock
      .mockResolvedValueOnce(res({ ok: false, status: 500, body: { error: 'first failed' } }))
      .mockRejectedValueOnce(new Error('second unreachable'));

    const r = await launchAgent({ agent: 'claude', slug: 'papercup' });

    expect(r.ok).toBe(false);
    expect(r.error).toBe('first failed');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  // Owner #773 (2026-09-28): the hosted HUD's "New session" showed only
  // "Launch failed: Failed to fetch" — the localhost fallbacks, unreachable from
  // the owner's own browser, overwrote the portal's real refusal.
  it('a hosted browser sees the same-origin refusal, not the localhost "Failed to fetch"', async () => {
    (globalThis as { window?: unknown }).window = { location: { protocol: 'https:', host: 'app.example' } };
    fetchMock
      .mockResolvedValueOnce(res({ ok: false, status: 403, body: { ok: false, error: 'route_not_relayed' } }))
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockRejectedValueOnce(new TypeError('Failed to fetch'));

    const r = await launchAgent({ agent: 'claude', slug: 'papercup' });

    expect(r).toEqual({ ok: false, error: 'route_not_relayed' });
    expect(urlsCalled()).toEqual([EP_SAME, EP_3070, EP_3055]);
  });

  it('CALIBRATION: with no operator answer at all, the last transport error is still reported', async () => {
    (globalThis as { window?: unknown }).window = { location: { protocol: 'https:', host: 'app.example' } };
    fetchMock
      .mockRejectedValueOnce(new TypeError('portal down'))
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockRejectedValueOnce(new TypeError('Failed to fetch :3055'));

    const r = await launchAgent({ agent: 'claude', slug: 'papercup' });

    expect(r).toEqual({ ok: false, error: 'Failed to fetch :3055' });
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

const ep = (port: number) => `http://localhost:${port}/api/adv/sessions/launch-su`;

describe('launchAgent — a Node caller inside an operator targets THAT operator', () => {
  it('probes its own PAPERCUSP_HONO_PORT host BEFORE the bare :3070 release fallback', async () => {
    process.env.PAPERCUSP_HONO_PORT = '3170';
    fetchMock
      .mockRejectedValueOnce(new Error(':3170 down'))
      .mockRejectedValueOnce(new Error(':3070 down'))
      .mockResolvedValueOnce(res({ body: { status: 'ok' } }));

    const r = await launchAgent({ agent: 'claude', slug: 'papercup' });

    expect(r.ok).toBe(true);
    expect(urlsCalled()).toEqual([ep(3170), EP_3070, EP_3055]);
  });

  it('stops at its own operator on success — never reaching the release checkout', async () => {
    process.env.PAPERCUSP_HONO_PORT = '3170';
    fetchMock.mockResolvedValueOnce(res({ body: { status: 'ok' } }));

    await launchAgent({ agent: 'omp', slug: 'papercup' });

    expect(urlsCalled()).toEqual([ep(3170)]);
  });

  it('CALIBRATION: with neither env var set the order is unchanged (:3070 → :3055)', async () => {
    fetchMock
      .mockRejectedValueOnce(new Error('down'))
      .mockResolvedValueOnce(res({ body: { status: 'ok' } }));

    await launchAgent({ agent: 'claude', slug: 'papercup' });

    expect(urlsCalled()).toEqual([EP_3070, EP_3055]);
  });

  it('skips PAPERCUSP_HONO_PORT=0 — "bind any free port" is not a dialable address', async () => {
    process.env.PAPERCUSP_HONO_PORT = '0';
    fetchMock
      .mockRejectedValueOnce(new Error('down'))
      .mockResolvedValueOnce(res({ body: { status: 'ok' } }));

    await launchAgent({ agent: 'claude', slug: 'papercup' });

    expect(urlsCalled()).toEqual([EP_3070, EP_3055]);
  });

  it('skips a non-numeric PAPERCUSP_HONO_PORT rather than building an unusable URL', async () => {
    process.env.PAPERCUSP_HONO_PORT = 'not-a-port';
    fetchMock
      .mockRejectedValueOnce(new Error('down'))
      .mockResolvedValueOnce(res({ body: { status: 'ok' } }));

    await launchAgent({ agent: 'claude', slug: 'papercup' });

    expect(urlsCalled()).toEqual([EP_3070, EP_3055]);
  });

  it('does not probe :3070 twice when PAPERCUSP_HONO_PORT IS 3070', async () => {
    process.env.PAPERCUSP_HONO_PORT = '3070';
    fetchMock
      .mockRejectedValueOnce(new Error('down'))
      .mockResolvedValueOnce(res({ body: { status: 'ok' } }));

    await launchAgent({ agent: 'claude', slug: 'papercup' });

    expect(urlsCalled()).toEqual([EP_3070, EP_3055]);
  });

  it('keeps the EXPLICIT pin ahead of the host port it is overriding', async () => {
    process.env.PAPERCUSP_OPERATOR_BASE = 'http://127.0.0.1:3271/';
    process.env.PAPERCUSP_HONO_PORT = '3170';
    fetchMock
      .mockRejectedValueOnce(new Error('pin down'))
      .mockResolvedValueOnce(res({ body: { status: 'ok' } }));

    await launchAgent({ agent: 'claude', slug: 'papercup' });

    // Trailing slash stripped; pin first, own-operator second.
    expect(urlsCalled()).toEqual(['http://127.0.0.1:3271/api/adv/sessions/launch-su', ep(3170)]);
  });

  it('stays SILENT on the bare release fallback — no console output from the library', async () => {
    // `vitest-fail-on-console` is repo policy: a library-level warn here would
    // red-light every unpinned-launch test in the tree, including files this
    // change never touched. Asserted rather than assumed, so a future attempt
    // to add loudness fails HERE instead of in someone else's suite.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    fetchMock.mockResolvedValueOnce(res({ body: { status: 'ok' } }));

    await launchAgent({ agent: 'claude', slug: 'papercup' });

    expect(urlsCalled()).toEqual([EP_3070]);
    expect(warn).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
    warn.mockRestore();
    error.mockRestore();
  });
});
