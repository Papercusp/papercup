import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { getServerCapabilities } from './server-catalog';
import type { ToolDefinitionMeta } from './from-tooldef';

const CATALOG: ToolDefinitionMeta[] = [
  { name: 'harness:list', capability: 'harness:read', description: 'List harnesses.', tier: 'low', args: z.object({ filter: z.string().optional() }) },
  { name: 'features:get', capability: 'features:read', description: 'Get a feature.', tier: 'low', args: z.object({ id: z.string() }) }, // required arg → excluded
  { name: 'backup:promote', capability: 'backup:write', description: 'Promote a backup.', tier: 'high', args: z.object({}) }, // destructive + high → confirm
  { name: 'operator:conv_voice', capability: 'voice:use', description: 'Voice.', tier: 'low', args: z.object({}) }, // streaming → excluded
  { name: 'plans:list', capability: 'plans:read', description: 'List plans.', tier: 'low', args: z.object({}) },
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
    const cat: ToolDefinitionMeta[] = [
      { name: 'harness:list', capability: 'harness:read', description: 'List.', tier: 'low', args: z.object({}) }, // no roles → always
      { name: 'worker:only', capability: 'worker:read', description: 'W.', tier: 'low', args: z.object({}), roles: ['worker'] },
      { name: 'ops:thing', capability: 'ops:read', description: 'O.', tier: 'low', args: z.object({}), roles: ['operator', 'worker'] },
    ];
    const ids = getServerCapabilities({ principal: superuser, role: 'operator', catalog: cat }).map((c) => c.id);
    expect(ids).toEqual(['harness:list', 'ops:thing']); // worker:only excluded for operator
    // Without a role, no role filtering.
    const all = getServerCapabilities({ principal: superuser, catalog: cat }).map((c) => c.id);
    expect(all).toContain('worker:only');
  });

  it('every returned capability is non-excluded and runs server-side', () => {
    const caps = getServerCapabilities({ principal: superuser, catalog: CATALOG });
    for (const c of caps) {
      expect(c.runsIn).toBe('server');
      expect(c.eligibility).not.toBe('exclude');
    }
  });
});
