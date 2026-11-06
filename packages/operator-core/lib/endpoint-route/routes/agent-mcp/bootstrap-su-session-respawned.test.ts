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

// This is the HTTP contract suite. Real lifecycle SQL is exercised by
// adv-sessions-reanchor.integration.test.ts; importing those implementations or
// the activation graph here can deadlock mock collection before any assertion.
vi.mock('@papercusp/db-org', async (original) => ({
  ...(await original<typeof import('@papercusp/db-org')>()),
  getOrgPg: () => ({ sql: readiness.sql }),
}));

let routes: { method: string; path: string; handler: (req: Request) => Promise<Response> }[];
beforeAll(async () => {
  const mod = await import('./bootstrap-su-resume');
  routes = mod.default as unknown as typeof routes;
}, 30_000);

const reanchorMock = vi.hoisted(() =>
  vi.fn(async (): Promise<{ reanchored: boolean; owner: string | null }> => ({
    reanchored: true,
    owner: 'su-resp-owner',
  })),
);
const reanchorByOwnerMock = vi.hoisted(() =>
  vi.fn(async (): Promise<{ reanchored: boolean; owner: string | null }> => ({
    reanchored: true,
    owner: 'su-interactive-owner',
  })),
);
const clearContextUsageMock = vi.hoisted(() => vi.fn());
const clearContextAnchorMock = vi.hoisted(() => vi.fn());
const clearContextEstimateMock = vi.hoisted(() => vi.fn(async () => {}));
const bindTasksMock = vi.hoisted(() => vi.fn(async (): Promise<string[]> => ['task-bound']));
const managedReserve = vi.hoisted(() => vi.fn());
const managedPrincipal = vi.hoisted(() => vi.fn(async () => ({ slug: 'system:superuser', authMethod: 'bearer-token' })));
vi.mock('../../../blind-review-continuation-custody', () => ({ reserveBlindReviewManagedSuccession: managedReserve }));
const readiness = vi.hoisted(() => ({
  launch: vi.fn(async (): Promise<unknown> => null),
  pending: vi.fn(async (): Promise<unknown> => null),
  apply: vi.fn(async () => true),
  binding: vi.fn(async (): Promise<unknown> => ({ status: 'bound', receipt: { sessionId: 42 } })),
  policy: vi.fn(async (): Promise<unknown> => ({ status: 'bound', attestation: { nativeSessionId: '1d70c364-c3dd-4dc0-a014-2bbfdd4ccd3f' } })),
  sql: vi.fn(async () => [{ agent: 'codex' }]),
}));


