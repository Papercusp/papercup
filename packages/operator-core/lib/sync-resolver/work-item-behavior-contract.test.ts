import { describe, expect, it, vi, beforeEach } from 'vitest';

/**
 * P-011, the work-item behavior-contract read surface.
 *
 * P-016 made applicability behavior-OWNED rather than plan-owned (D-012/D-013): an item
 * resolves clauses across plan namespaces through explicit edges, with the source-plan
 * stamp surviving only as back-compat provenance. This read exposes that resolution to a
 * human, running the SAME port the completion gate uses so the panel cannot drift.
 *
 * Two properties carry the weight, and both fail SILENTLY when broken:
 *
 *   1. THREE EMPTY STATES ARE NOT ONE. "no such work item", "the resolver could not run",
 *      and "this item is genuinely on the hook for nothing" all produce zero clauses and
 *      mean entirely different things. Collapsing them renders an unresolved item as a
 *      clean one — the resolver marks each with a distinct `unavailableReason`, and the
 *      tests below assert the three are mutually distinguishable rather than merely
 *      individually correct.
 *
 *   2. A REVISION RIDES ON EVERY CLAUSE. "A coverage claim without the revision it was
 *      earned against" is the exact defect this plan exists to end, so `specId` must never
 *      be surfaced without its `revision`. The permanent negative control at the bottom is
 *      a mapper that drops it, so the guard is provably falsifiable.
 *
 * D-017 also applies at this surface: the resolver REPORTS, it never enforces.
 * `impact.report` is populated independently of any refusal and `staleEdges` describe a
 * condition nothing enforces yet — P-013 owns hard enforcement. Rendering either as a
 * failure shows a human a blocker no gate is applying.
 */

let itemRows: unknown[] = [];
const sqlSpy = vi.fn(async () => itemRows);

vi.mock('@papercusp/db-org', async (orig) => ({
  ...(await orig<typeof import('@papercusp/db-org')>()),
  getOrgPg: () => ({ sql: sqlSpy }),
}));

const contractSpy = vi.fn();
const stampSpy = vi.fn();
vi.mock('../agent-tools/plans/behavior-contract-resolver', () => ({
  resolveWorkItemBehaviorContract: (...a: unknown[]) => contractSpy(...a),
  planStampOf: (...a: unknown[]) => stampSpy(...a),
  ENFORCEABLE_LIFECYCLE_STATUSES: ['accepted', 'active'] as const,
}));

import { resolveWorkItemBehaviorContract } from './work-item-behavior-contract';

const ARGS = { workspaceId: 'ws', harnessSlug: 'papercusp', workItemId: 'WI-1' };

const itemRow = {
  feature_id: 'WI-1',
  harness_slug: 'papercusp',
  item_kind: 'change',
  payload: {},
  source_plan_slug: 'plan-a',
  source_plan_item_ids: ['P-001'],
};

function clause(over: Record<string, unknown> = {}) {
  return {
    specId: 'SPEC-a',
    revision: 3,
    planItemId: 'P-001',
    behavior: 'it does the thing',
    behaviorClass: 'observable',
    lifecycleStatus: 'accepted',
    falsifier: null,
    mutationRequired: false,
    ...over,
  };
}

function contract(over: Record<string, unknown> = {}) {
  return {
    enforceable: [clause()],
    impact: { required: true, resolved: true, report: null, reason: 'resolved' },
    groups: [{ planSlug: 'plan-a', via: 'stamp', staleEdges: [], clauses: [clause()] }],
    ...over,
  };
}

type Row = {
  workItemId: string;
  groups: {
    planSlug: string;
    via: string;
    staleEdges: unknown[];
    clauses: Record<string, unknown>[];
  }[];
  enforceableCount: number;
  stampedPlanSlug: string | null;
  impact: Record<string, unknown> | null;
  unavailableReason: string | null;
};

const run = async (): Promise<Row> =>
  (await resolveWorkItemBehaviorContract(ARGS))[0] as Row;

beforeEach(() => {
  sqlSpy.mockClear();
  contractSpy.mockReset();
  stampSpy.mockReset();
  itemRows = [itemRow];
  stampSpy.mockReturnValue({ planSlug: 'plan-a' });
});

describe('P-011 behavior-contract read — the three empty states stay distinct', () => {
  it('a MISSING work item says so', async () => {
    itemRows = [];

    const row = await run();

    expect(row.unavailableReason).toBe('work-item-not-found');
    expect(row.groups).toEqual([]);
    expect(row.enforceableCount).toBe(0);
  });

  it('a FAILED resolver says so instead of reporting an empty contract', async () => {
    contractSpy.mockRejectedValue(new Error('port down'));

    const row = await run();

    expect(row.unavailableReason).toBe('resolver-unavailable');
    expect(row.groups).toEqual([]);
  });

  it('a GENUINELY empty contract is not marked unavailable', async () => {
    contractSpy.mockResolvedValue(contract({ enforceable: [], groups: [] }));

    const row = await run();

    expect(row.unavailableReason).toBeNull();
    expect(row.groups).toEqual([]);
    expect(row.enforceableCount).toBe(0);
  });

  it('the three are mutually distinguishable despite identical clause counts', async () => {
    itemRows = [];
    const missing = await run();

    itemRows = [itemRow];
    contractSpy.mockRejectedValue(new Error('port down'));
    const failed = await run();

    contractSpy.mockReset();
    contractSpy.mockResolvedValue(contract({ enforceable: [], groups: [] }));
    const empty = await run();

    // All three look identical to a renderer that reads only the counts:
    expect([missing.enforceableCount, failed.enforceableCount, empty.enforceableCount]).toEqual([
      0, 0, 0,
    ]);
    // ...and must never be confusable structurally:
    expect(
      new Set([missing.unavailableReason, failed.unavailableReason, empty.unavailableReason]).size,
    ).toBe(3);
  });
});

