/**
 * Unit tests for the capability-envelope policy evaluator
 * (agent-capability-confinement-2026-06-13 B-06 / P-012). Pure, no PG, no flag.
 */

import { describe, expect, it } from 'vitest';
import {
  evaluateCapabilityEnvelope,
  FLEET_ENVELOPE_ROLES,
  PROTECTED_CAPABILITY_GLOBS,
} from './policy';

const base = { toolName: 'plans.set-status', capabilities: ['plans:write'] as const };

describe('evaluateCapabilityEnvelope — exemptions (D-002)', () => {
  it('exempts a superuser caller (applied=false)', () => {
    const d = evaluateCapabilityEnvelope({ ...base, ctx: { role: 'worker', isSuperuser: true } });
    expect(d.applied).toBe(false);
    expect(d.withinEnvelope).toBe(true);
  });

  it('exempts a power-user caller', () => {
    expect(evaluateCapabilityEnvelope({ ...base, ctx: { role: 'worker', isPowerUser: true } }).applied).toBe(false);
  });

  it('exempts a roleless caller (e.g. a bearer API call)', () => {
    expect(evaluateCapabilityEnvelope({ ...base, ctx: {} }).applied).toBe(false);
  });

  it('exempts the interactive chat roles (operator / oracle)', () => {
    expect(evaluateCapabilityEnvelope({ ...base, ctx: { role: 'operator' } }).applied).toBe(false);
    expect(evaluateCapabilityEnvelope({ ...base, ctx: { role: 'oracle' } }).applied).toBe(false);
  });
});

describe('evaluateCapabilityEnvelope — fleet roles', () => {
  it('applies to a fleet role; a normal capability is within the envelope', () => {
    const d = evaluateCapabilityEnvelope({ ...base, ctx: { role: 'worker' } });
    expect(d.applied).toBe(true);
    expect(d.withinEnvelope).toBe(true);
    expect(d.reason).toBeUndefined();
  });

  it('denies a protected capability (secrets:*) for a fleet role', () => {
    const d = evaluateCapabilityEnvelope({
      toolName: 'secrets.read',
      capabilities: ['secrets:read:db'],
      ctx: { role: 'worker' },
    });
    expect(d.applied).toBe(true);
    expect(d.withinEnvelope).toBe(false);
    expect(d.reason).toContain('protected');
  });

  it('denies processes:kill for a fleet role (e.g. the Queen)', () => {
    const d = evaluateCapabilityEnvelope({
      toolName: 'processes.kill',
      capabilities: ['processes:kill'],
      ctx: { role: 'queen' },
    });
    expect(d.withinEnvelope).toBe(false);
  });

  it('a multi-capability tool is beyond-envelope if ANY capability is protected', () => {
    const d = evaluateCapabilityEnvelope({
      toolName: 'mixed.tool',
      capabilities: ['plans:write', 'secrets:read:x'],
      ctx: { role: 'worker' },
    });
    expect(d.withinEnvelope).toBe(false);
  });
});

describe('evaluateCapabilityEnvelope — bee write-capable (confinement LIFTED 2026-06-14)', () => {
  const bee = (capabilities: readonly string[], toolName = 't') =>
    evaluateCapabilityEnvelope({ toolName, capabilities, ctx: { role: 'bee' } });

  it('ALLOWS capability:fs-write for the bee (write/edit opened — owner-directed full autonomy)', () => {
    const d = bee(['capability:fs-write'], 'capability:write');
    expect(d.applied).toBe(true);
    expect(d.withinEnvelope).toBe(true);
  });

  it('ALLOWS capability:bash for the bee (exec opened — it must land fixes, not just diagnose)', () => {
    expect(bee(['capability:bash'], 'capability:bash').withinEnvelope).toBe(true);
  });

  it('still allows capability:fs-read + capability:code-inspect for the bee (read + verify stay open)', () => {
    expect(bee(['capability:fs-read'], 'capability:read').withinEnvelope).toBe(true);
    expect(bee(['capability:code-inspect'], 'capability:inspect').withinEnvelope).toBe(true);
  });

  it('leaves the coordination plane open (the bee must report + escalate)', () => {
    for (const cap of ['coord:write', 'work_items:write', 'plans:write', 'messages:write']) {
      expect(bee([cap]).withinEnvelope, `${cap} should stay within the bee envelope`).toBe(true);
    }
  });

  it('STILL denies the universal protected set for the bee (secrets / processes:kill — the floor holds)', () => {
    expect(bee(['secrets:read:x']).withinEnvelope).toBe(false);
    expect(bee(['processes:kill']).withinEnvelope).toBe(false);
  });

  it('the pipeline worker role is likewise write-capable (unchanged)', () => {
    const d = evaluateCapabilityEnvelope({
      toolName: 'capability:write',
      capabilities: ['capability:fs-write'],
      ctx: { role: 'worker' },
    });
    expect(d.applied).toBe(true);
    expect(d.withinEnvelope).toBe(true);
  });
});

describe('envelope constants', () => {
  it('FLEET_ENVELOPE_ROLES excludes the chat roles but includes the autonomous fleet', () => {
    expect(FLEET_ENVELOPE_ROLES.has('operator')).toBe(false);
    expect(FLEET_ENVELOPE_ROLES.has('oracle')).toBe(false);
    expect(FLEET_ENVELOPE_ROLES.has('worker')).toBe(true);
    expect(FLEET_ENVELOPE_ROLES.has('queen')).toBe(true);
    expect(FLEET_ENVELOPE_ROLES.has('bee')).toBe(true);
  });

  it('the protected set is non-empty (the only active B-06 constraint)', () => {
    expect(PROTECTED_CAPABILITY_GLOBS.length).toBeGreaterThan(0);
  });
});
