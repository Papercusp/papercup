import { describe, expect, it, beforeEach } from 'vitest';
import { z } from 'zod';
import { defineTool } from '@papercusp/tooldef';
import { _resetCatalogForTests, getCatalog, lookup } from '@papercusp/tooldef';
// Importing this registers papercuspTierFor as tooldef's tier resolver (load-
// time side effect), so the `defineTool(...).tier` assertions below classify
// against the real Papercusp table rather than the engine's 'low' default.
import { papercuspTierFor } from '../capability-tiers-papercusp';
import {
  _resetProjectionRegistryForTests,
  lookupByMcpName,
} from '@papercusp/tooldef';
import { dispatchProjectedTool } from '@papercusp/tooldef';

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
      agentRoles: ['operator', 'reviewer'],
      args: z.object({ x: z.number() }),
      async handler(args, ctx) {
        return { content: [{ type: 'text', text: `ok ${args.x} role=${ctx.role}` }] };
      },
    });
    expect(def.requirePrincipal).toBe(false);
    expect(def.agentRoles).toEqual(['operator', 'reviewer']);
    // NOT in the legacy catalog (only principal-gated tools land there).
    expect(lookup('operator:scan_test')).toBeUndefined();

    const tool = lookupByMcpName('operator:scan_test');
    expect(tool).toBeDefined();
    expect(tool!.agentRoles).toEqual(['operator', 'reviewer']);

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
      agentRoles: ['operator'],
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

  it('role-gated tools forward `state` schema to the projection registry', async () => {
    const StateSchema = z.object({
      count: z.number().int().min(0),
      phase: z.enum(['running', 'done']),
    });
    defineTool({
      name: 'operator:state_probe',
      description: 'state-shaped probe',
      capability: 'tasks:read',
      requirePrincipal: false,
      roles: ['operator'],
      state: StateSchema,
      args: z.object({}),
      async handler(_args, ctx) {
        if (!ctx.publishState) {
          return { content: [{ type: 'text', text: 'no_publishState' }], isError: true };
        }
        ctx.publishState({ count: 1, phase: 'done' });
        return { content: [{ type: 'text', text: 'ok' }] };
      },
    });
    const tool = lookupByMcpName('operator:state_probe')!;
    expect(tool.state).toBeDefined();
    expect(tool.state).toBe(StateSchema);
    const result = await dispatchProjectedTool(
      tool,
      'operator:state_probe',
      {},
      {
        log: () => {},
        signal: new AbortController().signal,
        progress: () => {},
        emit: () => {},
        workspaceId: 'default',
        role: 'operator',
        runId: 'run_state_probe',
      },
      {},
    );
    expect(result.ok).toBe(true);
    expect(result.result?.content[0]).toEqual({ type: 'text', text: 'ok' });
  });
});

describe('papercuspTierFor', () => {
  it('handles exact matches', () => {
    expect(papercuspTierFor('tasks:read')).toBe('low');
    expect(papercuspTierFor('tasks:write')).toBe('medium');
    expect(papercuspTierFor('audit:read')).toBe('high');
  });
  it('handles wildcards', () => {
    expect(papercuspTierFor('secrets:read:OPENAI_KEY')).toBe('high');
    expect(papercuspTierFor('http:fetch:youtube.com')).toBe('high');
    expect(papercuspTierFor('events:emit:foo')).toBe('medium');
  });
  it('defaults to medium for unknown', () => {
    expect(papercuspTierFor('frob:nicate')).toBe('medium');
  });
});

