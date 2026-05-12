import { describe, expect, it, beforeEach } from 'vitest';
import { z } from 'zod';
import { defineTool } from '../define-tool';
import { _resetCatalogForTests, getCatalog, lookup } from '../registry';
import { tierFor } from '../capability-tiers';
import {
  _resetProjectionRegistryForTests,
  lookupByMcpName,
} from '../tool-projection';
import { dispatchProjectedTool } from '../dispatch-projected';

describe('defineTool', () => {
  beforeEach(() => {
    _resetCatalogForTests();
    _resetProjectionRegistryForTests();
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

  it('role-gated tools dispatch without a principal', async () => {
    const def = defineTool({
      name: 'operator:scan_test',
      description: 'role-gated probe',
      capability: 'operator:scan',
      requirePrincipal: false,
      roles: ['operator', 'reviewer'],
      args: z.object({ x: z.number() }),
      async handler(args, ctx) {
        return { content: [{ type: 'text', text: `ok ${args.x} role=${ctx.role}` }] };
      },
    });
    expect(def.requirePrincipal).toBe(false);
    expect(def.roles).toEqual(['operator', 'reviewer']);
    // NOT in the legacy catalog (only principal-gated tools land there).
    expect(lookup('operator:scan_test')).toBeUndefined();

    const tool = lookupByMcpName('operator:scan_test');
    expect(tool).toBeDefined();
    expect(tool!.roles).toEqual(['operator', 'reviewer']);

    // No principal on ctx — would be 401 for principal-gated tools, but
    // role-gated should pass through to the handler.
    const result = await dispatchProjectedTool(
      tool!,
      'operator:scan_test',
      { x: 7 },
      {
        log: () => {},
        signal: new AbortController().signal,
        progress: () => {},
        emit: () => {},
        workspaceId: 'default',
        role: 'operator',
        runId: 'run_T',
      },
      {},
    );
    expect(result.ok).toBe(true);
    expect(result.result?.content[0]).toEqual({ type: 'text', text: 'ok 7 role=operator' });
  });

  it('role-gated tools enforce the role allowlist', async () => {
    defineTool({
      name: 'operator:scan_role_gate',
      description: 'role-gate probe',
      capability: 'operator:scan',
      requirePrincipal: false,
      roles: ['operator'],
      args: z.object({}),
      async handler() {
        return { content: [{ type: 'text', text: 'should not run' }] };
      },
    });
    const tool = lookupByMcpName('operator:scan_role_gate')!;
    const result = await dispatchProjectedTool(
      tool,
      'operator:scan_role_gate',
      {},
      {
        log: () => {},
        signal: new AbortController().signal,
        progress: () => {},
        emit: () => {},
        workspaceId: 'default',
        role: 'worker',
        runId: 'run_T',
        chunkId: 'ck_T',
      },
      {},
    );
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('role_not_allowed');
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
