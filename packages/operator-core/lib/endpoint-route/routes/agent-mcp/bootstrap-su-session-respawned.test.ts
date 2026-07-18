/**
 * Unit tests for POST /api/agent-mcp/console/bootstrap-su/session-respawned
 * (WI-5075 — the P-018 carry-respawn kill-loop fix).
 *
 * The route re-anchors a tracked adv_sessions row's NATIVE session id after a
 * managed-host respawn (carry-respawn / cold RECYCLE): psu-pty-host mints a
 * fresh `--session-id` for the successor, and without this report the row keeps
 * naming the dead predecessor — the compaction watchdog's context estimate then
 * reads the predecessor's over-limit transcript forever and re-kills every
 * successor (the 2026-07-15/16 kill loop). Pins the parsing + forwarding
 * contract: advSessionId must be a positive integer, sessionId must be a UUID
 * (a corrupted report must never poison the owner→native mapping).
 *
 * Mirrors bootstrap-su-heartbeat.test.ts's minimal mock set + beforeAll import
 * (EI-9784: pay bootstrap-su's heavy first import exactly once).
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.setConfig({ testTimeout: 15_000 });

let routes: { method: string; path: string; handler: (req: Request) => Promise<Response> }[];
beforeAll(async () => {
  const mod = await import('./bootstrap-su');
  routes = mod.default as unknown as typeof routes;
}, 30_000);

const reanchorMock = vi.hoisted(() =>
  vi.fn(async (): Promise<{ reanchored: boolean; owner: string | null }> => ({
    reanchored: true,
    owner: 'su-resp-owner',
  })),
);
const clearContextUsageMock = vi.hoisted(() => vi.fn());
const clearContextAnchorMock = vi.hoisted(() => vi.fn());

vi.mock('../../../auth/require-principal', () => ({
  requirePrincipal: vi.fn(async () => {}),
  PrincipalCheckError: class PrincipalCheckError extends Error {
    status = 401;
    reason = 'denied';
  },
}));
vi.mock('../../../adv-sessions', () => ({ endedRecordedOwnerIds: vi.fn(async () => new Set<string>()),
  recordAdvSession: vi.fn(async () => 1),
  markAdvSessionEnded: vi.fn(async () => {}),
  reactivateAdvSession: vi.fn(async () => false),
  reanchorAdvSessionNativeId: reanchorMock,
}));
vi.mock('../../../agent-tools/coordination/presence', () => ({
  touchHeartbeat: vi.fn(async () => {}),
}));
vi.mock('../../../system-health/context-usage-cache', () => ({
  clearContextUsage: clearContextUsageMock,
}));
// EI-12966: the anchored incremental cache (compaction-usage.ts) must be
// invalidated on respawn too — a stale watchdog-mirror clear alone leaves the
// LIVE render paths (P-013 annotator, P-015 hook fold) replaying the dead
// predecessor's frozen reading forever.
vi.mock('../../../compaction-usage', () => ({
  clearContextAnchor: clearContextAnchorMock,
}));

beforeEach(() => {
  vi.clearAllMocks();
  reanchorMock.mockResolvedValue({ reanchored: true, owner: 'su-resp-owner' });
});
afterEach(() => { vi.clearAllMocks(); });

const FRESH_ID = ' 1d70c364-c3dd-4dc0-a014-2bbfdd4ccd3f '.trim();

async function postRespawned(body: unknown): Promise<Response> {
  const route = routes.find((r) => r.method === 'POST' && r.path.endsWith('/session-respawned'))!;
  const req = new Request(
    'http://localhost:3070/api/agent-mcp/console/bootstrap-su/session-respawned',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    },
  );
  return route.handler(req);
}

describe('POST bootstrap-su/session-respawned — native-id re-anchor (WI-5075)', () => {
  it('re-anchors a valid { advSessionId, sessionId } and reports the outcome', async () => {
    const res = await postRespawned({ advSessionId: 42, sessionId: FRESH_ID });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, reanchored: true });
    expect(reanchorMock).toHaveBeenCalledWith(42, FRESH_ID);
  });

  it('EI-12966: clears BOTH the watchdog-mirror cache AND the anchored incremental cache for the owner', async () => {
    const res = await postRespawned({ advSessionId: 42, sessionId: FRESH_ID });
    expect(res.status).toBe(200);
    expect(clearContextUsageMock).toHaveBeenCalledWith('su-resp-owner');
    expect(clearContextAnchorMock).toHaveBeenCalledWith('su-resp-owner');
  });

  it('skips both gauge-cache clears when the reanchor reports no owner (never throws)', async () => {
    reanchorMock.mockResolvedValue({ reanchored: true, owner: null });
    const res = await postRespawned({ advSessionId: 42, sessionId: FRESH_ID });
    expect(res.status).toBe(200);
    expect(clearContextUsageMock).not.toHaveBeenCalled();
    expect(clearContextAnchorMock).not.toHaveBeenCalled();
  });

  it('an already-anchored id is a harmless no-op (reanchored: false)', async () => {
    reanchorMock.mockResolvedValue({ reanchored: false, owner: 'su-resp-owner' });
    const res = await postRespawned({ advSessionId: 42, sessionId: FRESH_ID });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, reanchored: false });
  });

  it('400s on a missing / non-positive / non-integer advSessionId', async () => {
    for (const advSessionId of [undefined, 0, -3, 1.5, '42']) {
      const res = await postRespawned({ advSessionId, sessionId: FRESH_ID });
      expect(res.status).toBe(400);
    }
    expect(reanchorMock).not.toHaveBeenCalled();
  });

  it('400s on a missing or non-UUID sessionId — a corrupted report must never poison the mapping', async () => {
    for (const sessionId of [undefined, '', 'not-a-uuid', 'adv-12884', '../../etc/passwd', 42]) {
      const res = await postRespawned({ advSessionId: 42, sessionId });
      expect(res.status).toBe(400);
    }
    expect(reanchorMock).not.toHaveBeenCalled();
  });

  it('trims surrounding whitespace on the sessionId before anchoring', async () => {
    const res = await postRespawned({ advSessionId: 7, sessionId: `  ${FRESH_ID}  ` });
    expect(res.status).toBe(200);
    expect(reanchorMock).toHaveBeenCalledWith(7, FRESH_ID);
  });
});
