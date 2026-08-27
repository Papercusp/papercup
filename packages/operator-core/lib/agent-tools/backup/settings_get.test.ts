/**
 * settings_get.test.ts — the backup:settings_get HANDLER (workspaceBackupFor().
 * getSettings + stats mocked). Pins that it reads the ACTIVE workspace's backup and
 * combines settings + repo stats (fetched together) into one { settings, stats } result.
 * A regression that reads the wrong workspace or drops one half is what this catches.
 *
 * In-tree (operator-core, tab-visible).
 * Run: cd packages/operator-core && npx vitest run lib/agent-tools/backup/settings_get.test.ts
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ getSettings: vi.fn(), stats: vi.fn(), kopiaContentStats: vi.fn() }));
vi.mock('../../backup', async () => {
  const { mergeRepoStatsWithKopia } = await vi.importActual<typeof import('@papercusp/backup')>('@papercusp/backup');
  return {
    workspaceBackupFor: vi.fn(() => ({
      getSettings: h.getSettings,
      stats: h.stats,
      kopiaContentStats: h.kopiaContentStats,
    })),
    mergeRepoStatsWithKopia,
  };
});
vi.mock('../../workspace-registry', () => ({ activeWorkspaceId: vi.fn(() => 'ws-1') }));

import { workspaceBackupFor } from '../../backup';
const forM = vi.mocked(workspaceBackupFor);
const tool = (await import('./settings_get')).default;

// Accepts BOTH ToolResponse shapes — the canonical { data } and the legacy
// inline-JSON { content:[{ text }] } — so migrating a tool to { data } never
// requires repointing this helper again (2026-07-26 batch's pattern).
type Out = { data: unknown } | { content: { text: string }[] };
const body = (o: Out) => ('data' in o ? o.data : JSON.parse(o.content[0]!.text));

beforeEach(() => {
  vi.clearAllMocks();
  h.getSettings.mockResolvedValue({ enabled: true });
  h.stats.mockResolvedValue({ snapshots: 5 });
  h.kopiaContentStats.mockResolvedValue(null);
});

describe('backup:settings_get handler', () => {
  it('reads the ACTIVE workspace and combines settings + stats', async () => {
    const out = (await tool.handler({} as never, {} as never)) as Out;
    expect(forM).toHaveBeenCalledWith('ws-1');
    expect(body(out)).toMatchObject({ settings: { enabled: true }, stats: { snapshots: 5 } });
  });

  it('uses live Kopia occupancy for bytesOnDisk and dedupRatio', async () => {
    h.stats.mockResolvedValue({
      totalSnapshots: 5,
      bytesOnDisk: 12,
      bytesRaw: 100,
      dedupRatio: 0.88,
      lastSnapshotAt: null,
      lastFailureAt: null,
    });
    h.kopiaContentStats.mockResolvedValue({ totalSize: 40, objectCount: 10 });

    const out = (await tool.handler({} as never, {} as never)) as Out;

    expect(body(out)).toMatchObject({
      stats: { bytesOnDisk: 40, bytesRaw: 100, dedupRatio: 0.6 },
    });
    expect(h.kopiaContentStats).toHaveBeenCalledOnce();
  });

  it('falls back to ledger stats when Kopia stats are unavailable', async () => {
    const ledgerStats = {
      totalSnapshots: 5,
      bytesOnDisk: 12,
      bytesRaw: 100,
      dedupRatio: 0.88,
      lastSnapshotAt: null,
      lastFailureAt: null,
    };
    h.stats.mockResolvedValue(ledgerStats);
    h.kopiaContentStats.mockRejectedValue(new Error('kopia unavailable'));

    const out = (await tool.handler({} as never, {} as never)) as Out;

    expect(body(out)).toMatchObject({ settings: { enabled: true }, stats: ledgerStats });
  });
});
