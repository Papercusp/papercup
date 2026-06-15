import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * The Learning tab's improvements feed reads the `learning.improvements` named
 * query (operator-learning-tab-2026-06-09 P-002). The resolver itself is thin glue
 * over the separately-tested readImprovementItems + buildDigest path (D-003), so
 * here we assert (1) it's registered in the v2 resolver — a missing registration
 * is the failure mode that would silently 404 the tab — and (2) the P-041 flow
 * extension: the resolved row is the digest PLUS a `flow` block whose recurrence
 * count is REUSED from the digest's recurringSignatures (never re-derived) and
 * whose watchdog half degrades gracefully when the tick read fails.
 */

const readImprovementItems = vi.fn();
vi.mock('../harness/improvements/read-items', () => ({
  readImprovementItems: (...a: unknown[]) => readImprovementItems(...a),
  IMPROVEMENT_TOPIC: 'papercusp-improvement',
}));

const readWatchdogFlowTicks = vi.fn();
vi.mock('../harness/improvements/flow-metrics', async (importOriginal) => {
  const real = await importOriginal<typeof import('../harness/improvements/flow-metrics')>();
  return { ...real, readWatchdogFlowTicks: (...a: unknown[]) => readWatchdogFlowTicks(...a) };
});

vi.mock('../workspace-registry', () => ({ activeWorkspaceId: () => 'ws-test' }));

// P-040: the per-Hive lens resolves the hive → its member-harness scope set via
// the registry. Keep hiveMemberHarnessScopes REAL (pure) over a mocked registry.
const loadHarnessRegistry = vi.fn();
vi.mock('../harness-registry', async (importOriginal) => {
  const real = await importOriginal<typeof import('../harness-registry')>();
  return { ...real, loadHarnessRegistry: (...a: unknown[]) => loadHarnessRegistry(...a) };
});

import { knownQueryNamesV2, resolveNamedQueryV2 } from './index';
import type { ImprovementDigest } from '../harness/improvements/digest';
import type { ImprovementFlow } from '../harness/improvements/flow-metrics';

beforeEach(() => {
  readImprovementItems.mockReset();
  readWatchdogFlowTicks.mockReset();
  loadHarnessRegistry.mockReset();
});

describe('learning.* resolver registration', () => {
  it('registers learning.improvements + learning.gym + learning.apiary in the v2 named-query resolver', () => {
    const names = knownQueryNamesV2();
    expect(names).toContain('learning.improvements');
    expect(names).toContain('learning.gym');
    expect(names).toContain('learning.apiary');
  });
});

describe('learning.improvements — digest + flow row (P-041)', () => {
  // Two same-signature items (one open, one resolved this week) → one recurring
  // signature in the digest, 1 capture + 1 resolve inside the 7d flow window.
  const recentIso = (daysAgo: number): string => new Date(Date.now() - daysAgo * 86_400_000).toISOString();
  const items = [
    { id: 'EI-1', kind: 'bug', scope: 'operator', title: 'spawn tree leaks frames', state: 'open', createdAt: recentIso(2) },
    { id: 'EI-2', kind: 'bug', scope: 'operator', title: 'spawn tree leaks frames', state: 'resolved', createdAt: recentIso(20), updatedAt: recentIso(1) },
  ];

  it('returns [digest & { flow }] with recurrence reused from digest.recurringSignatures', async () => {
    readImprovementItems.mockResolvedValue(items);
    readWatchdogFlowTicks.mockResolvedValue([{ tickAtMs: Date.now() - 10 * 60_000, capturedCount: 2 }]);

    const rows = (await resolveNamedQueryV2('learning.improvements', {})) as Array<ImprovementDigest & { flow: ImprovementFlow }>;
    expect(Array.isArray(rows)).toBe(true);
    expect(rows).toHaveLength(1);
    const row = rows[0];

    // The digest half is intact (the tool-shared shape).
    expect(row.total).toBe(2);
    expect(row.open).toBe(1);
    expect(row.recurringSignatures).toHaveLength(1);

    // The flow half: windows + the recurrence pass-through.
    expect(row.flow.captured7d).toBe(1);
    expect(row.flow.resolved7d).toBe(1);
    expect(row.flow.net7d).toBe(0);
    expect(row.flow.medianOpenAgeDays).toBeCloseTo(2, 0);
    expect(row.flow.recurringSignatureCount).toBe(row.recurringSignatures.length);
    expect(row.flow.watchdog.ticks24h).toBe(1);
    expect(row.flow.watchdog.captured24h).toBe(2);
    expect(row.flow.watchdog.lastTickAt).toBeTruthy();
    expect(readWatchdogFlowTicks).toHaveBeenCalledWith('ws-test');
  });

  it('degrades to an empty watchdog block when the tick read fails (no 500 for the tab)', async () => {
    readImprovementItems.mockResolvedValue(items);
    readWatchdogFlowTicks.mockRejectedValue(new Error('pg down'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const rows = (await resolveNamedQueryV2('learning.improvements', {})) as Array<ImprovementDigest & { flow: ImprovementFlow }>;
      expect(rows[0].flow.watchdog).toEqual({ lastTickAt: null, ticks24h: 0, captured24h: 0 });
      expect(rows[0].flow.captured7d).toBe(1); // the item half still computed
    } finally {
      warn.mockRestore();
    }
  });
});

describe('learning.improvements — per-Hive lens (P-040)', () => {
  beforeEach(() => {
    readImprovementItems.mockResolvedValue([]);
    readWatchdogFlowTicks.mockResolvedValue([]);
  });

  it('resolves the hive → its member-harness scope set and passes harnessScopes to readImprovementItems', async () => {
    loadHarnessRegistry.mockResolvedValue({
      projects: [
        { slug: 'my-hive' },
        { slug: 'member-a', hive_slug: 'my-hive' },
        { slug: 'elsewhere', hive_slug: 'other-hive' },
      ],
    });
    await resolveNamedQueryV2('learning.improvements', { hive: 'my-hive' });
    expect(loadHarnessRegistry).toHaveBeenCalled();
    const passed = readImprovementItems.mock.calls[0][0] as { harnessScopes?: string[] };
    expect(passed.harnessScopes?.sort()).toEqual(['harness:member-a', 'harness:my-hive']);
  });

  it('omits harnessScopes entirely when no hive is given (workspace-wide feed)', async () => {
    await resolveNamedQueryV2('learning.improvements', {});
    const passed = readImprovementItems.mock.calls[0][0] as { harnessScopes?: string[] };
    expect(passed.harnessScopes).toBeUndefined();
    expect(loadHarnessRegistry).not.toHaveBeenCalled();
  });

  it('degrades to the unfiltered feed (no 500) when the registry read fails', async () => {
    loadHarnessRegistry.mockRejectedValue(new Error('registry down'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const rows = await resolveNamedQueryV2('learning.improvements', { hive: 'my-hive' });
      expect(Array.isArray(rows)).toBe(true);
      const passed = readImprovementItems.mock.calls[0][0] as { harnessScopes?: string[] };
      expect(passed.harnessScopes).toBeUndefined(); // fell back to workspace-wide
    } finally {
      warn.mockRestore();
    }
  });
});
