/**
 * tcb-invariants.test.ts — P-141 of deterministic-blueprints-migration-2026-06-13
 * (ties to agent-capability-confinement D-007): the program-mode SPINE EXECUTOR +
 * the DETERMINISTIC-STEP RUNNER are in the never-auto protected set, and the only
 * widening dial (graduation = an `autoKinds` config edit) cannot promote them.
 *
 * "The executor cannot graduate its own permissions": an auto-captured improvement
 * that TOUCHES the executor's own dispatch / validation / runner code must classify
 * `tier: 'human'` under ANY graduation policy — pinned here so a refactor of the
 * risk-tier policy (or a stray reorder of the protected-path list) cannot silently
 * un-make the pin. Sibling of recursion-safety-invariants.test.ts (P-049), which
 * pins the wider learning-loop never-auto set; THIS suite pins the executor TCB the
 * deterministic-blueprints migration adds to it.
 */
import { describe, it, expect } from 'vitest';
import {
  classifyImprovement,
  matchGlob,
  DEFAULT_RISK_TIER_POLICY,
  type ImprovementCandidate,
  type RiskTierPolicy,
  type WorkItemKind,
} from '../harness/improvements/policy';
import { DETERMINISTIC_EXECUTOR_TCB_PATTERNS } from './tcb';

const ALL_KINDS: WorkItemKind[] = ['feature', 'bug', 'change', 'chunk'];

/** The maximal graduation: every kind auto-eligible (the dial turned all the way).
 *  The protected set must STILL gate — that is the invariant. */
const FULLY_GRADUATED: RiskTierPolicy = { ...DEFAULT_RISK_TIER_POLICY, autoKinds: ALL_KINDS };

function cand(p: Partial<ImprovementCandidate> & { id: string }): ImprovementCandidate {
  return { kind: 'bug', scope: 'operator', title: 'a thing', state: 'open', ...p };
}

/** One live representative file per TCB pattern the pin names — the spine executor
 *  adapter, the dispatch registry, the deterministic-step runner, the pure step
 *  engine, and the blueprint validator. Real files, so the test documents WHAT is
 *  pinned and breaks loudly if one is moved out from under its pattern. */
const TCB_REPRESENTATIVES: Array<[cls: string, path: string]> = [
  ['spine executor (runProgramCore)', 'packages/operator-core/lib/coord-ops/program-runner.ts'],
  ['dispatch registry (requireCoordOp)', 'packages/operator-core/lib/coord-ops/registry.ts'],
  ['deterministic-step runner', 'packages/operator-core/lib/blueprint-steps/ops/negative-space-scan.ts'],
  ['deterministic-step registration', 'packages/operator-core/lib/blueprint-steps/index.ts'],
  ['pure step engine', 'libs/generic/step-program/src/runner.ts'],
  ['blueprint validator', 'libs/papercusp/packages/orchestrator/src/blueprint/validate.ts'],
];

describe('P-141 — the spine executor + deterministic-step runner are pinned never-auto (TCB; cannot graduate own permissions)', () => {
  it('every TCB pattern is wired into DEFAULT_RISK_TIER_POLICY.protectedPathPatterns (the pin is live, not just declared)', () => {
    for (const pat of DETERMINISTIC_EXECUTOR_TCB_PATTERNS) {
      expect(DEFAULT_RISK_TIER_POLICY.protectedPathPatterns).toContain(pat);
    }
  });

  it.each(TCB_REPRESENTATIVES)(
    'an auto-kind edit to the %s stays HUMAN under FULL graduation (the executor cannot graduate itself)',
    (_cls, path) => {
      const d = classifyImprovement(cand({ id: 'tcb', kind: 'bug', paths: [path] }), FULLY_GRADUATED);
      expect(d.tier).toBe('human');
      expect(d.protectedHit).toBeTruthy();
    },
  );

  it('the pin (not an incidental pre-existing pattern) is what gates the executor — protectedHit ∈ the TCB set', () => {
    for (const [, path] of TCB_REPRESENTATIVES) {
      const d = classifyImprovement(cand({ id: 'pin', kind: 'bug', paths: [path] }), FULLY_GRADUATED);
      // classifyImprovement returns the FIRST matching pattern; the TCB globs are
      // appended last, so a hit on one of them proves nothing earlier covered the
      // executor (i.e. P-141 is doing the gating, meaningfully).
      expect(DETERMINISTIC_EXECUTOR_TCB_PATTERNS).toContain(d.protectedHit);
    }
  });

  it('graduation changes NOTHING about the executor pin: same protectedHit + tier under default and full graduation', () => {
    for (const [, path] of TCB_REPRESENTATIVES) {
      const base = classifyImprovement(cand({ id: 'b', kind: 'bug', paths: [path] }), DEFAULT_RISK_TIER_POLICY);
      const grad = classifyImprovement(cand({ id: 'g', kind: 'bug', paths: [path] }), FULLY_GRADUATED);
      expect(grad.tier).toBe('human');
      expect(grad.protectedHit).toBe(base.protectedHit);
    }
  });

  it('each TCB pattern actually MATCHES its representative file (the glob is not a dead pattern)', () => {
    for (const [, path] of TCB_REPRESENTATIVES) {
      const matched = DETERMINISTIC_EXECUTOR_TCB_PATTERNS.some((pat) => matchGlob(pat, path));
      expect(matched).toBe(true);
    }
  });

  it('the dial still turns: a clean off-executor edit IS promoted to auto by graduation (the pin is not vacuously blocking everything)', () => {
    const clean = cand({
      id: 'ok',
      kind: 'chunk', // not auto under the default policy…
      title: 'nicer empty-state for the inbox panel',
      paths: ['apps/operator/app/inbox/EmptyState.tsx'],
    });
    expect(classifyImprovement(clean, DEFAULT_RISK_TIER_POLICY).tier).toBe('human');
    expect(classifyImprovement(clean, FULLY_GRADUATED).tier).toBe('auto'); // …graduation promotes it
  });
});
