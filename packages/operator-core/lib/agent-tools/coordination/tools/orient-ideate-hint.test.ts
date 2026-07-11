/**
 * orient-ideate-hint (su-ideate-learning-substrate-2026-07-10 P-011). Pins the
 * coord:orient IDEATE "overdue" verdict:
 *  - keyed on OBSERVATION COUNT, never elapsed days (D-015): overdue ⇔
 *    observationsSince ≥ threshold OR ideasDrained; elapsed time is informational;
 *  - the observation count is measured SINCE the caller's last su-ideate pass;
 *  - lastPassAgoMs is informational (null when a pass never ran);
 *  - the blueprint-tunable threshold (env override, default 10);
 *  - the default observation-count dep filters by the caller + the since-boundary.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ImprovementCandidate } from '../../../harness/improvements/read-items';

vi.mock('../../../harness/improvements/read-items', () => ({
  readObservationItems: vi.fn(async () => []),
}));
import { readObservationItems } from '../../../harness/improvements/read-items';
import {
  computeIdeateOverdue,
  defaultIdeateHintDeps,
  suIdeateObsThreshold,
  type IdeateHintDeps,
} from './orient-ideate-hint';

const mockReadObs = vi.mocked(readObservationItems);

/** A deps double: each field is a spy; any `over` REPLACES it, so the returned
 *  handle IS the one computeIdeateOverdue calls. */
function makeDeps(over: Partial<IdeateHintDeps> = {}): IdeateHintDeps {
  return {
    readLastPassMs: over.readLastPassMs ?? vi.fn(async () => null),
    countObservationsSince: over.countObservationsSince ?? vi.fn(async () => 0),
    readIdeaQueue: over.readIdeaQueue ?? vi.fn(async () => ({ total: 0, pending: 0 })),
  };
}

afterEach(() => {
  vi.clearAllMocks();
  delete process.env.PAPERCUSP_SU_IDEATE_OBS_THRESHOLD;
});

describe('suIdeateObsThreshold', () => {
  it('defaults to 10', () => {
    expect(suIdeateObsThreshold()).toBe(10);
  });
  it('honors a positive integer override', () => {
    process.env.PAPERCUSP_SU_IDEATE_OBS_THRESHOLD = '5';
    expect(suIdeateObsThreshold()).toBe(5);
  });
  it('falls back to 10 on a non-positive / non-finite override (never disables the bar)', () => {
    process.env.PAPERCUSP_SU_IDEATE_OBS_THRESHOLD = '0';
    expect(suIdeateObsThreshold()).toBe(10);
    process.env.PAPERCUSP_SU_IDEATE_OBS_THRESHOLD = 'nonsense';
    expect(suIdeateObsThreshold()).toBe(10);
  });
});

