/**
 * Per-hive capability envelopes from blueprint.fleet.workerRoles
 * (hive-blueprint-generalization P-012). The resolver maps a blueprint's declared
 * per-role capability allow-lists into the envelope map `evaluateCapabilityEnvelope`
 * consumes; a non-fleet harness ⇒ undefined (the global map, unchanged).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { blueprintRoleEnvelopes, __clearBlueprintEnvelopeCache } from './blueprint-envelopes';
import { evaluateCapabilityEnvelope, FLEET_ENVELOPE_ROLES } from './policy';
import { compileAgentSpecification, MODE_AXES } from '@papercusp/orchestrator/blueprint';
import { dispatchProjectedTool, type ProjectedTool, type UnifiedToolContext } from '@papercusp/agent-mcp';
import { loadIdopP001RolePermissionReader } from '../agent-identities/idop-p001-baseline';
import { defaultCensusRoot } from '../agent-identities/identity-surface-census';

let stateDir: string;
const writeBlueprint = (yaml: string) => writeFileSync(join(stateDir, 'blueprint.yaml'), yaml, 'utf8');

// A fleet role to confine — pick a real fleet-envelope role so the evaluator applies.
const ROLE = FLEET_ENVELOPE_ROLES.has('cup') ? 'cup' : [...FLEET_ENVELOPE_ROLES][0];

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
  it('R-13: a mode contributes no grant and AUDIT still narrows at dispatch', async () => {
    for (const slot of MODE_AXES) {
      const source = { id: `mode-${slot}`, slots: [{ slot }] };
      expect(compileAgentSpecification({ source }).configuration.grants).toBeUndefined();
      expect(() => compileAgentSpecification({ source: { ...source, grants: { requires: ['claims.record@1.0.0'] } } }))
        .toThrow(/authority-on-mode-axis.*grants/);
    }

    // Use the current host gate's actual source and the full generic dispatcher.
    // Only authority reads are supplied by this private fixture, as in P001's
    // same-input replay. No gate or dispatcher implementation is substituted.
    let modes: Array<{ mode: string }> = [];
    const policy = loadIdopP001RolePermissionReader({ root: defaultCensusRoot(), revision: 'working-tree', testingFullAccess: 'off' });
    const readModes = vi.fn(async () => modes);
    const gate = policy.createHostEnvelopePort({
      resolveConfinement: async () => null, ensureConfinementReady: async () => {},
      audit: { resolveIdentity: () => ({ ownerId: 'r13-wearer', workspaceId: 'r13-workspace' }), readModes },
      roleOverrides: () => ({}), protectedAdditions: () => [], getFlag: async () => true,
    });
    const ctx: UnifiedToolContext = {
      workspaceId: 'r13-workspace', harnessSlug: 'r13-fixture', uiClientId: 'r13-wearer',
      role: 'su', isSuperuser: true, runId: 'r13-run', spawnId: 'r13-spawn', parentSpawnId: null,
      log: () => {}, progress: () => {}, emit: () => {}, signal: new AbortController().signal,
    };
    const marker = join(stateDir, 'mutation-effect');
    const mutate = vi.fn(async () => { writeFileSync(marker, 'effect'); return { content: [] }; });
    const tool: ProjectedTool = { pluginName: 'r13-fixture', description: 'Private R13 effect probe',
      inputSchema: { type: 'object' }, capabilities: [], expose: { mcp: { name: 'work_items:complete' } }, fn: mutate };
    const deps = { checkCapabilityEnvelope: gate };
    expect((await dispatchProjectedTool(tool, 'work_items:complete', {}, ctx, deps)).ok).toBe(true);
    expect(mutate).toHaveBeenCalledOnce();
    expect(existsSync(marker)).toBe(true);
    rmSync(marker);
    mutate.mockClear();

    modes = [{ mode: 'audit' }];
    expect(await dispatchProjectedTool(tool, 'work_items:complete', {}, ctx, deps)).toMatchObject({
      ok: false, error: { code: 'capability_denied', message: expect.stringContaining('AUDIT mode') },
    });
    expect(mutate).not.toHaveBeenCalled();
    expect(existsSync(marker)).toBe(false);
    expect(readModes).toHaveBeenLastCalledWith('r13-workspace', 'r13-wearer');
    const read = vi.fn(async () => ({ content: [] }));
    expect((await dispatchProjectedTool({ ...tool, fn: read }, 'work_items:get', {}, ctx, deps)).ok).toBe(true);
    expect(read).toHaveBeenCalledOnce();
    expect(existsSync(marker)).toBe(false);
  });

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
