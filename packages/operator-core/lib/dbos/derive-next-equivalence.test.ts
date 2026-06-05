/**
 * P-003 behavior-safety proof: `deriveNext(coding.spine, …)` is byte-equivalent
 * to the legacy `classifyDecision(…)` switch across the ENTIRE decision
 * vocabulary. This is the gate that makes the live wire-in (P-004) boring — if
 * this is green, swapping the call site cannot change pipeline behavior.
 *
 * Loads the SHIPPED `coding/blueprint.yaml` (the same file the engine loads), so
 * a drift between the blueprint and the switch fails here.
 */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import { harnessPath } from '@papercusp/harness/paths';
import { BlueprintSchema, deriveNext } from '@papercusp/orchestrator/blueprint';
import { DECISION_VERBS } from '@papercusp/orchestrator/decision-parse';
import type { ParsedDecision, DecisionVerb } from '@papercusp/orchestrator/decision-parse';
import { classifyDecision } from './orchestrator-decide';

// The spine under test = the real shipped coding blueprint, parsed through the
// validator-of-record (not a hand-built fixture).
const codingYaml = parseYaml(
  readFileSync(harnessPath('blueprints', 'coding', 'blueprint.yaml'), 'utf8'),
);
const spine = BlueprintSchema.parse(codingYaml).spine;

const FEATURE = 'F-001';

function mkParsed(verb: DecisionVerb, arg: string | null, n: number | null): ParsedDecision {
  const raw = `${verb}${arg ? ` ${arg}` : ''}${n ? ` N=${n}` : ''}`;
  return { verb, arg, n, raw };
}

test('deriveNext(coding) === classifyDecision — null decision', () => {
  assert.deepEqual(deriveNext(spine, null, FEATURE), classifyDecision(null, FEATURE));
});

test('deriveNext(coding) === classifyDecision — every verb × (no-arg, feature-arg, val-arg)', () => {
  for (const verb of DECISION_VERBS) {
    for (const arg of [null, 'F-042', 'VAL-7']) {
      const parsed = mkParsed(verb, arg, null);
      assert.deepEqual(
        deriveNext(spine, parsed, FEATURE),
        classifyDecision(parsed, FEATURE),
        `mismatch for verb=${verb} arg=${arg}`,
      );
    }
  }
});

test('deriveNext(coding) === classifyDecision — NEXT_WORKER N=k (parallel lanes → unsupported)', () => {
  for (const n of [2, 3, 5]) {
    const parsed = mkParsed('NEXT_WORKER', 'F-009', n);
    assert.deepEqual(
      deriveNext(spine, parsed, FEATURE),
      classifyDecision(parsed, FEATURE),
      `NEXT_WORKER N=${n}`,
    );
  }
  // N= on a non-worker verb must be ignored identically (validator dispatches).
  const v = mkParsed('NEXT_VALIDATOR', 'F-009', 2);
  assert.deepEqual(deriveNext(spine, v, FEATURE), classifyDecision(v, FEATURE));
});

test('coding spine declares an explicit edge for every DECISION_VERB (switch parity)', () => {
  for (const verb of DECISION_VERBS) {
    assert.ok(
      Object.prototype.hasOwnProperty.call(spine.edges, verb),
      `coding blueprint is missing an edge for ${verb} (would silently fall to spine.default)`,
    );
  }
});
