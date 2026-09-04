/**
 * Recurrence guard for EI-21194994217912029 — plans:get / plans:items
 * exact-slug scope recovery. The decision logic here IS the fix: a caller
 * holding an exact plan slug with no resolvable harness gets the owning
 * harness RESOLVED (or an error naming what was searched and found) instead
 * of a bare `harness_required` demanding an undiscoverable input.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ planHarnessesForSlugs: vi.fn() }));
vi.mock('./source', () => ({ planHarnessesForSlugs: mocks.planHarnessesForSlugs }));

import {
  decideSlugScope,
  exactPlanSlugsFromArgs,
  recoverHarnessFromSlugs,
  requireUnambiguousSlugScope,
  slugScopeErrorResult,
  verifyExplicitPlanHarness,
} from './slug-scope.js';

describe('decideSlugScope', () => {
  it('resolves when every requested slug maps to one harness', () => {
    const d = decideSlugScope(['a', 'b'], { a: ['hive-1'], b: ['hive-1'] });
    expect(d).toMatchObject({ status: 'resolved', harnessSlug: 'hive-1', bySlug: { a: 'hive-1', b: 'hive-1' }, ambiguous: {} });
  });

  it('resolves through per-slug ambiguity, carrying the candidates (index 0 = most recent)', () => {
    const d = decideSlugScope(['a'], { a: ['hive-new', 'hive-old'] });
    expect(d).toMatchObject({ status: 'resolved', harnessSlug: 'hive-new', ambiguous: { a: ['hive-new', 'hive-old'] } });
  });

  it('reports missing slugs alongside what did resolve — never silently drops them', () => {
    const d = decideSlugScope(['a', 'gone'], { a: ['hive-1'] });
    expect(d).toEqual({ status: 'missing', missing: ['gone'], found: { a: 'hive-1' }, workspaceId: '' });
  });

  it('reports a split when slugs span distinct harnesses', () => {
    const d = decideSlugScope(['a', 'b'], { a: ['hive-1'], b: ['hive-2'] }, 'ws-x');
    expect(d).toEqual({ status: 'split', mapping: { a: 'hive-1', b: 'hive-2' }, workspaceId: 'ws-x' });
  });
});

describe('requireUnambiguousSlugScope', () => {
  it('keeps a uniquely resolved write scope', () => {
    const decision = decideSlugScope(['a', 'b'], { a: ['hive-1'], b: ['hive-1'] }, 'ws-x');
    expect(requireUnambiguousSlugScope(decision, 'ws-x')).toMatchObject({
      status: 'resolved',
      harnessSlug: 'hive-1',
    });
  });

  it('refuses the read path\'s most-recently-updated ambiguity for writes', () => {
    const decision = decideSlugScope(['a'], { a: ['hive-new', 'hive-old'] }, 'ws-x');
    expect(requireUnambiguousSlugScope(decision, 'ws-x')).toEqual({
      status: 'ambiguous',
      candidates: { a: ['hive-new', 'hive-old'] },
      workspaceId: 'ws-x',
    });
  });
});

describe('recoverHarnessFromSlugs', () => {
  beforeEach(() => mocks.planHarnessesForSlugs.mockReset());

  it('searches the concrete session workspace and returns the resolved scope', async () => {
    mocks.planHarnessesForSlugs.mockResolvedValue(new Map([['my-plan', ['hive-a']]]));
    const d = await recoverHarnessFromSlugs({ workspaceId: 'ws-123' }, ['my-plan']);
    expect(mocks.planHarnessesForSlugs).toHaveBeenCalledWith('ws-123', ['my-plan']);
    expect(d).toMatchObject({
      status: 'resolved',
      harnessSlug: 'hive-a',
      bySlug: { 'my-plan': 'hive-a' },
    });
  });

  it("falls back to the operator's OWN workspace when the session is unscoped ('*')", async () => {
    mocks.planHarnessesForSlugs.mockResolvedValue(new Map());
    const d = await recoverHarnessFromSlugs({ workspaceId: '*' }, ['nope']);
    expect(mocks.planHarnessesForSlugs).toHaveBeenCalledWith('papercusp-workspace', ['nope']);
    // The missing decision carries the workspace actually searched — the error
    // must say WHERE it looked (EI-21194994217912029's "undiscoverable" half).
    expect(d.status === 'missing' && d.workspaceId).toBe('papercusp-workspace');
  });
});

describe('exactPlanSlugsFromArgs', () => {
  it('merges slug and slugs with stable de-duplication and ignores non-identity values', () => {
    expect(
      exactPlanSlugsFromArgs({
        slug: ' primary-plan ',
        slugs: ['secondary-plan', 'primary-plan', '  ', 42, null],
        plan: 'must-not-be-inferred',
      }),
    ).toEqual(['primary-plan', 'secondary-plan']);
  });

  it('reads coord:declare-intent current_plan_slug as an explicit plan identity', () => {
    expect(
      exactPlanSlugsFromArgs({
        current_plan_slug: ' recovered-plan ',
        items: ['P-006'],
        intent: 'continue the bound plan lane',
      }),
    ).toEqual(['recovered-plan']);
  });

  it('returns no scope when the argument is not a plans:get identity object', () => {
    expect(exactPlanSlugsFromArgs(null)).toEqual([]);
    expect(exactPlanSlugsFromArgs({ plan: { slug: 'nested-plan' } })).toEqual([]);
    expect(exactPlanSlugsFromArgs('primary-plan')).toEqual([]);
  });
});

describe('verifyExplicitPlanHarness', () => {
  beforeEach(() => mocks.planHarnessesForSlugs.mockReset());

  it('requires every exact slug to be owned by the explicit harness', async () => {
    mocks.planHarnessesForSlugs.mockResolvedValue(
      new Map([
        ['primary-plan', ['papercusp']],
        ['secondary-plan', ['papercusp', 'legacy-harness']],
      ]),
    );

    await expect(
      verifyExplicitPlanHarness(
        { workspaceId: 'ws-123' },
        'papercusp',
        { slug: 'primary-plan', slugs: ['secondary-plan'] },
      ),
    ).resolves.toBe(true);
    expect(mocks.planHarnessesForSlugs).toHaveBeenCalledWith('ws-123', ['primary-plan', 'secondary-plan']);

    mocks.planHarnessesForSlugs.mockResolvedValue(
      new Map([
        ['primary-plan', ['papercusp']],
        ['secondary-plan', ['other-harness']],
      ]),
    );
    await expect(
      verifyExplicitPlanHarness(
        { workspaceId: 'ws-123' },
        'papercusp',
        { slug: 'primary-plan', slugs: ['secondary-plan'] },
      ),
    ).resolves.toBe(false);
  });

  it('fails closed for missing identity, a blank harness, or an index failure', async () => {
    await expect(verifyExplicitPlanHarness({ workspaceId: 'ws-123' }, 'papercusp', {})).resolves.toBe(false);
    await expect(verifyExplicitPlanHarness({ workspaceId: 'ws-123' }, '  ', { slug: 'primary-plan' })).resolves.toBe(false);

    mocks.planHarnessesForSlugs.mockResolvedValue({
      get: () => {
        throw new Error('workspace index unavailable');
      },
    } as unknown as Map<string, string[]>);
    await expect(
      verifyExplicitPlanHarness({ workspaceId: 'ws-123' }, 'papercusp', { slug: 'primary-plan' }),
    ).resolves.toBe(false);
  });
});

describe('slugScopeErrorResult', () => {
  it('missing → plan_not_found_in_workspace naming the searched workspace + hint', () => {
    const r = slugScopeErrorResult('plans:get', {
      status: 'missing',
      missing: ['ghost-plan'],
      found: {},
      workspaceId: 'ws-9',
    });
    expect(r.isError).toBe(true);
    const parsed = JSON.parse(r.content[0].text);
    expect(parsed.error).toBe('plan_not_found_in_workspace');
    expect(parsed.missing).toEqual(['ghost-plan']);
    expect(parsed.detail).toContain("'ws-9'");
    expect(parsed.detail).toContain('harness');
  });

  it('split → harness_split_across_plans carrying the slug→harness mapping', () => {
    const r = slugScopeErrorResult('plans:get', {
      status: 'split',
      mapping: { a: 'hive-1', b: 'hive-2' },
      workspaceId: 'ws-9',
    });
    const parsed = JSON.parse(r.content[0].text);
    expect(parsed.error).toBe('harness_split_across_plans');
    expect(parsed.mapping).toEqual({ a: 'hive-1', b: 'hive-2' });
  });

  it('ambiguous write → names every candidate and requires an explicit harness', () => {
    const r = slugScopeErrorResult('plans:set-plan-status', {
      status: 'ambiguous',
      candidates: { a: ['hive-new', 'hive-old'] },
      workspaceId: 'ws-9',
    });
    const parsed = JSON.parse(r.content[0].text);
    expect(parsed.error).toBe('plan_slug_ambiguous_across_harnesses');
    expect(parsed.candidates).toEqual({ a: ['hive-new', 'hive-old'] });
    expect(parsed.detail).toContain('explicit `harness`');
  });
});
