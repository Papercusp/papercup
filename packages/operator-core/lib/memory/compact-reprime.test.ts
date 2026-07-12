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