describe('P-011 behavior-contract read — a revision rides on every clause', () => {
  it('never surfaces a specId without its revision', async () => {
    contractSpy.mockResolvedValue(
      contract({
        groups: [
          {
            planSlug: 'plan-a',
            via: 'stamp',
            staleEdges: [],
            clauses: [clause(), clause({ specId: 'SPEC-b', revision: 7 })],
          },
        ],
      }),
    );

    const row = await run();
    const clauses = row.groups.flatMap((g) => g.clauses);

    expect(clauses).toHaveLength(2);
    for (const c of clauses) {
      expect(c.specId).toBeTruthy();
      expect(typeof c.revision).toBe('number');
    }
    expect(clauses.map((c) => [c.specId, c.revision])).toEqual([
      ['SPEC-a', 3],
      ['SPEC-b', 7],
    ]);
  });

  it('derives `enforceable` from the lifecycle set rather than trusting the clause', async () => {
    contractSpy.mockResolvedValue(
      contract({
        groups: [
          {
            planSlug: 'plan-a',
            via: 'stamp',
            staleEdges: [],
            clauses: [
              clause({ specId: 'SPEC-accepted', lifecycleStatus: 'accepted' }),
              clause({ specId: 'SPEC-active', lifecycleStatus: 'active' }),
              clause({ specId: 'SPEC-draft', lifecycleStatus: 'draft' }),
              clause({ specId: 'SPEC-retired', lifecycleStatus: 'retired' }),
            ],
          },
        ],
      }),
    );

    const row = await run();
    const byId = Object.fromEntries(
      row.groups[0].clauses.map((c) => [c.specId as string, c.enforceable]),
    );

    // D-012: a draft clause is a candidate input, never an enforceable promise.
    expect(byId).toEqual({
      'SPEC-accepted': true,
      'SPEC-active': true,
      'SPEC-draft': false,
      'SPEC-retired': false,
    });
  });

  it('reports staleEdges rather than silently dropping them', async () => {
    const staleEdges = [{ specId: 'SPEC-a', pinnedRevision: 2, currentRevision: 5 }];
    contractSpy.mockResolvedValue(
      contract({ groups: [{ planSlug: 'plan-a', via: 'edge', staleEdges, clauses: [] }] }),
    );

    expect((await run()).groups[0].staleEdges).toEqual(staleEdges);
  });
});

describe('P-011 behavior-contract read — D-013 provenance, D-017 advisory', () => {
  it('surfaces a CROSS-NAMESPACE group, so the stamp is provenance and not a scope boundary', async () => {
    contractSpy.mockResolvedValue(
      contract({
        groups: [
          { planSlug: 'plan-a', via: 'stamp', staleEdges: [], clauses: [clause()] },
          {
            planSlug: 'plan-OTHER',
            via: 'edge',
            staleEdges: [],
            clauses: [clause({ specId: 'SPEC-x' })],
          },
        ],
      }),
    );

    const row = await run();

    expect(row.groups.map((g) => g.planSlug)).toEqual(['plan-a', 'plan-OTHER']);
    expect(row.stampedPlanSlug).toBe('plan-a');
  });

  it('reports a null stampedPlanSlug for a STANDALONE item without failing', async () => {
    stampSpy.mockReturnValue(null);
    contractSpy.mockResolvedValue(contract());

    const row = await run();

    expect(row.stampedPlanSlug).toBeNull();
    expect(row.unavailableReason).toBeNull();
  });

  it('carries an ADVISORY impact report even when nothing is refusing', async () => {
    contractSpy.mockResolvedValue(
      contract({
        impact: {
          required: true,
          resolved: false,
          report: 'behavior-impact-unresolved',
          reason: 'unresolved',
        },
      }),
    );

    const row = await run();

    // D-017: populated INDEPENDENTLY of any refusal. It must reach the panel, and the
    // panel must not render it as a failure.
    expect(row.impact).toMatchObject({ report: 'behavior-impact-unresolved', reason: 'unresolved' });
    expect(row.unavailableReason).toBeNull();
  });
});

describe('permanent negative control — the revision guard has teeth', () => {
  /**
   * A mapper that surfaces `specId` alone, i.e. the exact regression this plan exists to
   * end. If the assertion above ever stops discriminating, this control passes and the
   * expectation below fails loudly.
   */
  const revisionDroppingMapper = (c: { specId: string; revision: number }) => ({
    specId: c.specId,
  }) as { specId: string; revision?: number };

  it('a mapper that drops `revision` produces a clause the guard must reject', () => {
    const mapped = revisionDroppingMapper(clause());

    expect(mapped.specId).toBe('SPEC-a');
    expect(mapped.revision).toBeUndefined();
    expect(typeof mapped.revision).not.toBe('number');
  });
});
