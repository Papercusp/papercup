/**
 * code-recipes-candidates.test.ts — pure-logic unit tests for the Phase-3 graduation
 * scorer's D-007 name-collision damp (recipes-reuse-activation-2026-06-22 P-001 / Part A).
 *
 * No PG and no populated tool registry needed: the tool-name → recipe-id slug lookup is
 * pure, so the collision FIX is asserted directly here. The reuse FLOOR is covered
 * end-to-end (against real run-logs) in code-recipes-candidates.integration.test.ts.
 *
 * Regression guard for the original bug: the redundancy check compared a recipe id (a
 * kebab slug) against the RAW `ns:verb` tool names, which can never be equal — so the
 * "don't regenerate an existing tool" damp never fired. The slug set fixes it.
 */
import { describe, expect, it } from 'vitest';
import { slugifyToolName, existingToolSlugSet } from './code-recipes-candidates';

describe('slugifyToolName', () => {
  it('kebab-cases a ns:verb tool name into the recipe-id (recipeSlug) shape', () => {
    expect(slugifyToolName('plans:set-status')).toBe('plans-set-status');
    expect(slugifyToolName('work_items:set_state')).toBe('work-items-set-state');
    expect(slugifyToolName('coord:send')).toBe('coord-send');
  });
});

describe('existingToolSlugSet — the D-007 name-collision lookup', () => {
  it('indexes the raw name AND its kebab slug, and a recipe id collides via the SLUG (not the raw ns:verb)', () => {
    const { names, slugs } = existingToolSlugSet(['plans:set-status', 'work_items:list', null, undefined, '']);

    // raw names preserved
    expect(names.has('plans:set-status')).toBe(true);

    // THE FIX: a recipe id (a kebab slug) collides via the SLUG set. The original bug
    // was that only the raw `ns:verb` name set existed, which a slug id never matched.
    expect(slugs.has('plans-set-status')).toBe(true);
    expect(slugs.has('work-items-list')).toBe(true);

    // the raw colon'd form is NOT a recipe-id shape, so a recipe id never equals it
    expect(names.has('plans-set-status')).toBe(false);

    // null/empty/undefined skipped
    expect(slugs.size).toBe(2);
  });

  it('a non-colliding recipe id is absent from both sets (the damp does not over-fire)', () => {
    const { names, slugs } = existingToolSlugSet(['plans:set-status', 'work_items:list']);
    const recipeId = 'triage-and-block-stale';
    expect(names.has(recipeId) || slugs.has(recipeId)).toBe(false);
  });

  it('the collision predicate (names.has(id) || slugs.has(id)) fires for a colliding id', () => {
    const { names, slugs } = existingToolSlugSet(['deploy:harness']);
    const collides = (id: string) => names.has(id) || slugs.has(id);
    expect(collides('deploy-harness')).toBe(true); // recipe id maps onto deploy:harness
    expect(collides('deploy-and-announce')).toBe(false); // distinct recipe — no collision
  });
});
