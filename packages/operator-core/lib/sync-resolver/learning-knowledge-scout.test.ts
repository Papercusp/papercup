import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * The Learning tab's Knowledge + Scout sub-views read the `learning.knowledge` /
 * `learning.scout` named queries (operator-learning-tab-2026-06-09 P-008 +
 * learning-system-audit P-042). Both resolvers are thin glue over separately-
 * tested readers (knowledge-read.ts / learning-scout-read.ts), so here we assert
 * (1) registration — a missing registration silently 404s the tab — and (2) the
 * graceful-degradation contract: every PG/FS failure returns an empty-but-shaped
 * row, never a thrown 500 (mirroring learning.improvements' watchdog read).
 * Also pins learning.apiary's P-042 degrade (pre-baseline: missing table → []).
 */

const readInsightsSnapshot = vi.fn();
const readMemoryHealth = vi.fn();
vi.mock('../memory/knowledge-read', () => ({
  readInsightsSnapshot: (...a: unknown[]) => readInsightsSnapshot(...a),
  readMemoryHealth: (...a: unknown[]) => readMemoryHealth(...a),
}));

const readScoutSnapshot = vi.fn();
vi.mock('./learning-scout-read', () => ({
  readScoutSnapshot: (...a: unknown[]) => readScoutSnapshot(...a),
}));

const readApiaryInstanceSummaries = vi.fn();
vi.mock('../iq-battery/benchmark-read', () => ({
  readApiaryInstanceSummaries: (...a: unknown[]) => readApiaryInstanceSummaries(...a),
}));

const ORG_SQL = Symbol('org-sql');
vi.mock('@papercusp/db-org', () => ({
  getOrgPg: () => ({ sql: ORG_SQL }),
}));

const TX = Symbol('workspace-tx');
vi.mock('../route-workspace', () => ({
  routeWithWorkspace: (fn: (tx: unknown) => unknown) => fn(TX),
}));
vi.mock('../workspace-registry', () => ({ activeWorkspaceId: () => 'ws-test' }));

import { knownQueryNamesV2, resolveNamedQueryV2 } from './index';
import type { InsightsSnapshot, MemoryHealth } from '../memory/knowledge-read';
import type { ScoutSnapshot } from './learning-scout-read';

let warn: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  readInsightsSnapshot.mockReset();
  readMemoryHealth.mockReset();
  readScoutSnapshot.mockReset();
  readApiaryInstanceSummaries.mockReset();
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  warn.mockRestore();
});

describe('learning.knowledge / learning.scout resolver registration', () => {
  it('registers both in the v2 named-query resolver', () => {
    const names = knownQueryNamesV2();
    expect(names).toContain('learning.knowledge');
    expect(names).toContain('learning.scout');
  });
});

describe('learning.knowledge — insights snapshot + memory health (P-008)', () => {
  const insights: InsightsSnapshot = {
    count: 38,
    recent: [
      { slug: 'adding-a-sync-query', title: 'Adding a sync query', description: 'Recipe.', status: 'active', tags: ['sync'], modifiedAt: '2026-06-08T10:00:00.000Z' },
    ],
  };
  const memory: MemoryHealth = { totalMemories: 168, feedback30d: 2 };

  it('returns [{ insights, memory }] with the memory health read off the org PG handle', async () => {
    readInsightsSnapshot.mockResolvedValue(insights);
    readMemoryHealth.mockResolvedValue(memory);

    const rows = (await resolveNamedQueryV2('learning.knowledge', {})) as Array<{ insights: InsightsSnapshot; memory: MemoryHealth | null }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].insights).toEqual(insights);
    expect(rows[0].memory).toEqual(memory);
    expect(readMemoryHealth).toHaveBeenCalledWith(ORG_SQL);
  });

  it('degrades memory to null when the PG read fails — insights half still served', async () => {
    readInsightsSnapshot.mockResolvedValue(insights);
    readMemoryHealth.mockRejectedValue(new Error('pg down'));

    const rows = (await resolveNamedQueryV2('learning.knowledge', {})) as Array<{ insights: InsightsSnapshot; memory: MemoryHealth | null }>;
    expect(rows[0].memory).toBeNull();
    expect(rows[0].insights.count).toBe(38);
    expect(warn).toHaveBeenCalled();
  });

  it('degrades insights to an empty snapshot when the FS read fails — memory half still served', async () => {
    readInsightsSnapshot.mockRejectedValue(new Error('fs exploded'));
    readMemoryHealth.mockResolvedValue(memory);

    const rows = (await resolveNamedQueryV2('learning.knowledge', {})) as Array<{ insights: InsightsSnapshot; memory: MemoryHealth | null }>;
    expect(rows[0].insights).toEqual({ count: 0, recent: [] });
    expect(rows[0].memory).toEqual(memory);
  });
});

describe('learning.scout — routed ideas by rail + last tick (P-042)', () => {
  const snapshot: ScoutSnapshot = {
    totalRouted: 4,
    railCounts: [
      { rail: 'plan', count: 3 },
      { rail: 'gym', count: 1 },
    ],
    lastTick: { at: '2026-06-09T08:00:00.000Z', outcome: 'skipped', detail: 'budget gate closed' },
  };

  it('returns the reader snapshot as a 1-element array, scoped to the active workspace', async () => {
    readScoutSnapshot.mockResolvedValue(snapshot);
    const rows = (await resolveNamedQueryV2('learning.scout', {})) as ScoutSnapshot[];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual(snapshot);
    expect(readScoutSnapshot).toHaveBeenCalledWith(TX, 'ws-test');
  });

  it('degrades to the empty snapshot when the read fails (no 500 for the tab)', async () => {
    readScoutSnapshot.mockRejectedValue(new Error('pg down'));
    const rows = (await resolveNamedQueryV2('learning.scout', {})) as ScoutSnapshot[];
    expect(rows).toEqual([{ totalRouted: 0, railCounts: [], lastTick: null }]);
    expect(warn).toHaveBeenCalled();
  });
});

describe('learning.apiary — pre-baseline degrade (P-042)', () => {
  it('returns [{ instances: [] }] when the benchmark read fails (gen-0 baseline is owner-gated)', async () => {
    readApiaryInstanceSummaries.mockRejectedValue(
      Object.assign(new Error('relation "harness_shared.beekeeper_instances" does not exist'), { code: '42P01' }),
    );
    const rows = (await resolveNamedQueryV2('learning.apiary', {})) as Array<{ instances: unknown[] }>;
    expect(rows).toEqual([{ instances: [] }]);
    expect(warn).toHaveBeenCalled();
  });

  it('still passes real summaries through', async () => {
    const inst = [{ instanceId: 'gen0-x', codeSha: 'abc1234' }];
    readApiaryInstanceSummaries.mockResolvedValue(inst);
    const rows = (await resolveNamedQueryV2('learning.apiary', {})) as Array<{ instances: unknown[] }>;
    expect(rows).toEqual([{ instances: inst }]);
  });
});
