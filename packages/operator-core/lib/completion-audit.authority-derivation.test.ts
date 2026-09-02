/**
 * design-to-code-coverage-seam-2026-09-02 P-003 — `derivedTerminalCompletionAuthority`.
 *
 * The subject is a function whose whole value is what it DECLINES to do, so the negative
 * cases are the load-bearing ones and each is written as a named case rather than a loop:
 * a single `null` return is indistinguishable from every other `null` return, and a loop
 * over "these all return null" would still pass if the function were `() => null`. The
 * first two cases exist to rule exactly that out — they are the only ones that prove the
 * grader is reached at all.
 *
 * `classifyTerminalOwner` is exercised here too, on the two identities P-003 had to
 * register before this function could be correct. That coupling is the point: had they
 * stayed classified `agent`, this function would have started grading ~460 automation
 * closes a week (measured 2026-09-02, 7 days, papercusp-workspace) — so the classifier's
 * verdict for them is part of THIS function's contract, not a neighbouring module's detail.
 */
import { describe, it, expect } from 'vitest';
import {
  classifyTerminalOwner,
  derivedTerminalCompletionAuthority,
  KNOWN_SYSTEM_GATED_CLOSER_IDENTITIES,
} from './completion-audit';
import type { CompletionVerificationEvidence } from './coord-lifecycle/records';

const AGENT = 'su-467a4d53-6d9e-4abb-b919-8cec77ebb99c';

/** Evidence that clears every sufficiency check in `insufficientEvidenceReason`. */
const SUFFICIENT: CompletionVerificationEvidence = {
  summary: 'wired the derivation into both terminal writers',
  verifiedHow: 'unit',
  testsRun: 'npm run test:file -- completion-audit.authority-derivation.test.ts',
  testResult: '18 passed',
};

type DerivationInput = Parameters<typeof derivedTerminalCompletionAuthority>[0];

/** The shape of an ordinary `set_state { completionRef }` close: a ref, and nothing judged. */
function refOnlyClose(overrides: Partial<DerivationInput> = {}) {
  return derivedTerminalCompletionAuthority({ isTerminal: true, by: AGENT, ...overrides });
}

describe('derivedTerminalCompletionAuthority — the grader IS reached', () => {
  it('grades an agent ref-only close `proposed` instead of leaving it a legacy NULL', () => {
    // The defect P-003 closes: this close judged nothing, and a NULL terminal authority
    // reads as a pre-contract legacy close that COUNTS toward burn-down (D-005).
    expect(refOnlyClose()).toBe('proposed');
  });

  it('grades an agent close carrying sufficient evidence `committed`', () => {
    // Proves the two outcomes are actually distinguished — a function hard-wired to
    // 'proposed' would satisfy every other assertion in this file.
    expect(refOnlyClose({ evidence: SUFFICIENT })).toBe('committed');
  });

  it('routes through the same grader, so an evidence findings verdict demotes', () => {
    expect(
      refOnlyClose({
        evidence: SUFFICIENT,
        findings: { filesChangedNeverExisted: ['packages/operator-core/lib/never-existed.ts'] },
      }),
    ).toBe('proposed');
  });
});

describe('derivedTerminalCompletionAuthority — what it declines to judge', () => {
  it('declines when the caller already judged (never re-judges a supplied authority)', () => {
    // Including the case where the caller's own verdict DISAGREES with the evidence:
    // work_items:complete computes with impure findings this function cannot see, so its
    // judgement must win rather than be silently recomputed from the evidence alone.
    expect(refOnlyClose({ suppliedAuthority: 'proposed', evidence: SUFFICIENT })).toBeNull();
    expect(refOnlyClose({ suppliedAuthority: 'committed' })).toBeNull();
  });

  it('declines a non-terminal write', () => {
    expect(derivedTerminalCompletionAuthority({ isTerminal: false, by: AGENT })).toBeNull();
  });

  it('declines a skipCompletionGate write — those are not completions at all', () => {
    expect(refOnlyClose({ skipCompletionGate: true })).toBeNull();
  });

  it('declines a force ref-only correction, which must preserve the stored authority', () => {
    // EI-21184699633369991: stamping here would turn a real completion into `proposed`
    // on a correction that supplied no new evidence.
    expect(refOnlyClose({ preserveExistingRecord: true })).toBeNull();
  });

  it('declines when no closing identity is recorded', () => {
    expect(derivedTerminalCompletionAuthority({ isTerminal: true, by: null })).toBeNull();
    expect(derivedTerminalCompletionAuthority({ isTerminal: true, by: '   ' })).toBeNull();
  });
});

describe('derivedTerminalCompletionAuthority — system identities keep their legacy NULL', () => {
  // Each of these closes on an outcome with no code evidence in principle ("replication
  // recovered", "duplicate collapse", "the structural error cleared"). Grading them would
  // manufacture meaningless `proposed` rows at roughly 1,600/week and is the opposite of
  // what P-003 is for.
  const SYSTEM_CLOSERS = [
    'system:replication-liveness',
    'system:spec-triad',
    'system:plan-item-reconcile',
    'watchdog-auto-close',
    'watchdog-green-resolve',
    'improvement-hygiene',
    'structural-error-verifier',
    'tsc-red-cleared-resolve',
  ] as const;

  for (const by of SYSTEM_CLOSERS) {
    it(`declines '${by}'`, () => {
      expect(classifyTerminalOwner(by)).toBe('system');
      expect(refOnlyClose({ by })).toBeNull();
    });
  }

  it('declines a transport-only identity — there is no agent behind it to judge', () => {
    expect(refOnlyClose({ by: 'su-loopback' })).toBeNull();
    expect(refOnlyClose({ by: 'mcp-call-48213' })).toBeNull();
  });
});

describe('classifyTerminalOwner — the identities P-003 had to register', () => {
  it('classifies the gated system closers as system, not agent', () => {
    // The regression this fixes: neither carries a `system:`/`watchdog-` prefix and neither
    // passes skipCompletionGate, so BOTH membership tests missed them. Measured 2026-09-02
    // over 7 days, `structural-error-verifier` closed 397 items, every one filed as an agent.
    for (const id of KNOWN_SYSTEM_GATED_CLOSER_IDENTITIES) {
      expect(classifyTerminalOwner(id)).toBe('system');
    }
    expect(KNOWN_SYSTEM_GATED_CLOSER_IDENTITIES).toContain('structural-error-verifier');
  });

  it('still classifies a real agent id as agent, and a blank owner as unattributed', () => {
    // The control that keeps the fix from being "classify everything system": that would
    // pass every assertion above while disabling P-003 entirely.
    expect(classifyTerminalOwner(AGENT)).toBe('agent');
    expect(classifyTerminalOwner(null)).toBe('unattributed');
  });
});
