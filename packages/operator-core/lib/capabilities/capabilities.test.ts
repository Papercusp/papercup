import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { schemaRequiresArgs } from './introspection';
import { actionDefToCapability } from './from-action-registry';
import { toolDefinitionToCapability, projectedToolToCapability, type ToolDefinitionMeta } from './from-tooldef';
import { humanizeCapabilityId } from './format';
import { paletteEligibility, isPaletteVisible, requiresPaletteConfirm } from './safety-filter';
import type { Capability } from './types';
import type { Definition } from '../commands/types';

// ── introspection ────────────────────────────────────────────────────────
describe('schemaRequiresArgs', () => {
  it('false for a schema that accepts {}', () => {
    expect(schemaRequiresArgs(z.object({}))).toBe(false);
    expect(schemaRequiresArgs(z.object({ q: z.string().optional() }))).toBe(false);
    expect(schemaRequiresArgs(z.object({ n: z.number().default(1) }))).toBe(false);
  });
  it('true for a schema with a required field', () => {
    expect(schemaRequiresArgs(z.object({ id: z.string() }))).toBe(true);
  });
  it('false for no schema', () => {
    expect(schemaRequiresArgs(undefined)).toBe(false);
    expect(schemaRequiresArgs(null)).toBe(false);
  });
  it('JSON Schema flavour: required array decides', () => {
    expect(schemaRequiresArgs({ type: 'object', properties: { q: { type: 'string' } } })).toBe(false);
    expect(schemaRequiresArgs({ type: 'object', properties: {}, required: [] })).toBe(false);
    expect(schemaRequiresArgs({ type: 'object', properties: { id: { type: 'string' } }, required: ['id'] })).toBe(true);
  });
  it('JSON Schema flavour: required-with-default does not require an arg (Zod 4 output-mode artifact)', () => {
    // pot:pause-shaped: z.boolean().default(false) → required:['drainBees'] + default on the prop.
    expect(
      schemaRequiresArgs({
        type: 'object',
        properties: { harness: { type: 'string' }, drainBees: { type: 'boolean', default: false } },
        required: ['drainBees'],
      }),
    ).toBe(false);
    // …but a genuine required field alongside a defaulted one still requires args.
    expect(
      schemaRequiresArgs({
        type: 'object',
        properties: { id: { type: 'string' }, verbose: { type: 'boolean', default: false } },
        required: ['id', 'verbose'],
      }),
    ).toBe(true);
  });
});

// ── Action Registry adapter ──────────────────────────────────────────────
describe('actionDefToCapability', () => {
  const navDef = {
    id: 'nav.settings',
    kind: 'command',
    description: 'Navigate to /settings.',
    schema: z.object({}).strict(),
    agents: ['oracle', 'operator', 'palette', 'shortcut'],
    browser: 'required',
    concurrent: 'allow',
    tier: 'reflexive',
    paletteEntry: { section: 'Navigate', title: 'Go to Settings', icon: '⌖', keywords: 'settings' },
    handler: async () => ({}),
  } as unknown as Definition;

  it('maps a browser paletteEntry command', () => {
    const cap = actionDefToCapability(navDef);
    expect(cap.id).toBe('nav.settings');
    expect(cap.title).toBe('Go to Settings');
    expect(cap.runsIn).toBe('browser'); // browser:'required'
    expect(cap.requiresArgs).toBe(false);
    expect(cap.tier).toBe('low');
    expect(cap.gating.agentRoles).toContain('palette');
    expect(cap.surfaces?.palette).toEqual({ section: 'Navigate', icon: '⌖', keywords: 'settings' });
    // agents is the persona/surface axis — must NOT leak into principal RBAC (D-004).
    expect(cap.gating.auth?.roles).toBeUndefined();
  });

  it('maps browser:optional → hybrid', () => {
    const cap = actionDefToCapability({ ...navDef, id: 'chat.dispatch', browser: 'optional', paletteEntry: undefined } as unknown as Definition);
    expect(cap.runsIn).toBe('hybrid');
    expect(cap.surfaces?.palette).toBeUndefined();
  });

  it('maps a query (no browser) → server', () => {
    const q = { id: 'harness.status', kind: 'query', description: 'Status.', schema: z.object({}), agents: ['operator'], tier: 'fast-query', handler: async () => ({}) } as unknown as Definition;
    expect(actionDefToCapability(q).runsIn).toBe('server');
  });
});

// ── id humanizer ─────────────────────────────────────────────────────────
describe('humanizeCapabilityId', () => {
  it('group-qualifies namespaced ids so bare verbs are self-describing', () => {
    expect(humanizeCapabilityId('goals:list')).toBe('Goals: List');
    expect(humanizeCapabilityId('panel.toggle')).toBe('Panel: Toggle');
    expect(humanizeCapabilityId('papercusp:list_workspaces')).toBe('Papercusp: List Workspaces');
    expect(humanizeCapabilityId('dev:hello-card')).toBe('Dev: Hello Card');
  });
  it('title-cases a bare id with no namespace', () => {
    expect(humanizeCapabilityId('list_workspaces')).toBe('List Workspaces');
  });
});

