/**
 * start-guard.test.ts — plans:start refuses a terminal plan.
 *
 * The cross-store invariant's forward guard: starting a plan whose
 * git-canonical frontmatter is already shipped/superseded would create the
 * exact started+terminal state the system works to make impossible. The
 * handler reads the frontmatter first and refuses before ever writing the
 * op_status onto the plan's harness_plans row. We mock the plan read + the
 * PG/lock side-effects so the branch is exercised without a database or a
 * real plan row.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const H = vi.hoisted(() => {
  const state: {
    txCalls: { strings: readonly string[]; values: unknown[] }[];
    frontmatterStatus: string | null;
    /** WI-5825 regression override: force the next UPDATE to match 0 rows. */
    forceNoMatch: boolean;
    /** P-047: is the retired op_status axis still writable (flag ON)? */
    mugKettleOn: boolean;
  } = { txCalls: [], frontmatterStatus: 'ready', forceNoMatch: false, mugKettleOn: true };
  const tx = (strings: readonly string[], ...values: unknown[]) => {
    state.txCalls.push({ strings, values });
    // WI-5825 regression hook: force the UPDATE to match 0 rows.
    if (state.forceNoMatch) return Promise.resolve([]);
    return Promise.resolve([{ op_status: 'started', op_updated_at: '2026-06-02T00:00:00.000Z' }]);
  };
  const withWorkspace = async (_wsId: string, fn: (t: unknown) => Promise<unknown>) => fn(tx);
  return { state, withWorkspace };
});

vi.mock('@papercusp/db-org', async (orig) => {
  const actual = await orig<typeof import('@papercusp/db-org')>();
  return { ...actual, withWorkspace: H.withWorkspace };
});

vi.mock('../source', async (orig) => {
  const actual = await orig<typeof import('../source')>();
  return {
    ...actual,
    readPlanBySlug: vi.fn(async () => ({
      parsed: { frontmatter: { status: H.state.frontmatterStatus } },
      archived: false,
      row: { planSlug: 'mock', version: 1, opStatus: null },
    })),
    // WI-5825: plans:start now resolves its WRITE key through the same authority
    // its READ above uses (resolvePlanScope), instead of re-deriving the tenant
    // from the ambient activeWorkspaceId(). Pin it so the SQL params are
    // deterministic — and deliberately NOT 'default', so a regression to the old
    // literal/ambient path shows up in the assertions below.
    resolvePlanScope: vi.fn(async (opts: { harnessSlug?: string } = {}) => ({
      workspaceId: 'ws-of-harness',
      harnessSlug: opts.harnessSlug?.trim() || 'home-harn',
    })),
  };
});

// P-047 (retire-mug-kettle-su-only-2026-08-09): plans:start's op_status write is
// now gated on the Mug/Kettle retirement flag. PIN it — a real
// `mugKettleSystemEnabled` here reaches the flags server (this suite has no DB),
// resolves fail-CLOSED to retired, and would turn every "the UPDATE runs"
// assertion below into a false red about a write that is merely gated off.
// Default ON so the pre-retirement contract stays asserted verbatim; the retired
// branch flips it explicitly in its own describe block.
vi.mock('../../../pot/started', async (orig) => {
  const actual = await orig<typeof import('../../../pot/started')>();
  return { ...actual, mugKettleSystemEnabled: vi.fn(async () => H.state.mugKettleOn) };
});

// plans:start fires promotePlanItems fire-and-forget after the start. Stub it so
// the suite needs no work_items database — and so the P-047 block below can
// assert promotion STILL runs with the op_status write gated off (previously it
// ran for real and its failure was swallowed by the handler's own .catch()).
vi.mock('../../../plan-workitem-promotion-run', () => ({
  promotePlanItems: vi.fn(async () => ({ promoted: 0, flagOff: false })),
}));

