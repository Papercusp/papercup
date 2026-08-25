/**
 * Route contract for the manual psu resume claim.
 *
 * The datastore semantics (clean-ended claim, stale-active recovery, and
 * fresh competing-claim rejection) are covered by recorded-sessions.integration.test.ts.
 * This file pins the missing HTTP seam: the launcher-facing route must call
 * claimAdvSessionResume and preserve the historical `reactivated` response field
 * that reportSessionResumed consumes fail-closed.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.setConfig({ testTimeout: 15_000 });

let routes: { method: string; path: string; handler: (req: Request) => Promise<Response> }[];
beforeAll(async () => {
  const mod = await import('./bootstrap-su');
  routes = mod.default as unknown as typeof routes;
}, 30_000);

const claimResumeMock = vi.hoisted(() => vi.fn(async (): Promise<boolean> => true));

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
  claimAdvSessionResume: claimResumeMock,
  reanchorAdvSessionNativeId: vi.fn(async () => ({ reanchored: true, owner: null })),
  reanchorAdvSessionNativeIdByOwner: vi.fn(async () => ({ reanchored: true, owner: null })),
}));
vi.mock('../../../agent-tools/coordination/presence', () => ({
  touchHeartbeat: vi.fn(async () => {}),
}));

beforeEach(() => {
  vi.clearAllMocks();
  claimResumeMock.mockResolvedValue(true);
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

describe('POST bootstrap-su/session-resumed — atomic resume claim', () => {
  it('forwards the adv session id and replay key to the stale-safe single-winner claim', async () => {
    const res = await postResumed({ advSessionId: 42, resumeClaimKey: 'resume-claim-1' });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, reactivated: true });
    expect(claimResumeMock).toHaveBeenCalledOnce();
    expect(claimResumeMock).toHaveBeenCalledWith(42, 'resume-claim-1');
  });

  it('keeps legacy callers without a replay key compatible', async () => {
    const res = await postResumed({ advSessionId: 42 });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, reactivated: true });
    expect(claimResumeMock).toHaveBeenCalledWith(42, null);
  });

  it('preserves a lost fresh race as reactivated:false so the launcher refuses to spawn', async () => {
    claimResumeMock.mockResolvedValue(false);

    const res = await postResumed({ advSessionId: 42 });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, reactivated: false });
  });

  it('returns 503 when the claim cannot be evaluated', async () => {
    claimResumeMock.mockRejectedValue(new Error('resume claim datastore unavailable'));

    const res = await postResumed({ advSessionId: 42 });

    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ ok: false, error: 'resume claim datastore unavailable' });
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
});
