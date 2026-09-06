/**
 * Route contract for the manual psu resume claim.
 *
 * The datastore semantics (clean-ended claim, stale-active recovery, and
 * fresh competing-claim rejection) are covered by recorded-sessions.integration.test.ts.
 * This file pins the missing HTTP seam: the launcher-facing route must call
 * acquireAdvSessionResume for keyed callers, retain claimAdvSessionResume for
 * legacy callers, preserve the historical `reactivated` response field, and
 * expose the keyed finalize/release transitions used after spawn/setup failure.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AdvSessionResumeReservation } from '../../../adv-sessions';

vi.setConfig({ testTimeout: 15_000 });

let routes: { method: string; path: string; handler: (req: Request) => Promise<Response> }[];
beforeAll(async () => {
  const mod = await import('./bootstrap-su');
  routes = mod.default as unknown as typeof routes;
}, 60_000);

const claimResumeMock = vi.hoisted(() => vi.fn(async (): Promise<boolean> => true));
const acquireResumeMock = vi.hoisted(() =>
  vi.fn(
    async (): Promise<AdvSessionResumeReservation> => ({
      status: 'acquired' as const,
      acquired: true as const,
      replayed: false,
      leaseExpiresAt: '2026-08-26T16:00:00.000Z',
    }),
  ),
);
const finalizeResumeMock = vi.hoisted(() => vi.fn(async (): Promise<boolean> => true));
const releaseResumeMock = vi.hoisted(() => vi.fn(async (): Promise<boolean> => true));

vi.mock('../../../auth/require-principal', () => ({
  requirePrincipal: vi.fn(async () => {}),
  PrincipalCheckError: class PrincipalCheckError extends Error {
    status = 401;
    reason = 'denied';
  },
}));
vi.mock('../../../adv-sessions', async (orig) => ({
  ...(await orig<typeof import('../../../adv-sessions')>()),
  endedRecordedOwnerIds: vi.fn(async () => new Set<string>()),
  recordAdvSession: vi.fn(async () => 1),
  markAdvSessionEnded: vi.fn(async () => {}),
  acquireAdvSessionResume: acquireResumeMock,
  finalizeAdvSessionResume: finalizeResumeMock,
  claimAdvSessionResume: claimResumeMock,
  releaseAdvSessionResume: releaseResumeMock,
  reanchorAdvSessionNativeId: vi.fn(async () => ({ reanchored: true, owner: null })),
  reanchorAdvSessionNativeIdByOwner: vi.fn(async () => ({ reanchored: true, owner: null })),
}));
vi.mock('../../../agent-tools/coordination/presence', () => ({
  touchHeartbeat: vi.fn(async () => {}),
}));

beforeEach(() => {
  vi.clearAllMocks();
  claimResumeMock.mockResolvedValue(true);
  acquireResumeMock.mockResolvedValue({
    status: 'acquired',
    acquired: true,
    replayed: false,
    leaseExpiresAt: '2026-08-26T16:00:00.000Z',
  });
  finalizeResumeMock.mockResolvedValue(true);
  releaseResumeMock.mockResolvedValue(true);
});
afterEach(() => { vi.clearAllMocks(); });

async function postResumed(body: unknown): Promise<Response> {
  const route = routes.find((r) => r.method === 'POST' && r.path.endsWith('/session-resumed'))!;
  const req = new Request('http://localhost:3070/api/agent-mcp/console/bootstrap-su/session-resumed', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return route.handler(req);
}

async function postTransition(
  suffix: 'session-resume-finalized' | 'session-resume-released',
  body: unknown,
): Promise<Response> {
  const route = routes.find((r) => r.method === 'POST' && r.path.endsWith(`/${suffix}`))!;
  const req = new Request(`http://localhost:3070/api/agent-mcp/console/bootstrap-su/${suffix}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return route.handler(req);
}

describe('POST bootstrap-su/session-resumed — atomic resume claim', () => {
  it('acquires a keyed reservation without asserting liveness and returns its typed lease', async () => {
    const res = await postResumed({ advSessionId: 42, resumeClaimKey: 'resume-claim-1' });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      status: 'acquired',
      acquired: true,
      replayed: false,
      leaseExpiresAt: '2026-08-26T16:00:00.000Z',
      reactivated: true,
    });
    expect(acquireResumeMock).toHaveBeenCalledOnce();
    expect(acquireResumeMock).toHaveBeenCalledWith(42, 'resume-claim-1');
    expect(claimResumeMock).not.toHaveBeenCalled();
  });

  it('passes the canonical local-liveness witness to the locked acquisition', async () => {
    const evidence = { version: 1, kind: 'no-live-codex-writer' };
    const res = await postResumed({
      advSessionId: 42,
      resumeClaimKey: 'resume-claim-evidence',
      localLivenessEvidence: evidence,
    });

    expect(res.status).toBe(200);
    expect(acquireResumeMock).toHaveBeenCalledWith(
      42,
      'resume-claim-evidence',
      undefined,
      undefined,
      evidence,
    );
  });

  it('keeps legacy callers without a replay key compatible', async () => {
    const res = await postResumed({ advSessionId: 42 });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, reactivated: true });
    expect(claimResumeMock).toHaveBeenCalledWith(42, null);
    expect(acquireResumeMock).not.toHaveBeenCalled();
  });

  it('returns a truthful held reservation with expiry metadata instead of claiming a live process', async () => {
    acquireResumeMock.mockResolvedValue({
      status: 'reserved',
      acquired: false,
      retryAfterMs: 12_000,
      leaseExpiresAt: '2026-08-26T16:00:12.000Z',
    });

    const res = await postResumed({ advSessionId: 42, resumeClaimKey: 'resume-claim-2' });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      status: 'reserved',
      acquired: false,
      retryAfterMs: 12_000,
      leaseExpiresAt: '2026-08-26T16:00:12.000Z',
      reactivated: false,
    });
  });

  it('preserves a lost legacy race as reactivated:false', async () => {
    claimResumeMock.mockResolvedValue(false);

    const res = await postResumed({ advSessionId: 42 });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, reactivated: false });
  });

  it('returns 503 when keyed acquisition cannot be evaluated', async () => {
    acquireResumeMock.mockRejectedValue(new Error('resume acquisition datastore unavailable'));

    const res = await postResumed({ advSessionId: 42, resumeClaimKey: 'resume-claim-3' });

    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({
      ok: false,
      error: 'resume acquisition datastore unavailable',
    });
  });

  it('400s malformed ids without touching the claim', async () => {
    for (const advSessionId of [undefined, 0, -1, 1.5, '42']) {
      const res = await postResumed({ advSessionId });
      expect(res.status).toBe(400);
    }
    expect(claimResumeMock).not.toHaveBeenCalled();
  });

  it('400s malformed replay keys without touching the claim', async () => {
    for (const resumeClaimKey of ['', '   ', 42, 'x'.repeat(201)]) {
      const res = await postResumed({ advSessionId: 42, resumeClaimKey });
      expect(res.status).toBe(400);
    }
    expect(claimResumeMock).not.toHaveBeenCalled();
  });

  it('passes the CLAUDE witness through unchanged (WI-2141892)', async () => {
    // The endpoint is a trust boundary, so it re-validates; what it must NOT do
    // is silently drop a kind it does not recognise, which would restore the
    // fail-closed refusal while reporting success.
    const evidence = { version: 1, kind: 'no-live-claude-process' };
    const res = await postResumed({
      advSessionId: 22127,
      resumeClaimKey: 'resume-claim-claude-evidence',
      localLivenessEvidence: evidence,
    });

    expect(res.status).toBe(200);
    expect(acquireResumeMock).toHaveBeenCalledWith(
      22127,
      'resume-claim-claude-evidence',
      undefined,
      undefined,
      evidence,
    );
  });

  it('400s malformed local-liveness evidence without touching the claim', async () => {
    for (const localLivenessEvidence of [
      null,
      { version: 1, kind: 'free' },
      { version: 1, kind: 'no-live-codex-writer', extra: true },
      'no-live-codex-writer',
      // near-misses of the new kind, which must not be waved through
      { version: 1, kind: 'no-live-claude-writer' },
      { version: 2, kind: 'no-live-claude-process' },
      { version: 1, kind: 'no-live-claude-process', agent: 'claude' },
    ]) {
      const res = await postResumed({
        advSessionId: 42,
        resumeClaimKey: 'resume-claim-malformed-evidence',
        localLivenessEvidence,
      });
      expect(res.status).toBe(400);
    }
    expect(acquireResumeMock).not.toHaveBeenCalled();
    expect(claimResumeMock).not.toHaveBeenCalled();
  });
});

describe('POST bootstrap-su/session-resume-finalized — spawn evidence transition', () => {
  it('finalizes only the matching reservation key', async () => {
    const launchArgv = ['psu', '--resume=42', '--agent=claude', '--account=auto'];
    const res = await postTransition('session-resume-finalized', {
      advSessionId: 42,
      resumeClaimKey: 'resume-claim-1',
      launchArgv,
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      finalized: true,
      resumeClaimKey: 'resume-claim-1',
    });
    expect(finalizeResumeMock).toHaveBeenCalledWith(42, 'resume-claim-1', launchArgv);
  });

  it('returns the false key-match verdict and surfaces datastore faults', async () => {
    finalizeResumeMock.mockResolvedValueOnce(false);
    const mismatch = await postTransition('session-resume-finalized', {
      advSessionId: 42,
      resumeClaimKey: 'stale-key',
    });
    expect(await mismatch.json()).toEqual({
      ok: true,
      finalized: false,
      resumeClaimKey: 'stale-key',
    });

    finalizeResumeMock.mockRejectedValueOnce(new Error('finalize unavailable'));
    const fault = await postTransition('session-resume-finalized', {
      advSessionId: 42,
      resumeClaimKey: 'resume-claim-1',
    });
    expect(fault.status).toBe(503);
    expect(await fault.json()).toEqual({ ok: false, error: 'finalize unavailable' });
  });
});

describe('POST bootstrap-su/session-resume-released — setup failure transition', () => {
  it('releases only the matching reservation key', async () => {
    const res = await postTransition('session-resume-released', {
      advSessionId: 42,
      resumeClaimKey: 'resume-claim-1',
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      released: true,
      resumeClaimKey: 'resume-claim-1',
    });
    expect(releaseResumeMock).toHaveBeenCalledWith(42, 'resume-claim-1');
  });

  it('validates the shared transition payload without touching the datastore', async () => {
    for (const body of [
      { advSessionId: 0, resumeClaimKey: 'key' },
      { advSessionId: 42, resumeClaimKey: '' },
      { advSessionId: 42, resumeClaimKey: 7 },
      { advSessionId: 42, resumeClaimKey: 'x'.repeat(201) },
      { advSessionId: 42, resumeClaimKey: 'key', launchArgv: [] },
      { advSessionId: 42, resumeClaimKey: 'key', launchArgv: ['psu', 7] },
      { advSessionId: 42, resumeClaimKey: 'key', launchArgv: [''] },
    ]) {
      const res = await postTransition('session-resume-released', body);
      expect(res.status).toBe(400);
    }
    expect(releaseResumeMock).not.toHaveBeenCalled();
  });
});
