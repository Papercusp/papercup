/**
 * EI-10951 — code:run's post-failure warning must say something TRUE.
 *
 * The bug, observed twice in one session (2026-07-13): `plannedMutations` is recorded at
 * DISPATCH time, so a write-effect call REJECTED on its args (invalid_input) was still
 * counted as "already executed". A script whose last call had a bad argument came back with
 *
 *   "1 write-effect call(s) already executed before this failure (work_items:create×1) —
 *    do NOT blindly re-run the whole script; check what actually landed before retrying,
 *    to avoid a double-write."
 *
 * …when NOTHING had landed. The agent then spent a round-trip verifying a write that never
 * happened. And a warning that is wrong on the most common failure (a typo'd arg) trains
 * agents to skim past it in the rare case it is RIGHT — a genuinely partial batch, which is
 * the entire reason it exists.
 */
import { describe, expect, it } from 'vitest';
import { buildFailureWarning } from './run';

const m = (tool: string) => ({ tool });

describe('buildFailureWarning (EI-10951)', () => {
  it('a single REJECTED write reports that NOTHING landed — the exact false alarm that caused this', () => {
    const w = buildFailureWarning([m('work_items:create')], [m('work_items:create')], []);
    expect(w.warning).toMatch(/REJECTED before execution/);
    expect(w.warning).toMatch(/NOTHING was written/);
    expect(w.warning).toMatch(/No double-write risk/);
    // The old text must not survive: it is the lie.
    expect(w.warning).not.toMatch(/already executed/i);
    expect(w.warning).not.toMatch(/do NOT blindly re-run/i);
  });

  it('a write that LANDED before the failure still gets the loud double-write warning, verbatim as before', () => {
    // 2 dispatched, 0 threw ⇒ both landed, then the script itself failed (e.g. a timeout).
    // This case's SEMANTICS are unchanged, so its wording is unchanged too (WI-1377/EI-7174).
    const w = buildFailureWarning([m('coord:send'), m('work_items:claim')], [], []);
    expect(w.warning).toMatch(/2 write-effect call\(s\) already executed before this failure/);
    expect(w.warning).toMatch(/coord:send×1, work_items:claim×1/);
    expect(w.warning).toMatch(/do NOT blindly re-run/);
  });

  it('a write that threw MID-FLIGHT is honestly reported as MAY have landed', () => {
    const w = buildFailureWarning([m('work_items:complete')], [], [m('work_items:complete')]);
    expect(w.warning).toMatch(/MAY have landed/);
    expect(w.warning).toMatch(/do NOT blindly re-run/);
  });

  it('separates what landed from what was rejected in a mixed batch', () => {
    // 3 dispatched: 2 landed, 1 rejected on its args.
    const w = buildFailureWarning(
      [m('coord:send'), m('work_items:link'), m('work_items:create')],
      [m('work_items:create')],
      [],
    );
    expect(w.warning).toMatch(/2 write-effect call\(s\) already executed before this failure/);
    // …and the tally names the tools that ACTUALLY landed — not the one that was rejected.
    expect(w.warning).toMatch(/coord:send×1, work_items:link×1/);
    expect(w.warning).not.toMatch(/work_items:create×1/);
    expect(w.warning).toMatch(/1 further call\(s\) were rejected before execution and wrote nothing/);
  });

  it('a failure with no write-effect calls at all warns about nothing', () => {
    expect(buildFailureWarning([], [], [])).toEqual({});
  });

  it('a read-only script that failed produces no double-write scare', () => {
    // The common case: the script threw in pure-read code. Nothing to warn about.
    expect(buildFailureWarning([], [], []).warning).toBeUndefined();
  });

  // EI-18717906460509995: a rejected/thrown write aborts every call written AFTER it in the
  // SAME script — the ordering hazard the reporter hit (a facts:assert rejection stranded an
  // unreached work_items:checkpoint). The failure warning now teaches the mitigation (durable
  // writes FIRST) at the exact moment it would have helped, not just in the tool's static docs.
  it('a rejected-only failure includes the ordering hint', () => {
    const w = buildFailureWarning([m('facts:assert')], [m('facts:assert')], []);
    expect(w.warning).toMatch(/Ordering tip/);
    expect(w.warning).toMatch(/aborts every call written AFTER it/);
    expect(w.warning).toMatch(/work_items:checkpoint/);
  });

  it('a mixed landed+rejected failure includes the ordering hint', () => {
    const w = buildFailureWarning(
      [m('coord:send'), m('work_items:create')],
      [m('work_items:create')],
      [],
    );
    expect(w.warning).toMatch(/Ordering tip/);
  });

  it('an uncertain (threw mid-flight) failure includes the ordering hint', () => {
    const w = buildFailureWarning([m('work_items:complete')], [], [m('work_items:complete')]);
    expect(w.warning).toMatch(/Ordering tip/);
  });

  it('a pure landed-then-script-failed case (no rejected/uncertain) omits the ordering hint — nothing was aborted mid-script', () => {
    const w = buildFailureWarning([m('coord:send'), m('work_items:claim')], [], []);
    expect(w.warning).not.toMatch(/Ordering tip/);
  });
});