describe('JSON schema flattening for OpenAI compat', () => {
  beforeEach(() => {
    _resetCatalogForTests();
    _resetProjectionRegistryForTests();
  });

  it('plain z.object schemas pass through with type:object', () => {
    defineTool({
      name: 'test:plain',
      capability: 'test:read',
      args: z.object({ name: z.string() }),
      async handler() { return { data: { ok: true } }; },
    });
    const t = lookupByMcpName('test:plain');
    expect(t).toBeTruthy();
    expect(t!.inputSchema.type).toBe('object');
    expect((t!.inputSchema as Record<string, unknown>).oneOf).toBeUndefined();
    expect((t!.inputSchema as Record<string, unknown>).anyOf).toBeUndefined();
  });

  it('discriminatedUnion flattens to a single object with merged properties', () => {
    defineTool({
      name: 'test:union',
      capability: 'test:read',
      args: z.discriminatedUnion('op', [
        z.object({ op: z.literal('peek') }),
        z.object({ op: z.literal('push'), data: z.string() }),
      ]),
      async handler() { return { data: { ok: true } }; },
    });
    const t = lookupByMcpName('test:union');
    expect(t).toBeTruthy();
    const s = t!.inputSchema as Record<string, unknown>;
    expect(s.type).toBe('object');
    expect(s.oneOf).toBeUndefined();
    expect(s.anyOf).toBeUndefined();
    const props = s.properties as Record<string, unknown>;
    expect(props.op).toBeTruthy();
    expect(props.data).toBeTruthy();
    expect((s.required as string[]).includes('op')).toBe(true);
    expect((s.required as string[] | undefined)?.includes('data') ?? false).toBe(false);
  });

  it('z.union flattens like discriminatedUnion', () => {
    defineTool({
      name: 'test:plain_union',
      capability: 'test:read',
      args: z.union([
        z.object({ kind: z.literal('a'), foo: z.string() }),
        z.object({ kind: z.literal('b'), bar: z.number() }),
      ]),
      async handler() { return { data: { ok: true } }; },
    });
    const t = lookupByMcpName('test:plain_union');
    expect(t).toBeTruthy();
    const s = t!.inputSchema as Record<string, unknown>;
    expect(s.type).toBe('object');
    expect(s.oneOf).toBeUndefined();
    expect(s.anyOf).toBeUndefined();
    const props = s.properties as Record<string, unknown>;
    expect(props.foo).toBeTruthy();
    expect(props.bar).toBeTruthy();
  });

  // Phase 4 T3.1 — E2E bug #36 regression. The role-gated defineTool path
  // was silently dropping the `modality` field between input and the
  // projection registry, so voice users got an empty tool catalog.
  // Lock the pipeline so future field additions get tested at the seam,
  // not just by the downstream filter mock.
  it('forwards modality from defineTool to the projected tool', () => {
    defineTool({
      name: 'test:voice_only',
      description: 'voice surface only',
      capability: 'test:read',
      requirePrincipal: false,
      roles: ['operator'],
      modality: ['voice'],
      args: z.object({}),
      async handler() { return { content: [{ type: 'text', text: 'ok' }] }; },
    });
    defineTool({
      name: 'test:both_surfaces',
      description: 'visible on both surfaces',
      capability: 'test:read',
      requirePrincipal: false,
      roles: ['operator'],
      modality: ['text', 'voice'],
      args: z.object({}),
      async handler() { return { content: [{ type: 'text', text: 'ok' }] }; },
    });
    defineTool({
      name: 'test:no_modality_declared',
      description: 'absent modality — defaults to both at the filter layer',
      capability: 'test:read',
      requirePrincipal: false,
      agentRoles: ['operator'],
      args: z.object({}),
      async handler() { return { content: [{ type: 'text', text: 'ok' }] }; },
    });
    const voiceTool = lookupByMcpName('test:voice_only');
    const bothTool = lookupByMcpName('test:both_surfaces');
    const absentTool = lookupByMcpName('test:no_modality_declared');
    expect(voiceTool?.modality).toEqual(['voice']);
    expect(bothTool?.modality).toEqual(['text', 'voice']);
    // Absent on the projection — the catalog layer applies the
    // ['text','voice'] default when reading.
    expect(absentTool?.modality).toBeUndefined();
  });
});
