/**
 * PG-source report builder tests (plan benchmark-report-portable-trace-2026-06-17, P-001).
 * Injected fake readers — NO PG. Proves the live-store → bundle adapter joins rollouts, derives
 * arms/models, maps coord/spawn, and degrades gracefully.
 */
import { describe, it, expect, vi } from 'vitest';
import { buildBundleFromPg, type PgReportReaders } from './report-builder-pg';

const defaults = vi.hoisted(() => ({ listRunResults: vi.fn(), getRollout: vi.fn(), getBenchRunDetail: vi.fn() }));
vi.mock('../reproducibility/store', () => ({ listRunResults: defaults.listRunResults, getRollout: defaults.getRollout }));
vi.mock('../run-store', () => ({ getBenchRunDetail: defaults.getBenchRunDetail }));

function fakeReaders(over: Partial<PgReportReaders> = {}): PgReportReaders {
  return {
    listRunResults: async () => [
      { runId: 'r1', suite: 'swe-bench-pro', taskId: 't1', arm: 'hive', seed: 0, resolved: true, graderStatus: 'passed',
        generationStatus: 'completed', rolloutId: 'roll-1', tokensIn: 5, tokensOut: 5, tokensTotal: 10, costUsd: 2, wallClockMs: 100 },
      { runId: 'r1', suite: 'swe-bench-pro', taskId: 't2', arm: 'su-independent', seed: 0, resolved: false, graderStatus: 'failed',
        generationStatus: 'completed', rolloutId: 'roll-2', tokensIn: 5, tokensOut: 5, tokensTotal: 10, costUsd: 3, wallClockMs: 200 },
    ],
    getRollout: async (id) => ({
      rolloutId: id, taskId: id === 'roll-1' ? 't1' : 't2', arm: id === 'roll-1' ? 'hive' : 'su-independent', seed: 0,
      modelId: 'claude-opus-4-8[1m]', harnessVersion: 'external-bench@abc', harnessGitSha: 'cafe1234',
      submission: 'diff --git a/x b/x', rawGraderOutput: '{"resolved":true}', trajectoryRef: 'xbench://t-' + id,
      configSnapshot: { tier: 'max' }, createdAt: '2026-06-17T00:00:00Z',
    }),
    getBenchRunDetail: async () => ({
      coordEvents: [{ ts: 1718600000000, kind: 'spawn', agent: 'mug', taskId: 't1', detail: 'placed t1' }],
      perTask: [{ instanceId: 't1', cupId: 's-bee-1', stopReason: 'done', costUsd: 2 }],
    }),
    ...over,
  };
}

describe('buildBundleFromPg', () => {
  it('binds the requested workspace on each default store read', async () => {
    const fixtures = fakeReaders();
    defaults.listRunResults.mockResolvedValue(await fixtures.listRunResults({ runId: 'r1' }));
    defaults.getRollout.mockImplementation(fixtures.getRollout);
    defaults.getBenchRunDetail.mockImplementation(fixtures.getBenchRunDetail!);
    const report = await buildBundleFromPg('r1', { workspace: 'bench-private' });
    expect(report?.rollouts).toHaveLength(2);
    expect(defaults.listRunResults).toHaveBeenCalledWith({ runId: 'r1', workspaceId: 'bench-private' });
    expect(defaults.getRollout).toHaveBeenCalledWith('roll-1', { workspaceId: 'bench-private' });
    expect(defaults.getRollout).toHaveBeenCalledWith('roll-2', { workspaceId: 'bench-private' });
    expect(defaults.getBenchRunDetail).toHaveBeenCalledWith('r1', { workspaceId: 'bench-private' });
  });

  it('assembles a bundle from the live store: rollups, replay fingerprint, coord + spawn', async () => {
    const b = (await buildBundleFromPg('r1', { readers: fakeReaders() }))!;
    expect(b).not.toBeNull();
    expect(b.run.runId).toBe('r1');
    expect(b.suite).toBe('swe-bench-pro');
    expect(b.run.arms.sort()).toEqual(['hive', 'su-independent']);
    expect(b.run.models.hive).toBe('claude-opus-4-8[1m]');
    expect(b.rollouts).toHaveLength(2);
    // replay fingerprint joined onto the row
    const t1 = b.rollouts.find((r) => r.taskId === 't1')!;
    expect(t1.harnessGitSha).toBe('cafe1234');
    expect(t1.submission).toContain('diff --git');
    expect(t1.trajectoryRef).toBe('xbench://t-roll-1');
    // coord + spawn projected
    expect(b.coordTrace).toHaveLength(1);
    expect(b.coordTrace![0].kind).toBe('spawn');
    expect(b.spawnTree).toHaveLength(1);
    expect(b.spawnTree![0].spawnId).toBe('s-bee-1');
    // per-arm rollup
    expect(b.arms.find((a) => a.arm === 'hive')!.resolved).toBe(1);
  });

  it('returns null for a run with no result rows', async () => {
    const b = await buildBundleFromPg('empty', { readers: fakeReaders({ listRunResults: async () => [] }) });
    expect(b).toBeNull();
  });

  it('degrades gracefully when rollout + detail reads return nothing', async () => {
    const b = (await buildBundleFromPg('r1', {
      readers: fakeReaders({ getRollout: async () => null, getBenchRunDetail: async () => null }),
    }))!;
    expect(b.rollouts).toHaveLength(2); // still has the scoreable rows
    expect(b.rollouts[0].submission).toBeNull(); // no replay fingerprint, but no crash
    expect(b.coordTrace).toBeUndefined();
    expect(b.spawnTree).toBeUndefined();
    expect(b.arms.find((a) => a.arm === 'hive')!.resolved).toBe(1); // rollups still computed
  });

  it('attaches an injected call-log (the defineTool replay-grade audit)', async () => {
    const b = (await buildBundleFromPg('r1', {
      readers: fakeReaders(),
      extraCallLog: [{ ts: '2026-06-17T00:00:01Z', tool: 'capability:edit', ok: true, costUsd: 0.01 }],
    }))!;
    expect(b.callLog).toHaveLength(1);
    expect(b.callLog![0].tool).toBe('capability:edit');
  });
});
