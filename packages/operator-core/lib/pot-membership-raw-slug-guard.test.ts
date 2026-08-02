/**
 * pot-membership-raw-slug-guard.test.ts — the raw-installSlug CI guard's detection
 * predicate (EI-19298972043721870).
 *
 * The guard (`scripts/check-no-raw-install-slug-filter.mjs`) runs green on the clean
 * tree, which only proves the no-false-positive direction. This locks the direction the
 * item actually asks for: that it FLAGS a NEW `harness_slug = ${installSlug}` read while
 * NOT flagging the resolved form (the fix), unrelated slug filters, or prose describing
 * the trap in a comment.
 *
 * Why this matters more than for a typical guard: the bug it catches is SILENT. A
 * re-homed row makes the filter match zero rows with no error, which for a detector is
 * indistinguishable from "everything is healthy" — it cost ~12 days of blind canary. A
 * guard whose teeth are never tested is the same failure mode one level up.
 */
import { describe, it, expect } from 'vitest';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — pure JS guard script, no .d.ts; imported for its predicate only. Kept on
// ONE line: @ts-ignore suppresses only the FOLLOWING line, and tsc reports an untyped-
// module error on the `from '...'` specifier, so a multi-line import escapes it.
// prettier-ignore
import { BASELINE, formatCleanVerdict, stripComments, usesRawInstallSlugFilter } from '../../../scripts/check-no-raw-install-slug-filter.mjs';

describe('raw-installSlug guard predicate (EI-19298972043721870)', () => {
  it('FLAGS a harness_slug filter on the raw installSlug', () => {
    expect(
      usesRawInstallSlugFilter('await sql`SELECT 1 FROM t WHERE harness_slug = ${installSlug}`'),
    ).toBe(true);
  });

  it('FLAGS it regardless of whitespace around the = and inside the interpolation', () => {
    expect(usesRawInstallSlugFilter('WHERE harness_slug=${installSlug}')).toBe(true);
    expect(usesRawInstallSlugFilter('WHERE harness_slug   =  ${ installSlug }')).toBe(true);
  });

  it('does NOT flag the FIXED form (a resolved storage slug)', () => {
    // The whole point of the guard is to push sites here, so a false positive on the
    // fix would make the guard un-satisfiable.
    expect(usesRawInstallSlugFilter('WHERE harness_slug = ${storageSlug}')).toBe(false);
    expect(
      usesRawInstallSlugFilter(
        'WHERE harness_slug = ${await routineStorageSlug(installSlug, workspaceId)}',
      ),
    ).toBe(false);
  });

  it('does NOT flag installSlug used for NON-row-addressing purposes', () => {
    // installSlug stays correct for self-gating, pause resolution, logs and watchdogKeys —
    // re-homing those would break alarm identity continuity.
    expect(usesRawInstallSlugFilter('if (routine.install_slug !== installSlug) return;')).toBe(
      false,
    );
    expect(usesRawInstallSlugFilter('const watchdogKey = `green-stall:${installSlug}`;')).toBe(
      false,
    );
    expect(usesRawInstallSlugFilter('console.log(`[canary] ${installSlug} tick`);')).toBe(false);
  });

  it('does NOT flag a different column compared to installSlug', () => {
    expect(usesRawInstallSlugFilter('WHERE install_slug = ${installSlug}')).toBe(false);
    expect(usesRawInstallSlugFilter('WHERE pot_home_slug = ${installSlug}')).toBe(false);
  });

  it('does NOT flag PROSE describing the trap in a comment', () => {
    // This file, the guard, and pot-membership.ts all describe the banned pattern in
    // their doc comments; flagging those would make documenting the trap impossible.
    expect(
      usesRawInstallSlugFilter('// a read that filters harness_slug = ${installSlug} matches zero rows'),
    ).toBe(false);
    expect(
      usesRawInstallSlugFilter('/**\n * WHERE harness_slug = ${installSlug} is the trap.\n */'),
    ).toBe(false);
  });

  it('still flags real code that sits next to a comment mentioning it', () => {
    const src = [
      '// Correct per EI-19298246923137692: harness_slug = ${installSlug} is the trap.',
      'await sql`DELETE FROM harness_shared.t WHERE harness_slug = ${installSlug}`;',
    ].join('\n');
    expect(usesRawInstallSlugFilter(src)).toBe(true);
  });

  it('stripComments removes block and line comments but keeps code', () => {
    expect(stripComments('/* x */ const a = 1; // y').trim()).toBe('const a = 1;');
  });

  it('the grandfather BASELINE is a RATCHET: it must only ever shrink', () => {
    // Not a style assertion. The guard exists because the failure is silent, so the
    // one way it can rot is by growing the grandfather set instead of fixing sites.
    // 9 files / 18 sites were pre-existing when the guard landed.
    //
    // ⚠ EQUALITY, NOT `<=` — deliberately, and this is the whole point of the test.
    //
    // A `<=` ceiling pinned at the ORIGINAL size stops ratcheting the moment the first
    // file graduates: it keeps passing while the set grows back toward it, so the
    // assertion reads as a live guard while silently admitting the exact regression its
    // own name forbids. That is not hypothetical — this assertion sat at 9 after the set
    // had already reached 7, i.e. carrying two graduations' worth of slack, and would
    // have stayed green through a full regression from 7 back to 9 (EI-19333067460319780).
    //
    // Equality removes the slack STRUCTURALLY rather than asking the next agent to
    // remember: a graduation now fails here until the count below is decremented in the
    // SAME edit, and a regression fails just as loudly. Failing on a shrink is the
    // feature, not a nuisance.
    //
    // History (append a line, never raise the number without a REASON):
    //   18 sites / 9 files — pre-existing when the guard landed
    //    9 → 7  2026-08-02 WI-6978 — green-stall-watchdog.ts and
    //           release-deploy-staleness-watchdog.ts graduated to ALLOWLIST on the
    //           audited "harness_escalations is not re-homed" relation verdict.
    expect(
      BASELINE.size,
      'BASELINE changed size. If you GRADUATED a file (audited its relation and moved it to ' +
        'ALLOWLIST, or converted it to routineStorageSlug), DECREMENT the expected count here ' +
        'in this same edit and add a history line above. If this grew, you added a grandfather ' +
        'instead of fixing a site — do NOT raise the number to make this pass.',
    ).toBe(7);
  });
});

