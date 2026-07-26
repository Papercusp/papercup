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

// WI-5825: the handler resolves its (workspace_id, harness_slug) key through
// resolvePlanScope — the SAME authority the plan readers use — never via the
// ambient activeWorkspaceId() and never off the raw ctx slug. This fake models the
// two things that authority does and that the ambient path got wrong:
//   1. the workspace is a property OF THE HARNESS (registry/projects), not of
//      whatever workspace happens to be "current" in this process, and
//   2. a MEMBER harness collapses to its Hive HOME, because plans are Hive-scoped.
// Deliberately NON-'default' so a regression to a DEFAULT_WORKSPACE_ID literal —
// or to activeWorkspaceId(), which these tests no longer control — fails here.
const HOME_WS = 'ws-of-home';
const MEMBER_HARNESS = 'member-harn';
const MEMBER_HIVE_HOME = 'hive-home-harn';
const wsOf = (harness: string) => (harness === MEMBER_HIVE_HOME ? 'ws-of-hive' : `ws-of-${harness}`);

vi.mock('../source', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../source')>();
  const { operatorHomeHarnessSlug: home } = await import('../../../harness/operator-home-harness');
  return {
    ...actual,
    resolvePlanScope: async (opts: { harnessSlug?: string } = {}) => {
      const raw = opts.harnessSlug?.trim();
      if (!raw || raw === '*' || raw === 'all' || raw === home()) {
        return { workspaceId: HOME_WS, harnessSlug: home() };
      }
      const collapsed = raw === MEMBER_HARNESS ? MEMBER_HIVE_HOME : raw;
      return { workspaceId: wsOf(collapsed), harnessSlug: collapsed };
    },
  };
});

// The ambient workspace is deliberately pinned to something WRONG: if the handler
// ever reads it again, the assertions below catch it immediately.
vi.mock('../../../workspace-registry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../workspace-registry')>();
  return { ...actual, activeWorkspaceId: () => 'ambient-WRONG-workspace' };
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
    expect(values[2]).toBe(wsOf('myharn'));
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

  it('WI-5825 regression (gen 1+2): the workspace comes from the plan-scope resolver, NEVER the ambient one or a DEFAULT_WORKSPACE_ID literal', async () => {
    await run({ slug: 'p', priority: 1, harness: 'myharn' });
    const wsParam = H.state.txCalls[0].values[2];
    // The row's tenant is a property of the HARNESS...
    expect(wsParam).toBe(wsOf('myharn'));
    // ...not of whatever workspace is "current" in this process (gen 2),
    // and not the 'default' literal that matched zero real rows (gen 1).
    expect(wsParam).not.toBe('ambient-WRONG-workspace');
    expect(wsParam).not.toBe(DEFAULT_WORKSPACE_ID);
  });

  it('WI-5825 regression (gen 3): a MEMBER harness is keyed on its Hive HOME — the same collapse the readers apply', async () => {
    const res = await run({ slug: 'p', priority: 1, harness: MEMBER_HARNESS });
    const { values } = H.state.txCalls[0];
    // Plans are Hive-scoped: the row lives under the home, so a writer that
    // kept the raw ctx slug would UPDATE a row no reader ever looks at.
    expect(values[3]).toBe(MEMBER_HIVE_HOME);
    expect(values[3]).not.toBe(MEMBER_HARNESS);
    // ...and the workspace travels with the collapsed harness, not the raw one.
    expect(values[2]).toBe(wsOf(MEMBER_HIVE_HOME));
    // The result reports the key actually written, so a caller can see it.
    expect(res.data.results[0].harnessSlug).toBe(MEMBER_HIVE_HOME);
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