vi.mock('../../../auth/require-principal', () => ({
  requirePrincipal: managedPrincipal,
  PrincipalCheckError: class PrincipalCheckError extends Error {
    status = 401;
    reason = 'denied';
  },
}));
vi.mock('../../../agent-tools/coordination/control-anchor', () => ({
  preparePendingControlTransition: readiness.pending,
  applyRelaunchedActivation: readiness.apply,
}));
vi.mock('../../../blueprint/operation-worker-binding', () => ({
  readActiveOperationWorkerClaimBinding: readiness.binding,
  readActiveOperationModelPolicy: readiness.policy,
}));
vi.mock('../../../adv-sessions', () => ({
  NATIVE_SESSION_ID_RE: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
  acquireAdvSessionResume: vi.fn(),
  finalizeAdvSessionResume: vi.fn(),
  getAdvSession: vi.fn(),
  isAdvSessionLocalLivenessEvidence: vi.fn(),
  releaseAdvSessionResume: vi.fn(),
  recordAdvSession: vi.fn(async () => 1),
  markAdvSessionEnded: vi.fn(async () => {}),
  claimAdvSessionResume: vi.fn(async () => false),
  reanchorAdvSessionNativeId: reanchorMock,
  reanchorAdvSessionNativeIdByOwner: reanchorByOwnerMock,
  readSuLaunchSpecByOwner: readiness.launch,
}));
vi.mock('../../../agent-tools/coordination/presence', () => ({
  touchHeartbeat: vi.fn(async () => {}),
  clearContextEstimate: clearContextEstimateMock,
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
vi.mock('../../../task-manager/store', () => ({
  bindLiveAgentSessionTasksToNativeSession: bindTasksMock,
}));

beforeEach(() => {
  vi.clearAllMocks();
  reanchorMock.mockResolvedValue({ reanchored: true, owner: 'su-resp-owner' });
  reanchorByOwnerMock.mockResolvedValue({ reanchored: true, owner: 'su-interactive-owner' });
  bindTasksMock.mockResolvedValue(['task-bound']);
  readiness.launch.mockResolvedValue(null);
  readiness.pending.mockResolvedValue(null);
  readiness.apply.mockResolvedValue(true);
  readiness.binding.mockResolvedValue({ status: 'bound', receipt: { sessionId: 42 } });
  readiness.policy.mockResolvedValue({ status: 'bound', attestation: { nativeSessionId: FRESH_ID } });
  readiness.sql.mockResolvedValue([{ agent: 'codex' }]);
  managedPrincipal.mockResolvedValue({ slug: 'system:superuser', authMethod: 'bearer-token' });
  managedReserve.mockReset();
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
  it('reserves before creation without running reanchor or accepting caller-mismatched host evidence', async () => {
    const request = { ownerId: 'su-source', advSessionId: 42, sourceNativeSessionId: FRESH_ID };
    const permit = { bindingId: 7, reservationId: 8, attemptKey: 'attempt', receiptId: 'receipt' };
    managedReserve.mockResolvedValue(permit);
    const response = await postRespawned({ advSessionId: 42, coordOwnerId: 'su-source', sessionId: FRESH_ID,
      managedSuccession: { phase: 'reserve', request } });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, managedSuccessionPermit: permit });
    expect(managedReserve).toHaveBeenCalledWith(expect.any(String), request);
    expect(reanchorMock).not.toHaveBeenCalled();
    const mismatch = await postRespawned({ advSessionId: 43, coordOwnerId: 'su-source', sessionId: FRESH_ID,
      managedSuccession: { phase: 'reserve', request } });
    expect(mismatch.status).toBe(400);
    expect(managedReserve).toHaveBeenCalledTimes(1);
  });

  it('passes the exact custody receipt to the atomic reanchor', async () => {
    const permit = { bindingId: 7, reservationId: 8, attemptKey: 'attempt', receiptId: 'receipt' };
    expect((await postRespawned({ advSessionId: 42, coordOwnerId: 'su-source', sessionId: FRESH_ID,
      managedSuccession: { phase: 'settle', permit } })).status).toBe(200);
    expect(reanchorMock).toHaveBeenCalledWith(42, FRESH_ID, { childLaunchSessionId: null, managedSuccessionPermit: permit });
  });

  it('does not turn failed reservation storage into a successful callback', async () => {
    managedReserve.mockRejectedValue(new Error('continuation_storage_unavailable'));
    const response = await postRespawned({ advSessionId: 42, coordOwnerId: 'su-source', sessionId: FRESH_ID,
      managedSuccession: { phase: 'reserve', request: { advSessionId: 42, ownerId: 'su-source', sourceNativeSessionId: FRESH_ID } } });
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(reanchorMock).not.toHaveBeenCalled();
  });
  it('passes the managed host provenance namespace to the atomic reanchor', async () => {
    const turnProvenanceDir = '/runtime/host/turn-provenance';
    const response = await postRespawned({ advSessionId: 42, sessionId: FRESH_ID, turnProvenanceDir });
    expect(response.status).toBe(200);
    expect(reanchorMock).toHaveBeenCalledWith(42, FRESH_ID, { childLaunchSessionId: null, turnProvenanceDir });
  });

  it.each(['relative/ledger', '', 42])('rejects an invalid host provenance namespace: %j', async turnProvenanceDir => {
    const response = await postRespawned({ advSessionId: 42, sessionId: FRESH_ID, turnProvenanceDir });
    expect(response.status).toBe(400);
    expect(reanchorMock).not.toHaveBeenCalled();
  });

  it('confirms an accepted worker only after launch-proven activation and exact native attestation are ready', async () => {
    const revision = { specificationRevision: 'a'.repeat(64), stateRevision: 'launch-state' };
    readiness.launch.mockResolvedValue({ acceptedOperation: { kind: 'blueprint-operation-worker', modelPolicy: {} } });
    readiness.pending.mockResolvedValue({ generation: 3, state: { activation: { desired: revision } } });
    const response = await postRespawned({ advSessionId: 42, sessionId: FRESH_ID });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, reanchored: true });
    expect(readiness.apply).toHaveBeenCalledWith('su-resp-owner', expect.any(String), 3, revision);
    expect(readiness.policy).toHaveBeenCalledWith(expect.any(String), 'su-resp-owner', 'codex');
    expect(reanchorMock.mock.invocationCallOrder[0]).toBeLessThan(readiness.apply.mock.invocationCallOrder[0]);
    expect(readiness.apply.mock.invocationCallOrder[0]).toBeLessThan(readiness.policy.mock.invocationCallOrder[0]);
  });

  it('does not acknowledge native binding as operation readiness when activation remains unavailable', async () => {
    readiness.launch.mockResolvedValue({ acceptedOperation: { kind: 'blueprint-operation-worker', modelPolicy: {} } });
    readiness.binding.mockResolvedValue({ status: 'unavailable', reason: 'identity is not applied' });
    const response = await postRespawned({ advSessionId: 42, sessionId: FRESH_ID });
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ ok: false, error: 'accepted operation identity is not ready' });
    expect(readiness.policy).not.toHaveBeenCalled();
  });

  it.each([null, { nativeSessionId: 'another-worker' }])('refuses an absent or foreign attestation sink: %j', async (attestation) => {
    readiness.launch.mockResolvedValue({ acceptedOperation: { kind: 'blueprint-operation-worker', modelPolicy: {} } });
    readiness.policy.mockResolvedValue({ status: 'bound', attestation });
    const response = await postRespawned({ advSessionId: 42, sessionId: FRESH_ID });
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ ok: false, error: 'accepted operation attestation is not ready' });
    expect(bindTasksMock).not.toHaveBeenCalled();
  });

  it('re-anchors a valid { advSessionId, sessionId } and reports the outcome', async () => {
    const res = await postRespawned({ advSessionId: 42, sessionId: FRESH_ID });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, reanchored: true });
    expect(reanchorMock).toHaveBeenCalledWith(42, FRESH_ID, { childLaunchSessionId: null });
  });

  it('clears the PG estimate plus BOTH process-local caches for the respawned owner', async () => {
    const res = await postRespawned({ advSessionId: 42, sessionId: FRESH_ID });
    expect(res.status).toBe(200);
    expect(clearContextEstimateMock).toHaveBeenCalledWith('su-resp-owner');
    expect(clearContextUsageMock).toHaveBeenCalledWith('su-resp-owner');
    expect(clearContextAnchorMock).toHaveBeenCalledWith('su-resp-owner');
  });

  it('rebinds the owner task row to the successor native session after re-anchor', async () => {
    const res = await postRespawned({ advSessionId: 42, sessionId: FRESH_ID });
    expect(res.status).toBe(200);
    expect(bindTasksMock).toHaveBeenCalledWith(expect.objectContaining({
      coordOwnerId: 'su-resp-owner',
      sessionId: FRESH_ID,
    }));
  });

  it('keeps respawn successful when the best-effort task bind fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    bindTasksMock.mockRejectedValueOnce(new Error('task ledger unavailable'));

    const res = await postRespawned({ advSessionId: 42, sessionId: FRESH_ID });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, reanchored: true });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('respawn task/session bind failed'));
    warn.mockRestore();
  });

  it('refuses confirmation when the reanchor cannot resolve an owner', async () => {
    reanchorMock.mockResolvedValue({ reanchored: true, owner: null });
    const res = await postRespawned({ advSessionId: 42, sessionId: FRESH_ID });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({
      ok: false,
      reanchored: true,
      error: 'native session binding is not established',
    });
    expect(clearContextEstimateMock).not.toHaveBeenCalled();
    expect(clearContextUsageMock).not.toHaveBeenCalled();
    expect(clearContextAnchorMock).not.toHaveBeenCalled();
    expect(bindTasksMock).not.toHaveBeenCalled();
  });

  it('an already-anchored id is a harmless no-op (reanchored: false)', async () => {
    reanchorMock.mockResolvedValue({ reanchored: false, owner: 'su-resp-owner' });
    const res = await postRespawned({ advSessionId: 42, sessionId: FRESH_ID });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, reanchored: false });
  });

  it('400s on a missing / non-positive / non-integer advSessionId when no coordOwnerId rides along', async () => {
    for (const advSessionId of [undefined, 0, -3, 1.5, '42']) {
      const res = await postRespawned({ advSessionId, sessionId: FRESH_ID });
      expect(res.status).toBe(400);
    }
    expect(reanchorMock).not.toHaveBeenCalled();
    expect(reanchorByOwnerMock).not.toHaveBeenCalled();
  });

  it('a successful adv-id re-anchor never falls through to the owner-keyed path', async () => {
    const res = await postRespawned({
      advSessionId: 42,
      coordOwnerId: 'su-interactive-owner',
      sessionId: FRESH_ID,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, reanchored: true });
    expect(reanchorByOwnerMock).not.toHaveBeenCalled();
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
    expect(reanchorMock).toHaveBeenCalledWith(7, FRESH_ID, { childLaunchSessionId: null });
  });
});

