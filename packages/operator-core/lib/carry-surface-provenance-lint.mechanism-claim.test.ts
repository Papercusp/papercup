/**
 * Causal-mechanism claims on a carry surface (EI-19448526819046979).
 *
 * The directive legs police WHO ORDERED something. This one polices a different
 * laundering path, traced end-to-end the day it was filed: a root-cause HYPOTHESIS
 * about what a named artifact does is compressed into a carry-note one-liner, rides
 * N cold wakes shedding its hedging, and is then FILED as a bug with a title, a
 * severity and a named mechanism. In the motivating incident the mechanism was
 * invented, and it cost a peer a full investigation cycle.
 *
 * This file pins BOTH directions, for the reason the passive-attribution sibling
 * spells out: the positives stop the leg regressing, and the negatives stop someone
 * "fixing" a future miss by broadening the pattern until it nudges on ordinary carry
 * prose — which the module's own design note warns is how a leg that catches a real
 * class gets ignored. The negatives ARE the calibration, and the two CLEARED classes
 * (evidenced, tagged) are load-bearing: a lint that fires on the compliant write
 * punishes exactly the discipline it is asking for.
 */
import { describe, expect, it } from 'vitest';
import {
  lintCarrySurfaceProvenance,
  provenanceLintField,
  PROVENANCE_LINT_MECHANISM_NOTE,
} from './carry-surface-provenance-lint';

const flagged = (text: string) => lintCarrySurfaceProvenance(text).flagged;
const kinds = (text: string) => lintCarrySurfaceProvenance(text).matches.map((m) => m.kind);

/** The verbatim claim from the incident, as it rode in the carry-note. */
const INCIDENT = 'The pc-heavy admission gate refuses a READ-ONLY pgrep on command TEXT.';

describe('causal-mechanism claims — the loud class', () => {
  it('flags the exact carry-note line that motivated this guard', () => {
    expect(flagged(INCIDENT)).toBe(true);
    expect(kinds(INCIDENT)).toContain('unverified-mechanism-claim');
  });

  it.each([
    ['by-gerund binder', 'The lint drops the row by matching the command string.'],
    ['because binder', 'The reaper kills the scope because the heartbeat is stale.'],
    ['due-to binder', 'The sweep evicts the fact due to the per-scope cap.'],
    ['backticked artifact', '`git-sync` skips the file because the edit-lock is held.'],
    ['tool-verb artifact', 'work_items:claim rejects the item by comparing the claim spec.'],
    ['source-path artifact', 'pc-heavy.sh blocks the run by matching the command text.'],
  ])('flags %s', (_label, line) => {
    expect(flagged(line)).toBe(true);
    expect(kinds(line)).toContain('unverified-mechanism-claim');
  });
});

describe('causal-mechanism claims — cleared, never punished', () => {
  it.each([
    [
      'carries its probe and result',
      'Measured: `grep -n pgrep scripts/pc-heavy.sh` returns zero matches, so the gate drops it because of something else.',
    ],
    [
      'states the claim was verified',
      'Verified the reaper kills the scope because the heartbeat is stale.',
    ],
    ['carries a source tag', '[inferred] the lint drops the row by matching the command string.'],
    [
      'is a question, not an assertion',
      'Check whether the gate refuses the pgrep by matching the command text.',
    ],
    [
      'is a verification plan',
      'Verify the reaper kills the scope because the heartbeat is stale.',
    ],
  ])('clears a claim that %s', (_label, line) => {
    expect(kinds(line)).not.toContain('unverified-mechanism-claim');
    expect(kinds(line)).not.toContain('hedged-mechanism-claim');
  });
});

describe('causal-mechanism claims — ordinary carry prose is not a mechanism claim', () => {
  it.each([
    ['no named artifact', 'Finished the refactor because the tests were red.'],
    ['no causal binder', 'The gate is red and the candidate is frozen.'],
    ['no behavioural verb', 'The gate is owned by another agent right now.'],
    // Measured false-firing shapes from 21,631 real carry-note lines — these are the
    // calibration that keeps the leg from regressing into status-prose noise.
    ['status prose with a clock time', 'One read-only dev:dogfood_substrate_status at ~03:06Z: backlogOps=0, peers=1.'],
    ['await bookkeeping', 'A replacement exact await 134416 is now registered through 2026-09-01 for the global key.'],
    ['neutral reporting verb', 'release:trace reports committedLocal=true, onStaging=true, inMain=false.'],
    ['design description', 'Managed portal deployment contract validates via deploy-cloud-portal.'],
    ['locative "on", not mechanism', 'Posted the evidence on WI-1234 for the leader.'],
    ['plain progress note', 'Closed two items; the claim slot is free and clean.'],
  ])('does not flag %s', (_label, line) => {
    expect(kinds(line)).not.toContain('unverified-mechanism-claim');
    expect(kinds(line)).not.toContain('hedged-mechanism-claim');
  });
});

