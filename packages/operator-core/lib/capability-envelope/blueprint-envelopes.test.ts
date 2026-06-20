/**
 * Per-hive capability envelopes from blueprint.fleet.workerRoles
 * (hive-blueprint-generalization P-012). The resolver maps a blueprint's declared
 * per-role capability allow-lists into the envelope map `evaluateCapabilityEnvelope`
 * consumes; a non-fleet harness ⇒ undefined (the global map, unchanged).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { blueprintRoleEnvelopes, __clearBlueprintEnvelopeCache } from './blueprint-envelopes';
import { evaluateCapabilityEnvelope, FLEET_ENVELOPE_ROLES } from './policy';

let stateDir: string;
const writeBlueprint = (yaml: string) => writeFileSync(join(stateDir, 'blueprint.yaml'), yaml, 'utf8');

// A fleet role to confine — pick a real fleet-envelope role so the evaluator applies.
const ROLE = FLEET_ENVELOPE_ROLES.has('bee') ? 'bee' : [...FLEET_ENVELOPE_ROLES][0];

// EI-2048: disable the testing-phase full-access exemption for the
// envelope-CONFINEMENT suites below — otherwise the chosen fleet role (a testing
// role: bee) bypasses its per-role denies and `fs-write` reads as within-envelope,
// masking the confinement assertions. Mirrors the same guard policy.test.ts uses.
const prevTestingFlag = process.env.PAPERCUSP_TESTING_FULL_ACCESS_ROLES;
beforeAll(() => { process.env.PAPERCUSP_TESTING_FULL_ACCESS_ROLES = 'off'; });
afterAll(() => {
  if (prevTestingFlag === undefined) delete process.env.PAPERCUSP_TESTING_FULL_ACCESS_ROLES;
  else process.env.PAPERCUSP_TESTING_FULL_ACCESS_ROLES = prevTestingFlag;
});

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), 'bp-envelope-'));
  __clearBlueprintEnvelopeCache();
});
afterEach(() => rmSync(stateDir, { recursive: true, force: true }));

const FLEET_YAML = [
  'id: confined-hive',
  'workItem: { kind: feature, idPrefix: F }',
  'spine: { decider: director, edges: { DONE: { to: done } }, default: { to: idle } }',
  'fleet:',
  '  workerRoles:',
  `    - id: ${ROLE}`,
  '      capabilities: [capability:read, capability:inspect]',
  '',
].join('\n');

describe('blueprintRoleEnvelopes', () => {
  it('returns undefined when there is no blueprint.yaml (→ global ROLE_ENVELOPES unchanged)', () => {
    expect(blueprintRoleEnvelopes(stateDir)).toBeUndefined();
  });

  it('returns undefined when the blueprint declares no fleet.workerRoles', () => {
    writeBlueprint('id: plain\nworkItem: { kind: feature }\nspine: { edges: { DONE: { to: done } } }\n');
    expect(blueprintRoleEnvelopes(stateDir)).toBeUndefined();
  });

  it('maps a declared workerRole capability list into an allow-list envelope (merged over global)', () => {
    writeBlueprint(FLEET_YAML);
    const env = blueprintRoleEnvelopes(stateDir);
    expect(env).toBeDefined();
    expect(env![ROLE]?.allowCapabilities).toEqual(['capability:read', 'capability:inspect']);
  });
});

describe('evaluateCapabilityEnvelope honors a per-hive envelope map (P-012)', () => {
  it('confines a fleet role to its blueprint allow-list — a non-listed capability is beyond-envelope', () => {
    writeBlueprint(FLEET_YAML);
    const envelopes = blueprintRoleEnvelopes(stateDir);
    // Within the allow-list → ok.
    const ok = evaluateCapabilityEnvelope({
      toolName: 'capability.read',
      capabilities: ['capability:read'],
      ctx: { role: ROLE },
      envelopes,
    });
    expect(ok.withinEnvelope).toBe(true);
    // fs-write is NOT in the blueprint allow-list → beyond-envelope.
    const denied = evaluateCapabilityEnvelope({
      toolName: 'capability.write',
      capabilities: ['capability:fs-write'],
      ctx: { role: ROLE },
      envelopes,
    });
    expect(denied.withinEnvelope).toBe(false);
    expect(denied.applied).toBe(true);
  });

  it('with the DEFAULT (global) map, the same fleet role is unconfined (behavior-preserving)', () => {
    // No `envelopes` arg ⇒ global ROLE_ENVELOPES, where the fleet role is default-allow.
    const d = evaluateCapabilityEnvelope({
      toolName: 'capability.write',
      capabilities: ['capability:fs-write'],
      ctx: { role: ROLE },
    });
    expect(d.withinEnvelope).toBe(true);
  });
});
