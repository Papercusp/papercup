import { describe, expect, it, beforeEach } from 'vitest';
import { z } from 'zod';
import { defineTool } from '../define-tool';
import { _resetCatalogForTests, getCatalog, lookup } from '../registry';
import { tierFor } from '../capability-tiers';

describe('defineTool', () => {
  beforeEach(() => {
    _resetCatalogForTests();
  });

  it('registers a tool with explicit name', () => {
    const tool = defineTool({
      name: 'tasks:list',
      description: 'List tasks',
      capability: 'tasks:read',
      args: z.object({}),
      async handler() {
        return { data: [] };
      },
    });
    expect(tool.name).toBe('tasks:list');
    expect(tool.tier).toBe('low');
    expect(lookup('tasks:list')).toBe(tool);
  });

  it('looks up tier from capability', () => {
    const tool = defineTool({
      name: 'audit:list',
      description: 'List audit',
      capability: 'audit:read',
      args: z.object({}),
      async handler() {
        return { data: [] };
      },
    });
    expect(tool.tier).toBe('high');
  });

  it('refuses duplicate tool registration', () => {
    defineTool({
      name: 'unique:tool',
      description: 'first',
      capability: 'tasks:read',
      args: z.object({}),
      async handler() {
        return { data: null };
      },
    });
    expect(() =>
      defineTool({
        name: 'unique:tool',
        description: 'second',
        capability: 'audit:read',
        args: z.object({}),
        async handler() {
          return { data: null };
        },
      }),
    ).toThrow(/collision/);
  });

  it('exposes the catalog', () => {
    defineTool({
      name: 'a:one',
      description: 'a',
      capability: 'tasks:read',
      args: z.object({}),
      async handler() {
        return { data: null };
      },
    });
    defineTool({
      name: 'b:two',
      description: 'b',
      capability: 'goals:read',
      args: z.object({}),
      async handler() {
        return { data: null };
      },
    });
    const names = getCatalog().map((t) => t.name).sort();
    expect(names).toEqual(['a:one', 'b:two']);
  });
});

describe('tierFor', () => {
  it('handles exact matches', () => {
    expect(tierFor('tasks:read')).toBe('low');
    expect(tierFor('tasks:write')).toBe('medium');
    expect(tierFor('audit:read')).toBe('high');
  });
  it('handles wildcards', () => {
    expect(tierFor('secrets:read:OPENAI_KEY')).toBe('high');
    expect(tierFor('http:fetch:youtube.com')).toBe('high');
    expect(tierFor('events:emit:foo')).toBe('medium');
  });
  it('defaults to medium for unknown', () => {
    expect(tierFor('frob:nicate')).toBe('medium');
  });
});
