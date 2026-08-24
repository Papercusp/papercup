/**
 * plan_items:claim — the four trap-guards it never attached (WI-41182).
 *
 * The parity test (`claim-time-enrichment-parity.test.ts`) proves this surface can
 * REACH every registered guard. This proves the guards actually reach the AGENT —
 * which is the property that was broken, and the one a wiring check cannot see.
 *
 * Before this fix `plan_items:claim` attached 2 of 6: plan Decisions and prior
 * attempts. An agent claiming here — the natural verb right after `coord:orient
 * { planItems }` declines to claim — got no premise check, no retraction warning,
 * no authorship revalidation, and no plan-says-done contradiction (WI-39498's
 * zombie guard, whose absence cost 9 successive claimants on WI-36047 at a sibling
 * surface). Nothing in the result said so: a skipped guard and a passed guard
 * produced byte-identical payloads.
 *
 * ⚠ The bare-lease path asymmetry pinned at the bottom is DELIBERATE, not a
 * lesser version of the same bug: four of the six guards key on a work-item, and
 * the bare path has none by definition. Pinning it here stops a future reader from
 * "fixing" that asymmetry by inventing a work-item id for a lease that has none.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../coordination/identity', () => ({
  resolveAgentIdentity: () => ({ ownerId: 'sess-A', ownerLabel: 'A' }),
  isEphemeralMcpCallIdentity: (id: string) => /^mcp-call-\d+$/.test(id),
}));
vi.mock('../plans/source', () => ({
  resolvePlanScope: vi.fn(async (opts?: { harnessSlug?: string }) => ({
    workspaceId: 'default',
    harnessSlug: opts?.harnessSlug ?? 'papercup',
  })),
}));
vi.mock('../../plan-items/agent-names', () => ({
  bestEffortOwnerUser: () => 'user-A',
  resolveAdoptedName: vi.fn(async () => 'builder-1'),
}));
vi.mock('../../plan-items/liveness', () => ({ claimPlanItem: vi.fn() }));
vi.mock('../../plan-items/convert', () => ({ convertPlanItem: vi.fn() }));

// The two legs this surface already had — mocked so they cannot reach real PG.
vi.mock('../../plan-decisions-claim-port', () => ({
  getClaimTimePlanDecisions: vi.fn(async () => null),
  renderPlanDecisionsNote: vi.fn(() => 'rendered note'),
}));
vi.mock('../../prior-attempt-context', () => ({
  getClaimTimePriorAttemptBrief: vi.fn(async () => null),
}));

// The four it did NOT have. These are the subject of this file.
const getClaimTimePremises = vi.fn();
vi.mock('../../premises-claim-port', () => ({
  getClaimTimePremises: (...a: unknown[]) => getClaimTimePremises(...a),
}));
const getClaimTimeRetractionAdvisory = vi.fn();
vi.mock('../work_items/retraction-advisory', () => ({
  getClaimTimeRetractionAdvisory: (...a: unknown[]) => getClaimTimeRetractionAdvisory(...a),
}));
const getClaimTimeAuthorshipRevalidationHint = vi.fn();
const authorshipRevalidationWarning = vi.fn();
vi.mock('../../work-item-prior-work', () => ({
  getClaimTimeAuthorshipRevalidationHint: (...a: unknown[]) => getClaimTimeAuthorshipRevalidationHint(...a),
  authorshipRevalidationWarning: (...a: unknown[]) => authorshipRevalidationWarning(...a),
}));
const getClaimTimePlanItemContradiction = vi.fn();
const planItemContradictionWarning = vi.fn();
vi.mock('../../work-item-plan-contradiction', () => ({
  getClaimTimePlanItemContradiction: (...a: unknown[]) => getClaimTimePlanItemContradiction(...a),
  planItemContradictionWarning: (...a: unknown[]) => planItemContradictionWarning(...a),
}));

let flagOn = true;
vi.mock('@papercusp/flags/server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@papercusp/flags/server')>()),
  getFlag: vi.fn(async () => flagOn),
}));

import { claimPlanItem } from '../../plan-items/liveness';
import { convertPlanItem } from '../../plan-items/convert';
import { mockImplementationTyped } from '../../testing/typed-mock';
const claimM = vi.mocked(claimPlanItem);
const convertM = vi.mocked(convertPlanItem);
const tool = (await import('./claim')).default;

type Out = { data: any };
const one = async (args: Record<string, unknown>) =>
  (((await tool.handler(args as never, {} as never)) as Out).data).results[0];

/** The full row convert mints — payload/title/summary/state are what the four guards key on. */
const CONVERTED_WI = {
  id: 'WI-1',
  kind: 'change',
  harness: 'papercup',
  state: 'wip',
  title: 'Add the thing',
  summary: 'There is no existing thing, so build one.',
  payload: { plan_item: { plan_slug: 'a-plan', item_id: 'P-001', harness_slug: 'papercup' } },
};

