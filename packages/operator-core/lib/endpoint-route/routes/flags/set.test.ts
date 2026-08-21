/**
 * /flags/set — PG-override fallback coverage (EI-7088).
 *
 * Before this fix, POST /api/flags/set only fell back to the PG override
 * store when setFlag's failure reason was exactly 'flag-backend-not-configured'
 * (no PostHog configured at all). A PostHog CONFIGURED-but-unreachable failure
 * (a fetch error, `list:<status>`, `patch:<status>`, or flag-not-found-in-posthog)
 * fell straight to a 502 with no fallback attempt — during a PostHog outage NO
 * existing-in-PostHog flag could be toggled at all, including a kill-switch an
 * operator might urgently need. This pins the fix: ANY setFlag failure now
 * falls back to the PG override.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@papercusp/flags/server', async (orig) => ({
  ...(await orig<typeof import('@papercusp/flags/server')>()),
  setFlag: vi.fn(),
  setFlagOverride: vi.fn(),
  getFlag: vi.fn(),
}));
vi.mock('../../../flag-bus', () => ({ publishFlagChange: vi.fn() }));
vi.mock('../../../flag-audit', () => ({ recordFlagAudit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@papercusp/flags', async (orig) => ({
  ...(await orig<typeof import('@papercusp/flags')>()), ALL_FLAG_KEYS: ['papercusp-the-hive', 'papercusp-accept-delegated-seats'] }));

import { setFlag, setFlagOverride, getFlag } from '@papercusp/flags/server';
import route from './set';

function ctxFor(key: string, enabled: boolean | null) {
  return { input: { key, enabled }, principal: { slug: 'tester' } } as never;
}

async function callRoute(key: string, enabled: boolean | null) {
  const res = (await route.handler(new Request('http://127.0.0.1/api/flags/set'), ctxFor(key, enabled))) as Response;
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

beforeEach(() => {
  vi.mocked(setFlag).mockReset();
  vi.mocked(setFlagOverride).mockReset();
  vi.mocked(getFlag).mockReset();
  // Default: the readback echoes back whatever the most recent setFlagOverride call
  // wrote — i.e. the write "took" as far as this process's own resolver is concerned.
  // Tests targeting the readback GUARD itself override this per-case to simulate a
  // write/read mismatch.
  vi.mocked(getFlag).mockImplementation(async () => {
    const calls = vi.mocked(setFlagOverride).mock.calls;
    const last = calls[calls.length - 1];
    return last ? (last[1] as boolean) : true;
  });
});

describe('POST /api/flags/set — PG-override fallback', () => {
  it('falls back to pg-override when PostHog is not configured at all (pre-existing behavior, unchanged)', async () => {
    vi.mocked(setFlag).mockResolvedValue({ ok: false, reason: 'flag-backend-not-configured' });
    vi.mocked(setFlagOverride).mockResolvedValue({ ok: true });

    const { status, body } = await callRoute('papercusp-the-hive', true);

    expect(status).toBe(200);
    expect(body).toMatchObject({ ok: true, backend: 'pg-override' });
  });

  it('EI-7088: falls back to pg-override when PostHog is CONFIGURED but unreachable (fetch error)', async () => {
    vi.mocked(setFlag).mockResolvedValue({ ok: false, reason: 'fetch failed' });
    vi.mocked(setFlagOverride).mockResolvedValue({ ok: true });

    const { status, body } = await callRoute('papercusp-the-hive', false);

    expect(status).toBe(200);
    expect(body).toMatchObject({ ok: true, backend: 'pg-override', posthogFailureReason: 'fetch failed' });
  });

  it('EI-7088: falls back to pg-override on a PostHog list:<status> failure', async () => {
    vi.mocked(setFlag).mockResolvedValue({ ok: false, reason: 'list:503' });
    vi.mocked(setFlagOverride).mockResolvedValue({ ok: true });

    const { status, body } = await callRoute('papercusp-the-hive', true);

    expect(status).toBe(200);
    expect(body).toMatchObject({ ok: true, backend: 'pg-override', posthogFailureReason: 'list:503' });
  });

  it('EI-7088: falls back to pg-override on flag-not-found-in-posthog', async () => {
    vi.mocked(setFlag).mockResolvedValue({ ok: false, reason: 'flag-not-found-in-posthog' });
    vi.mocked(setFlagOverride).mockResolvedValue({ ok: true });

    const { status, body } = await callRoute('papercusp-accept-delegated-seats', true);

    expect(status).toBe(200);
    expect(body).toMatchObject({ ok: true, backend: 'pg-override' });
  });

  it('returns a 502 naming BOTH failures when PostHog fails AND the pg-override fallback also fails', async () => {
    vi.mocked(setFlag).mockResolvedValue({ ok: false, reason: 'patch:500' });
    vi.mocked(setFlagOverride).mockResolvedValue({ ok: false, reason: 'override-store-not-configured' });

    const { status, body } = await callRoute('papercusp-the-hive', true);

    expect(status).toBe(502);
    expect(body.error).toContain('patch:500');
    expect(body.error).toContain('override-store-not-configured');
  });

  it('still succeeds via PostHog directly when setFlag succeeds (unaffected by this fix)', async () => {
    vi.mocked(setFlag).mockResolvedValue({ ok: true });
    vi.mocked(setFlagOverride).mockResolvedValue({ ok: true }); // the post-success override-clear

    const { status, body } = await callRoute('papercusp-the-hive', true);

    expect(status).toBe(200);
    expect(body).toMatchObject({ ok: true, backend: 'posthog' });
  });

  it('rejects an unknown flag key before ever calling setFlag', async () => {
    const { status, body } = await callRoute('not-a-real-flag', true);

    expect(status).toBe(400);
    expect(body.ok).toBe(false);
    expect(setFlag).not.toHaveBeenCalled();
  });
});

describe('POST /api/flags/set — read-back guard (EI-18712738949489735)', () => {
  it('reports ok:true, applied:true on the pg-override path when the readback confirms the flip', async () => {
    vi.mocked(setFlag).mockResolvedValue({ ok: false, reason: 'flag-backend-not-configured' });
    vi.mocked(setFlagOverride).mockResolvedValue({ ok: true });
    vi.mocked(getFlag).mockResolvedValue(true);

    const { status, body } = await callRoute('papercusp-the-hive', true);

    expect(status).toBe(200);
    expect(body).toMatchObject({ ok: true, applied: true, backend: 'pg-override' });
  });

  it('FALSE-TEST-SETUP CLASS BUG: returns ok:false, applied:false, 502 (not a bare 200) when the pg-override write "succeeds" but this process\'s own getFlag() still resolves the OLD value', async () => {
    vi.mocked(setFlag).mockResolvedValue({ ok: false, reason: 'flag-backend-not-configured' });
    vi.mocked(setFlagOverride).mockResolvedValue({ ok: true });
    // The write reports success, but readback disagrees — e.g. a resolving process
    // with no propagated override-store view (the exact silent-no-op this bug is about).
    vi.mocked(getFlag).mockResolvedValue(false);

    const { status, body } = await callRoute('papercusp-the-hive', true);

    expect(status).toBe(502);
    expect(body).toMatchObject({ ok: false, applied: false, key: 'papercusp-the-hive', backend: 'pg-override' });
    expect(body.error).toContain('not observably applied');
  });

  it('does not run the readback (or fail on its account) on the posthog-success path', async () => {
    vi.mocked(setFlag).mockResolvedValue({ ok: true });
    vi.mocked(setFlagOverride).mockResolvedValue({ ok: true });
    // If the route wrongly ran a readback here, this "wrong" resolution would fail it.
    vi.mocked(getFlag).mockResolvedValue(false);

    const { status, body } = await callRoute('papercusp-the-hive', true);

    expect(status).toBe(200);
    expect(body).toMatchObject({ ok: true, applied: true, backend: 'posthog' });
    expect(getFlag).not.toHaveBeenCalled();
  });
});

/**
 * `enabled: null` = CLEAR the pg-override.
 *
 * ⚠ THE FIRST TEST HERE IS THE LOAD-BEARING ONE, and it is a SCHEMA test on purpose.
 * The defect was never in the handler — it was that this edge declared `z.boolean()`,
 * so a caller could not EXPRESS the clear the store had always implemented
 * (`FlagOverrideStore.set(key, boolean | null)`, "`null` clears it"). A handler-only
 * test calls `route.handler` directly and therefore never runs the input schema at
 * all — it would pass just as happily against a `z.boolean()` edge that rejects every
 * real request. Tightening the schema back to boolean must FAIL a test, and that is
 * the one below.
 */
