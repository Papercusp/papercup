/**
 * agent-goal-sources.resource-governor.test.ts — EI-21870243647094665.
 *
 * THE BUG. `readHeldWorkItems` (the work-item leg feeding P-016's goal
 * resolver, `resolveAgentGoal`) filtered by `status <> ALL(TERMINAL_WORK_ITEM_STATES)`
 * alone. A `system:resource-governor` inference-admission receipt is a
 * `harness_shared.work_items` row with `taken_by` set to the querying agent —
 * local queue telemetry, not real engineering work — and it can carry a
 * non-terminal outer `status` while briefly in flight, or as a
 * legacy/partially-reconciled row whose outer status column never caught up
 * to its true terminal state. Neither case is excluded by a bare status
 * filter, so the receipt entered `GoalCandidates.workItems` alongside the
 * agent's real engineering claim (e.g. `EI-218678`) and `resolveAgentGoal`
 * reported `agreement: 'divergent'` with the receipt as `goalRef` and the
 * real work demoted into `competing` — making a sole, uncontested lane look
 * conflicted to `work_items:get`'s `holder` field AND `locks:queue`'s
 * `holder_context` (both render through this one shared derivation).
 *
 * THE FIX. Exclude by the reserved `resource_governor` payload marker,
 * mirroring `carry-brief.ts`'s identical fix for the sibling defect
 * (EI-21867218655207954, session:request-compaction's checkpoint tripwire).
 * Same class of bug, same repo-established remedy, now applied at the ONE
 * place `readHeldWorkItems` for the goal resolver lives.
 *
 * WHY THE ASSERTION IS ON QUERY TEXT, NOT A THREADED PARAMETER. The
 * `resource_governor` exclusion is a static SQL fragment (a literal key
 * name), not an interpolated value — there is no bound parameter a fake
 * could apply the way `agent-goal-lens.test.ts` applies `includeLapsed`.
 * `carry-brief.test.ts` established the pattern for exactly this shape of
 * filter: the fake `sql` inspects the raw query TEXT for the exclusion
 * clause and only then applies it to the canned rows — so a regression that
 * drops the clause changes the RESULT (the receipt reappears), not just a
 * dropped assertion.
 *
 * Run: cd packages/operator-core && npx vitest run lib/agent-tools/coordination/agent-goal-sources.resource-governor.test.ts
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { sqlMock, fastPathState, foldFactsMock } = vi.hoisted(() => ({
  sqlMock: Object.assign(vi.fn(), { reserve: vi.fn() }),
  fastPathState: { on: true },
  foldFactsMock: vi.fn(async () => []),
}));

vi.mock('./log', () => ({
  coordSql: () => sqlMock,
  coordWorkspaceId: () => 'default',
  coordHasPgFastPath: () => fastPathState.on,
}));

// No author override in play — exercise the work-item leg and its precedence
// over an unrelated plan-item/fleet leg, not the override short-circuit.
vi.mock('../../agent-facts/store', () => ({ foldFacts: foldFactsMock }));

import { readGoalCandidates, resolveOwnerGoal, resolveOwnerGoalForAuthority } from './agent-goal-sources';

const OWNER = 'su-goal-rg-test';

const RECEIPT_EXCLUSION_CLAUSE =
  "NOT jsonb_exists(COALESCE(payload, '{}'::jsonb), 'resource_governor')";

interface WorkItemRow {
  id: string;
  taken_at: string | null;
  /** Whether this canned row would carry the reserved `resource_governor`
   *  payload marker in production — used ONLY by the fake to decide what a
   *  correctly-filtered query would return, never read by the code under test. */
  isGovernorReceipt: boolean;
}

/**
 * Route the four legs by query text. The work-items leg APPLIES the
 * `resource_governor` exclusion exactly as Postgres would IF the production
 * query text contains the clause — so dropping the clause from the source
 * changes what this fake returns, and the test fails against the
 * pre-fix shape.
 */
