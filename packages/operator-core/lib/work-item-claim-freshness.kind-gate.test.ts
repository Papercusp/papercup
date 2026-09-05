/**
 * EI-20264587083609474 — claim-time freshness must cover `change`, and its policy
 * must live in ONE place.
 *
 * ## What was wrong
 *
 * The freshness lane has two enforcement points that have to agree:
 *   STAMP — `issues-engineer.createIssue` writes `payload.freshnessEnvelope`.
 *   READ  — `scheduler:get_next` scores that envelope into a claim-time verdict.
 *
 * Each carried its own hand-written `kind === 'bug'` literal. Two copies of one
 * policy can only ever be half-changed, and the failure is silent in the
 * direction that matters: a `change` claimant simply receives no `freshness` key
 * at all, which is indistinguishable from "this item is fresh".
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

  it('has both enforcement points consult the shared predicate, not a local literal', () => {
    const getNext = read(GET_NEXT);
    const issuesEngineer = read(ISSUES_ENGINEER);

    // Calibration: a mis-resolved path would read '' and make every absence
    // assertion below pass vacuously. Prove we are looking at the real files.
    expect(getNext.length).toBeGreaterThan(10_000);
    expect(issuesEngineer.length).toBeGreaterThan(10_000);
    expect(getNext).toContain('assessClaimFreshness');
    expect(issuesEngineer).toContain('createBugFreshnessEnvelope');

    // The READ site (scheduler:get_next) and the STAMP site (createIssue).
    expect(getNext).toContain('isFreshnessTrackedKind(wi.kind)');
    expect(issuesEngineer).toContain('isFreshnessTrackedKind(storageKind)');

    // The exact pre-fix literals must not come back.
    expect(getNext).not.toContain("if (wi.kind === 'bug')");
    expect(issuesEngineer).not.toContain("storageKind === 'bug' &&");
  });
});
