/**
 * Unit tests for the explicit harness-scope resolver (_harness-scope.ts).
 * Pure function — covers the arg/ctx precedence + the '*'-as-no-choice rule.
 */
import { describe, expect, it } from 'vitest';
import { HarnessRequiredError } from '@papercusp/agent-mcp';
import {
  harnessRequiredResult,
  harnessRequiredDetail,
  harnessScopedCtx,
  isAllHarnessSentinel,
  isEngineeringDocsSentinel,
  resolveConcreteHarnessSlug,
  resolveHarnessScope,
  stripCallerOperatorScope,
} from './_harness-scope';

describe('isAllHarnessSentinel', () => {
  it('treats * and all (any case) as the sentinel', () => {
    for (const v of ['*', 'all', 'ALL', ' All ']) expect(isAllHarnessSentinel(v)).toBe(true);
  });
  it('treats a real slug / empty / nullish as not-sentinel', () => {
    for (const v of ['papercup', 'restart', '', undefined, null]) expect(isAllHarnessSentinel(v)).toBe(false);
  });
});

describe('stripCallerOperatorScope (EI-20186804943808838)', () => {
  it('drops a caller-supplied operator-scope sentinel in any accepted spelling', () => {
    for (const v of ['*', 'all', 'ALL', ' All ']) {
      expect(stripCallerOperatorScope({ harness: v, plan: 'p' })).toEqual({ plan: 'p' });
    }
  });
  it('leaves a concrete harness untouched — a caller may still scope itself', () => {
    expect(stripCallerOperatorScope({ harness: 'papercusp', plan: 'p' }))
      .toEqual({ harness: 'papercusp', plan: 'p' });
  });
  it('handles an absent context and an absent harness without inventing keys', () => {
    expect(stripCallerOperatorScope(undefined)).toEqual({});
    expect(stripCallerOperatorScope(null)).toEqual({});
    // Typed to match the REAL caller shape (recipes:search's zod-inferred context: `harness`
    // declared optional, simply absent at runtime). The annotation is load-bearing, not
    // decoration — an untyped `{ plan: 'p' }` literal shares no properties with the
    // all-optional constraint, so TS's weak-type check rejects it (TS2559) even though the
    // call is valid. This keeps the case honest: an ABSENT harness key, which is a different
    // input from `harness: undefined`.
    const noHarness: { harness?: string; plan: string } = { plan: 'p' };
    expect(stripCallerOperatorScope(noHarness)).toEqual({ plan: 'p' });
    expect('harness' in noHarness).toBe(false);
  });
  it('removes the key entirely rather than setting it undefined (so a later spread can supply it)', () => {
    // The call site spreads server-derived values AFTER this; a surviving `harness: undefined`
    // key would still be overwritten, but an own-key with undefined would defeat any `??`
    // consumer downstream. Assert the key is genuinely gone.
    expect(Object.keys(stripCallerOperatorScope({ harness: '*', plan: 'p' }))).toEqual(['plan']);
  });
});

describe('isEngineeringDocsSentinel (EI-18894866320087268)', () => {
  it('treats "engineering" (any case, trimmed) as the sentinel', () => {
    for (const v of ['engineering', 'ENGINEERING', ' Engineering ']) expect(isEngineeringDocsSentinel(v)).toBe(true);
  });
  it('does NOT treat all/*/a real slug/empty/nullish as the engineering sentinel', () => {
    for (const v of ['all', '*', 'papercup', 'restart', '', undefined, null]) {
      expect(isEngineeringDocsSentinel(v)).toBe(false);
    }
  });
  it('is a DISTINCT literal from isAllHarnessSentinel — neither predicate double-matches the other\'s sentinel', () => {
    expect(isAllHarnessSentinel('engineering')).toBe(false);
    expect(isEngineeringDocsSentinel('all')).toBe(false);
    expect(isEngineeringDocsSentinel('*')).toBe(false);
  });
});

describe('resolveHarnessScope', () => {
  it('explicit all arg → { all } (deliberate operator scope)', () => {
    expect(resolveHarnessScope('all', { harnessSlug: undefined })).toEqual({ kind: 'all' });
    expect(resolveHarnessScope('*', { harnessSlug: '*' })).toEqual({ kind: 'all' });
  });

  it('explicit concrete arg → { harness } (wins over ctx)', () => {
    expect(resolveHarnessScope('restart', { harnessSlug: 'papercup' })).toEqual({ kind: 'harness', slug: 'restart' });
  });

  it('no arg + concrete ctx → { harness } (scoped session)', () => {
    expect(resolveHarnessScope(undefined, { harnessSlug: 'papercup' })).toEqual({ kind: 'harness', slug: 'papercup' });
  });

  it("no arg + ctx '*' (auto superuser default) → { none } (must opt in)", () => {
    expect(resolveHarnessScope(undefined, { harnessSlug: '*' })).toEqual({ kind: 'none' });
  });

  it('no arg + unset ctx → { none }', () => {
    expect(resolveHarnessScope(undefined, { harnessSlug: undefined })).toEqual({ kind: 'none' });
    expect(resolveHarnessScope(undefined, null)).toEqual({ kind: 'none' });
  });

  it("no arg + ctx 'all' literal → { none } (ctx all is not an explicit per-call choice)", () => {
    expect(resolveHarnessScope(undefined, { harnessSlug: 'all' })).toEqual({ kind: 'none' });
  });

  it('trims whitespace on the arg', () => {
    expect(resolveHarnessScope('  restart  ', null)).toEqual({ kind: 'harness', slug: 'restart' });
  });
});

