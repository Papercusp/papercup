/**
 * EI-19362441037986499 — the record-only-completion-of-an-already-terminal-item decision.
 *
 * The motivating measurement: an agent fixed two watchdog-filed red-test items, verified
 * them, and called `work_items:complete` with full structured evidence. The watchdog had
 * already auto-resolved both (correctly — the tests really had gone green). The tool returned
 * ok:true with a mutation count, and the row kept `authority: null` plus the watchdog's
 * one-line generic testResult. Everything the agent wrote about WHY the tests were red was
 * absent from the terminal row, and nothing in the result said so. This module is the
 * decision that replaced that silent discard; no mocks and no PG, because it is pure.
 */
import { describe, it, expect } from 'vitest';

import { classifySettledCompletionEvidence } from './work-item-settled-completion-evidence';
import type { CompletionVerificationEvidence } from './coord-lifecycle/records';
import { isSufficientEvidence } from './work-item-completion-authority';

/** Clears the `committed` bar: a verifiedHow plus a test result. */
const RICH: CompletionVerificationEvidence = {
  verifiedHow: 'unit',
  testsRun: 'testing:run complete.test.ts',
  testResult: '144 passed / 0 failed',
};
/** Does NOT clear it — a summary is not verification. */
const THIN: CompletionVerificationEvidence = { summary: 'fixed it' } as CompletionVerificationEvidence;

const WATCHDOG = 'watchdog-green-resolve';
const AGENT = 'su-63319e40';

/**
 * A row a watchdog auto-resolved: it IS credited and DOES carry a completion ref (measured
 * table-wide — watchdog-green-resolve populates that ref on 248 of 248 rows), which is what
 * makes it a record worth defending rather than an empty terminal row.
 */
const watchdogResolved = (evidence: CompletionVerificationEvidence | null) => ({
  by: AGENT,
  terminalOwner: WATCHDOG,
  terminalCompletionRef: 'auto-resolved: 4 consecutive green runs',
  completionAuthority: null,
  storedEvidence: evidence,
  incomingEvidence: RICH,
});

describe('classifySettledCompletionEvidence — calibration of the evidence fixtures', () => {
  // Without this, EVERY expectation below could be satisfied by a classifier that ignores
  // evidence entirely, or by fixtures that both sit on the same side of the bar. The bar is
  // the shared helper, so assert the fixtures straddle it before relying on them.
  it('RICH clears the sufficiency bar and THIN does not', () => {
    expect(isSufficientEvidence(RICH)).toBe(true);
    expect(isSufficientEvidence(THIN)).toBe(false);
  });
});

describe('classifySettledCompletionEvidence — nothing to protect ⇒ the record is installed', () => {
  it('installs when the row carries NO completion record (the watchdog-auto-close shape)', () => {
    // ~9,618 `watchdog-auto-close` rows carry neither a ref nor an authority. The state-write
    // path installs over them because nothing is being protected; this path must agree rather
    // than being quietly stricter.
    const d = classifySettledCompletionEvidence({
      by: AGENT,
      terminalOwner: 'watchdog-auto-close',
      terminalCompletionRef: null,
      completionAuthority: null,
      storedEvidence: null,
      incomingEvidence: RICH,
    });
    expect(d.outcome).toBe('recorded');
    expect(d.install).toBe(true);
  });

  it('installs when the caller IS the credited closer, amending their own record', () => {
    const d = classifySettledCompletionEvidence({
      by: AGENT,
      terminalOwner: AGENT,
      terminalCompletionRef: 'my earlier close',
      completionAuthority: 'committed',
      storedEvidence: RICH,
      incomingEvidence: RICH,
    });
    expect(d.outcome).toBe('recorded');
    expect(d.install).toBe(true);
  });

  it('installs a THIN record when the row holds nothing — some evidence beats none', () => {
    const d = classifySettledCompletionEvidence({
      by: AGENT,
      terminalOwner: null,
      terminalCompletionRef: null,
      completionAuthority: null,
      storedEvidence: null,
      incomingEvidence: THIN,
    });
    expect(d.outcome).toBe('recorded');
    expect(d.install).toBe(true);
    expect(d.incomingSufficient).toBe(false);
  });
});

describe('classifySettledCompletionEvidence — a peer record present ⇒ upgrade or attest', () => {
  it('UPGRADES when the stored record is thin and the incoming one is rich', () => {
    const d = classifySettledCompletionEvidence(watchdogResolved(THIN));
    expect(d.outcome).toBe('upgraded');
    expect(d.install).toBe(true);
    expect(d.existingSufficient).toBe(false);
    expect(d.incomingSufficient).toBe(true);
  });

  it('ATTESTS on a TIE — two sufficient records leave the FIRST standing', () => {
    // This is the honest expected outcome for the motivating case: the watchdog's own
    // evidence carries a verifiedHow and a testResult, so it clears the same bar. The
    // agent's richer record is therefore filed BESIDE it, not over it. Recording that here
    // so a later reader does not "fix" a tie into a newest-wins rule by accident — whether
    // a human-verified record should outrank a watchdog's is a separate judgement.
    const d = classifySettledCompletionEvidence(watchdogResolved(RICH));
    expect(d.outcome).toBe('attested');
    expect(d.install).toBe(false);
    expect(d.existingSufficient).toBe(true);
    expect(d.incomingSufficient).toBe(true);
  });

  it('ATTESTS when the incoming record is weaker than the stored one', () => {
    const d = classifySettledCompletionEvidence({ ...watchdogResolved(RICH), incomingEvidence: THIN });
    expect(d.outcome).toBe('attested');
    expect(d.install).toBe(false);
  });

  it('ATTESTS when NEITHER record clears the bar — a weak record never erases a weak record', () => {
    const d = classifySettledCompletionEvidence({ ...watchdogResolved(THIN), incomingEvidence: THIN });
    expect(d.outcome).toBe('attested');
    expect(d.install).toBe(false);
  });

  it('treats an authority-only stored record as worth defending (no ref present)', () => {
    // Either signal alone means "someone recorded a real completion here" — the guard reads
    // `ref || authority`, so a peer close carrying only an authority judgement still counts.
    const d = classifySettledCompletionEvidence({
      by: AGENT,
      terminalOwner: 'su-peer',
      terminalCompletionRef: null,
      completionAuthority: 'committed',
      storedEvidence: RICH,
      incomingEvidence: RICH,
    });
    expect(d.outcome).toBe('attested');
    expect(d.install).toBe(false);
  });
});

describe('classifySettledCompletionEvidence — controls that must NOT pass', () => {
  // A guard that has never failed is a guard nobody has tested. These deliberately-wrong
  // implementations stay here permanently: if the assertions above can also be satisfied by
  // "newest always wins" or "never install", then they are not testing what they claim.
  const newestAlwaysWins = () => ({ outcome: 'upgraded' as const, install: true });
  const neverInstalls = () => ({ outcome: 'attested' as const, install: false });

  it('a newest-wins implementation would break the TIE case', () => {
    const real = classifySettledCompletionEvidence(watchdogResolved(RICH));
    expect(real.outcome).toBe('attested');
    expect(newestAlwaysWins().outcome).not.toBe(real.outcome);
  });

  it('a never-install implementation would break the empty-row case', () => {
    const real = classifySettledCompletionEvidence({
      by: AGENT,
      terminalOwner: 'watchdog-auto-close',
      terminalCompletionRef: null,
      completionAuthority: null,
      storedEvidence: null,
      incomingEvidence: RICH,
    });
    expect(real.install).toBe(true);
    expect(neverInstalls().install).not.toBe(real.install);
  });
});
