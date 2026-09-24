// @vitest-environment node
/**
 * Pure result-shape helpers from plans-api.ts that back the PlanEditor
 * save flow + the lock banner. (bucketOf / applyPlanFilters already have
 * dedicated coverage in plan-buckets.test.ts — not duplicated here.)
 *
 *  - `staleConflictOf` — the CAS-stale conflict shape-guard. Returns the
 *    conflict iff the result is a non-success object whose `code` OR
 *    `error` is `'stale'` AND `currentContent` is a string. Every other
 *    branch → null.
 *  - `planLockPath` — workspace-relative lock key (archived plans live
 *    under an extra `archive/` segment).
 *  - `PROMOTABLE_PLAN_STATUSES` — which frontmatter statuses can be written
 *    (the parser-synthesized `unknown` + item-only `blocked` are excluded).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
const { phaseSpy } = vi.hoisted(() => ({ phaseSpy: vi.fn() }));
vi.mock('@/app/_components/perf/perf-marks', () => ({
  markInteractionPhase: phaseSpy,
  PERF_INTERACTIONS: { planPopupOpen: 'plan-popup-open' },
}));
import {
  fetchPlan,
  staleConflictOf,
  planLockPath,
  PROMOTABLE_PLAN_STATUSES,
  normalizeAttentionGroups,
  type SetContentResult,
} from './plans-api';

afterEach(() => {
  vi.unstubAllGlobals();
  phaseSpy.mockClear();
});

describe('popup plan read phases', () => {
  it('marks request start and parsed response without changing the plan result', async () => {
    vi.stubGlobal('window', { location: { origin: 'http://localhost:3170' } });
    const fetchSpy = vi.fn(async (_url: string) => new Response(JSON.stringify({ slug: 'p', raw: '# Body' }), { status: 200 }));
    vi.stubGlobal('fetch', fetchSpy);
    const result = await fetchPlan('p', 'papercusp');
    expect(result).toEqual({ slug: 'p', raw: '# Body' });
    expect(fetchSpy.mock.calls[0]?.[0]).toContain('/api/admin/plans/get?slug=p&mode=full&harness=papercusp');
    expect(phaseSpy.mock.calls).toEqual([
      ['plan-popup-open', 'request-started'],
      ['plan-popup-open', 'response-ready'],
    ]);
  });

  it('does not mark a response that arrives after the caller was cancelled', async () => {
    vi.stubGlobal('window', { location: { origin: 'http://localhost:3170' } });
    let resolveFetch!: (response: Response) => void;
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>((resolve) => { resolveFetch = resolve; })));
    const controller = new AbortController();
    const pending = fetchPlan('p', controller.signal);
    expect(phaseSpy).toHaveBeenCalledWith('plan-popup-open', 'request-started');
    controller.abort();
    resolveFetch(new Response(JSON.stringify({ slug: 'p' }), { status: 200 }));
    expect(await pending).toEqual({ slug: 'p' });
    expect(phaseSpy.mock.calls).toEqual([['plan-popup-open', 'request-started']]);
  });
});

describe('normalizeAttentionGroups', () => {
  it('removes sparse and malformed live-sync entries before Create reads item.kind', () => {
    const valid = { id: 'a', kind: 'coord-message' };
    const rows = normalizeAttentionGroups([
      undefined,
      { key: 'alerts:workspace', items: [undefined, null, valid, { id: 'missing-kind' }] },
      { key: 'missing-items' },
    ]);

    expect(rows).toHaveLength(1);
    expect(rows[0]?.key).toBe('alerts:workspace');
    expect(rows[0]?.items).toEqual([valid]);
  });

  it('returns an empty snapshot for a completely malformed payload', () => {
    expect(normalizeAttentionGroups([null, false, 'group', { items: [] }])).toEqual([]);
  });
});

describe('staleConflictOf', () => {
  it('returns the conflict when error==="stale" and currentContent is a string', () => {
    const r: SetContentResult = { error: 'stale', currentContent: 'newer body' };
    expect(staleConflictOf(r)).toEqual({ currentContent: 'newer body', currentHash: undefined });
  });

  it('returns the conflict when code==="stale" (sketch shape) and carries currentHash', () => {
    const r: SetContentResult = { code: 'stale', currentContent: 'newer body', currentHash: 'h1' };
    expect(staleConflictOf(r)).toEqual({ currentContent: 'newer body', currentHash: 'h1' });
  });

  it('drops a non-string currentHash to undefined', () => {
    const r = { code: 'stale', currentContent: 'x', currentHash: 42 } as unknown as SetContentResult;
    expect(staleConflictOf(r)).toEqual({ currentContent: 'x', currentHash: undefined });
  });

  it('returns null on a success result (ok:true)', () => {
    expect(staleConflictOf({ ok: true, slug: 'p' })).toBeNull();
  });

  it('returns null when stale but currentContent is missing / not a string', () => {
    expect(staleConflictOf({ error: 'stale' })).toBeNull();
    expect(
      staleConflictOf({ code: 'stale', currentContent: 123 } as unknown as SetContentResult),
    ).toBeNull();
  });

  it('returns null for a non-stale failure code (e.g. a lint error)', () => {
    const r: SetContentResult = {
      error: 'lint_failed',
      currentContent: 'irrelevant',
      errors: [{ level: 'error', code: 'X', message: 'm' }],
    };
    expect(staleConflictOf(r)).toBeNull();
  });

  it('returns null when neither code nor error is present', () => {
    expect(staleConflictOf({ currentContent: 'x' } as unknown as SetContentResult)).toBeNull();
  });
});

describe('planLockPath', () => {
  it('maps a live plan to the plans dir', () => {
    expect(planLockPath('auth-rework', false)).toBe('apps/operator/docs/plans/auth-rework.md');
  });

  it('maps an archived plan under the archive/ segment', () => {
    expect(planLockPath('auth-rework', true)).toBe(
      'apps/operator/docs/plans/archive/auth-rework.md',
    );
  });

  it('does not sanitize the slug — it is inlined verbatim', () => {
    // The path mirrors with-plan-lock.ts; the slug is the caller's concern.
    expect(planLockPath('a-b_c', false)).toBe('apps/operator/docs/plans/a-b_c.md');
  });
});

describe('PROMOTABLE_PLAN_STATUSES', () => {
  it('contains exactly the four writable frontmatter statuses', () => {
    expect([...PROMOTABLE_PLAN_STATUSES].sort()).toEqual(
      ['active', 'draft', 'shipped', 'superseded'].sort(),
    );
  });

  it('includes draft/active/shipped/superseded', () => {
    for (const s of ['draft', 'active', 'shipped', 'superseded'] as const) {
      expect(PROMOTABLE_PLAN_STATUSES).toContain(s);
    }
  });

  it('excludes the synthesized `unknown` and the item-only `blocked` / derived `ready`', () => {
    expect(PROMOTABLE_PLAN_STATUSES as readonly string[]).not.toContain('unknown');
    expect(PROMOTABLE_PLAN_STATUSES as readonly string[]).not.toContain('blocked');
    expect(PROMOTABLE_PLAN_STATUSES as readonly string[]).not.toContain('ready');
  });
});
