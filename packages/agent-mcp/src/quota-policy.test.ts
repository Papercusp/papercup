/**
 * Papercusp quota-windowing policy (plan P-011). These cases moved here from
 * the core's dispatch-projected.test.ts when the worker/chunk/power-user logic
 * left the engine for this host adapter; the core now only tests its generic
 * `defaultComputeQuotaWindow` (run-scoped / perRun).
 */
import { describe, expect, it, vi } from 'vitest';
import type { RolesQuota, UnifiedToolContext } from '@papercusp/tooldef';
import { papercuspComputeQuotaWindow } from './quota-policy';

const MAKE_CTX = (over: Partial<UnifiedToolContext> = {}): UnifiedToolContext => ({
  log: vi.fn(),
  signal: new AbortController().signal,
  progress: vi.fn(),
  emit: vi.fn(),
  workspaceId: 'default',
  harnessSlug: 'sheets',
  role: 'worker',
  featureId: 'F-AUTH-003',
  chunkId: 'ck_X',
  runId: 'run_X',
  spawnId: 'spw_X',
  parentSpawnId: null,
  ...over,
});

describe('papercuspComputeQuotaWindow', () => {
  const Q: RolesQuota = { perChunk: 7, perRun: 9 };

  it('keys workers on chunk:<id> and caps by perChunk', () => {
    expect(papercuspComputeQuotaWindow(MAKE_CTX({ role: 'worker', chunkId: 'ck_A' }), Q)).toEqual({
      key: 'chunk:ck_A',
      limit: 7,
    });
  });

  it('keys non-workers on run:<id> and caps by perRun', () => {
    expect(
      papercuspComputeQuotaWindow(MAKE_CTX({ role: 'architect', runId: 'run_A', chunkId: null }), Q),
    ).toEqual({ key: 'run:run_A', limit: 9 });
  });

  it('gives workers without a chunk a null window', () => {
    expect(papercuspComputeQuotaWindow(MAKE_CTX({ role: 'worker', chunkId: null }), Q).key).toBeNull();
  });

  it('keys power-user sessions on the auth session (uiClientId), not the per-request runId', () => {
    expect(
      papercuspComputeQuotaWindow(
        MAKE_CTX({ role: 'operator', isPowerUser: true, uiClientId: 'pus-abc', runId: 'run_ephemeral', chunkId: null }),
        Q,
      ),
    ).toEqual({ key: 'power-user:pus-abc', limit: 9 });
  });

  it('falls back to run:<id> for a power-user ctx missing uiClientId', () => {
    expect(
      papercuspComputeQuotaWindow(
        MAKE_CTX({ role: 'operator', isPowerUser: true, uiClientId: null, runId: 'run_A', chunkId: null }),
        Q,
      ).key,
    ).toBe('run:run_A');
  });

  it('reports a null limit when the role has no quota entry', () => {
    expect(papercuspComputeQuotaWindow(MAKE_CTX({ role: 'worker', chunkId: 'ck_A' }), undefined)).toEqual({
      key: 'chunk:ck_A',
      limit: null,
    });
    expect(
      papercuspComputeQuotaWindow(MAKE_CTX({ role: 'architect', chunkId: null }), undefined).limit,
    ).toBeNull();
  });

  it('keeps release cut reads available after the write allowance is spent', () => {
    const ctx = MAKE_CTX({ role: 'operator', chunkId: null, runId: 'long_cut' });
    const quota: RolesQuota = { perRun: 10 };
    for (const op of ['preflight', 'status', 'handoff']) {
      expect(papercuspComputeQuotaWindow(ctx, quota, 'release:cut', { op })).toEqual({
        key: 'run:long_cut:read',
        limit: null,
      });
    }
    for (const op of ['prepare-tag', 'run', 'run-leg', 'abort-leg', 'gate-status']) {
      expect(papercuspComputeQuotaWindow(ctx, quota, 'release:cut', { op })).toEqual({
        key: 'run:long_cut:write',
        limit: 10,
      });
    }
    expect(papercuspComputeQuotaWindow(ctx, quota, 'release:deploy', { op: 'status' })).toEqual({
      key: 'run:long_cut',
      limit: 10,
    });
  });

  it('separates release cut reads for power-user session quotas too', () => {
    const ctx = MAKE_CTX({ role: 'operator', isPowerUser: true, uiClientId: 'session_A' });
    expect(papercuspComputeQuotaWindow(ctx, { perRun: 10 }, 'release:cut', { op: 'status' })).toEqual({
      key: 'power-user:session_A:read',
      limit: null,
    });
    expect(papercuspComputeQuotaWindow(ctx, { perRun: 10 }, 'release:cut', { op: 'run' })).toEqual({
      key: 'power-user:session_A:write',
      limit: 10,
    });
  });
});
