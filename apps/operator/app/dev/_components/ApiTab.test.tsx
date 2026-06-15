// @vitest-environment jsdom
//
// ApiTab — the registry-driven tool invoker. Its genuine logic is the sidebar
// derivation: namespaceOf (group key from a tool name), requiredArgCount (the
// "N req" badge), and filterAndGroupTools (the built-in/plugin toggles + free
// text filter → namespace-grouped, name-sorted list). All three are extracted +
// exported and pinned here; the invoke() path is an effect-only fetch shell.
// SchemaForm + primitives + nuqs are mocked so the module imports cleanly.

import { describe, expect, it, vi } from 'vitest';

vi.mock('./SchemaForm', () => ({ default: () => null }));
vi.mock('@/app/harness/Checkbox', () => ({ Checkbox: () => null }));
vi.mock('@/app/harness/Select', () => ({ Select: () => null }));
vi.mock('nuqs', () => ({
  parseAsString: { withDefault: () => ({}) },
  parseAsBoolean: { withDefault: () => ({}) },
  parseAsStringEnum: () => ({ withDefault: () => ({}) }),
  useQueryState: () => [null, () => {}],
}));

import { namespaceOf, requiredArgCount, filterAndGroupTools, type Tool } from './ApiTab';

function tool(over: Partial<Tool>): Tool {
  return {
    name: 'group:verb',
    pluginName: 'some-plugin',
    description: 'does a thing',
    capabilities: [],
    expose: {},
    inputSchema: {},
    ...over,
  };
}

describe('namespaceOf', () => {
  it('splits on a colon first', () => {
    expect(namespaceOf('plans:new')).toBe('plans');
  });
  it('falls back to a dot when there is no colon', () => {
    expect(namespaceOf('harnessLanes.byHarness')).toBe('harnessLanes');
  });
  it('returns "misc" for a bare name', () => {
    expect(namespaceOf('ping')).toBe('misc');
  });
});

describe('requiredArgCount', () => {
  it('counts the required array length from the input schema', () => {
    expect(requiredArgCount(tool({ inputSchema: { required: ['a', 'b'] } }))).toBe(2);
  });
  it('returns 0 when required is absent or not an array', () => {
    expect(requiredArgCount(tool({ inputSchema: {} }))).toBe(0);
    expect(requiredArgCount(tool({ inputSchema: { required: 'oops' } }))).toBe(0);
  });
});

describe('filterAndGroupTools', () => {
  const tools = [
    tool({ name: 'plans:new', pluginName: 'agent-mcp', description: 'create a plan' }),
    tool({ name: 'plans:edit', pluginName: 'agent-mcp', description: 'edit a plan' }),
    tool({ name: 'backups:run', pluginName: 'backups-plugin', description: 'snapshot now' }),
  ];
  const ALL = { filter: '', showBuiltins: true, showPlugins: true };

  it('groups by namespace and sorts the groups by name', () => {
    const groups = filterAndGroupTools(tools, ALL);
    expect(groups.map(([ns]) => ns)).toEqual(['backups', 'plans']);
    expect(groups.find(([ns]) => ns === 'plans')![1]).toHaveLength(2);
  });

  it('hides built-ins (pluginName agent-mcp) when showBuiltins is off', () => {
    const groups = filterAndGroupTools(tools, { ...ALL, showBuiltins: false });
    expect(groups.map(([ns]) => ns)).toEqual(['backups']);
  });

  it('hides non-built-in plugins when showPlugins is off', () => {
    const groups = filterAndGroupTools(tools, { ...ALL, showPlugins: false });
    expect(groups.map(([ns]) => ns)).toEqual(['plans']);
  });

  it('filters by name, description, or plugin name (case-insensitive)', () => {
    expect(filterAndGroupTools(tools, { ...ALL, filter: 'SNAPSHOT' }).flatMap(([, l]) => l.map((t) => t.name)))
      .toEqual(['backups:run']);
    expect(filterAndGroupTools(tools, { ...ALL, filter: 'edit' }).flatMap(([, l]) => l.map((t) => t.name)))
      .toEqual(['plans:edit']);
  });

  it('returns no groups when the filter matches nothing', () => {
    expect(filterAndGroupTools(tools, { ...ALL, filter: 'zzz-nomatch' })).toEqual([]);
  });
});
