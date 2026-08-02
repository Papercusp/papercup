/**
 * code-recipes-ui-projection coverage (WI-7085).
 *
 * The projection is an ALLOW-LIST, so the risk it carries is the mirror of a
 * deny-list's: a deny-list leaks new columns, an allow-list SWALLOWS new fields.
 * These tests pin both halves — the keep set survives verbatim, everything else
 * (including a column that does not exist yet) is dropped, and null-omission
 * never eats a real value.
 */
import { describe, expect, it } from 'vitest';

import {
  CODE_RECIPE_UI_FIELDS,
  projectCodeRecipeRow,
  projectCodeRecipeRows,
} from './code-recipes-ui-projection';

const ROW = {
  // read set
  id: 'fetch-and-summarize',
  title: 'Fetch and summarize',
  description: 'pulls a URL then summarizes',
  authorRole: 'operator',
  toolsUsed: ['fetch:get', 'llm:summarize'],
  runCount: 7,
  successCount: 6,
  lastRunAt: '2026-06-21T00:00:00.000Z',
  status: 'active',
  promotedTool: 'recipes:run',
  // never read by RecipesClient.tsx
  script: 'return 1;',
  potSlug: 'papercusp',
  mergedInto: null,
  tags: ['a'],
  hasEmbedding: true,
  createdBy: 'owner:abc',
  createdAt: '2026-06-20T00:00:00.000Z',
  updatedAt: '2026-06-21T00:00:00.000Z',
};

describe('projectCodeRecipeRow', () => {
  it('keeps every field the UI reads, with values untouched', () => {
    const out = projectCodeRecipeRow(ROW) as Record<string, unknown>;
    expect(out).toEqual({
      id: 'fetch-and-summarize',
      title: 'Fetch and summarize',
      description: 'pulls a URL then summarizes',
      authorRole: 'operator',
      toolsUsed: ['fetch:get', 'llm:summarize'],
      runCount: 7,
      successCount: 6,
      lastRunAt: '2026-06-21T00:00:00.000Z',
      status: 'active',
      promotedTool: 'recipes:run',
    });
  });

  it('drops the unread columns — the 79%-of-payload `script` above all', () => {
    const out = projectCodeRecipeRow(ROW) as Record<string, unknown>;
    for (const dead of [
      'script',
      'potSlug',
      'mergedInto',
      'tags',
      'hasEmbedding',
      'createdBy',
      'createdAt',
      'updatedAt',
    ]) {
      expect(out, dead).not.toHaveProperty(dead);
    }
  });

  it('omits null-valued keys rather than sending "k":null (D-025)', () => {
    const out = projectCodeRecipeRow({ ...ROW, promotedTool: null, authorRole: null }) as Record<
      string,
      unknown
    >;
    expect(out).not.toHaveProperty('promotedTool');
    expect(out).not.toHaveProperty('authorRole');
    // ...but a falsy NON-null value is a real value and must survive.
    const zeros = projectCodeRecipeRow({ ...ROW, runCount: 0, description: '' }) as Record<string, unknown>;
    expect(zeros.runCount).toBe(0);
    expect(zeros.description).toBe('');
  });

  it('swallows a column added to code_recipes later — the allow-list is the point', () => {
    const out = projectCodeRecipeRow({ ...ROW, someHugeNewBlob: 'x'.repeat(10_000) }) as Record<
      string,
      unknown
    >;
    expect(out).not.toHaveProperty('someHugeNewBlob');
  });

  it('keeps distinctAgents, which the client reads but the resolver does not yet supply', () => {
    expect(CODE_RECIPE_UI_FIELDS).toContain('distinctAgents');
    const out = projectCodeRecipeRow({ ...ROW, distinctAgents: 4 }) as Record<string, unknown>;
    expect(out.distinctAgents).toBe(4);
  });

  it('passes non-object rows through untouched', () => {
    expect(projectCodeRecipeRow(null)).toBeNull();
    expect(projectCodeRecipeRow('x')).toBe('x');
  });

  it('projects a whole result set, preserving order', () => {
    const out = projectCodeRecipeRows([ROW, { ...ROW, id: 'second' }]) as Array<Record<string, unknown>>;
    expect(out).toHaveLength(2);
    expect(out.map((r) => r.id)).toEqual(['fetch-and-summarize', 'second']);
    expect(out[1]).not.toHaveProperty('script');
  });
});