function primeSql(workItems: WorkItemRow[]) {
  const workItemQueries: { text: string }[] = [];
  sqlMock.mockImplementation((strings: TemplateStringsArray) => {
    const text = Array.isArray(strings) ? strings.join('?') : String(strings);

    if (text.includes('FROM harness_shared.work_items')) {
      workItemQueries.push({ text });
      const excludesReceipts = text.includes(RECEIPT_EXCLUSION_CLAUSE);
      const visible = excludesReceipts ? workItems.filter((w) => !w.isGovernorReceipt) : workItems;
      return Promise.resolve(visible.map((w) => ({ id: w.id, taken_at: w.taken_at })));
    }
    if (text.includes('plan_item_claims')) return Promise.resolve([]);
    if (text.includes('fleet_membership_events')) return Promise.resolve([]);
    if (text.includes('coord_links')) return Promise.resolve([]);
    return Promise.resolve([]);
  });
  return workItemQueries;
}

beforeEach(() => {
  sqlMock.mockReset();
  sqlMock.reserve.mockReset();
  foldFactsMock.mockClear();
  fastPathState.on = true;
});

describe('goal selector cancellation', () => {
  it('releases a late reservation without starting the override read', async () => {
    const connection = { release: vi.fn() };
    let supplyConnection!: (value: typeof connection) => void;
    sqlMock.reserve.mockReturnValue(new Promise<typeof connection>(resolve => {
      supplyConnection = resolve;
    }));
    const controller = new AbortController();
    const result = resolveOwnerGoalForAuthority(OWNER, 'self', () => {}, controller.signal);
    expect(sqlMock.reserve).toHaveBeenCalledOnce();
    controller.abort(new Error('selector deadline expired'));
    supplyConnection(connection);

    expect(await result).toEqual({ goal: null, diagnostics: [
      { leg: 'resolution', status: 'unavailable', detail: 'selector deadline expired' },
    ] });
    expect(foldFactsMock).not.toHaveBeenCalled();
    expect(connection.release).toHaveBeenCalledOnce();
  });
});

describe('EI-21870243647094665: a resource-governor receipt cannot compete with the real goal', () => {
  it('the production query excludes receipts by the reserved payload marker', async () => {
    const queries = primeSql([
      { id: 'EI-218678', taken_at: '2026-08-30T09:00:00.000Z', isGovernorReceipt: false },
    ]);
    await readGoalCandidates(OWNER, 'peer');
    expect(queries[0]!.text).toContain(RECEIPT_EXCLUSION_CLAUSE);
  });

  it('THE REGRESSION: a held receipt alongside real work no longer produces a divergent goal', async () => {
    // WI-1151772 mirrors the reported receipt: taken_by the owner, a
    // non-terminal outer status at read time (this fake never sees `status`
    // directly, only whether the payload marker would exclude it — the same
    // discriminator the production filter uses). EI-218678 is the agent's
    // real, uncontested engineering claim.
    primeSql([
      { id: 'WI-1151772', taken_at: '2026-08-30T08:59:00.000Z', isGovernorReceipt: true },
      { id: 'EI-218678', taken_at: '2026-08-30T09:00:00.000Z', isGovernorReceipt: false },
    ]);

    const goal = await resolveOwnerGoal(OWNER, 'peer');

    // Before the fix: agreement:'divergent', ref could resolve to either held
    // row (recency-picked), with the other landing in `competing` — exactly
    // the false conflict `work_items:get` and `locks:queue` reported.
    expect(goal?.ref).toBe('EI-218678');
    expect(goal?.agreement).toBe('sole');
    expect(goal?.competing).toEqual([]);
  });

  it('the receipt never enters the candidates array at all, even before resolution', async () => {
    primeSql([
      { id: 'WI-1152090', taken_at: '2026-08-30T08:59:00.000Z', isGovernorReceipt: true },
      { id: 'EI-218678', taken_at: '2026-08-30T09:00:00.000Z', isGovernorReceipt: false },
    ]);

    const candidates = await readGoalCandidates(OWNER, 'peer');
    expect((candidates.workItems ?? []).map((w) => w.id)).toEqual(['EI-218678']);
  });

  it('two live receipts and nothing else still resolve to no goal, not a divergent one', async () => {
    primeSql([
      { id: 'WI-1151772', taken_at: '2026-08-30T08:59:00.000Z', isGovernorReceipt: true },
      { id: 'WI-1152090', taken_at: '2026-08-30T09:00:00.000Z', isGovernorReceipt: true },
    ]);

    const goal = await resolveOwnerGoal(OWNER, 'peer');
    expect(goal).toBeNull();
  });
});
