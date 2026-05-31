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

  it('every returned capability is non-excluded and runs server-side', () => {
    const caps = getServerCapabilities({ principal: superuser, catalog: CATALOG });
    for (const c of caps) {
      expect(c.runsIn).toBe('server');
      expect(c.eligibility).not.toBe('exclude');
    }
  });
});
