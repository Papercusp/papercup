/**
 * Pins for the launch-profile resolver (memory-delivery-unification-2026-07-12
 * P-007 / D-005): the specificity ladder, the 1–3 query cap, the
 * deterministic-section markers per dim, and the multi-query merge dedup.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  resolveLaunchProfile,
  buildLaunchMemoryBlock,
  MAX_LAUNCH_QUERIES,
} from './launch-profile';
import { initializeQueryForHarness } from './mcp-prelude';
import { buildMemoryContextBlock } from './injection';

vi.mock('./injection', () => ({
  buildMemoryContextBlock: vi.fn(),
}));

beforeEach(() => {
  vi.mocked(buildMemoryContextBlock).mockReset();
});

describe('resolveLaunchProfile — the specificity ladder', () => {
  it('rung 0: post-compaction (focus + checkpoint titles) outranks everything', () => {
    const p = resolveLaunchProfile({
      compactionFocus: 'resume the epoch ledger work',
      heldCheckpointTitles: ['WI-1 wire prelude', 'WI-2 ledger'],
      kickoffText: 'ignored kickoff',
      claimedItemTitles: ['ignored item'],
      harnessSlug: 'papercusp',
    });
    expect(p.rung).toBe('post-compaction');
    expect(p.queries).toEqual([
      'resume the epoch ledger work',
      'WI-1 wire prelude',
      'WI-2 ledger',
    ]);
    expect(p.deterministicSections[0]).toBe('recovery-block');
  });

  it('rung 0 caps at MAX_LAUNCH_QUERIES', () => {
    const p = resolveLaunchProfile({
      compactionFocus: 'focus',
      heldCheckpointTitles: ['a', 'b', 'c', 'd'],
    });
    expect(p.queries.length).toBe(MAX_LAUNCH_QUERIES);
  });

  it('rung 1: kickoff text yields ONE query', () => {
    const p = resolveLaunchProfile({
      kickoffText: 'implement the claim-time port',
      claimedItemTitles: ['ignored'],
      harnessSlug: 'papercusp',
    });
    expect(p.rung).toBe('kickoff');
    expect(p.queries).toEqual(['implement the claim-time port']);
  });

  it('rung 2: one query PER claimed item, planNow fills a spare slot', () => {
    const p = resolveLaunchProfile({
      planSlug: 'some-plan',
      claimedItemTitles: ['wire prelude', 'epoch ledger'],
      planNow: 'P-001 in flight',
      harnessSlug: 'papercusp',
    });
    expect(p.rung).toBe('plan');
    expect(p.queries).toEqual(['wire prelude', 'epoch ledger', 'P-001 in flight']);
    expect(p.deterministicSections).toContain('plan-now');
    expect(p.deterministicSections).toContain('claimed-items');
  });

  it('rung 2: three claimed items leave no room for planNow', () => {
    const p = resolveLaunchProfile({
      claimedItemTitles: ['a', 'b', 'c'],
      planNow: 'now text',
    });
    expect(p.queries).toEqual(['a', 'b', 'c']);
  });

  it('rung 3: fleet mission', () => {
    const p = resolveLaunchProfile({ fleetSlug: 'f1', fleetMission: 'drain the backlog' });
    expect(p.rung).toBe('fleet');
    expect(p.queries).toEqual(['drain the backlog']);
    expect(p.deterministicSections).toContain('fleet-mission');
    expect(p.deterministicSections).toContain('announced-gates');
  });

  it('rung 4: harness-only DOES query at initialize (owner-approved)', () => {
    const p = resolveLaunchProfile({ harnessSlug: 'sheets' });
    expect(p.rung).toBe('harness');
    expect(p.queries).toEqual([initializeQueryForHarness('sheets')]);
    expect(p.harnessSlugs).toEqual(['sheets']);
    expect(p.deterministicSections).toEqual(['facts', 'insights-index']);
  });

  it('rung 5: bare session gets NO initialize recall', () => {
    const p = resolveLaunchProfile({});
    expect(p.rung).toBe('bare');
    expect(p.queries).toEqual([]);
    expect(p.deterministicSections).toEqual([]);
  });

  it('clamps and whitespace-collapses long queries', () => {
    const p = resolveLaunchProfile({ kickoffText: `  a${'x'.repeat(500)}\n\nb  ` });
    expect(p.queries[0].length).toBeLessThanOrEqual(300);
    expect(p.queries[0]).not.toContain('\n');
  });
});

describe('buildLaunchMemoryBlock — multi-query merge', () => {
  const ID_A = '11111111-1111-1111-1111-111111111111';
  const ID_B = '22222222-2222-2222-2222-222222222222';

  it('merges queries under one heading and dedups by memory id', async () => {
    vi.mocked(buildMemoryContextBlock)
      .mockResolvedValueOnce(`## H\n\n- [ref] (id=${ID_A}) fact A`)
      .mockResolvedValueOnce(`## H\n\n- [ref] (id=${ID_A}) fact A\n- [ref] (id=${ID_B}) fact B`);
    const out = await buildLaunchMemoryBlock({
      profile: {
        rung: 'plan',
        queries: ['q1', 'q2'],
        harnessSlugs: ['h'],
        deterministicSections: [],
      },
      workspaceId: 'w1',
      heading: 'H',
    });
    expect(out).toBe(`## H\n\n- [ref] (id=${ID_A}) fact A\n- [ref] (id=${ID_B}) fact B`);
    expect(buildMemoryContextBlock).toHaveBeenCalledTimes(2);
  });

  it('tolerates a per-query failure and still returns the rest', async () => {
    vi.mocked(buildMemoryContextBlock)
      .mockRejectedValueOnce(new Error('embed down'))
      .mockResolvedValueOnce(`## H\n\n- [ref] (id=${ID_B}) fact B`);
    const out = await buildLaunchMemoryBlock({
      profile: { rung: 'plan', queries: ['q1', 'q2'], harnessSlugs: [], deterministicSections: [] },
      workspaceId: 'w1',
    });
    expect(out).toContain('fact B');
  });

  it('returns null when nothing surfaced (or no queries)', async () => {
    vi.mocked(buildMemoryContextBlock).mockResolvedValue(null);
    expect(
      await buildLaunchMemoryBlock({
        profile: { rung: 'bare', queries: [], harnessSlugs: [], deterministicSections: [] },
        workspaceId: 'w1',
      }),
    ).toBeNull();
    expect(
      await buildLaunchMemoryBlock({
        profile: { rung: 'plan', queries: ['q'], harnessSlugs: [], deterministicSections: [] },
        workspaceId: 'w1',
      }),
    ).toBeNull();
  });

  it('passes the session identity through to the pipeline (P-002)', async () => {
    vi.mocked(buildMemoryContextBlock).mockResolvedValue(null);
    await buildLaunchMemoryBlock({
      profile: { rung: 'plan', queries: ['q'], harnessSlugs: ['h'], deterministicSections: [] },
      workspaceId: 'w1',
      session: { sessionId: 'sid-1', port: 'compact' },
    });
    expect(buildMemoryContextBlock).toHaveBeenCalledWith(
      expect.objectContaining({
        session: { sessionId: 'sid-1', port: 'compact' },
        harnessSlugs: ['h'],
        queryContext: 'q',
      }),
    );
  });
});
