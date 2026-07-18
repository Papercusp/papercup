import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * learning.gym resolver — the Learning tab's Gym view (operator-learning-tab P-006),
 * extended with the per-Hive lens (per-hive-learning-loops-2026-06-14 P-041): a
 * `hive` arg narrows the cross-harness rollup to ONE hive's gym harness. The gym
 * is scoped per (workspace_id, harness_slug) and the Hive home slug IS the gym
 * harness_slug, so the resolver threads `hive` straight through as `harnessSlug`
 * to the two control-plane readers. The readers themselves (the SQL `AND
 * harness_slug = …`) are covered at the control-plane/integration layer; here we
 * pin the resolver's arg threading + the workspace-wide default.
 */

const listRecentProposalsForWorkspace = vi.fn();
const listAutoloopsForWorkspace = vi.fn();
const listScoutArchiveSeeds = vi.fn();
vi.mock('../gym/control-plane', () => ({
  listRecentProposalsForWorkspace: (...a: unknown[]) => listRecentProposalsForWorkspace(...a),
  listAutoloopsForWorkspace: (...a: unknown[]) => listAutoloopsForWorkspace(...a),
  listScoutArchiveSeeds: (...a: unknown[]) => listScoutArchiveSeeds(...a),
}));

vi.mock('../workspace-registry', () => ({ activeWorkspaceId: () => 'ws-test' }));

// routeWithWorkspace just hands the resolver a tx — run the callback with a stub.
vi.mock('../route-workspace', () => ({
  routeWithWorkspace: (fn: (tx: unknown) => Promise<unknown>) => fn({ tag: 'tx' }),
}));

import { resolveNamedQueryV2 } from './index';

beforeEach(() => {
  listRecentProposalsForWorkspace.mockReset().mockResolvedValue([]);
  listAutoloopsForWorkspace.mockReset().mockResolvedValue([]);
  listScoutArchiveSeeds.mockReset().mockResolvedValue([]);
});

describe('learning.gym — per-Hive lens (P-041)', () => {
  it('threads the hive through as harnessSlug to BOTH control-plane readers', async () => {
    await resolveNamedQueryV2('learning.gym', { hive: 'my-hive' });
    expect(listRecentProposalsForWorkspace).toHaveBeenCalledWith(
      { tag: 'tx' },
      { workspaceId: 'ws-test', limit: 50, harnessSlug: 'my-hive' },
    );
    expect(listAutoloopsForWorkspace).toHaveBeenCalledWith(
      { tag: 'tx' },
      { workspaceId: 'ws-test', harnessSlug: 'my-hive' },
    );
    expect(listScoutArchiveSeeds).toHaveBeenCalledWith(
      { tag: 'tx' },
      { workspaceId: 'ws-test', harnessSlug: 'my-hive' },
    );
  });

  it('omits harnessSlug entirely with no hive (cross-harness workspace rollup)', async () => {
    await resolveNamedQueryV2('learning.gym', {});
    expect(listRecentProposalsForWorkspace).toHaveBeenCalledWith(
      { tag: 'tx' },
      { workspaceId: 'ws-test', limit: 50 },
    );
    expect(listAutoloopsForWorkspace).toHaveBeenCalledWith({ tag: 'tx' }, { workspaceId: 'ws-test' });
    expect(listScoutArchiveSeeds).toHaveBeenCalledWith({ tag: 'tx' }, { workspaceId: 'ws-test' });
  });

  it('returns the 1-element { proposals, autoloops, archiveSeeds } snapshot', async () => {
    listRecentProposalsForWorkspace.mockResolvedValue([{ id: 'p1' }]);
    listAutoloopsForWorkspace.mockResolvedValue([{ harnessSlug: 'my-hive' }]);
    listScoutArchiveSeeds.mockResolvedValue([{ candidateId: 'SP-002' }]);
    const rows = (await resolveNamedQueryV2('learning.gym', { hive: 'my-hive' })) as Array<{
      proposals: unknown[];
      autoloops: unknown[];
      archiveSeeds: unknown[];
    }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].proposals).toEqual([{ id: 'p1' }]);
    expect(rows[0].autoloops).toEqual([{ harnessSlug: 'my-hive' }]);
    expect(rows[0].archiveSeeds).toEqual([{ candidateId: 'SP-002' }]);
  });

  it('archive-seed read failure degrades to [] (WI-5412) — never fails the snapshot', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    listScoutArchiveSeeds.mockRejectedValue(new Error('no archive table'));
    const rows = (await resolveNamedQueryV2('learning.gym', {})) as Array<{ archiveSeeds: unknown[] }>;
    expect(rows[0].archiveSeeds).toEqual([]);
    warn.mockRestore();
  });
});
