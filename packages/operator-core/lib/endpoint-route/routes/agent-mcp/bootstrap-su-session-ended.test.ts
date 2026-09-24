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

// Resolves a boolean like the real function: the route now reports `ended` from it (WI-10002854).
const markAdvSessionEndedMock = vi.hoisted(() => vi.fn(async (..._args: unknown[]) => true));

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
    const res = await postEnded({ advSessionId: 42, exitCode: 0, endAttemptKey: 'end-42' });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, ended: true, endAttemptKey: 'end-42' });
    expect(markAdvSessionEndedMock).toHaveBeenCalledWith(42, 0, 'self', {
      signal: null,
      throwOnError: true,
      observedAt: null,
    });
  });

  it('records a valid signal as signal provenance, including exit code 0', async () => {
    const res = await postEnded({
      advSessionId: 42,
      exitCode: 0,
      killedBySignal: 'SIGHUP',
      endAttemptKey: 'end-signal-42',
    });

    expect(res.status).toBe(200);
    expect(markAdvSessionEndedMock).toHaveBeenCalledWith(42, 0, 'signal', {
      signal: 'SIGHUP',
      throwOnError: true,
      observedAt: null,
    });
  });

  it('records a claimed resume launch failure as cleanup and clears signal provenance', async () => {
    const res = await postEnded({
      advSessionId: 42,
      exitCode: null,
      killedBySignal: 'SIGTERM',
      launchFailed: true,
      endAttemptKey: 'end-cleanup-42',
    });

    expect(res.status).toBe(200);
    expect(markAdvSessionEndedMock).toHaveBeenCalledWith(42, null, 'cleanup', {
      signal: null,
      throwOnError: true,
      observedAt: null,
    });
  });

  it('rejects malformed or non-positive ids without touching the datastore', async () => {
    for (const advSessionId of [undefined, 0, -1, 1.5, '42']) {
      const res = await postEnded({ advSessionId, endAttemptKey: 'end-bad-id' });
      expect(res.status).toBe(400);
    }
    expect(markAdvSessionEndedMock).not.toHaveBeenCalled();
  });

  it('degrades an invalid signal to an explicit ordinary exit rather than persisting it', async () => {
    const res = await postEnded({
      advSessionId: 42,
      exitCode: 1,
      killedBySignal: "SIGHUP'; DROP TABLE",
      endAttemptKey: 'end-invalid-signal',
    });

    expect(res.status).toBe(200);
    expect(markAdvSessionEndedMock).toHaveBeenCalledWith(42, 1, 'self', {
      signal: null,
      throwOnError: true,
      observedAt: null,
    });
  });

  // WI-10002854: the observation time is what lets markAdvSessionEnded refuse to end a
  // successor incarnation (a headless wake resume) with a killed predecessor's report.
  it('forwards a valid observedAt as a Date and ignores an unparseable one', async () => {
    await postEnded({ advSessionId: 42, exitCode: 0, endAttemptKey: 'end-obs-42', observedAt: '2026-09-24T01:02:05.000Z' });
    const opts = markAdvSessionEndedMock.mock.calls[0]![3] as { observedAt: Date | null };
    expect(opts.observedAt).toBeInstanceOf(Date);
    expect(opts.observedAt!.toISOString()).toBe('2026-09-24T01:02:05.000Z');

    await postEnded({ advSessionId: 42, exitCode: 0, endAttemptKey: 'end-obs-bad', observedAt: 'yesterday-ish' });
    expect((markAdvSessionEndedMock.mock.calls[1]![3] as { observedAt: Date | null }).observedAt).toBeNull();
  });

  it('reports ended:false (still ok) when the store refuses a stale end, so the launcher drops its witness', async () => {
    markAdvSessionEndedMock.mockResolvedValueOnce(false);
    const res = await postEnded({ advSessionId: 42, exitCode: 0, endAttemptKey: 'end-stale-42', observedAt: '2026-09-24T01:02:05.000Z' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, ended: false, endAttemptKey: 'end-stale-42' });
  });

  it('returns 503 when ending cannot be persisted', async () => {
    markAdvSessionEndedMock.mockRejectedValueOnce(new Error('adv session store unavailable'));

    const res = await postEnded({ advSessionId: 42, exitCode: 1, endAttemptKey: 'end-fail-42' });

    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ ok: false, error: 'adv session store unavailable' });
  });

  it('requires a bounded stable endAttemptKey before touching the datastore', async () => {
    for (const endAttemptKey of [undefined, '', '   ', 42, 'x'.repeat(201)]) {
      const res = await postEnded({ advSessionId: 42, endAttemptKey });
      expect(res.status).toBe(400);
    }
    expect(markAdvSessionEndedMock).not.toHaveBeenCalled();
  });
});
