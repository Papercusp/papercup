import { describe, expect, it, vi, beforeEach } from 'vitest';

/**
 * P-017 slice D. The behaviour under test is NOT "does it return a brief" — it is that
 * the three ways this read can come back empty stay DISTINGUISHABLE.
 *
 * getClaimTimePriorAttemptBrief collapses "no plan pointer" and "collector failed" into
 * the same `null`. If the panel renders both as an empty section, a collector timeout
 * reads to a human as "nothing was ever tried on this lane" — the exact false all-clear
 * the prior-attempt work exists to prevent. So the resolver must label them.
 */

let rows: unknown[] = [];
const sqlSpy = vi.fn(async () => rows);

vi.mock('@papercusp/db-org', async (orig) => ({
  ...(await orig<typeof import('@papercusp/db-org')>()),
  getOrgPg: () => ({ sql: sqlSpy }),
}));

const getBrief = vi.fn();
const resolveRefs = vi.fn();
vi.mock('../prior-attempt-context', () => ({
  getClaimTimePriorAttemptBrief: (...a: unknown[]) => getBrief(...a),
  resolvePriorAttemptRefs: (...a: unknown[]) => resolveRefs(...a),
}));

import { resolveWorkItemPriorAttempts } from './work-item-prior-attempts';

const BASE = { workspaceId: 'ws', harnessSlug: 'papercusp', workItemId: 'WI-1' };

const planRow = {
  feature_id: 'WI-1',
  harness_slug: 'papercusp',
  payload: { plan_item: { plan_slug: 'p', item_id: 'P-001' } },
  source_plan_slug: 'p',
  source_plan_item_ids: ['P-001'],
};

beforeEach(() => {
  rows = [];
  sqlSpy.mockClear();
  getBrief.mockReset();
  resolveRefs.mockReset();
});

describe('resolveWorkItemPriorAttempts', () => {
  it('labels a missing work-item row rather than returning a bare empty brief', async () => {
    rows = [];
    const out = (await resolveWorkItemPriorAttempts(BASE)) as Array<Record<string, unknown>>;
    expect(out).toHaveLength(1);
    expect(out[0].brief).toBeNull();
    expect(out[0].unavailableReason).toBe('work-item-not-found');
    expect(getBrief).not.toHaveBeenCalled();
  });

  // WI-2142613 INVERTED THE ASSERTION THAT USED TO LIVE HERE. It read
  // `it('distinguishes an item with NO plan lane from a collector failure')` and
  // expected 'no-plan-pointer' on exactly this input. That distinction was correct
  // while the collector REQUIRED a plan pointer; P-018 removed the requirement, so an
  // orphan compiles its own `self` rung and "no plan lane" stopped implying "no
  // history". The stale reason made the panel render a real collector failure as
  // "there is no prior-attempt history to compile" for the 94% of items with no plan.
  it('reports collector-unavailable for an ORPHAN too — a null brief is a FAILURE, never an expected absence', async () => {
    rows = [{ ...planRow, payload: {}, source_plan_slug: null, source_plan_item_ids: null }];
    getBrief.mockResolvedValue(null);
    const out = (await resolveWorkItemPriorAttempts(BASE)) as Array<Record<string, unknown>>;
    expect(out[0].unavailableReason).toBe('collector-unavailable');
    // The point is that lacking a plan no longer BUYS a softer explanation: post-P-018
    // this item had a self rung to compile, so the null means the read failed.
    expect(out[0].unavailableReason).not.toBe('no-plan-pointer');
  });

  it('reports collector-unavailable when the item HAS a lane but the brief came back null', async () => {
    rows = [planRow];
    getBrief.mockResolvedValue(null);
    const out = (await resolveWorkItemPriorAttempts(BASE)) as Array<Record<string, unknown>>;
    // Identical reason to the orphan case above, and that sameness is the fix: a null
    // brief now has exactly one meaning, so there is exactly one reason to report.
    expect(out[0].unavailableReason).toBe('collector-unavailable');
  });

  it('never throws when the collector rejects — a failed read must not break the panel', async () => {
    rows = [planRow];
    getBrief.mockRejectedValue(new Error('prior-attempt-claim-timeout'));
    const out = (await resolveWorkItemPriorAttempts(BASE)) as Array<Record<string, unknown>>;
    expect(out[0].brief).toBeNull();
    expect(out[0].unavailableReason).toBe('collector-unavailable');
  });

  it('returns the brief and leaves refResolution null when no refs were asked for', async () => {
    rows = [planRow];
    const brief = { schemaVersion: 'prior-attempt-brief-v1', attempts: [], estimatedTokens: 900 };
    getBrief.mockResolvedValue(brief);
    const out = (await resolveWorkItemPriorAttempts(BASE)) as Array<Record<string, unknown>>;
    expect(out[0].brief).toBe(brief);
    expect(out[0].refResolution).toBeNull();
    expect(out[0].unavailableReason).toBeNull();
    expect(resolveRefs).not.toHaveBeenCalled();
  });

  it('resolves raw drill-down refs independently of the brief', async () => {
    rows = [planRow];
    getBrief.mockResolvedValue({ attempts: [] });
    const resolution = { records: [{ rawRef: 'WI-9#completion' }], unresolved: [] };
    resolveRefs.mockResolvedValue(resolution);
    const out = (await resolveWorkItemPriorAttempts({
      ...BASE,
      rawRefs: ['WI-9#completion'],
    })) as Array<Record<string, unknown>>;
    expect(out[0].refResolution).toBe(resolution);
    expect(resolveRefs).toHaveBeenCalledTimes(1);
  });

  it('a drill-down failure degrades to null without losing the brief', async () => {
    rows = [planRow];
    const brief = { attempts: [] };
    getBrief.mockResolvedValue(brief);
    resolveRefs.mockRejectedValue(new Error('boom'));
    const out = (await resolveWorkItemPriorAttempts({
      ...BASE,
      rawRefs: ['WI-9#completion'],
    })) as Array<Record<string, unknown>>;
    expect(out[0].brief).toBe(brief);
    expect(out[0].refResolution).toBeNull();
  });
});