// ── tooldef adapter ──────────────────────────────────────────────────────
function tool(over: Partial<ToolDefinitionMeta> & Pick<ToolDefinitionMeta, 'name' | 'capability'>): ToolDefinitionMeta {
  return { description: 'desc', tier: 'low', args: z.object({}), ...over };
}

describe('toolDefinitionToCapability', () => {
  it('read tool: low risk, no args, non-destructive → fire-and-toast', () => {
    const cap = toolDefinitionToCapability(tool({ name: 'harness:list', capability: 'harness:read' }));
    expect(cap.runsIn).toBe('server');
    expect(cap.title).toBe('Harness: List'); // group-qualified, not a bare "List"
    expect(cap.destructive).toBe(false);
    expect(cap.requiresArgs).toBe(false);
    expect(cap.gating.auth?.capabilities).toEqual(['harness:read']);
    expect(paletteEligibility(cap)).toBe('fire-and-toast');
  });

  it('destructive verb → confirm', () => {
    expect(paletteEligibility(toolDefinitionToCapability(tool({ name: 'backup:promote', capability: 'backup:write' })))).toBe('confirm');
    expect(paletteEligibility(toolDefinitionToCapability(tool({ name: 'processes:kill', capability: 'dev:write' })))).toBe('confirm');
  });

  it('tier:high → confirm even without a destructive name', () => {
    expect(paletteEligibility(toolDefinitionToCapability(tool({ name: 'flags:set', capability: 'flags:write', tier: 'high' })))).toBe('confirm');
  });

  it('required args → exclude', () => {
    const cap = toolDefinitionToCapability(tool({ name: 'features:get', capability: 'features:read', args: z.object({ id: z.string() }) }));
    expect(cap.requiresArgs).toBe(true);
    expect(paletteEligibility(cap)).toBe('exclude');
  });

  it('streaming / interactive → exclude', () => {
    expect(paletteEligibility(toolDefinitionToCapability(tool({ name: 'operator:conv_voice', capability: 'voice:use' })))).toBe('exclude');
    expect(paletteEligibility(toolDefinitionToCapability(tool({ name: 'chat:ask_choice', capability: 'chat:use' })))).toBe('exclude');
  });
});

// ── projected-registry adapter (role-gated tools live ONLY here) ─────────
describe('projectedToolToCapability', () => {
  const lowTier = () => 'low' as const;

  it('maps a pot:start-shaped role-gated tool to an invocable capability', () => {
    const cap = projectedToolToCapability(
      'pot:start',
      {
        description: 'START the hive.',
        inputSchema: { type: 'object', properties: { harness: { type: 'string' } } }, // all optional
        capabilities: ['harness:write'],
        agentRoles: ['operator', 'worker', 'cup'],
        guidance: { when: 'The user clicks Start Hive.' },
      },
      lowTier,
    );
    expect(cap.id).toBe('pot:start');
    expect(cap.requiresArgs).toBe(false);
    expect(cap.gating.agentRoles).toContain('operator');
    expect(cap.gating.auth?.capabilities).toEqual(['harness:write']);
    expect(cap.agentDescription).toBe('The user clicks Start Hive.');
    expect(paletteEligibility(cap)).not.toBe('exclude');
  });

  it('takes the highest tier across capabilities and flags high as destructive', () => {
    const tiers: Record<string, 'low' | 'medium' | 'high'> = { 'a:read': 'low', 'b:write': 'high' };
    const cap = projectedToolToCapability(
      'b:thing',
      { description: 'd', inputSchema: {}, capabilities: ['a:read', 'b:write'] },
      (c) => tiers[c] ?? 'low',
    );
    expect(cap.tier).toBe('high');
    expect(cap.destructive).toBe(true);
  });

  it('required input → requiresArgs → palette-excluded', () => {
    const cap = projectedToolToCapability(
      'x:get',
      { description: 'd', inputSchema: { type: 'object', required: ['id'] }, capabilities: [] },
      lowTier,
    );
    expect(cap.requiresArgs).toBe(true);
    expect(paletteEligibility(cap)).toBe('exclude');
  });
});

// ── safety filter matrix ─────────────────────────────────────────────────
describe('paletteEligibility', () => {
  const base: Capability = {
    id: 't:x', title: 'X', description: 'x', runsIn: 'server', requiresArgs: false, tier: 'low', gating: {},
  };
  it('browser command needs a palette annotation to show', () => {
    expect(paletteEligibility({ ...base, runsIn: 'browser' })).toBe('exclude');
    expect(paletteEligibility({ ...base, runsIn: 'browser', surfaces: { palette: { section: 'S' } } })).toBe('fire-and-toast');
  });
  it('isPaletteVisible: confirm counts as visible, exclude does not', () => {
    expect(isPaletteVisible({ ...base, destructive: true })).toBe(true);
    expect(isPaletteVisible({ ...base, requiresArgs: true })).toBe(false);
  });
  it('requiresPaletteConfirm tracks the confirm bucket', () => {
    expect(requiresPaletteConfirm({ ...base, tier: 'high' })).toBe(true);
    expect(requiresPaletteConfirm(base)).toBe(false);
  });
});
