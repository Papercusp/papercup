/**
 * Deterministic asserts — §5.1
 *
 * Each kind maps to an evaluator that consumes a RunSummary and returns
 * Violations. The full assertion catalogue is intentionally finite —
 * new behaviors → new kinds, registered here. Free-form `custom`
 * predicates exist as an escape hatch but should be promoted into a
 * built-in kind once they recur (§5.2).
 */

import type { DeterministicAssert, RunSummary, Violation } from '../types';

export type AssertEvaluator = (assert: DeterministicAssert, run: RunSummary) => Violation[];

// Lazy-initialized via globalThis to avoid TDZ when side-effect-register
// modules (./tool, ./text, ...) load before this module's `const` runs.
function getRegistry(): Partial<Record<DeterministicAssert['kind'], AssertEvaluator>> {
  const g = globalThis as unknown as {
    __llmTestEvaluators?: Partial<Record<DeterministicAssert['kind'], AssertEvaluator>>;
  };
  if (!g.__llmTestEvaluators) g.__llmTestEvaluators = {};
  return g.__llmTestEvaluators;
}

export function registerEvaluator<K extends DeterministicAssert['kind']>(
  kind: K,
  fn: (assert: Extract<DeterministicAssert, { kind: K }>, run: RunSummary) => Violation[],
): void {
  getRegistry()[kind] = fn as unknown as AssertEvaluator;
}

export function evaluateAsserts(asserts: DeterministicAssert[], run: RunSummary): Violation[] {
  // Touch the side-effect register modules on first call so they're loaded.
  loadBuiltins();
  const registry = getRegistry();
  const violations: Violation[] = [];
  for (const a of asserts) {
    const fn = registry[a.kind];
    if (!fn) {
      violations.push({
        assertKind: a.kind,
        severity: 'error',
        claim: `No evaluator registered for assert kind '${a.kind}'`,
      });
      continue;
    }
    violations.push(...fn(a, run));
  }
  return violations;
}

let _builtinsLoaded = false;
function loadBuiltins(): void {
  if (_builtinsLoaded) return;
  _builtinsLoaded = true;
  // Side-effect imports — each module calls registerEvaluator at top level.
  // Lazy-loaded so module init order doesn't matter.
  require('./tool');
  require('./text');
  require('./card');
  require('./control-tag');
  require('./auto-fire');
  require('./continue-chain');
  require('./latency');
}
