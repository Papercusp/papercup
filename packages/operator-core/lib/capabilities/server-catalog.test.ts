import { describe, it, expect } from 'vitest';
import { getServerCapabilities, type NamedProjectedTool } from './server-catalog';

/** Projected-shaped fixture entry (the registry stores JSON Schema input). */
function entry(
  name: string,
  capability: string,
  o?: { required?: string[]; agentRoles?: string[]; description?: string },
): NamedProjectedTool {
  return {
    name,
    tool: {
      description: o?.description ?? `Tool ${name}.`,
      inputSchema: { type: 'object', properties: {}, ...(o?.required ? { required: o.required } : {}) },
      capabilities: capability ? [capability] : [],
      agentRoles: o?.agentRoles,
    },
  };
}

const CATALOG: NamedProjectedTool[] = [
  entry('harness:list', 'harness:read', { description: 'List harnesses.' }),
  entry('features:get', 'features:read', { required: ['id'] }), // required arg → excluded
  entry('backup:promote', 'backup:write'), // destructive (name) → confirm
  entry('operator:conv_voice', 'voice:use'), // streaming → excluded
  entry('plans:list', 'plans:read'),
];

const superuser = { capabilities: new Set(['*']) };

describe('getServerCapabilities', () => {
  it('returns the palette-eligible subset, sorted, with eligibility', () => {
    const caps = getServerCapabilities({ principal: superuser, catalog: CATALOG });
    const byId = Object.fromEntries(caps.map((c) => [c.id, c.eligibility]));
    expect(byId).toEqual({
      'backup:promote': 'confirm',
      'harness:list': 'fire-and-toast',
      'plans:list': 'fire-and-toast',
    });
    // excluded: features:get (required arg), operator:conv_voice (streaming)
    expect(caps.find((c) => c.id === 'features:get')).toBeUndefined();
    expect(caps.find((c) => c.id === 'operator:conv_voice')).toBeUndefined();
    // sorted by id
    expect(caps.map((c) => c.id)).toEqual(['backup:promote', 'harness:list', 'plans:list']);
  });

  it('enforces the principal capability gate (no * → only held caps)', () => {
    const limited = { capabilities: new Set(['harness:read']) };
    const caps = getServerCapabilities({ principal: limited, catalog: CATALOG });
    expect(caps.map((c) => c.id)).toEqual(['harness:list']); // plans:read / backup:write not held
  });

  it('filters by role so the listing matches invocability (no-allowlist tools always pass)', () => {
    const cat: NamedProjectedTool[] = [
      entry('harness:list', 'harness:read'), // no roles → always
      entry('worker:only', 'worker:read', { agentRoles: ['worker'] }),
      entry('ops:thing', 'ops:read', { agentRoles: ['operator', 'worker'] }),
    ];
    const ids = getServerCapabilities({ principal: superuser, role: 'operator', catalog: cat }).map((c) => c.id);
    expect(ids).toEqual(['harness:list', 'ops:thing']); // worker:only excluded for operator
    // Without a role, no role filtering.
    const all = getServerCapabilities({ principal: superuser, catalog: cat }).map((c) => c.id);
    expect(all).toContain('worker:only');
  });

  it('lists role-gated tools (the pot:start regression — absent from the legacy catalog)', () => {
    // pot:start-shaped: role-gated (agentRoles incl. operator), all-optional args.
    const cat: NamedProjectedTool[] = [
      entry('pot:start', 'harness:write', { agentRoles: ['operator', 'worker', 'cup'] }),
    ];
    const caps = getServerCapabilities({ principal: superuser, role: 'operator', catalog: cat });
    expect(caps.map((c) => c.id)).toEqual(['pot:start']);
  });

  it('every returned capability is non-excluded and runs server-side', () => {
    const caps = getServerCapabilities({ principal: superuser, catalog: CATALOG });
    for (const c of caps) {
      expect(c.runsIn).toBe('server');
      expect(c.eligibility).not.toBe('exclude');
    }
  });
});
