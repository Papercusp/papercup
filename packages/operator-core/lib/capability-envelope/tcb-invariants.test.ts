/**
 * tcb-invariants.test.ts — P-030 of agent-capability-confinement-2026-06-13
 * (D-007): the capability dispatch GATE (the envelope PDP, the decision-ledger,
 * the host wiring, the dispatch stack, and the gated capability tools) is in the
 * never-auto protected set, and the only widening dial (graduation = an
 * `autoKinds` config edit) cannot promote it.
 *
 * "The gate cannot graduate its own permissions": an auto-captured improvement
 * that TOUCHES the gate's own policy / ledger / wiring / capability code must
 * classify `tier: 'human'` under ANY graduation policy — pinned here so a
 * refactor of the risk-tier policy (or a stray reorder of the protected-path
 * list) cannot silently un-make the pin. Sibling of blueprint-steps/
 * tcb-invariants.test.ts (the deterministic spine executor TCB) and
 * recursion-safety-invariants.test.ts (P-049, the wider learning-loop never-auto
 * set); THIS suite pins the capability dispatch gate the confinement plan
 * concentrates fleet authority in.
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
import { CAPABILITY_DISPATCH_TCB_PATTERNS } from './tcb';

const ALL_KINDS: WorkItemKind[] = ['feature', 'bug', 'change', 'chunk'];

/** The maximal graduation: every kind auto-eligible (the dial turned all the way).
 *  The protected set must STILL gate — that is the invariant. */
const FULLY_GRADUATED: RiskTierPolicy = { ...DEFAULT_RISK_TIER_POLICY, autoKinds: ALL_KINDS };

function cand(p: Partial<ImprovementCandidate> & { id: string }): ImprovementCandidate {
  return { kind: 'bug', scope: 'operator', title: 'a thing', state: 'open', ...p };
}

/** One live representative file per TCB pattern the pin names — the envelope PDP,
 *  the decision-ledger emit, the host wiring, the generic dispatch stack, and a
 *  gated capability tool. Real files, so the test documents WHAT is pinned and
 *  breaks loudly if one is moved out from under its pattern. */
const TCB_REPRESENTATIVES: Array<[cls: string, path: string]> = [
  ['envelope PDP (evaluateCapabilityEnvelope)', 'packages/operator-core/lib/capability-envelope/policy.ts'],
  ['decision-ledger emit (D-012 chokepoint)', 'packages/operator-core/lib/decision-ledger/emit.ts'],
  ['host wiring (checkCapabilityEnvelope port)', 'packages/operator-core/lib/projected-tool-deps.ts'],
  ['generic dispatch stack (gate steps)', 'libs/generic/tooldef/src/dispatch-stack.ts'],
  ['gated capability tool (bash)', 'packages/operator-core/lib/agent-tools/capability/bash.ts'],
];

describe('P-030 — the capability dispatch gate is pinned never-auto (TCB; cannot graduate its own permissions)', () => {
  it('every TCB pattern is wired into DEFAULT_RISK_TIER_POLICY.protectedPathPatterns (the pin is live, not just declared)', () => {
    for (const pat of CAPABILITY_DISPATCH_TCB_PATTERNS) {
      expect(DEFAULT_RISK_TIER_POLICY.protectedPathPatterns).toContain(pat);
    }
  });

  it.each(TCB_REPRESENTATIVES)(
    'an auto-kind edit to the %s stays HUMAN under FULL graduation (the gate cannot graduate itself)',
    (_cls, path) => {
      const d = classifyImprovement(cand({ id: 'tcb', kind: 'bug', paths: [path] }), FULLY_GRADUATED);
      expect(d.tier).toBe('human');
      expect(d.protectedHit).toBeTruthy();
    },
  );

  it('the pin (not an incidental pre-existing pattern) is what gates the capability tools + wiring — protectedHit ∈ the TCB set', () => {
    // The envelope/ledger/wiring/capability files have no broader pre-existing
    // pattern; the TCB globs are appended last, so a hit on one of them proves
    // P-030 is doing the gating, meaningfully. (The generic dispatch-stack file
    // is likewise only covered by the TCB pin.)
    for (const [, path] of TCB_REPRESENTATIVES) {
      const d = classifyImprovement(cand({ id: 'pin', kind: 'bug', paths: [path] }), FULLY_GRADUATED);
      expect(CAPABILITY_DISPATCH_TCB_PATTERNS).toContain(d.protectedHit);
    }
  });

  it('graduation changes NOTHING about the gate pin: same protectedHit + tier under default and full graduation', () => {
    for (const [, path] of TCB_REPRESENTATIVES) {
      const base = classifyImprovement(cand({ id: 'b', kind: 'bug', paths: [path] }), DEFAULT_RISK_TIER_POLICY);
      const grad = classifyImprovement(cand({ id: 'g', kind: 'bug', paths: [path] }), FULLY_GRADUATED);
      expect(grad.tier).toBe('human');
      expect(grad.protectedHit).toBe(base.protectedHit);
    }
  });

  it('each TCB pattern actually MATCHES its representative file (the glob is not a dead pattern)', () => {
    for (const [, path] of TCB_REPRESENTATIVES) {
      const matched = CAPABILITY_DISPATCH_TCB_PATTERNS.some((pat) => matchGlob(pat, path));
      expect(matched).toBe(true);
    }
  });

  it('the dial still turns: a clean off-gate edit IS promoted to auto by graduation (the pin is not vacuously blocking everything)', () => {
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
