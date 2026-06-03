/**
 * start-guard.test.ts — plans:start refuses a terminal plan.
 *
 * The cross-store invariant's forward guard: starting a plan whose
 * git-canonical frontmatter is already shipped/superseded would create the
 * exact started+terminal state the system works to make impossible. The
 * handler reads the frontmatter first and refuses before ever writing the
 * harness_plan_status row. We mock the file read + the PG/lock side-effects
 * so the branch is exercised without a database or a real plan file.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const H = vi.hoisted(() => {
  const state: {
    txCalls: { strings: readonly string[]; values: unknown[] }[];
    frontmatterStatus: string | null;
  } = { txCalls: [], frontmatterStatus: 'ready' };
  const tx = (strings: readonly string[], ...values: unknown[]) => {
    state.txCalls.push({ strings, values });
    return Promise.resolve([{ status: 'started', updated_at: '2026-06-02T00:00:00.000Z' }]);
  };
  const withWorkspace = async (_wsId: string, fn: (t: unknown) => Promise<unknown>) => fn(tx);
  return { state, withWorkspace };
});

vi.mock('@papercusp/db-org', async (orig) => {
  const actual = await orig<typeof import('@papercusp/db-org')>();
  return { ...actual, withWorkspace: H.withWorkspace };
});

vi.mock('@/lib/agent-tools/plans/source', async (orig) => {
  const actual = await orig<typeof import('@/lib/agent-tools/plans/source')>();
  return {
    ...actual,
    readPlanBySlug: vi.fn(async () => ({
      parsed: { frontmatter: { status: H.state.frontmatterStatus } },
      archived: false,
    })),
  };
});

// Auto-approve runs inside withPlanLock after a successful start — stub it to
// a no-op so the proceed-case test doesn't need the real lock side-database.
vi.mock('@/lib/agent-tools/plans/with-plan-lock', async (orig) => {
  const actual = await orig<typeof import('@/lib/agent-tools/plans/with-plan-lock')>();
  return { ...actual, withPlanLock: vi.fn(async () => ({ kind: 'noop', value: false })) };
});

import tool from '@/lib/agent-tools/plans/start';
import { DEFAULT_WORKSPACE_ID } from '@/lib/workspace-registry';

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
    content: { text: string }[];
    isError?: boolean;
  };

beforeEach(() => {
  H.state.txCalls = [];
  H.state.frontmatterStatus = 'ready';
});

describe('plans:start terminal guard', () => {
  it.each(['shipped', 'superseded'])('refuses a %s plan without writing the started row', async (status) => {
    H.state.frontmatterStatus = status;
    const res = await run({ slug: 'done-plan-2026-06-02' });

    expect(res.isError).toBe(true);
    const data = JSON.parse(res.content[0].text);
    expect(data).toMatchObject({ error: 'plan_terminal', status });
    // The guard returns BEFORE the INSERT — no started row is created.
    expect(H.state.txCalls).toHaveLength(0);
  });

  it('starts a non-terminal (ready) plan — the INSERT runs', async () => {
    H.state.frontmatterStatus = 'ready';
    const res = await run({ slug: 'live-plan-2026-06-02' });

    expect(res.isError).toBeUndefined();
    const data = JSON.parse(res.content[0].text);
    expect(data).toMatchObject({ status: 'started' });
    expect(H.state.txCalls).toHaveLength(1);
    expect(H.state.txCalls[0].strings.join('§')).toContain('INSERT INTO harness_shared.harness_plan_status');
  });

  it('starts a legacy/no-frontmatter plan (status null → not terminal)', async () => {
    H.state.frontmatterStatus = null;
    const res = await run({ slug: 'legacy-plan' });
    expect(res.isError).toBeUndefined();
    expect(H.state.txCalls).toHaveLength(1);
  });
});