describe('owner-keyed fallback — the interactive/`psu --resume` cohort (no adv id in env)', () => {
  it('re-anchors by coordOwnerId alone and clears both gauge caches for that owner', async () => {
    const res = await postRespawned({ coordOwnerId: 'su-interactive-owner', sessionId: FRESH_ID });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, reanchored: true });
    expect(reanchorMock).not.toHaveBeenCalled();
    expect(reanchorByOwnerMock).toHaveBeenCalledWith('su-interactive-owner', FRESH_ID);
    expect(clearContextEstimateMock).toHaveBeenCalledWith('su-interactive-owner');
    expect(clearContextUsageMock).toHaveBeenCalledWith('su-interactive-owner');
    expect(clearContextAnchorMock).toHaveBeenCalledWith('su-interactive-owner');
  });

  it('does not redirect a supplied-but-missing adv id through owner-keyed fallback', async () => {
    reanchorMock.mockResolvedValue({ reanchored: false, owner: null });
    const res = await postRespawned({
      advSessionId: 42,
      coordOwnerId: 'su-interactive-owner',
      sessionId: FRESH_ID,
    });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({
      ok: false,
      reanchored: false,
      error: 'native session binding is not established',
    });
    expect(reanchorMock).toHaveBeenCalledWith(42, FRESH_ID, { childLaunchSessionId: null });
    expect(reanchorByOwnerMock).not.toHaveBeenCalled();
    expect(clearContextEstimateMock).not.toHaveBeenCalled();
    expect(clearContextUsageMock).not.toHaveBeenCalled();
    expect(clearContextAnchorMock).not.toHaveBeenCalled();
  });

  it('a no-op fallback keeps the adv path’s resolved owner for the gauge clears', async () => {
    reanchorMock.mockResolvedValue({ reanchored: false, owner: 'su-resp-owner' });
    reanchorByOwnerMock.mockResolvedValue({ reanchored: false, owner: null });
    const res = await postRespawned({
      advSessionId: 42,
      coordOwnerId: 'su-interactive-owner',
      sessionId: FRESH_ID,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, reanchored: false });
    expect(clearContextEstimateMock).toHaveBeenCalledWith('su-resp-owner');
    expect(clearContextUsageMock).toHaveBeenCalledWith('su-resp-owner');
    expect(clearContextAnchorMock).toHaveBeenCalledWith('su-resp-owner');
  });

  it('400s when NEITHER advSessionId nor coordOwnerId is usable', async () => {
    for (const body of [
      { sessionId: FRESH_ID },
      { coordOwnerId: '', sessionId: FRESH_ID },
      { coordOwnerId: '   ', sessionId: FRESH_ID },
      { coordOwnerId: 42, sessionId: FRESH_ID },
    ]) {
      const res = await postRespawned(body);
      expect(res.status).toBe(400);
    }
    expect(reanchorMock).not.toHaveBeenCalled();
    expect(reanchorByOwnerMock).not.toHaveBeenCalled();
  });

  it('still 400s on a non-UUID sessionId with a coordOwnerId present', async () => {
    const res = await postRespawned({ coordOwnerId: 'su-interactive-owner', sessionId: 'nope' });
    expect(res.status).toBe(400);
    expect(reanchorByOwnerMock).not.toHaveBeenCalled();
  });
});
