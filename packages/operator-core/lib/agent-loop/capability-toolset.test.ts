/**
 * capability-toolset unit tests (P-007, own-tui-full-divorce-2026-08-24).
 * Injected registry + dispatcher — no global tool registration, no principal.
 */
import { describe, expect, it } from 'vitest';
import type { ProjectedTool } from '@papercusp/tooldef';
import {
  capabilityToolNames,
  capabilityToolset,
  flattenDispatchResult,
  OWNED_LOOP_TOOL_SELECTION,
  type ToolDispatcher,
} from './capability-toolset';

function fakeProjected(
  name: string,
  description = `desc of ${name}`,
  inputSchema: unknown = { type: 'object', properties: {} },
): ProjectedTool {
  return {
    pluginName: 'test',
    description,
    inputSchema,
    expose: { mcp: { name } },
  } as unknown as ProjectedTool;
}

const registry = () => [
  fakeProjected('capability:read'),
  fakeProjected('capability:bash'),
  fakeProjected('work_items:get'),
  fakeProjected('coord:send'),
];

const ownedLoopRegistry = () => [
  ...registry(),
  fakeProjected('tasks:ops'),
  fakeProjected('tasks:todo_write'),
  fakeProjected('tasks:update_plan'),
];

const okDispatch: ToolDispatcher = async (name, args) => ({
  content: [{ type: 'text', text: JSON.stringify({ ok: true, name, args }) }],
});

describe('capabilityToolset', () => {
  it('shares one selector with prompt-time capability names', () => {
    expect(capabilityToolNames({ registry }).sort()).toEqual([
      'capability:bash',
      'capability:read',
    ]);
    expect(capabilityToolNames({ registry, names: ['work_items:get'] }).sort()).toEqual([
      'capability:bash',
      'capability:read',
      'work_items:get',
    ]);
  });

  it('selects capability doors and canonical task facades for the owned loop', () => {
    const expected = [
      'capability:bash',
      'capability:read',
      'tasks:ops',
      'tasks:todo_write',
      'tasks:update_plan',
    ];
    const selection = { ...OWNED_LOOP_TOOL_SELECTION, registry: ownedLoopRegistry };

    expect(capabilityToolNames(selection).sort()).toEqual(expected);
    expect(capabilityToolset({ dispatch: okDispatch, ...selection }).map((tool) => tool.name).sort()).toEqual(expected);
  });

  it('selects by default capability: prefix and projects def fields', () => {
    const tools = capabilityToolset({ dispatch: okDispatch, registry });
    expect(tools.map((t) => t.name).sort()).toEqual(['capability:bash', 'capability:read']);
    expect(tools[0].description).toBeTruthy();
    expect(tools[0].inputSchema).toEqual({ type: 'object', properties: {} });
  });

  it('adds exact names beyond the prefix set', () => {
    const tools = capabilityToolset({ dispatch: okDispatch, registry, names: ['work_items:get'] });
    expect(tools.map((t) => t.name).sort()).toEqual([
      'capability:bash',
      'capability:read',
      'work_items:get',
    ]);
  });

  it('throws LOUD on a named tool missing from the registry', () => {
    expect(() =>
      capabilityToolset({ dispatch: okDispatch, registry, names: ['capability:nonexistent'] }),
    ).toThrow(/capability:nonexistent/);
  });

  it('rejects an oversized aggregate schema load before projecting LoopTools', () => {
    const registry = () => [
      fakeProjected('capability:huge', 'huge', {
        type: 'object',
        description: 'x'.repeat(128_001),
      }),
    ];

    expect(() => capabilityToolset({ dispatch: okDispatch, registry })).toThrow(
      /capabilityToolset input schemas use .* aggregate budget/,
    );
  });

  it('execute routes through the dispatcher and flattens the result', async () => {
    const calls: Array<[string, Record<string, unknown>]> = [];
    const dispatch: ToolDispatcher = async (name, args) => {
      calls.push([name, args]);
      return { structuredContent: { rows: [1, 2] } };
    };
    const tools = capabilityToolset({ dispatch, registry, prefixes: ['capability:read'] });
    const out = await tools[0].execute({ file_path: '/x' }, { stepIndex: 0 });
    expect(calls).toEqual([['capability:read', { file_path: '/x' }]]);
    expect(out).toEqual({ rows: [1, 2] });
  });

  it('an isError dispatch result throws (→ loop records isError tool_result)', async () => {
    const dispatch: ToolDispatcher = async () => ({
      isError: true,
      content: [{ type: 'text', text: 'permission denied' }],
    });
    const tools = capabilityToolset({ dispatch, registry, prefixes: ['capability:read'] });
    await expect(tools[0].execute({}, { stepIndex: 0 })).rejects.toThrow('permission denied');
  });

  it('needsApproval predicate is threaded per-tool with the tool name', () => {
    const tools = capabilityToolset({
      dispatch: okDispatch,
      registry,
      needsApproval: (name) => name === 'capability:bash',
    });
    const bash = tools.find((t) => t.name === 'capability:bash')!;
    const read = tools.find((t) => t.name === 'capability:read')!;
    expect(typeof bash.needsApproval).toBe('function');
    expect((bash.needsApproval as (i: unknown) => boolean)({})).toBe(true);
    expect((read.needsApproval as (i: unknown) => boolean)({})).toBe(false);
  });
});

describe('flattenDispatchResult', () => {
  it('prefers structuredContent', () => {
    expect(flattenDispatchResult({ structuredContent: { a: 1 }, content: [{ type: 'text', text: 'x' }] })).toEqual({ a: 1 });
  });
  it('parses JSON text content', () => {
    expect(flattenDispatchResult({ content: [{ type: 'text', text: '{"b":2}' }] })).toEqual({ b: 2 });
  });
  it('falls back to plain text and null-for-empty', () => {
    expect(flattenDispatchResult({ content: [{ type: 'text', text: 'plain' }] })).toBe('plain');
    expect(flattenDispatchResult({})).toBeNull();
  });
});
