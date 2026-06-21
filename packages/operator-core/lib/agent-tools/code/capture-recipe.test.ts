/**
 * capture-recipe.test.ts — the PURE code:run → recipe capture helpers
 * (code-recipes-2026-06-21 Phase 1, P-003): slug derivation, the always-derive
 * fallback title/description (so a recipe is ALWAYS saveable), and tools_used
 * extraction via the parse-check ref resolver mapped to canonical ns:verb.
 *
 * The PG/embedder side of captureRecipe is exercised through the store
 * integration test + the run.test.ts capture-trigger test; this file pins the
 * deterministic derivation logic with no PG.
 */
import { describe, it, expect } from 'vitest';
import {
  recipeSlug,
  deriveTitleDescription,
  extractToolsUsed,
} from './capture-recipe';

const mkTool = (name: string) => ({ expose: { mcp: { name } } }) as never;
const TOOLS = [
  mkTool('work_items:list'),
  mkTool('work_items:get'),
  mkTool('coord:wake-queue'),
  mkTool('plans:set-status'),
];

describe('recipeSlug', () => {
  it('kebab-cases a title into a stable slug', () => {
    expect(recipeSlug('Triage Stale Work-Items!')).toBe('triage-stale-work-items');
    expect(recipeSlug('  leading/trailing  ')).toBe('leading-trailing');
  });
});

describe('extractToolsUsed', () => {
  it('maps dotted refs back to canonical ns:verb (sorted, de-duped)', () => {
    const used = extractToolsUsed(
      `const o = await tools.work_items.list({});
       for (const w of o.items) await tools.work_items.get({ id: w.id });
       await tools.coord.wakeQueue();`,
      TOOLS,
    );
    expect(used).toEqual(['coord:wake-queue', 'work_items:get', 'work_items:list']);
  });

  it('resolves the tools.call() escape-hatch full name', () => {
    const used = extractToolsUsed(`await tools.call('plans:set-status', { id: 'P-1' });`, TOOLS);
    expect(used).toEqual(['plans:set-status']);
  });

  it('respects the allow-list (a ref outside it is not counted)', () => {
    const used = extractToolsUsed(
      `await tools.work_items.list({}); await tools.plans.setStatus({});`,
      TOOLS,
      new Set(['work_items:list']),
    );
    expect(used).toEqual(['work_items:list']);
  });

  it('returns [] for a tool-free script', () => {
    expect(extractToolsUsed('return 1 + 1;', TOOLS)).toEqual([]);
  });
});

describe('deriveTitleDescription — always produces a saveable title + description', () => {
  it('uses agent-supplied title/description when given', () => {
    const r = deriveTitleDescription('return 1;', ['coord:send'], {
      title: 'My recipe',
      description: 'does a thing',
    });
    expect(r.title).toBe('My recipe');
    expect(r.description).toBe('does a thing');
  });

  it('falls back to the first // comment for the title', () => {
    const r = deriveTitleDescription(
      `// triage stale items\nawait tools.work_items.list({});`,
      ['work_items:list'],
      {},
    );
    expect(r.title).toBe('triage stale items');
    expect(r.description).toBe('auto-captured recipe: calls work_items:list');
  });

  it('falls back to the tool-set for the title when there is no comment', () => {
    const r = deriveTitleDescription(
      `await tools.work_items.list({}); await tools.coord.wakeQueue();`,
      ['coord:wake-queue', 'work_items:list'],
      {},
    );
    expect(r.title).toBe('recipe: coord:wake-queue + work_items:list');
    expect(r.description).toBe('auto-captured recipe: calls coord:wake-queue, work_items:list');
  });

  it('degrades to "untitled recipe" / "no tools" for a tool-free, comment-free script', () => {
    const r = deriveTitleDescription('return 1;', [], {});
    expect(r.title).toBe('untitled recipe');
    expect(r.description).toBe('auto-captured recipe: calls no tools');
    expect(recipeSlug(r.title)).toBe('untitled-recipe'); // still produces a valid slug
  });
});
