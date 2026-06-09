/**
 * tools-search tests (tool-distribution-discovery-2026-06-08 P-005).
 *
 * The contract the Cupboard's capability search rests on:
 *   - tokenize / categoryOf split tool names the way the scorer + facets do;
 *   - scoring is field-weighted (name ≫ category/capability ≫ provider ≫
 *     description), so the right provider for a capability leads;
 *   - search is AND-across-tokens (every query token must hit some field);
 *   - an exact / substring name match outranks a description-only hit;
 *   - an empty query is the neutral name-sorted browse order.
 */
import { describe, it, expect } from 'vitest';
import type { ToolDiscoveryEntry } from './tools-discovery';
import { tokenize, categoryOf, scoreTool, searchTools, FIELD_WEIGHTS } from './tools-search';

function entry(over: Partial<ToolDiscoveryEntry> & { tool: string }): ToolDiscoveryEntry {
  return {
    status: 'available',
    category: categoryOf(over.tool),
    provider: { kind: 'builtin', name: 'builtin' },
    ...over,
  };
}

describe('tokenize', () => {
  it('lowercases and splits on every non-alphanumeric run', () => {
    expect(tokenize('coord:send')).toEqual(['coord', 'send']);
    expect(tokenize('repomix.pack')).toEqual(['repomix', 'pack']);
    expect(tokenize('Markdown — Render_2')).toEqual(['markdown', 'render', '2']);
    expect(tokenize('   ')).toEqual([]);
  });
});

describe('categoryOf', () => {
  it('takes the namespace prefix before the first : or .', () => {
    expect(categoryOf('coord:send')).toBe('coord');
    expect(categoryOf('repomix.pack')).toBe('repomix');
    expect(categoryOf('plans:get')).toBe('plans');
  });
  it('a separatorless name is its own category', () => {
    expect(categoryOf('slugify')).toBe('slugify');
  });
});

describe('scoreTool', () => {
  it('returns 0 when any query token matches no field (AND semantics)', () => {
    const e = entry({ tool: 'coord:send', description: 'send a message to a peer' });
    expect(scoreTool(e, 'coord send')).toBeGreaterThan(0);
    expect(scoreTool(e, 'coord zzzz')).toBe(0);
  });

  it('weights a name hit above a description-only hit', () => {
    const named = entry({ tool: 'repomix.pack', description: 'unrelated' });
    const described = entry({ tool: 'other.tool', description: 'this can repomix a repo' });
    expect(scoreTool(named, 'repomix')).toBeGreaterThan(scoreTool(described, 'repomix'));
  });

  it('an exact full-name match earns the phrase boost', () => {
    const exact = entry({ tool: 'slugify' });
    const partial = entry({ tool: 'slugify.batch' });
    expect(scoreTool(exact, 'slugify')).toBeGreaterThan(scoreTool(partial, 'slugify'));
  });

  it('matches on the capability gate string', () => {
    const e = entry({ tool: 'x.y', capability: 'tasks:read', description: null });
    expect(scoreTool(e, 'tasks')).toBeGreaterThanOrEqual(FIELD_WEIGHTS.capability);
  });

  it('matches on the providing unit name', () => {
    const e = entry({
      tool: 'md.render',
      status: 'installable',
      provider: { kind: 'pack', name: 'markdown-tools', listingId: 'lst-1' },
      unit: { name: 'markdown-tools', kind: 'pack', source: 'cupboard', listingId: 'lst-1' },
    });
    expect(scoreTool(e, 'markdown')).toBeGreaterThan(0);
  });

  it('an empty / whitespace query scores 0', () => {
    expect(scoreTool(entry({ tool: 'coord:send' }), '')).toBe(0);
    expect(scoreTool(entry({ tool: 'coord:send' }), '   ')).toBe(0);
  });
});

describe('searchTools', () => {
  const catalog = [
    entry({ tool: 'coord:send', description: 'send a message to a peer' }),
    entry({ tool: 'coord:inbox', description: 'read your coordination inbox' }),
    entry({ tool: 'plans:get', description: 'fetch a plan' }),
    entry({
      tool: 'repomix.pack',
      provider: { kind: 'plugin', name: '@papercupai/repomix' },
      unit: { name: '@papercupai/repomix', kind: 'plugin', source: 'installed' },
      description: 'pack a repo into one document',
    }),
    entry({
      tool: 'md.render',
      status: 'installable',
      provider: { kind: 'pack', name: 'markdown-tools', listingId: 'lst-1' },
      unit: { name: 'markdown-tools', kind: 'pack', source: 'cupboard', description: 'Markdown helpers', listingId: 'lst-1' },
    }),
  ];

  it('ranks the namespace match as a group, best first', () => {
    const ranked = searchTools(catalog, 'coord');
    expect(ranked.map((e) => e.tool)).toEqual(['coord:inbox', 'coord:send']);
  });

  it('finds a tool by a capability phrase in its description', () => {
    const ranked = searchTools(catalog, 'pack repo');
    expect(ranked[0]?.tool).toBe('repomix.pack');
  });

  it('drops non-matches entirely', () => {
    expect(searchTools(catalog, 'nonexistentcapability')).toEqual([]);
  });

  it('an empty query returns every entry name-sorted (browse order)', () => {
    const all = searchTools(catalog, '');
    expect(all.map((e) => e.tool)).toEqual(['coord:inbox', 'coord:send', 'md.render', 'plans:get', 'repomix.pack']);
  });

  it('respects the limit', () => {
    expect(searchTools(catalog, 'coord', { limit: 1 })).toHaveLength(1);
  });
});
