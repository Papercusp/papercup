/**
 * Pins for the post-compaction memory re-prime
 * (memory-delivery-unification-2026-07-12 P-003b): the epoch bump happens
 * FIRST and unconditionally (a compaction happened whether or not recall
 * succeeds), the resolver runs at rung 0 off the held-item titles, the new
 * epoch is stamped under port 'compact', and every failure degrades to null.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  buildCompactReprimeBlock,
  dominantHarness,
  COMPACT_REPRIME_HEADING,
} from './compact-reprime';
import { bumpSessionEpoch } from './session-epoch-ledger';
import { buildLaunchMemoryBlock } from './launch-profile';

vi.mock('@papercusp/db-org', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    getOrgPg: () => ({ sql: (() => Promise.resolve([])) as unknown }),
  };
});
vi.mock('./session-epoch-ledger', () => ({
  bumpSessionEpoch: vi.fn(async () => 1),
}));
vi.mock('./launch-profile', async (importOriginal) => {
  const real = (await importOriginal()) as Record<string, unknown>;
  return { ...real, buildLaunchMemoryBlock: vi.fn(async () => null) };
});
vi.mock('../workspace-registry', () => ({ activeWorkspaceId: () => 'ws-active' }));
vi.mock('../auth', () => ({
  getSessionUserOrDefault: vi.fn(async () => ({ id: 'user-1' })),
}));
// P-026: the DEFAULT retire-flag read lazily imports the real flag store — stub it
// OFF here so the legacy (deps-less) cases stay hermetic AND pin today's behavior;
// the P-026 cases below pass explicit deps and never touch this mock.
vi.mock('@papercusp/flags/server', () => ({ getFlag: vi.fn(async () => false) }));

beforeEach(() => {
  vi.mocked(bumpSessionEpoch).mockClear();
  vi.mocked(buildLaunchMemoryBlock).mockClear();
  vi.mocked(buildLaunchMemoryBlock).mockResolvedValue(null);
});

describe('dominantHarness', () => {
  it('picks the most common non-null harness', () => {
    expect(
      dominantHarness([
        { harness: 'a' },
        { harness: 'b' },
        { harness: 'b' },
        { harness: null },
      ]),
    ).toBe('b');
  });
  it('null when no item carries a harness', () => {
    expect(dominantHarness([{ harness: null }])).toBeNull();
    expect(dominantHarness([])).toBeNull();
  });
});

describe('buildCompactReprimeBlock', () => {
  it('empty ownerId → null, NO epoch bump', async () => {
    expect(await buildCompactReprimeBlock({ ownerId: '', heldItems: [] })).toBeNull();
    expect(bumpSessionEpoch).not.toHaveBeenCalled();
  });

  it('bumps the epoch FIRST even when the profile has no queries (bare)', async () => {
    const out = await buildCompactReprimeBlock({ ownerId: 'sid-1', heldItems: [] });
    expect(out).toBeNull();
    expect(bumpSessionEpoch).toHaveBeenCalledTimes(1);
    expect(buildLaunchMemoryBlock).not.toHaveBeenCalled();
  });

  it('runs rung 0 off held-item titles, stamping port compact on the session', async () => {
    vi.mocked(buildLaunchMemoryBlock).mockResolvedValue('## R\n\n- [ref] x');
    const out = await buildCompactReprimeBlock({
      ownerId: 'sid-1',
      workspaceId: 'ws-9',
      heldItems: [
        { title: 'WI-1 wire prelude', harness: 'papercusp' },
        { title: 'WI-2 ledger', harness: 'papercusp' },
      ],
      fleetSlug: 'f1',
    });
    expect(out).toBe('## R\n\n- [ref] x');
    expect(bumpSessionEpoch).toHaveBeenCalledTimes(1);
    expect(buildLaunchMemoryBlock).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'user-1',
        workspaceId: 'ws-9',
        session: { sessionId: 'sid-1', port: 'compact' },
        heading: COMPACT_REPRIME_HEADING,
        profile: expect.objectContaining({
          rung: 'post-compaction',
          queries: ['WI-1 wire prelude', 'WI-2 ledger'],
          harnessSlugs: ['papercusp'],
        }),
      }),
    );
  });

  it('falls back to the active workspace when none is passed', async () => {
    vi.mocked(buildLaunchMemoryBlock).mockResolvedValue('## R\n\n- x');
    await buildCompactReprimeBlock({
      ownerId: 'sid-1',
      heldItems: [{ title: 't', harness: null }],
    });
    expect(buildLaunchMemoryBlock).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: 'ws-active' }),
    );
  });

  it('never throws: a recall failure degrades to null (epoch still bumped)', async () => {
    vi.mocked(buildLaunchMemoryBlock).mockRejectedValue(new Error('embed down'));
    const out = await buildCompactReprimeBlock({
      ownerId: 'sid-1',
      heldItems: [{ title: 't', harness: null }],
    });
    expect(out).toBeNull();
    expect(bumpSessionEpoch).toHaveBeenCalledTimes(1);
  });
});

describe('buildCompactReprimeBlock — P-026 verdict-gated enrichment retirement (deterministic-context-carry, WI-5001)', () => {
  const held = [{ title: 'WI-1 wire prelude', harness: 'papercusp' }];

  it('a DRILL-PROVEN class skips the speculative re-prime entirely — but the epoch bump STAYS (the ledger boundary is not the enrichment)', async () => {
    vi.mocked(buildLaunchMemoryBlock).mockResolvedValue('## R\n\n- would-have-injected');
    const provenClassFn = vi.fn(async () => 'claude-headless');
    const out = await buildCompactReprimeBlock(
      { ownerId: 'sid-1', heldItems: held },
      { retireFlagFn: async () => true, provenClassFn },
    );
    expect(out).toBeNull(); // the hole-patch fold is retired for this class
    expect(bumpSessionEpoch).toHaveBeenCalledTimes(1); // epoch boundary unaffected
    expect(buildLaunchMemoryBlock).not.toHaveBeenCalled(); // no speculative recall paid
    expect(provenClassFn).toHaveBeenCalledWith('sid-1');
  });

  it('an UNPROVEN class keeps the re-prime (null verdict ⇒ today’s behavior)', async () => {
    vi.mocked(buildLaunchMemoryBlock).mockResolvedValue('## R\n\n- x');
    const out = await buildCompactReprimeBlock(
      { ownerId: 'sid-1', heldItems: held },
      { retireFlagFn: async () => true, provenClassFn: async () => null },
    );
    expect(out).toBe('## R\n\n- x');
    expect(buildLaunchMemoryBlock).toHaveBeenCalledTimes(1);
  });

  it('the kill-switch flag OFF keeps the re-prime WITHOUT reading the verdict', async () => {
    vi.mocked(buildLaunchMemoryBlock).mockResolvedValue('## R\n\n- x');
    const provenClassFn = vi.fn(async () => 'claude-headless');
    const out = await buildCompactReprimeBlock(
      { ownerId: 'sid-1', heldItems: held },
      { retireFlagFn: async () => false, provenClassFn },
    );
    expect(out).toBe('## R\n\n- x');
    expect(provenClassFn).not.toHaveBeenCalled();
  });

  it('FAIL-SOFT: a throwing flag/verdict read KEEPS the enrichment (never a lost re-prime on a fault)', async () => {
    vi.mocked(buildLaunchMemoryBlock).mockResolvedValue('## R\n\n- x');
    await expect(
      buildCompactReprimeBlock(
        { ownerId: 'sid-1', heldItems: held },
        {
          retireFlagFn: async () => {
            throw new Error('flag store down');
          },
        },
      ),
    ).resolves.toBe('## R\n\n- x');
    await expect(
      buildCompactReprimeBlock(
        { ownerId: 'sid-1', heldItems: held },
        {
          retireFlagFn: async () => true,
          provenClassFn: async () => {
            throw new Error('ledger unreadable');
          },
        },
      ),
    ).resolves.toBe('## R\n\n- x');
  });
});

describe('buildCompactReprimeBlock — P-026 leg (a): retirement emits pull-precise HANDLES, not bare null (WI-5001)', () => {
  it('a proven class with an id-bearing held item returns a deterministic work-item handle block, no recall paid', async () => {
    vi.mocked(buildLaunchMemoryBlock).mockResolvedValue('## R\n\n- would-have-injected');
    const out = await buildCompactReprimeBlock(
      { ownerId: 'sid-1', heldItems: [{ id: 'WI-1', title: 'wire the prelude', harness: 'papercusp' }] },
      { retireFlagFn: async () => true, provenClassFn: async () => 'claude-headless' },
    );
    expect(out).toBe('Pull-precise carry handles (no recall)\n- [work-item:WI-1] pull: wire the prelude');
    expect(buildLaunchMemoryBlock).not.toHaveBeenCalled(); // still no speculative recall
  });

  it('a proven class with only title/harness (no id) still returns null — same as pre-P-026(a) behavior, nothing resolvable to point at', async () => {
    const out = await buildCompactReprimeBlock(
      { ownerId: 'sid-1', heldItems: [{ title: 'WI-1 wire prelude', harness: 'papercusp' }] /* no id field */ },
      { retireFlagFn: async () => true, provenClassFn: async () => 'claude-headless' },
    );
    expect(out).toBeNull();
  });

  it('threads awaits ("open threads") and dead-end facts into the handles block even with no held items', async () => {
    const out = await buildCompactReprimeBlock(
      {
        ownerId: 'sid-1',
        heldItems: [],
        awaits: [{ eventKey: 'work-item:claimable', note: 'lane drained' }],
        facts: [
          { key: 'dead-end:tried-x', body: 'tried X, broke Y' },
          { key: 'not-a-dead-end', body: 'ordinary standing fact' },
        ],
      },
      { retireFlagFn: async () => true, provenClassFn: async () => 'claude-headless' },
    );
    expect(out).toBe(
      'Pull-precise carry handles (no recall)\n' +
        '- [topic:work-item:claimable] pull: lane drained\n' +
        '- [fact:dead-end:tried-x] pull: tried X, broke Y',
    );
  });

  it('an unproven class is unaffected by leg (a) — still runs the full resolver-driven re-prime', async () => {
    vi.mocked(buildLaunchMemoryBlock).mockResolvedValue('## R\n\n- x');
    const out = await buildCompactReprimeBlock(
      { ownerId: 'sid-1', heldItems: [{ id: 'WI-1', title: 'wire the prelude', harness: 'papercusp' }] },
      { retireFlagFn: async () => true, provenClassFn: async () => null },
    );
    expect(out).toBe('## R\n\n- x');
  });
});