describe('computeIdeateOverdue', () => {
  it('is OVERDUE when observations since the last pass reach the threshold', async () => {
    const deps = makeDeps({
      readLastPassMs: vi.fn(async () => 1_000),
      countObservationsSince: vi.fn(async () => 10),
      readIdeaQueue: vi.fn(async () => ({ total: 3, pending: 2 })),
    });
    const out = await computeIdeateOverdue({ ownerId: 'su-a', workspaceId: 'ws-1', nowMs: 6_000 }, deps);
    expect(out.verdict).toBe('overdue');
    expect(out.observationsSince).toBe(10);
    expect(out.ideasDrained).toBe(false);
    expect(out.reason).toContain('run a pass');
    expect(out.threshold).toBe(10);
    expect(out.lastPassAgoMs).toBe(5_000);
  });

  it('is OVERDUE when the su-ideate idea pipeline has drained (below the obs threshold)', async () => {
    const deps = makeDeps({
      readLastPassMs: vi.fn(async () => 1_000),
      countObservationsSince: vi.fn(async () => 2),
      readIdeaQueue: vi.fn(async () => ({ total: 4, pending: 0 })),
    });
    const out = await computeIdeateOverdue({ ownerId: 'su-a', workspaceId: 'ws-1', nowMs: 2_000 }, deps);
    expect(out.verdict).toBe('overdue');
    expect(out.ideasDrained).toBe(true);
    expect(out.reason).toContain('every su-ideate idea');
  });

  it('is OK below the threshold with a non-drained pipeline — and never keys on elapsed time (D-015)', async () => {
    // A last pass a "long time" ago (huge lastPassAgoMs) must NOT flip the verdict:
    // only observation count / drain do.
    const deps = makeDeps({
      readLastPassMs: vi.fn(async () => 1),
      countObservationsSince: vi.fn(async () => 3),
      readIdeaQueue: vi.fn(async () => ({ total: 5, pending: 2 })),
    });
    const out = await computeIdeateOverdue({ ownerId: 'su-a', workspaceId: 'ws-1', nowMs: 10_000_000_000 }, deps);
    expect(out.verdict).toBe('ok');
    expect(out.observationsSince).toBe(3);
    expect(out.reason).toBe('3/10 observations since your last ideate pass — not yet overdue');
    expect(out.lastPassAgoMs).toBe(10_000_000_000 - 1); // informational only
  });

  it('measures observations SINCE the last pass (passes the tick boundary to the counter)', async () => {
    const count = vi.fn(async () => 0);
    const deps = makeDeps({ readLastPassMs: vi.fn(async () => 4_242), countObservationsSince: count });
    await computeIdeateOverdue({ ownerId: 'su-a', workspaceId: 'ws-1' }, deps);
    expect(count).toHaveBeenCalledWith('su-a', 4_242);
  });

  it('handles a never-ran session: null boundary (count all-time), lastPassAgoMs null, never drained', async () => {
    const count = vi.fn(async () => 2);
    const deps = makeDeps({
      readLastPassMs: vi.fn(async () => null),
      countObservationsSince: count,
      readIdeaQueue: vi.fn(async () => ({ total: 0, pending: 0 })),
    });
    const out = await computeIdeateOverdue({ ownerId: 'su-a', workspaceId: 'ws-1', nowMs: 5_000 }, deps);
    expect(count).toHaveBeenCalledWith('su-a', null);
    expect(out.lastPassAgoMs).toBeNull();
    expect(out.ideasDrained).toBe(false); // total 0 ⇒ never "drained"
    expect(out.verdict).toBe('ok');
  });

  it('respects the blueprint-tunable threshold', async () => {
    process.env.PAPERCUSP_SU_IDEATE_OBS_THRESHOLD = '5';
    const deps = makeDeps({ readLastPassMs: vi.fn(async () => 0), countObservationsSince: vi.fn(async () => 6) });
    const out = await computeIdeateOverdue({ ownerId: 'su-a', workspaceId: 'ws-1', nowMs: 1_000 }, deps);
    expect(out.threshold).toBe(5);
    expect(out.verdict).toBe('overdue'); // 6 ≥ 5
  });
});

describe('defaultIdeateHintDeps.countObservationsSince', () => {
  const cand = (over: Partial<ImprovementCandidate>): ImprovementCandidate =>
    ({ id: 'x', kind: 'change', scope: 'harness:papercusp', title: 't', ...over } as ImprovementCandidate);

  it('counts only the caller\'s rows filed strictly after the boundary', async () => {
    mockReadObs.mockResolvedValueOnce([
      cand({ createdBy: 'su-a', createdAt: new Date(2_000).toISOString() }), // ✓ after
      cand({ createdBy: 'su-a', createdAt: new Date(500).toISOString() }), //   ✗ before
      cand({ createdBy: 'su-b', createdAt: new Date(3_000).toISOString() }), // ✗ other owner
      cand({ createdBy: 'su-a', createdAt: undefined }), //                      ✗ no timestamp
    ]);
    expect(await defaultIdeateHintDeps.countObservationsSince('su-a', 1_000)).toBe(1);
  });

  it('counts all of the caller\'s rows when the boundary is null (never ran)', async () => {
    mockReadObs.mockResolvedValueOnce([
      cand({ createdBy: 'su-a', createdAt: new Date(2_000).toISOString() }),
      cand({ createdBy: 'su-a', createdAt: new Date(500).toISOString() }),
      cand({ createdBy: 'su-a', createdAt: undefined }),
      cand({ createdBy: 'su-b', createdAt: new Date(3_000).toISOString() }),
    ]);
    expect(await defaultIdeateHintDeps.countObservationsSince('su-a', null)).toBe(3);
  });
});