/**
 * EI-19298378364087215. The guard asserts a repo-wide NEGATIVE, which an incomplete
 * enumeration cannot establish. In an archive-extracted release/checkpoint checkout
 * `git ls-files --recurse-submodules` descends into NO submodule, so the scan covers
 * the superproject alone — and the old clean line reported that as "✓ no NEW offenders".
 *
 * This is the bug class where "I could not tell" renders identically to "no": the
 * reader cannot distinguish a verified absence from an unasked question, and acts on
 * the failure as though it were the answer.
 */
describe('clean-path verdict never claims a pass it could not establish', () => {
  const whole = { scanned: 5664, grandfathered: 9, unscannedPresent: 0 };

  it('claims a clean pass ONLY when the enumeration was whole', () => {
    const line = formatCleanVerdict(whole);
    expect(line.startsWith('✓')).toBe(true);
    expect(line).toContain('5664 files scanned');
  });

  it('DOWNGRADES the verdict when submodules with files on disk went unread', () => {
    const line = formatCleanVerdict({ ...whole, unscannedPresent: 39 });
    // The load-bearing property: it must not read as a clean bill of health.
    expect(line.startsWith('✓')).toBe(false);
    expect(line).toContain('cannot establish');
    expect(line).toContain('39 submodule(s)');
  });

  it('says UNKNOWN in words, not merely by omitting the tick', () => {
    // A reader skimming for a verdict must be told, not left to infer it from a
    // missing character — that inference is exactly what nobody makes under load.
    const line = formatCleanVerdict({ ...whole, unscannedPresent: 39 });
    expect(line).toMatch(/UNKNOWN, not as a pass/);
  });

  it('keys on unscannedPresent, so the permanently-absent submodule cannot trip it', () => {
    // libs/zero-harness is retired and deliberately uninitialised, so it sits in
    // `unscanned` on EVERY run of a healthy tree. An alarm keyed on that fires always
    // and is trained away; this one must stay silent when the tree is fine.
    expect(formatCleanVerdict(whole).startsWith('✓')).toBe(true);
  });
});
