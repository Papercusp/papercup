/**
 * P-007 (owner-visibility-provenance-2026-08-11) — the WIRING guard for the
 * live-drive acceptance warning.
 *
 * ── WHY THIS FILE EXISTS, GIVEN THE PREDICATE IS ALREADY TESTED ────────────
 * `owner-visible-surface-acceptance.test.ts` proves the PREDICATE (18 tests:
 * when it fires, when it stays silent, how it matches paths). It cannot prove
 * that anything CALLS it. Those are different failures, and the second one is
 * the one this plan exists to prevent: a registry + a carefully-worded message
 * that no code path invokes is dead code that reads, from every surface an
 * agent looks at, exactly like a shipped gate. The predicate suite stays green
 * the entire time.
 *
 * That is not hypothetical here — the wiring sat unlanded behind a file lock
 * for ~4.5h while the module and its 18 green tests were already committed, so
 * "the acceptance gate is in" was true of the module and false of the product.
 *
 * ── HOW THIS FILE PROVES ITSELF ────────────────────────────────────────────
 * It asserts the seam in BOTH directions: the symbol must be imported from the
 * registry module (not re-implemented locally, which would silently fork the
 * message and the accepted-verification list), AND it must reach the returned
 * result object. A stub that satisfies one half fails the other. The final
 * case pins the invariant the whole gate rests on, so widening the accepted
 * list to include 'unit' — the one change that would quietly neuter this —
 * fails here rather than passing review as a one-word diff.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import * as nodePath from 'node:path';

import { LIVE_DRIVE_ACCEPTED_VERIFICATIONS } from '../../turn-provenance/owner-visible-surface-acceptance';

const COMPLETE_TS = nodePath.join(__dirname, 'complete.ts');
const source = readFileSync(COMPLETE_TS, 'utf8');

describe('complete.ts WIRES the live-drive acceptance warning (P-007)', () => {
  it('imports the gap + message helpers from the registry module, rather than re-deriving them', () => {
    // Re-implementing either locally would fork the message and the accepted
    // list away from the registry, which is the single definition P-005/P-007
    // exist to establish.
    expect(source).toContain('liveDriveAcceptanceGap');
    expect(source).toContain('liveDriveAcceptanceMessage');
    expect(source).toMatch(
      /from\s+'\.\.\/\.\.\/turn-provenance\/owner-visible-surface-acceptance'/,
    );
  });

  it('computes the warning from the SAME evidence extraction as every sibling check', () => {
    // completionEvidenceForGate is the one extraction all the other warnings
    // read, so computing off anything else would let this check disagree with
    // what the caller actually supplied.
    expect(source).toMatch(/liveDriveAcceptanceGap\(\s*completionEvidenceForGate\s*\)/);
  });

  it('returns liveDriveEvidenceWarning on the result object, so the caller actually sees it', () => {
    // A computed-but-unreturned warning is the exact dead-code shape this
    // guard exists to catch: every unit test still passes.
    expect(source).toMatch(
      /\.\.\.\(liveDriveEvidenceWarning\s*\?\s*\{\s*liveDriveEvidenceWarning\s*\}\s*:\s*\{\}\)/,
    );
  });

  it('does NOT hard-reject — complete.ts records-and-warns by contract (D-005 / EI-24)', () => {
    // The refusing tier is setWorkItemState's completion-integrity gate, which
    // preserves the evidence and refuses only the terminal flip. Throwing here
    // would LOSE the completion, violating this file's whole contract.
    const wiring = source.slice(source.indexOf('const liveDriveGap'));
    const block = wiring.slice(0, wiring.indexOf('\n\n'));
    expect(block).not.toMatch(/throw\b/);
  });
});

describe('the invariant the gate rests on', () => {
  it("does not accept 'unit' as a live-drive verification", () => {
    // On this surface a unit fixture asserts against text the author invented,
    // so code and fixture share the author's blind spot. Accepting 'unit' here
    // would make the gate unfalsifiable while still appearing to be enforced.
    expect(LIVE_DRIVE_ACCEPTED_VERIFICATIONS).not.toContain('unit');
    expect(LIVE_DRIVE_ACCEPTED_VERIFICATIONS).not.toContain('already-passing');
  });
});