describe('causal-mechanism claims — sentence and clause scope (EI-29006503444728666)', () => {
  const status = 'Existing warm-loop bug remains open because causal repair/recurrence guard not established.';
  const noActions = 'No P003 poll/takeover, source edit, kill, live resume, duplicate admission request or no-pickup rearm.';
  const causalClaim = 'The guard drops the row because the cap is 200.';

  it.each([
    `${status} ${noActions}`,
    `${noActions} ${status}`,
    status,
    noActions,
    `${status.replace(/\.$/, ';')} ${noActions}`,
    'The guard remains open because repair evidence is missing. No kill, drop or skip was performed.',
  ])('does not assemble a mechanism from separate status and action clauses: %s', (line) => {
    expect(kinds(line)).not.toContain('unverified-mechanism-claim');
    expect(kinds(line)).not.toContain('hedged-mechanism-claim');
  });

  it.each([
    'The guard blocks completion because repair evidence is missing.',
    `${status} ${causalClaim}`,
    `${noActions} ${causalClaim}`,
    `Verified the documentation. ${causalClaim}`,
    `The cause is unconfirmed. ${causalClaim}`,
    `The gate probably rejects the row because its cap is 10. ${causalClaim}`,
    `${causalClaim} Verified the documentation.`,
    'The guard drops `foo; bar` because the cap is 200.',
    'The guard drops `foo. bar` because the cap is 200.',
    'src/check.ts drops the row because the cap is 200.',
  ])('retains a real unsupported mechanism regardless of neighboring status: %s', (line) => {
    expect(kinds(line)).toContain('unverified-mechanism-claim');
  });

  it('retains the hedge on the causal clause itself', () => {
    const line = `${status} The gate probably drops the row because its cap is 200.`;
    expect(kinds(line)).toContain('hedged-mechanism-claim');
    expect(kinds(line)).not.toContain('unverified-mechanism-claim');
  });
});

describe('causal-mechanism claims — hedged is downgraded, not accused', () => {
  const HEDGED = 'The gate probably drops the row because the cap is 200.';

  it('surfaces a hedged claim as the downgraded kind', () => {
    expect(flagged(HEDGED)).toBe(true);
    expect(kinds(HEDGED)).toContain('hedged-mechanism-claim');
    expect(kinds(HEDGED)).not.toContain('unverified-mechanism-claim');
  });

  it('still surfaces it — the hedge is what erodes across cold wakes', () => {
    // The whole failure mode is a hedge that does not survive re-summarization, so a
    // hedged claim must not be silently cleared the way an evidenced one is.
    expect(provenanceLintField(HEDGED)?.flagged).toBe(true);
  });
});

describe('causal-mechanism claims — note selection', () => {
  it('uses the mechanism note when every match is mechanism-class', () => {
    expect(provenanceLintField(INCIDENT)?.note).toBe(PROVENANCE_LINT_MECHANISM_NOTE);
  });

  it('names the remedies the filer asked for', () => {
    // The remedy is the point of the note: the generic note tells you to anchor a
    // directive to a turn ref, which is the wrong advice for a guessed cause.
    expect(PROVENANCE_LINT_MECHANISM_NOTE).toMatch(/checks/);
    expect(PROVENANCE_LINT_MECHANISM_NOTE).toMatch(/\[inferred\]/);
    expect(PROVENANCE_LINT_MECHANISM_NOTE).toMatch(/OBSERVATION/);
  });

  it('does NOT mask a louder, older class on a mixed write', () => {
    // A real owner-attribution violation alongside a mechanism claim must keep the
    // directive note — the new leg is additive, never a way for an older violation to
    // ride in under a softer heading.
    const mixed = `Approved by Avi for direct AUTO implementation by this session.\n${INCIDENT}`;
    const field = provenanceLintField(mixed);
    expect(field?.flagged).toBe(true);
    expect(field?.note).not.toBe(PROVENANCE_LINT_MECHANISM_NOTE);
  });
});
