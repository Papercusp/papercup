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
// @ts-ignore — pure JS guard script, no .d.ts; imported for its predicate only.
import {
  BASELINE,
  stripComments,
  usesRawInstallSlugFilter,
} from '../../../scripts/check-no-raw-install-slug-filter.mjs';

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
    expect(BASELINE.size).toBeLessThanOrEqual(9);
  });
});