beforeEach(() => {
  vi.clearAllMocks();
  flagOn = true;
  // Typed rather than `as never` (lint:mock-cast-escape): these fixtures stand in for
  // the two functions whose return shapes this surface reads, so a required field added
  // to either must fail HERE at compile time — not at some peer's green-checkpoint.
  mockImplementationTyped(claimM, async (opts) => ({
    status: 'claimed',
    claim: { itemId: opts.itemId, owner: 'sess-A' },
    mode: 'availability',
    viaAssignment: false,
  }));
  mockImplementationTyped(convertM, async (opts) => ({
    status: 'converted',
    claim: { itemId: opts.itemId, owner: 'sess-A' },
    mode: 'availability',
    viaAssignment: false,
    workItem: CONVERTED_WI,
  }));
  getClaimTimePremises.mockResolvedValue(null);
  getClaimTimeRetractionAdvisory.mockResolvedValue(null);
  getClaimTimeAuthorshipRevalidationHint.mockResolvedValue(null);
  authorshipRevalidationWarning.mockReturnValue(null);
  getClaimTimePlanItemContradiction.mockResolvedValue(null);
  planItemContradictionWarning.mockReturnValue(null);
});

describe('plan_items:claim — trap-guards on the auto-convert path (WI-41182)', () => {
  it('surfaces the item premises', async () => {
    const brief = { rendered: ['no existing thing'], note: 'verify before building' };
    getClaimTimePremises.mockResolvedValue(brief);
    const r = await one({ plan: 'a-plan', item: 'P-001' });
    expect(r.ok).toBe(true);
    expect(r.premises).toEqual(brief);
  });

  it('surfaces a retraction warning', async () => {
    getClaimTimeRetractionAdvisory.mockResolvedValue({ retractionWarning: 'a cited finding was retracted' });
    const r = await one({ plan: 'a-plan', item: 'P-001' });
    expect(r.retractionWarning).toBe('a cited finding was retracted');
  });

  it('surfaces an authorship-revalidation warning', async () => {
    const hint = { authoredBy: 'sess-B' };
    getClaimTimeAuthorshipRevalidationHint.mockResolvedValue(hint);
    authorshipRevalidationWarning.mockReturnValue('revalidate with the author');
    const r = await one({ plan: 'a-plan', item: 'P-001' });
    expect(r.authorshipRevalidation).toEqual(hint);
    expect(r.authorshipRevalidationWarning).toBe('revalidate with the author');
  });

  it('surfaces the plan-says-done contradiction — WI-39498 zombie guard', async () => {
    const hint = { planItemStatus: 'done', annotation: '← WI-1 completed' };
    getClaimTimePlanItemContradiction.mockResolvedValue(hint);
    planItemContradictionWarning.mockReturnValue('the plan says this is already done');
    const r = await one({ plan: 'a-plan', item: 'P-001' });
    expect(r.planItemContradiction).toEqual(hint);
    expect(r.planItemContradictionWarning).toBe('the plan says this is already done');
    // The guard must key on the MINTED row, not the plan pointer: passing only the
    // item id is what kept this surface at 2 of 6 (the id alone carries no payload
    // stamp, so the contradiction lookup finds nothing and silently says "clean").
    expect(getClaimTimePlanItemContradiction).toHaveBeenCalledWith({
      workItemId: 'WI-1',
      payload: CONVERTED_WI.payload,
    });
  });

  it('omits every guard that has nothing to report, rather than emitting empty keys', async () => {
    const r = await one({ plan: 'a-plan', item: 'P-001' });
    expect(r.ok).toBe(true);
    for (const key of [
      'premises',
      'retractionWarning',
      'authorshipRevalidation',
      'authorshipRevalidationWarning',
      'planItemContradiction',
      'planItemContradictionWarning',
    ]) {
      expect(r, `a silent guard must omit "${key}", not emit an empty value`).not.toHaveProperty(key);
    }
  });

  it('a throwing guard omits its hint without failing the claim', async () => {
    getClaimTimePlanItemContradiction.mockRejectedValue(new Error('pg down'));
    getClaimTimePremises.mockRejectedValue(new Error('pg down'));
    const r = await one({ plan: 'a-plan', item: 'P-001' });
    // The claim is the thing the agent needs; an advisory read that fails must
    // never take it down. Saying nothing asserts nothing.
    expect(r.ok).toBe(true);
    expect(r.result.status).toBe('claimed');
    expect(r).not.toHaveProperty('planItemContradiction');
    expect(r).not.toHaveProperty('premises');
  });
});

describe('plan_items:claim — bare-lease path has no work-item to key on', () => {
  beforeEach(() => {
    flagOn = false;
  });

  it('skips the four work-item-keyed guards entirely', async () => {
    const r = await one({ plan: 'a-plan', item: 'P-001' });
    expect(r.ok).toBe(true);
    // Not "returned nothing" — never CALLED. There is no work-item id to ask about,
    // and asking with a synthesized one would answer about the wrong subject.
    expect(getClaimTimePremises).not.toHaveBeenCalled();
    expect(getClaimTimeRetractionAdvisory).not.toHaveBeenCalled();
    expect(getClaimTimeAuthorshipRevalidationHint).not.toHaveBeenCalled();
    expect(getClaimTimePlanItemContradiction).not.toHaveBeenCalled();
  });
});
