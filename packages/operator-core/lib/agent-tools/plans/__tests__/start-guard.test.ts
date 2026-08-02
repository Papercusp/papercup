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
  } = { txCalls: [], frontmatterStatus: 'ready', forceNoMatch: false };
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
