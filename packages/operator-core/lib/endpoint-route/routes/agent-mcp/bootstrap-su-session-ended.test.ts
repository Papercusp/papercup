/**
 * Route contract for the manual psu child-exit report.
 *
 * The launcher uses this seam both for an observed child exit and for cleanup
 * after a tracked resume claim that never reaches a child process. Pin the
 * parsing/classification contract here so a future route refactor cannot turn
 * a launch failure into a voluntary exit or silently accept an unsafe signal.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.setConfig({ testTimeout: 15_000 });

let routes: { method: string; path: string; handler: (req: Request) => Promise<Response> }[];
beforeAll(async () => {
  const mod = await import('./bootstrap-su');
  routes = mod.default as unknown as typeof routes;
}, 30_000);

const markAdvSessionEndedMock = vi.hoisted(() => vi.fn(async () => {}));

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
  markAdvSessionEnded: markAdvSessionEndedMock,
  claimAdvSessionResume: vi.fn(async () => false),
  reanchorAdvSessionNativeId: vi.fn(async () => ({ reanchored: true, owner: null })),
  reanchorAdvSessionNativeIdByOwner: vi.fn(async () => ({ reanchored: true, owner: null })),
}));
vi.mock('../../../agent-tools/coordination/presence', () => ({
  touchHeartbeat: vi.fn(async () => {}),
}));

beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(() => {
  vi.clearAllMocks();
});

async function postEnded(body: unknown): Promise<Response> {
  const route = routes.find((r) => r.method === 'POST' && r.path.endsWith('/session-ended'))!;
  const req = new Request('http://localhost:3070/api/agent-mcp/console/bootstrap-su/session-ended', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return route.handler(req);
}

describe('POST bootstrap-su/session-ended — child-exit classification', () => {
  it('records an observed ordinary exit as self with an explicit null signal', async () => {
    const res = await postEnded({ advSessionId: 42, exitCode: 0 });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(markAdvSessionEndedMock).toHaveBeenCalledWith(42, 0, 'self', { signal: null });
  });

  it('records a valid signal as signal provenance, including exit code 0', async () => {
    const res = await postEnded({ advSessionId: 42, exitCode: 0, killedBySignal: 'SIGHUP' });

    expect(res.status).toBe(200);
    expect(markAdvSessionEndedMock).toHaveBeenCalledWith(42, 0, 'signal', { signal: 'SIGHUP' });
  });

  it('records a claimed resume launch failure as cleanup and clears signal provenance', async () => {
    const res = await postEnded({
      advSessionId: 42,
      exitCode: null,
      killedBySignal: 'SIGTERM',
      launchFailed: true,
    });

    expect(res.status).toBe(200);
    expect(markAdvSessionEndedMock).toHaveBeenCalledWith(42, null, 'cleanup', { signal: null });
  });

  it('rejects malformed or non-positive ids without touching the datastore', async () => {
    for (const advSessionId of [undefined, 0, -1, 1.5, '42']) {
      const res = await postEnded({ advSessionId });
      expect(res.status).toBe(400);
    }
    expect(markAdvSessionEndedMock).not.toHaveBeenCalled();
  });

  it('degrades an invalid signal to an explicit ordinary exit rather than persisting it', async () => {
    const res = await postEnded({ advSessionId: 42, exitCode: 1, killedBySignal: "SIGHUP'; DROP TABLE" });

    expect(res.status).toBe(200);
    expect(markAdvSessionEndedMock).toHaveBeenCalledWith(42, 1, 'self', { signal: null });
  });

  it('returns 503 when ending cannot be persisted', async () => {
    markAdvSessionEndedMock.mockRejectedValueOnce(new Error('adv session store unavailable'));

    const res = await postEnded({ advSessionId: 42, exitCode: 1 });

    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ ok: false, error: 'adv session store unavailable' });
  });
});
