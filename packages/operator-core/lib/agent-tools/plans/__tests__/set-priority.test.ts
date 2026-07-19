/**
 * set-priority.test.ts — handler-level unit tests for plans:set-priority
 * (dbos-system-completion P-045/D-013).
 *
 * The verb resolves a harness slug then issues one UPDATE against
 * harness_shared.harness_plans.op_priority inside withWorkspace (op_priority
 * was folded onto the plan's own row under PG-canonical storage). We mock
 * withWorkspace to capture the tagged-template call so the SQL shape, the
 * threaded params (incl. a null priority = clear), the harness resolution
 * precedence, and the return shape are verified without a real database.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const H = vi.hoisted(() => {
  const state: {
    txCalls: { strings: readonly string[]; values: unknown[] }[];
    /** EI-16183 regression override: force the next UPDATE to match 0 rows. */
    forceNoMatch: boolean;
  } = { txCalls: [], forceNoMatch: false };
  // A captured `tx` tagged template: tx`...${v}...` → tx(strings, ...values).
  // EI-16183: the handler now RETURNS the updated row and treats a 0-row match as
  // plan_not_found (rather than a silently-successful no-op) — echo the plan_slug
  // param (always the last value bound) back as a matched row so the existing
  // "found" assertions below still exercise the success path, unless a test opts
  // into forceNoMatch to exercise the not-found path.
  const tx = (strings: readonly string[], ...values: unknown[]) => {
    state.txCalls.push({ strings, values });
    if (state.forceNoMatch) return Promise.resolve([]);
    return Promise.resolve([{ plan_slug: values[values.length - 1] }]);
  };
  const withWorkspace = async (_wsId: string, fn: (t: unknown) => Promise<unknown>) => fn(tx);
  return { state, withWorkspace };
});

vi.mock('@papercusp/db-org', async (orig) => {
  const actual = await orig<typeof import('@papercusp/db-org')>();
  return { ...actual, withWorkspace: H.withWorkspace };
});

// EI-16183: the handler resolves its workspace via activeWorkspaceId() (process-global
// — request-ALS → PAPERCUSP_WORKSPACE_ID → registry default), uncontrolled here. Pin it
// deterministically rather than depending on the real machine's workspace-registry file.
vi.mock('../../../workspace-registry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../workspace-registry')>();
  return { ...actual, activeWorkspaceId: () => actual.DEFAULT_WORKSPACE_ID };
});

import tool from '../set-priority';
import { operatorHomeHarnessSlug } from '../../../harness/operator-home-harness';
import { DEFAULT_WORKSPACE_ID } from '../../../workspace-registry';

const MAKE_CTX = (harnessSlug?: string) =>
  ({
    log: vi.fn(),
    signal: new AbortController().signal,
    progress: vi.fn(),
    workspaceId: DEFAULT_WORKSPACE_ID,
    harnessSlug,
    role: 'operator' as const,
    principal: { slug: 'agent-test' },
  } as never);

const run = async (args: Record<string, unknown>, ctxHarness?: string) =>
  (await tool.handler(args as never, MAKE_CTX(ctxHarness))) as {
    data: {
      ok: true;
      results: Array<Record<string, unknown>>;
      counts: { ok: number; failed: number };
    };
  };

beforeEach(() => {
  H.state.txCalls = [];
  H.state.forceNoMatch = false;
});

describe('plans:set-priority', () => {
  it('issues one UPDATE on harness_plans.op_priority and returns the resolved fields', async () => {
    const res = await run({ slug: 'my-plan-2026-06-01', priority: 3, harness: 'myharn' });

    expect(H.state.txCalls).toHaveLength(1);
    const { strings, values } = H.state.txCalls[0];
    const sqlText = strings.join('§');
    expect(sqlText).toContain('UPDATE harness_shared.harness_plans');
    expect(sqlText).toContain('op_priority');
    // Params: [priority, op_updated_at, workspace_id, harness_slug, plan_slug].
    expect(values[0]).toBe(3);
    expect(values[2]).toBe(DEFAULT_WORKSPACE_ID);
    expect(values[3]).toBe('myharn');
    expect(values[4]).toBe('my-plan-2026-06-01');

    expect(res.data.counts).toEqual({ ok: 1, failed: 0 });
    expect(res.data.results[0]).toMatchObject({ ok: true, slug: 'my-plan-2026-06-01', harnessSlug: 'myharn', priority: 3 });
  });

  it('threads a null priority through (clear → use started-order default)', async () => {
    const res = await run({ slug: 'p', priority: null, harness: 'myharn' });
    expect(H.state.txCalls[0].values[0]).toBeNull();
    expect(res.data.results[0].priority).toBeNull();
  });

  it('resolves the harness from ctx when no explicit arg is given', async () => {
    await run({ slug: 'p', priority: 1 }, 'ctxharn');
    expect(H.state.txCalls[0].values[3]).toBe('ctxharn');
  });

  it('defaults to the operator-home harness when the arg is the all-sentinel', async () => {
    const home = operatorHomeHarnessSlug(); // 'papercusp' post-migration
    const res = await run({ slug: 'p', priority: 1, harness: 'all' });
    expect(H.state.txCalls[0].values[3]).toBe(home);
    expect(res.data.results[0].harnessSlug).toBe(home);
  });

  it('refuses when neither an arg nor a ctx harness scope is present', async () => {
    await expect(run({ slug: 'p', priority: 1 })).rejects.toThrow();
    expect(H.state.txCalls).toHaveLength(0);
  });

  it('EI-16183 regression: a 0-row UPDATE (e.g. wrong workspace) is reported as plan_not_found, never a silent ok:true no-op', async () => {
    H.state.forceNoMatch = true;
    const res = await run({ slug: 'ghost-plan', priority: 1, harness: 'myharn' });
    expect(res.data.results[0]).toMatchObject({ ok: false, slug: 'ghost-plan', error: 'plan_not_found' });
    expect(res.data.counts).toEqual({ ok: 0, failed: 1 });
  });
});
