/**
 * recipe-export — what a shared recipe may and may not carry
 * (cupboard-plan-rubric-recipe-sharing-2026-08-21 P-016 / P-013).
 *
 * The load-bearing case is the REFUSAL. A recipe whose script names a concrete plan
 * slug, work-item id, fleet or workspace cannot work elsewhere, and the tempting fix —
 * strip the ref and publish anyway — yields a recipe that runs and does something
 * other than what its title promises. These tests pin the refusal so a later
 * "convenience" that laundered the script would fail here rather than in someone
 * else's workspace.
 */
import { describe, it, expect } from 'vitest';
import { sanitizeRecipeForExport, localRefsOf } from './recipe-export';
import type { RecipeAuthorityDescriptor, RecipeAuthorityRefs } from '../recipe-authority';

const NO_REFS: RecipeAuthorityRefs = {
  workspaces: [],
  fleets: [],
  plans: [],
  harnesses: [],
  items: [],
  resources: [],
};

const portable: RecipeAuthorityDescriptor = {
  refs: NO_REFS,
  unresolved: false,
  unresolvedCause: null,
  bound: false,
};

const ROW = {
  id: 'summarize-failing-tests',
  title: 'Summarize failing tests',
  description: 'Group the red rows by file.',
  script: 'const runs = await testing_runs({ status: ["fail"] });',
  toolsUsed: ['testing:runs'],
  tags: ['testing'],
};

describe('sanitizeRecipeForExport', () => {
  it('exports a portable recipe with only the adoptable fields', () => {
    const r = sanitizeRecipeForExport(ROW, portable);
    if ('error' in r) throw new Error(r.error);
    expect(r.manifest).toEqual({
      id: 'summarize-failing-tests',
      title: 'Summarize failing tests',
      description: 'Group the red rows by file.',
      script: ROW.script,
      toolsUsed: ['testing:runs'],
      tags: ['testing'],
      authorityUnresolved: false,
    });
  });

  it('names the usage/attribution columns it dropped', () => {
    const r = sanitizeRecipeForExport(ROW, portable);
    if ('error' in r) throw new Error(r.error);
    // Reported rather than assumed: the manifest is a SUBSET by construction, so the
    // only way a publisher can see the sanitizer ran is for it to say what it removed.
    expect(r.strippedFields).toEqual(
      expect.arrayContaining(['potSlug', 'createdBy', 'runCount', 'lastRunAt', 'status']),
    );
    expect(Object.keys(r.manifest)).not.toContain('createdBy');
    expect(Object.keys(r.manifest)).not.toContain('runCount');
  });

  it('REFUSES a script naming a concrete plan slug, and names it', () => {
    const r = sanitizeRecipeForExport(ROW, {
      ...portable,
      refs: { ...NO_REFS, plans: ['ship-the-widget-2026-08-21'] },
    });
    expect('error' in r).toBe(true);
    if (!('error' in r)) return;
    expect(r.status).toBe(422);
    expect(r.error).toContain('ship-the-widget-2026-08-21');
    expect(r.localRefs).toEqual({ plans: ['ship-the-widget-2026-08-21'] });
  });

  it('REFUSES on every workspace-local ref family, not just workspaces', () => {
    for (const family of ['workspaces', 'fleets', 'plans', 'harnesses', 'items', 'resources'] as const) {
      const r = sanitizeRecipeForExport(ROW, {
        ...portable,
        refs: { ...NO_REFS, [family]: ['some-value'] },
      });
      expect('error' in r, `${family} should refuse`).toBe(true);
    }
  });

  it('does NOT refuse an unresolved (opaque) script — opacity is not locality', () => {
    // Most captured recipes are unresolved (raw SQL / shell); refusing them would
    // make the recipe kind mostly unpublishable. It travels as a warning instead.
    const r = sanitizeRecipeForExport(ROW, {
      refs: NO_REFS,
      unresolved: true,
      unresolvedCause: { kind: 'opaque-tool', tool: 'dev:pg_query' },
      bound: false,
    });
    if ('error' in r) throw new Error(r.error);
    expect(r.manifest.authorityUnresolved).toBe(true);
    expect(r.manifest.authorityUnresolvedCause).toBe('opaque-tool');
  });

  it('refuses an empty script and a missing id', () => {
    expect('error' in sanitizeRecipeForExport({ ...ROW, script: '  ' }, portable)).toBe(true);
    expect('error' in sanitizeRecipeForExport({ ...ROW, id: '' }, portable)).toBe(true);
  });

  it('falls back to the title when the recipe has no description', () => {
    const r = sanitizeRecipeForExport({ ...ROW, description: '' }, portable);
    if ('error' in r) throw new Error(r.error);
    expect(r.description).toBe('Summarize failing tests');
  });
});

describe('localRefsOf', () => {
  it('is empty for a portable script', () => {
    expect(localRefsOf(NO_REFS)).toEqual({});
  });

  it('reports only the families that carry values', () => {
    expect(localRefsOf({ ...NO_REFS, items: ['WI-1'], plans: ['p'] })).toEqual({
      plans: ['p'],
      items: ['WI-1'],
    });
  });
});
