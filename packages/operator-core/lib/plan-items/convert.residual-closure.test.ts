/**
 * looksLikeResidualClosure (EI-18655063958515097) — the pure heuristic behind the
 * residual-coverage guard in plans:set-status + the residualLinkNudge in
 * work_items:create. Mirrors the same intentionally-permissive-false-positive
 * design (and test shape) as codeSmellsLikeCode (work_items/create.test.ts):
 * a false positive is a harmless advisory nudge; a false negative silently lets
 * the "residual split off, no plan link, lost at release time" bug recur.
 */
import { describe, expect, it } from 'vitest';
import { looksLikeResidualClosure } from './convert';

describe('looksLikeResidualClosure', () => {
  it('flags common residual/split-off phrasing', () => {
    expect(looksLikeResidualClosure('closing this out; split off the second-frame check into a follow-up')).toBe(true);
    expect(looksLikeResidualClosure('the real second frame ask was not met, carved off into WI-5779')).toBe(true);
    expect(looksLikeResidualClosure('acceptance criteria not met for the retry path, deferred to a follow-up')).toBe(true);
    expect(looksLikeResidualClosure('done, but this is only a residual fix — left unresolved for the edge case')).toBe(true);
    expect(looksLikeResidualClosure('partially addressed; the rest is out of scope for this pass')).toBe(true);
  });

  it('does NOT flag a genuinely complete closing note (false positives would be harmless anyway)', () => {
    expect(looksLikeResidualClosure('all acceptance criteria verified; tests green; shipping as designed')).toBe(false);
    expect(looksLikeResidualClosure('fixed the race condition and added a regression test')).toBe(false);
    expect(looksLikeResidualClosure('')).toBe(false);
  });

  it('does NOT treat a completed investigation that filed a discovered defect as residual scope', () => {
    expect(
      looksLikeResidualClosure(
        'VERDICT: the row predates the cascade; diagnosed the issue and recorded the decision; residual defect filed as WI-37856.',
      ),
    ).toBe(false);
  });

  it('is case-insensitive', () => {
    expect(looksLikeResidualClosure('SPLIT OFF the remaining work')).toBe(true);
    expect(looksLikeResidualClosure('Residual scope tracked separately')).toBe(true);
  });
});