// Auto-approve runs inside withPlanLock after a successful start — stub it to
// a no-op so the proceed-case test doesn't need the real lock side-database.
vi.mock('../with-plan-lock', async (orig) => {
  const actual = await orig<typeof import('../with-plan-lock')>();
  return { ...actual, withPlanLock: vi.fn(async () => ({ kind: 'noop', value: false })) };
});

import tool from '../start';
import { DEFAULT_WORKSPACE_ID } from '../../../workspace-registry';

const MAKE_CTX = () =>
  ({
    log: vi.fn(),
    signal: new AbortController().signal,
    progress: vi.fn(),
    metadata: vi.fn(),
    workspaceId: DEFAULT_WORKSPACE_ID,
    // no harnessSlug → ctxToPlanSourceOpts resolves the papercup default
    role: 'operator' as const,
    principal: { slug: 'agent-test' },
  } as never);

const run = async (args: Record<string, unknown>) =>
  (await tool.handler({ harness: 'papercup', ...args } as never, MAKE_CTX())) as {
    data: {
      ok: true;
      results: Array<Record<string, unknown>>;
      counts: { ok: number; failed: number };
    };
    isError?: boolean;
  };

beforeEach(() => {
  H.state.txCalls = [];
  H.state.frontmatterStatus = 'ready';
  H.state.forceNoMatch = false;
  H.state.mugKettleOn = true;
});

/**
 * The op_status UPDATE, found by CONTENT rather than by position. The handler
 * runs other reads through the same mocked `withWorkspace` before it writes —
 * the P-006 `checkPlanStartable` gate reads the plan row first — so indexing
 * `txCalls[0]` pins the transaction's statement ORDER, which no assertion here
 * is actually about. Adding a read ahead of the write then reds this file for a
 * change that never touched the write at all (it did, 2026-08-01).
 */
const opStatusUpdate = (): { strings: readonly string[]; values: unknown[] } => {
  const call = H.state.txCalls.find((c) => c.strings.join('§').includes('UPDATE harness_shared.harness_plans'));
  if (!call) throw new Error(`no op_status UPDATE among ${H.state.txCalls.length} tx call(s) — the write never ran`);
  return call;
};

describe('plans:start terminal guard', () => {
  it.each(['shipped', 'superseded'])('refuses a %s plan without writing the started row', async (status) => {
    H.state.frontmatterStatus = status;
    const res = await run({ slug: 'done-plan-2026-06-02' });

    expect(res.isError).toBeUndefined();
    expect(res.data.counts).toEqual({ ok: 0, failed: 1 });
    expect(res.data.results[0]).toMatchObject({ ok: false, error: 'plan_terminal', status });
    // The guard returns BEFORE the INSERT — no started row is created.
    expect(H.state.txCalls).toHaveLength(0);
  });

  it('starts a non-terminal (ready) plan — the op_status UPDATE runs', async () => {
    H.state.frontmatterStatus = 'ready';
    const res = await run({ slug: 'live-plan-2026-06-02' });

    expect(res.isError).toBeUndefined();
    expect(res.data.counts).toEqual({ ok: 1, failed: 0 });
    expect(res.data.results[0]).toMatchObject({ ok: true, status: 'started' });
    // PG-canonical: op_status is folded onto the plan's own harness_plans row.
    const sql = opStatusUpdate().strings.join('§');
    expect(sql).toContain('UPDATE harness_shared.harness_plans');
    expect(sql).toContain("op_status     = 'started'");
  });

  it('starts a legacy/no-frontmatter plan (status null → not terminal)', async () => {
    H.state.frontmatterStatus = null;
    const res = await run({ slug: 'legacy-plan' });
    expect(res.isError).toBeUndefined();
    expect(() => opStatusUpdate()).not.toThrow();
  });

  it('WI-5825: the UPDATE is keyed on the resolvePlanScope pair — the same authority the plan READ used', async () => {
    H.state.frontmatterStatus = 'ready';
    await run({ slug: 'live-plan-2026-06-02' });
    const { values } = opStatusUpdate();
    // This handler reads the plan through the reader path and then writes; keying
    // the write off a second resolver (activeWorkspaceId / the raw ctx slug) is
    // exactly how the two came to disagree.
    expect(values).toContain('ws-of-harness');
    expect(values).not.toContain(DEFAULT_WORKSPACE_ID);
  });

  it('WI-5825: a 0-row UPDATE reports plan_not_found instead of announcing a start that never happened', async () => {
    H.state.frontmatterStatus = 'ready';
    H.state.forceNoMatch = true;
    const res = await run({ slug: 'ghost-plan' });
    expect(res.data.counts).toEqual({ ok: 0, failed: 1 });
    expect(res.data.results[0]).toMatchObject({ ok: false, error: 'plan_not_found' });
    // ...and crucially it is NOT reported as started, so the `plan started` demand
    // event (which fires on transitioned:true) cannot fire on a write that missed.
    expect(res.data.results[0]).not.toMatchObject({ status: 'started' });
  });
});

