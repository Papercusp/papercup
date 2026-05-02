import { describe, expect, it, beforeEach } from 'vitest';
import { z } from 'zod';
import { defineTool } from '../define-tool';
import { _resetCatalogForTests, lookup } from '../registry';

describe('tool registration and lookup', () => {
  beforeEach(() => {
    _resetCatalogForTests();
  });

  it('a tool registered with explicit name is findable', () => {
    const tool = defineTool({
      name: 'fixture:probe',
      description: 'Test fixture',
      capability: 'tasks:read',
      args: z.object({ x: z.number() }),
      async handler() {
        return { data: 'ok' };
      },
    });
    expect(lookup('fixture:probe')).toBe(tool);
    expect(tool.tier).toBe('low');
  });

  it('handlers receive validated args', async () => {
    const tool = defineTool({
      name: 'fixture:validate',
      description: 'Validate args',
      capability: 'tasks:read',
      args: z.object({
        n: z.number().int(),
        s: z.string().default('hello'),
      }),
      async handler(args) {
        return { data: { n: args.n, s: args.s } };
      },
    });
    // Args go through Zod parsing; defaults applied.
    const validated = tool.args.parse({ n: 5 });
    expect(validated).toEqual({ n: 5, s: 'hello' });
    const r = await tool.handler(validated, {} as any);
    expect(r.data).toEqual({ n: 5, s: 'hello' });
  });

  it('tier inference handles wildcard capabilities', () => {
    const t1 = defineTool({
      name: 'fixture:secret-tool',
      description: 'Touches a secret',
      capability: 'secrets:read:OPENAI_KEY',
      args: z.object({}),
      async handler() {
        return { data: null };
      },
    });
    expect(t1.tier).toBe('high');

    const t2 = defineTool({
      name: 'fixture:net-tool',
      description: 'Outbound network',
      capability: 'http:fetch:example.com',
      args: z.object({}),
      async handler() {
        return { data: null };
      },
    });
    expect(t2.tier).toBe('high');
  });

  it('returns degraded envelope when partial source unavailable', async () => {
    const tool = defineTool({
      name: 'fixture:degrade',
      description: 'Always degraded',
      capability: 'tasks:read',
      args: z.object({}),
      async handler() {
        return {
          data: [],
          degraded: true,
          degradedReasons: ['source_unavailable'],
        };
      },
    });
    const r = await tool.handler({}, {} as any);
    expect(r.degraded).toBe(true);
    expect(r.degradedReasons).toEqual(['source_unavailable']);
  });
});
