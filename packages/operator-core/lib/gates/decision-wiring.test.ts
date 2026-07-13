/**
 * decision-wiring.test.ts — EI-10619 / EI-10660. The gate-decision log is only worth having if
 * something WRITES to it.
 *
 * `degenerate.test.ts` proves the detector discriminates. It would pass just as green if
 * `recordGateDecisions` had zero callers — which is precisely Shape 4 of the cannot-discriminate
 * class (a correct verdict that nothing reads; a check that nothing calls), and precisely the bug
 * EI-10660 found sitting in the LAST guard we shipped. Shipping an un-emitted decision log inside
 * the fix for that class would be the joke writing itself.
 *
 * So: assert the CALL SITE. A green check that nothing invokes is not a check.
 *
 * Run: cd packages/operator-core && npx vitest run lib/gates/decision-wiring.test.ts
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { GATE_REGISTRY } from './degenerate';

const read = (rel: string) => readFileSync(join(__dirname, '..', rel), 'utf8');

describe('the gate-decision log has a real writer (EI-10619, Shape-4 guard)', () => {
  it('orient CALLS recordGateDecisions — not merely imports it', () => {
    const orient = read('agent-tools/coordination/tools/orient.ts');
    expect(orient).toContain('gates/decision');
    // The CALL, not the import. `rg` for the caller — never trust a "Called by:" comment.
    expect(orient).toMatch(/recordGateDecisions\s*\(/);
  });

  it('the gates orient runs are the gates the registry declares — no silent drift', () => {
    // The registry is what the detector diffs against to find a gate that went dark. If a gate is
    // emitted but unregistered, its absence would never be noticed; if it is registered but never
    // emitted, the detector cries never-ran forever. Both directions are drift, so pin both.
    const admission = read('memory/recall-admission.ts');
    const emitted = [...admission.matchAll(/gate:\s*'([^']+)'/g)].map((m) => m[1]).sort();
    const registered = GATE_REGISTRY.map((g) => g.gate).sort();
    expect(emitted).toEqual(registered);
  });

  it('every emitted gate declares an `expect` — the column the detector cannot work without', () => {
    const admission = read('memory/recall-admission.ts');
    const gates = [...admission.matchAll(/gate:\s*'([^']+)'/g)].length;
    const expects = [...admission.matchAll(/expect:\s*'(discriminates|guards)'/g)].length;
    expect(expects).toBe(gates);
  });
});