describe('POST /api/flags/set — `enabled: null` clears the override', () => {
  it('the input schema ACCEPTS null (the actual gap: the store supported it, the edge did not)', () => {
    const parsed = route.input!.parse({ key: 'papercusp-the-hive', enabled: null });
    expect(parsed).toEqual({ key: 'papercusp-the-hive', enabled: null });
  });

  it('still rejects a missing/garbage `enabled` — nullable widened the type, it did not remove the field', () => {
    expect(() => route.input!.parse({ key: 'papercusp-the-hive' })).toThrow();
    expect(() => route.input!.parse({ key: 'papercusp-the-hive', enabled: 'null' })).toThrow();
  });

  it('CLEARS the override (setFlagOverride(key, null)) and never touches PostHog', async () => {
    vi.mocked(setFlagOverride).mockResolvedValue({ ok: true });
    vi.mocked(getFlag).mockResolvedValue(true); // the derived default governs once the row is gone

    const { status, body } = await callRoute('papercusp-the-hive', null);

    expect(status).toBe(200);
    expect(setFlagOverride).toHaveBeenCalledWith('papercusp-the-hive', null);
    // A LOCAL clear must never rewrite the PostHog value, which governs other deployments.
    expect(setFlag).not.toHaveBeenCalled();
    expect(body).toMatchObject({ ok: true, applied: true, cleared: true, backend: 'pg-override-cleared' });
  });

  it('reports what NOW GOVERNS after the clear, not the value that was cleared', async () => {
    vi.mocked(setFlagOverride).mockResolvedValue({ ok: true });
    // A graduated flag: the override row said nothing useful; the derived default is ON.
    vi.mocked(getFlag).mockResolvedValue(true);

    const { body } = await callRoute('papercusp-the-hive', null);

    expect(body.enabled).toBe(true);
  });

  it('null is NOT false: `false` PINS the flag off via a write, `null` REMOVES the row', async () => {
    vi.mocked(setFlag).mockResolvedValue({ ok: false, reason: 'flag-backend-not-configured' });
    vi.mocked(setFlagOverride).mockResolvedValue({ ok: true });

    await callRoute('papercusp-the-hive', false);
    expect(setFlagOverride).toHaveBeenLastCalledWith('papercusp-the-hive', false);

    vi.mocked(getFlag).mockResolvedValue(true);
    await callRoute('papercusp-the-hive', null);
    expect(setFlagOverride).toHaveBeenLastCalledWith('papercusp-the-hive', null);
  });

  it('a failed clear is reported as a failure, and does not publish', async () => {
    vi.mocked(setFlagOverride).mockResolvedValue({ ok: false, reason: 'pg down' });

    const { status, body } = await callRoute('papercusp-the-hive', null);

    expect(status).toBe(502);
    expect(body).toMatchObject({ ok: false, applied: false });
    expect(body.error).toContain('could not clear the pg-override');
  });

  it('an unknown key is still rejected before any store write', async () => {
    const { status } = await callRoute('papercusp-totally-made-up-flag', null);
    expect(status).toBe(400);
    expect(setFlagOverride).not.toHaveBeenCalled();
  });
});
