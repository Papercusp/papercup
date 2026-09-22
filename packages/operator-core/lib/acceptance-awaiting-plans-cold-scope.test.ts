/**
 * Recurrence guard for the COLD-SCOPE over-count
 * (plan generic-acceptance-routing-and-live-plan-agent-brief-2026-09-20, found by P-006's
 * live probe; see D-014).
 *
 * THE BUG: `isHarnessInScope` defaults to `workScopePolicy()`, a SYNCHRONOUS read of a
 * cache that is empty until an async refresh lands. An empty policy is "not enforced",
 * and an unenforced policy admits EVERY harness — so on a cold process this filter failed
 * OPEN and counted out-of-scope plans. Measured live: 52 on the first call in a fresh
 * process, 51 on every later call, reproducibly.
 *
 * Why it mattered rather than being a rounding error: `plansAwaitingAcceptance` is the
 * top-priority input to the plan-agent brief, and the brief renders in a freshly-started
 * process — i.e. it read the cold value every time. An over-reported acceptance count
 * makes the brief direct "acceptance first" and withhold a legitimate delegation.
 *
 * The guard asserts the PROPERTY (a cold process filters identically to a warm one),
 * not the implementation, and carries a paired control so it cannot pass vacuously.
 */

import { describe, expect, it, vi } from 'vitest';

/** Two plans, one in an allowed harness and one not. */
const ROWS = [
  { plan_slug: 'in-scope-plan', harness_slug: 'papercusp', rubric_slug: 'r', gradeable_since: null, workspace_id: 'ws' },
  { plan_slug: 'out-of-scope-plan', harness_slug: 'some-other-harness', rubric_slug: 'r', gradeable_since: null, workspace_id: 'ws' },
];

const ENFORCING = { mode: 'enforce' as const, allowHarnesses: ['papercusp', 'portal'] };

/**
 * A policy cache that starts COLD (null) exactly like a fresh process, and is populated
 * only by an explicit refresh — the real module's shape, reduced to the one behaviour
 * under test.
 */
function coldPolicyCache() {
  let cached: typeof ENFORCING | null = null;
  return {
    refreshes: 0,
    workScopePolicy: () => cached,
    isWorkScopeEnforced: (p: typeof ENFORCING | null = cached) => !!p && p.mode === 'enforce',
    isHarnessInScope(slug: string | null, p: typeof ENFORCING | null = cached) {
      // Byte-for-byte the real predicate's fail-open branch: not enforced ⇒ everything
      // is in scope. This is what makes a cold read over-count.
      if (!this.isWorkScopeEnforced(p)) return true;
      return !slug || slug === '*' || p!.allowHarnesses.includes(slug);
    },
    refresh() {
      this.refreshes++;
      cached = ENFORCING;
    },
  };
}

/** The production sequence: ensure the policy is loaded, THEN filter. */
function filterWithRefresh(cache: ReturnType<typeof coldPolicyCache>): string[] {
  if (cache.workScopePolicy() === null) cache.refresh();
  return ROWS.filter((r) => cache.isHarnessInScope(r.harness_slug)).map((r) => r.plan_slug);
}

/** ⛔ DELIBERATELY WRONG — the pre-fix sequence, kept so the assertion is falsifiable. */
function filterWithoutRefresh(cache: ReturnType<typeof coldPolicyCache>): string[] {
  return ROWS.filter((r) => cache.isHarnessInScope(r.harness_slug)).map((r) => r.plan_slug);
}

describe('cold-scope over-count guard', () => {
  it('excludes an out-of-scope harness on a COLD cache, exactly as on a warm one', () => {
    const cold = coldPolicyCache();
    expect(filterWithRefresh(cold)).toEqual(['in-scope-plan']);

    const warm = coldPolicyCache();
    warm.refresh(); // already populated, as in a long-lived operator process
    const before = warm.refreshes;
    expect(filterWithRefresh(warm)).toEqual(['in-scope-plan']);
    // ...and a warm cache is not re-read: the fix is paid once per process, not per call.
    expect(warm.refreshes).toBe(before);
  });

  it('CONTROL — without the refresh the cold cache really does admit the out-of-scope plan', () => {
    // If this ever stops over-counting, the fail-open branch is gone and the test above
    // has become vacuous; fix this control rather than deleting it.
    expect(filterWithoutRefresh(coldPolicyCache())).toEqual(['in-scope-plan', 'out-of-scope-plan']);
  });

  it('the real predicate loads the policy before filtering when the cache is cold', async () => {
    vi.resetModules();
    const refreshPotControlPolicy = vi.fn(async () => {});
    let policy: typeof ENFORCING | null = null;

    vi.doMock('./work-scope-policy', () => ({
      workScopePolicy: () => policy,
      isWorkScopeEnforced: (p: typeof ENFORCING | null = policy) => !!p && p.mode === 'enforce',
      isHarnessInScope: (slug: string | null, p: typeof ENFORCING | null = policy) => {
        if (!p || p.mode !== 'enforce') return true;
        return !slug || slug === '*' || p.allowHarnesses.includes(slug);
      },
    }));
    vi.doMock('./pot-control-policy', () => ({
      refreshPotControlPolicy: async () => {
        refreshPotControlPolicy();
        policy = ENFORCING; // the refresh populates the cache the sync reader reads
      },
    }));

    const { listPlansAwaitingAcceptance } = await import('./acceptance-awaiting-plans');
    const sql = Object.assign(async () => ROWS, {}) as never;

    const out = await listPlansAwaitingAcceptance({ sql, rubricTemplateName: 'tpl', workspaceId: 'ws' });

    expect(refreshPotControlPolicy).toHaveBeenCalledTimes(1);
    expect(out.map((r) => r.planSlug)).toEqual(['in-scope-plan']);

    vi.doUnmock('./work-scope-policy');
    vi.doUnmock('./pot-control-policy');
    vi.resetModules();
  });
});
