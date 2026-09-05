/**
 * EI-20264587083609474 — claim-time freshness must cover `change`, and its policy
 * must live in ONE place.
 *
 * ## What was wrong
 *
 * The freshness lane has THREE enforcement points that have to agree:
 *   STAMP   — `issues-engineer.createIssue` writes `payload.freshnessEnvelope`.
 *   SCORE   — `scheduler:get_next` scores that envelope into a claim-time verdict.
 *   MEASURE — `scheduler:get_next` computes the source-generation signal that the
 *             SCORE site re-scores the verdict with.
 *
 * Each carried its own hand-written `kind === 'bug'` literal. Copies of one
 * policy can only ever be half-changed, and the failure is silent in the
 * direction that matters: a `change` claimant simply receives no `freshness` key
 * at all, which is indistinguishable from "this item is fresh".
 *
 * ## The third site, and why this docblock used to say "two" (WI-2145579)
 *
 * The original fix unified STAMP and SCORE and then asserted, here, that the lane
 * had two enforcement points. It has three, and the MEASURE site was left on its
 * literal — so the gate went from fully-bug-only to two-thirds-changed, which
 * fails in a NEW and quieter way: a `change` claim now gets a `freshness` key from
 * SCORE whose only item-specific axis is permanently unmeasured, because the
 * signal feeding the re-score is never computed for it. A verdict that looks
 * measured and is not is worse than an absent one.
 *
 * The lesson is about the GUARD, not just the gate: a source guard that names its
 * own population is only as good as that census. This one asserted two sites
 * because its author had found two, and a third that it never looked for could
 * not fail it. Hence the assertions below are written to pin every site AND to
 * reject the bare literal anywhere in the READ file, so a fourth copy introduced
 * later fails here instead of being silently outside the guard's stated scope.
 *
 * Measured on the filing item itself: claiming EI-20264587083609474 (kind
 * `change`) returned a result with ZERO freshness fields — verified with a
 * positive control on the same payload, so the absence was real and not a
 * truncated read. Of the two already-built items its filer cited as motivation,
 * EI-19932168784507536 was a `bug` and EI-19313376980892266 was a `change`, so
 * the bug-only gate skipped half of its own evidence.
 *
 * ## Why a source guard and not only a unit test
 *
 * The truth table below cannot fail if a future editor re-inlines a literal at
 * either call site — the predicate would still be correct and simply unused.
 * The defect is DRIFT BETWEEN TWO SITES, so the guard has to assert the sites
 * actually consult the shared predicate. Both assertions below fail against the
 * pre-fix source, which is what makes this falsifiable rather than decorative.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { FRESHNESS_TRACKED_KINDS, isFreshnessTrackedKind } from './work-item-claim-freshness';

const read = (rel: string): string => readFileSync(new URL(rel, import.meta.url), 'utf8');

/**
 * Drop block and line comments so a literal quoted in PROSE cannot be mistaken for
 * a literal in CODE. Both sites' history comments quote the pre-fix
 * `kind === 'bug'` verbatim, so without this the guard would fail on its own
 * explanation. The `[^:]` guard keeps `https://` in a string from being eaten;
 * the assertions calibrate this both ways rather than trusting it.
 */
const stripComments = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

const GET_NEXT = './agent-tools/scheduler/get_next.ts';
const ISSUES_ENGINEER = './issues-engineer.ts';

describe('freshness kind gate', () => {
  it('tracks bug and change, and deliberately excludes non-code kinds', () => {
    expect(isFreshnessTrackedKind('bug')).toBe(true);
    expect(isFreshnessTrackedKind('change')).toBe(true);

    // `task` is documented as non-code work. The scorer's only item-specific axis
    // is source movement over the item's own paths, so a task could only ever
    // receive a verdict driven by unmeasured defaults — a signal that fires
    // identically on every row is what drains the lane of meaning.
    expect(isFreshnessTrackedKind('task')).toBe(false);
    expect(isFreshnessTrackedKind('feature')).toBe(false);
    expect(isFreshnessTrackedKind(null)).toBe(false);
    expect(isFreshnessTrackedKind(undefined)).toBe(false);
    expect(isFreshnessTrackedKind('')).toBe(false);

    expect([...FRESHNESS_TRACKED_KINDS].sort()).toEqual(['bug', 'change']);
  });

  it('has all THREE enforcement points consult the shared predicate, not a local literal', () => {
    const getNext = read(GET_NEXT);
    const issuesEngineer = read(ISSUES_ENGINEER);

    // Calibration: a mis-resolved path would read '' and make every absence
    // assertion below pass vacuously. Prove we are looking at the real files.
    expect(getNext.length).toBeGreaterThan(10_000);
    expect(issuesEngineer.length).toBeGreaterThan(10_000);
    expect(getNext).toContain('assessClaimFreshness');
    expect(issuesEngineer).toContain('createBugFreshnessEnvelope');

    // Both fixes deliberately QUOTE the pre-fix literal in their own history
    // comments, so the absence assertions have to run against code alone —
    // otherwise the explanation of the bug would read as the bug.
    const getNextCode = stripComments(getNext);
    const issuesEngineerCode = stripComments(issuesEngineer);

    // Calibration for the stripper itself, in BOTH directions — a stripper that
    // returned '' would make every absence assertion below pass vacuously, and one
    // that stripped nothing would trip them on prose. `EI-22283949842250645` is a
    // comment-only marker in get_next.ts (it tags the source-axis work), so it must
    // vanish; the code markers must survive. Keyed to a stable id rather than to the
    // wording of any one comment, so rephrasing a comment cannot break this.
    expect(getNext).toContain('EI-22283949842250645');
    expect(getNextCode).not.toContain('EI-22283949842250645');
    expect(getNextCode).toContain('assessClaimFreshness');
    expect(issuesEngineerCode).toContain('createBugFreshnessEnvelope');

    // SCORE (get_next), MEASURE (get_next), STAMP (createIssue).
    expect(getNextCode).toContain('isFreshnessTrackedKind(wi.kind)');
    expect(getNextCode).toContain('isFreshnessTrackedKind(wi?.kind)');
    expect(issuesEngineerCode).toContain('isFreshnessTrackedKind(storageKind)');

    // No bare literal survives in CODE at any site. Stated as a whole-file
    // absence rather than three exact pre-fix strings on purpose: the previous
    // version of this guard pinned the two copies its author had found, so the
    // third could not fail it. A fourth introduced later fails here.
    expect(getNextCode).not.toMatch(/kind === 'bug'/);
    expect(issuesEngineerCode).not.toMatch(/storageKind === 'bug'/);
  });
});
