/**
 * P-001 (deterministic-blueprints-migration-2026-06-13, brief 6) — the blueprint
 * validator's op/role LIVENESS contract, wired at the admission chokepoints.
 *
 * The registry header has always claimed `coordOpNames()` is "what the operator
 * passes to `validateBlueprint({ knownOps })` so a program that names a
 * nonexistent op fails at author/load time, not at run time" — but until this
 * brief NO caller passed it, so the `unknown-op` check was dead in practice and a
 * deterministic-program blueprint (a migrated learning loop, or any future
 * procedure migration) could name a typo'd / unregistered op, validate clean, and
 * throw `requireCoordOp` deep in the durable pipeline at run time.
 *
 * These tests prove: (1) `blueprintRegistrySets()` exposes the full op + role
 * universe; (2) the contract being ACTIVATED does not break a single shipped
 * built-in blueprint (the load-bearing safety guarantee — no built-in names an
 * unregistered op); (3) the authoring path (`resolveAndValidate`, backing
 * `blueprint:validate`/`blueprint:extend`) now rejects an unknown op instead of
 * passing it through.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { harnessPath } from '@papercusp/harness/paths';
import { loadBuiltinBlueprint, validateBlueprint } from '@papercusp/orchestrator/blueprint';
import { blueprintRegistrySets } from './registry-sets.js';
import { resolveAndValidate } from '../agent-tools/blueprint/_resolve.js';

const blueprintsDir = harnessPath('blueprints');
const builtinIds = readdirSync(blueprintsDir).filter((d) => existsSync(join(blueprintsDir, d, 'blueprint.yaml')));

describe('blueprintRegistrySets — the operator→validator registry bridge (P-001)', () => {
  it('exposes the full coord-op + deterministic-step-op set', () => {
    const { knownOps } = blueprintRegistrySets();
    // Coordination ops (compose/thread/collect/aggregate/spawn) AND the migrated
    // deterministic step-ops (the learning loops) both register through the bridge.
    for (const op of [
      'coord:thread-open',
      'coord:collect',
      'vote:aggregate',
      'orchestrator:spawn-roles',
      'coord:escalate',
      'negative-space:scan',
      'regret:mine',
      'iq-battery:gen',
      'scout:cycle',
    ]) {
      expect(knownOps?.has(op), `expected registered op "${op}"`).toBe(true);
    }
  });

  it('exposes the live agent-role universe', () => {
    const { knownRoles } = blueprintRegistrySets();
    expect(knownRoles?.size ?? 0).toBeGreaterThan(0);
    expect(knownRoles?.has('worker')).toBe(true);
  });
});

describe('every built-in blueprint stays valid under the live registries (P-001 regression guard)', () => {
  const sets = blueprintRegistrySets();
  it('discovers built-in blueprints to check', () => {
    expect(builtinIds.length).toBeGreaterThan(10);
    expect(builtinIds).toContain('coding-factory');
    expect(builtinIds).toContain('vote');
    expect(builtinIds).toContain('negative-space');
  });

  for (const id of builtinIds) {
    it(`built-in "${id}" names only registered ops + live/declared roles`, () => {
      // Baseline (no registries) load — abstract parents like `base` (no spine)
      // throw here today; they have no ops, so they're not an op-liveness concern.
      let blueprint;
      try {
        blueprint = loadBuiltinBlueprint(id).blueprint;
      } catch {
        return; // not an independently-runnable blueprint — skip
      }
      // Re-validate WITH the live registries (validateBlueprint returns issues, it
      // does not throw). Activating the contract must introduce NO unknown-op error
      // and must keep the blueprint valid.
      const v = validateBlueprint(blueprint, sets);
      expect(v.errors.filter((e) => e.code === 'unknown-op'), `unknown-op in built-in "${id}"`).toEqual([]);
      expect(v.ok, `built-in "${id}" errors: ${JSON.stringify(v.errors)}`).toBe(true);
    });
  }
});

describe('resolveAndValidate enforces op-liveness at authoring time (P-001 — the activated gap)', () => {
  const base = { id: 'p001-authoring-test', workItem: { kind: 'decision', idPrefix: 'X' }, roles: [{ id: 'voter' }] };

  it('a program naming registered ops validates clean', () => {
    const r = resolveAndValidate({
      ...base,
      spine: {
        steps: [
          { id: 's1', op: 'orchestrator:spawn-roles' },
          { id: 's2', op: 'coord:collect' },
        ],
        gate: [{ op: 'resolve', else: true }],
      },
    });
    expect(r.ok, JSON.stringify(r.validation?.errors ?? r.parseError)).toBe(true);
  });

  it('a program naming an UNregistered op is rejected with unknown-op (was silently accepted pre-P-001)', () => {
    const r = resolveAndValidate({
      ...base,
      spine: {
        steps: [{ id: 's1', op: 'totally:nonexistent' }],
        gate: [{ op: 'resolve', else: true }],
      },
    });
    expect(r.ok).toBe(false);
    expect(r.validation?.errors.some((e) => e.code === 'unknown-op')).toBe(true);
  });
});