/**
 * P-047 / D-010 — the OPERATIONAL axis (op_status) retires with the Mug/Kettle
 * tier, and this is the half that actually matters: op_status does not ENABLE
 * anything for su, it RESERVES the plan's items from scheduler self-selection
 * (`reservedPlanLaneExclusionSql`) for a dispatcher that no longer runs. So the
 * contract is asymmetric and both halves need pinning: the WRITE must not
 * happen, and everything else the verb does — approval and, above all,
 * promotion — must still happen. A gate that also stopped promotion would be
 * the P-044 mistake ("the cut was backwards"): the su queue would never fill.
 */
describe('plans:start — the retired op_status axis (P-047)', () => {
  beforeEach(() => {
    H.state.mugKettleOn = false;
  });

  it('writes NO op_status while the tier is retired — and says so instead of claiming a start', async () => {
    const res = await run({ slug: 'live-plan-2026-06-02' });

    expect(res.data.counts).toEqual({ ok: 1, failed: 0 });
    // The whole point: no UPDATE reached harness_plans.
    expect(() => opStatusUpdate()).toThrow(/the write never ran/);
    // Reporting `status:'started'` on a row that carries nothing is the WI-5825
    // "announced a start that never happened" bug wearing a flag.
    expect(res.data.results[0]).toMatchObject({ ok: true, status: null, opStatusRetired: true });
    // Promotion is fire-and-forget and may be refused by the spec-triad gate;
    // this response must not claim items were promoted when it cannot know that.
    expect(res.data.results[0].message).toContain('verify claimable work-items');
    expect(res.data.results[0].message).not.toMatch(/items promoted/i);
    // transitioned MUST stay false, or the `plan started` demand event fires at
    // the retired Queen for a transition that did not occur. This is the trap in
    // the retired branch: prev_op_status mirrors the CURRENT value there, so a
    // never-started plan scores `null !== 'started'` unless axisLive gates it.
    expect(res.data.results[0]).toMatchObject({ transitioned: false });
  });

  it('still detects plan_not_found — the retired branch reads the SAME key the write used', async () => {
    H.state.forceNoMatch = true;
    const res = await run({ slug: 'ghost-plan' });
    expect(res.data.counts).toEqual({ ok: 0, failed: 1 });
    expect(res.data.results[0]).toMatchObject({ ok: false, error: 'plan_not_found' });
  });

  it('KEEPS promoting items into work_items — the gate is on the write, never on the mechanism', async () => {
    const { promotePlanItems } = await import('../../../plan-workitem-promotion-run');
    await run({ slug: 'live-plan-2026-06-02' });
    // Fire-and-forget inside the handler (`void import(...)`), so wait for it
    // rather than asserting synchronously on a promise nobody awaited.
    await vi.waitFor(() => expect(promotePlanItems).toHaveBeenCalled());
    expect(vi.mocked(promotePlanItems).mock.calls[0][0]).toMatchObject({
      planSlug: 'live-plan-2026-06-02',
      workspaceId: 'ws-of-harness',
    });
  });
});
