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

vi.mock('@papercusp/flags/server', () => ({
  setFlag: vi.fn(),
  setFlagOverride: vi.fn(),
}));
vi.mock('../../../flag-bus', () => ({ publishFlagChange: vi.fn() }));
vi.mock('../../../flag-audit', () => ({ recordFlagAudit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@papercusp/flags', () => ({ ALL_FLAG_KEYS: ['papercusp-the-hive', 'papercusp-accept-delegated-seats'] }));

import { setFlag, setFlagOverride } from '@papercusp/flags/server';
import route from './set';

function ctxFor(key: string, enabled: boolean) {
  return { input: { key, enabled }, principal: { slug: 'tester' } } as never;
}

async function callRoute(key: string, enabled: boolean) {
  const res = (await route.handler(new Request('http://127.0.0.1/api/flags/set'), ctxFor(key, enabled))) as Response;
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

beforeEach(() => {
  vi.mocked(setFlag).mockReset();
  vi.mocked(setFlagOverride).mockReset();
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