describe('resolveConcreteHarnessSlug', () => {
  it('concrete arg or ctx → that slug', () => {
    expect(resolveConcreteHarnessSlug('restart', { harnessSlug: 'papercup' })).toBe('restart');
    expect(resolveConcreteHarnessSlug(undefined, { harnessSlug: 'papercup' })).toBe('papercup');
  });

  it("operator '*' auto-default (no arg) → null (NOT silently swallowed as a '*' bucket)", () => {
    expect(resolveConcreteHarnessSlug(undefined, { harnessSlug: '*' })).toBeNull();
  });

  it('unset / null ctx → null', () => {
    expect(resolveConcreteHarnessSlug(undefined, { harnessSlug: undefined })).toBeNull();
    expect(resolveConcreteHarnessSlug(undefined, null)).toBeNull();
  });

  it("explicit 'all' / '*' arg → null (cross-harness scope is not a single harness)", () => {
    expect(resolveConcreteHarnessSlug('all', { harnessSlug: 'papercup' })).toBeNull();
    expect(resolveConcreteHarnessSlug('*', { harnessSlug: 'papercup' })).toBeNull();
  });
});

describe('harnessRequiredResult', () => {
  it('returns a fail-loud isError envelope with a harness_required error code', () => {
    const r = harnessRequiredResult('autoloop:status');
    expect(r.isError).toBe(true);
    const payload = JSON.parse(r.content[0].text);
    expect(payload.error).toBe('harness_required');
    expect(payload.tool).toBe('autoloop:status');
    expect(typeof payload.detail).toBe('string');
  });

  it('omits the tool field when no name is passed', () => {
    const payload = JSON.parse(harnessRequiredResult().content[0].text);
    expect(payload.error).toBe('harness_required');
    expect('tool' in payload).toBe(false);
  });
});

describe('harnessRequiredDetail (P-002 registry-guidance contradiction)', () => {
  it("tells a workspace-scoped caller to use a concrete harness and forbids the doomed 'all' retry", () => {
    const detail = harnessRequiredDetail({ workspaceId: 'workspace-1' });
    expect(detail).toContain("`harness: 'papercusp'`");
    expect(detail).toContain("Do not retry with `harness: 'all'`");
    expect(detail).toContain('harness_forbidden');
  });

  it("allows the 'all' sentinel only for a truly unscoped workspace context", () => {
    const detail = harnessRequiredDetail({ workspaceId: '*' });
    expect(detail).toContain("`harness: 'all'`");
    expect(detail).toContain('--all-workspaces');
    expect(detail).not.toContain('harness_forbidden');
  });
});

describe('harnessScopedCtx', () => {
  it('throws HarnessRequiredError when no harness is resolvable', () => {
    expect(() => harnessScopedCtx(undefined, { harnessSlug: '*' })).toThrow(HarnessRequiredError);
    expect(() => harnessScopedCtx(undefined, { harnessSlug: undefined })).toThrow(HarnessRequiredError);
  });

  it("pins plans:get's workspace-scoped harness_required correction away from harness:'all'", () => {
    expect(() => harnessScopedCtx(undefined, { harnessSlug: '*', workspaceId: 'workspace-1' }))
      .toThrow(/Do not retry with `harness: 'all'`.*harness_forbidden/);
  });

  it("'all' arg → ctx with harnessSlug '*' (preserving other ctx fields)", () => {
    expect(harnessScopedCtx('all', { harnessSlug: '*', runId: 'r' })).toEqual({ harnessSlug: '*', runId: 'r' });
  });

  it('concrete arg wins over ctx → ctx with that slug', () => {
    expect(harnessScopedCtx('restart', { harnessSlug: 'papercup' })).toEqual({ harnessSlug: 'restart' });
  });

  it('scoped session (concrete ctx, no arg) → that slug', () => {
    expect(harnessScopedCtx(undefined, { harnessSlug: 'papercup' })).toEqual({ harnessSlug: 'papercup' });
  });
});
