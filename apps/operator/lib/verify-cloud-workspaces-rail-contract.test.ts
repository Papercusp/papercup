/**
 * Contract guard for scripts/verify-cloud-workspaces-rail.sh — the live
 * verification instrument for plan cloud-workspaces-guided-rail-2026-08-28.
 *
 * WHY THIS FILE EXISTS. The plan's acceptance rubric
 * (cloud-workspaces-guided-rail-acceptance, criterion
 * `verified-live-with-stated-coverage`) asks a GRADER to confirm several
 * properties of that script by reading it: that it emits a machine-readable
 * coverage line, that no assertion is an unguarded negative, and that the run
 * is read-only. Those are exactly the checks that rot when nobody re-reads the
 * script — so they are pinned here instead of re-asked of every future grader.
 *
 * The rubric originally declared the .sh itself as its `check.kind:'tests'`
 * file. That made the rubric permanently ungradeable: `scorecards:emit` routes
 * every rated criterion's declared files through the Vitest router, and the
 * router cannot report on a shell script (TEST_FILE_UNSUPPORTED_INPUT /
 * NON_TEST), so the emit refused unconditionally and the plan could never reach
 * `shipped`. The class fix — validating routability at propose time — is
 * WI-369566. This file is the local repair: a real Vitest suite the rubric can
 * point at, which pins the script's contract rather than merely naming it.
 *
 * KNOWN GAP, deliberately not asserted here: the `exercised` field is derived
 * from fixture preconditions (HOSTS/DRIFTING) rather than from assertions that
 * actually reported PASS, and the stronger `grep_pass()` derivation is defined
 * and never called. That is tracked as EI-21680639474041670. A test asserting
 * the current weak behaviour would cement it, so this file pins only the
 * properties that are genuinely contractual.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(__dirname, '../../..');
/* Overridable so falsifiability can be proven against a COPY outside the tree
   (scripts/mutation-probe.sh --file ... ), never by mutating this shared
   checkout: git-sync sweeps the whole tree every few minutes and would commit
   a probe's intermediate mutant even when nothing goes wrong. */
const SCRIPT = process.env.CW_RAIL_SCRIPT
  ? resolve(process.env.CW_RAIL_SCRIPT)
  : resolve(ROOT, 'scripts/verify-cloud-workspaces-rail.sh');
const src = readFileSync(SCRIPT, 'utf8');

/** The script with comment-only lines removed, so prose describing a behaviour
 *  is never mistaken for the behaviour itself. (`grep 'click'` over the raw
 *  source matches three COMMENTS promising the script does not click — the
 *  exact false positive this strips.) */
const code = src
  .split('\n')
  .filter((line) => !/^\s*#/.test(line))
  .join('\n');

describe('verify-cloud-workspaces-rail.sh — live-verification contract', () => {
  it('emits the CW_RAIL_RESULT coverage line with every field the rubric reads', () => {
    /* The rubric's method reads this line FIRST and refuses a pass on failed>0
       or unaccepted skips. If the format drifts, a grader silently loses the
       ability to tell a real verification from a green run that skipped
       everything — so pin the exact printf contract, not just the token. */
    expect(code).toContain(
      'CW_RAIL_RESULT passed=%d failed=%d skipped=%d hosts=%d drifting=%d exercised=%s',
    );

    /* Positive control for the instrument: the same source must NOT contain a
       format string we know was never written, or `toContain` passing above
       would prove nothing about how the file was read. */
    expect(code).not.toContain('CW_RAIL_RESULT ok=%d');
  });

  it('can name all three data-dependent assertions the rubric requires', () => {
    /* `exercised` is what makes the run evidence rather than ceremony: these
       three can only pass against real fixture data. The rubric refuses a pass
       when they are absent, so the vocabulary must exist in the emitter. */
    for (const token of [
      'landing-operate',
      'expanded-host-tabs',
      'drift-divergent-form',
    ]) {
      expect(code).toContain(token);
    }
  });

  it('uses no unguarded negative assertion', () => {
    /* An absence assertion on a half-loaded document is vacuously true. The
       rubric names this as a drift marker and asks the grader to grep for it. */
    expect(src).not.toContain('allow-unguarded-negative');
  });

  it('fuses the navigation nonce and a presence guard into one evaluation', () => {
    /* settle() is the only assertion primitive. Both halves must be in the SAME
       --eval: the nonce proves the navigation landed, --require proves the
       subject rendered. Split across two evaluations, a stale document can
       satisfy one while the other is measured on the next frame. */
    expect(code).toContain("location.href.indexOf('vnonce=");
    expect(code).toMatch(/--require\s+"\$req"/);
    expect(code).toMatch(/settle\(\)\s*\{/);
  });

  it('stays read-only: no lifecycle control is clicked and no form submitted', () => {
    /* The wrapper does NOT isolate the database by default, so a lifecycle
       click here really provisions, stops or destroys a live cloud host. This
       asserts against COMMENT-STRIPPED source, because the script's own header
       comments mention exactly these words while promising not to do them. */
    expect(code).not.toMatch(/\bclick\b/i);
    expect(code).not.toMatch(/\bsubmit\(/i);
  });

  it('fails the run when any assertion failed, and marks skips as unverified', () => {
    /* A skip is unverified coverage, not a pass. The script must say so rather
       than let `exit 0` be read as full coverage. */
    expect(code).toMatch(/if \[ "\$failures" -gt 0 \]/);
    expect(code).toContain('exit 1');
    expect(src).toContain('A skipped assertion is UNVERIFIED');
  });
});
