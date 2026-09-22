/**
 * live-federation-gate-certified-source-window.test.ts — regression guard for WI-10002288.
 *
 * THE BUG: the exact-SHA certification claim is "the build consumed the bytes of
 * $GATE_CERTIFICATION_TARGET_SHA and nothing else". Until 2026-09-21 the gate tried to prove
 * that by measuring the source tree's cleanliness in §4, at VERDICT time — on the far side of
 * the multi-hour content-matrix / from-repo / local-matrix legs:
 *
 *   GATE_TERMINAL_DIRTY_FILES="$(cd "$DESKTOP_DIR/.." && git status --porcelain | wc -l)"   # §4
 *   [ "$GATE_TERMINAL_DIRTY_FILES" = 0 ] || REDS+=("certification-source-dirty-at-verdict")
 *
 * `$DESKTOP_DIR/..` is the canonical SHARED superproject checkout — edited continuously by ~100
 * agents and swept by git-sync on a schedule. So P(clean AND HEAD unmoved at an arbitrary
 * instant HOURS after the build) → 0, and exact-SHA certification became impossible by
 * CONSTRUCTION rather than by any regression: a peer's unrelated edit landing during the test
 * tail manufactured a permanent deploy wall.
 *
 * TYPE SPECIMEN: of the 6 banked verdicts for green pin 844e9d43f5f2, three carried ONLY
 * `certification-source-dirty-at-verdict` while every real leg PASSED (content-matrix=PASS-971,
 * from-repo=PASS).
 *
 * THE FIX: close the CERTIFIED-SOURCE WINDOW at BUILD END (§2z) instead. The window that
 * matters is bracketed by the two instants at which the build actually READS the tree — build
 * start (already enforced, and it `exit 1`s) and build end. After §2 nothing re-reads the
 * source, so nothing measured later is evidence about the certified artifact. Verdict-time
 * values are still taken and banked, as `postlegs_*`, but are DIAGNOSTIC ONLY.
 *
 * WHY A GUARD AND NOT JUST THE FIX: the defect is a one-line re-pointing away. Any future edit
 * that moves a GATE_TERMINAL_* measurement back below the smoke legs, or gates a certification
 * RED on a postlegs value, silently restores a permanent deploy wall that looks exactly like a
 * real regression. That is the class this pins shut.
 *
 * STATIC leg: pins WHERE the certified-source window closes (before the smokes) and WHICH
 * values the certification REDs are allowed to read.
 * BEHAVIORAL leg: evals the REAL bank_verdict out of the shipping script with GATE_POSTLEGS_*
 * deliberately UNSET, proving the record stays parseable JSON. This is an earned guard: the
 * first cut of the WI-10002288 fix referenced "$GATE_POSTLEGS_HEAD" bare in bank_verdict, and
 * under the script's own `set -uo pipefail` that aborted with `unbound variable` for every
 * caller that sources the helpers standalone.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

function repoRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 12; i++) {
    if (existsSync(join(dir, 'papercusp-desktop', 'bin', 'live-federation-gate.sh'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(
    'could not locate the repo root (no papercusp-desktop/bin/live-federation-gate.sh above this test)',
  );
}

const ROOT = repoRoot();
// PROBE_SCRIPT lets scripts/mutation-probe.sh point this suite at a MUTATED COPY outside the
// tree (tier 2), so proving the guard falsifiable never dirties the shared checkout — the
// sweep race that committed a mutant in EI-19450431506682666.
const GATE_PATH =
  process.env.PROBE_SCRIPT || join(ROOT, 'papercusp-desktop', 'bin', 'live-federation-gate.sh');
const gate = readFileSync(GATE_PATH, 'utf8');
const lines = gate.split('\n');

/** 1-based line number of the first line matching `re`, or -1. */
function lineOf(re: RegExp): number {
  const i = lines.findIndex((l) => re.test(l));
  return i === -1 ? -1 : i + 1;
}

/** Every 1-based line number carrying a top-level assignment to `VAR=`. */
function assignmentsTo(varPrefix: string): number[] {
  const re = new RegExp(`^\\s*${varPrefix}[A-Z_]*=`);
  const out: number[] = [];
  lines.forEach((l, i) => {
    if (re.test(l)) out.push(i + 1);
  });
  return out;
}

describe('live-federation gate: the certified-source window closes at BUILD END', () => {
  // ── STATIC leg ──────────────────────────────────────────────────────────────
  it('anchors the sections this guard reasons about (fails loudly if the script is restructured)', () => {
    // A positive control for the whole static leg: every ordering assertion below is only
    // meaningful if these anchors resolve. Without this, a rename would make the ordering
    // checks vacuously pass on -1 < -1 comparisons.
    expect(lineOf(/^# ── 2z\. close the CERTIFIED-SOURCE WINDOW/), '§2z anchor').toBeGreaterThan(0);
    expect(lineOf(/^# ── 3\. run the smokes/), '§3 anchor').toBeGreaterThan(0);
    expect(lineOf(/^# ── 4\. verdict/), '§4 anchor').toBeGreaterThan(0);
    expect(assignmentsTo('GATE_TERMINAL_').length, 'GATE_TERMINAL_* assignments').toBeGreaterThan(
      0,
    );
  });

  it('measures GATE_TERMINAL_* at build end — BEFORE the smoke legs, never after', () => {
    const smokes = lineOf(/^# ── 3\. run the smokes/);
    const windowClose = lineOf(/^# ── 2z\. close the CERTIFIED-SOURCE WINDOW/);
    expect(windowClose).toBeLessThan(smokes);

    // The defaults block near the top is fine (it only supplies `:-` fallbacks). Every REAL
    // measurement must sit in §2z, i.e. between the window-close header and the smokes.
    const measurements = assignmentsTo('GATE_TERMINAL_').filter((n) => n > windowClose);
    expect(measurements.length, 'GATE_TERMINAL_* must be measured in §2z').toBeGreaterThan(0);

    // THE REGRESSION: a GATE_TERMINAL_* assignment below the smoke legs is the pre-fix defect
    // verbatim — it re-points certification at a tree that ~100 agents have been editing for
    // hours. Historical check: this assertion fails on the pre-2026-09-21 source.
    const afterLegs = measurements.filter((n) => n > smokes);
    expect(
      afterLegs,
      `GATE_TERMINAL_* re-measured AFTER the smoke legs (lines ${afterLegs.join(', ')}) — that is ` +
        'WI-10002288: certification would again be decided on fleet churn, not on the certified ' +
        'artifact. Measure it in §2z at build end; bank verdict-time values as postlegs_* instead.',
    ).toEqual([]);
  });

  it('never gates a certification RED on a postlegs (verdict-time) value', () => {
    const redLines = lines.filter((l) => /REDS\+=\(/.test(l));
    expect(redLines.length, 'no REDS+= lines found — extraction is broken').toBeGreaterThan(0);

    // postlegs_* is diagnostic. The moment a RED reads one, the permanent-wall class is back,
    // regardless of where the measurement itself lives.
    const offenders = redLines.filter((l) => /POSTLEGS/.test(l));
    expect(
      offenders,
      'a certification RED is gated on a GATE_POSTLEGS_* value — those are verdict-time ' +
        'diagnostics about fleet activity, never evidence about the certified artifact (WI-10002288)',
    ).toEqual([]);
  });

  it('keeps the four certification REDs reading build-end/source values', () => {
    // Guards the fix from the other direction: the REDs must still EXIST. Deleting them would
    // also make the test above pass, while silently dropping torn-tree detection entirely.
    const certReds = lines.filter((l) => /REDS\+=\("certification-/.test(l));
    expect(certReds.length, 'the certification REDs vanished').toBe(4);

    const src = certReds.join('\n');
    expect(src).toMatch(/certification-source-not-rebuilt/);
    expect(src).toMatch(/certification-source-head-moved/);
    expect(src).toMatch(/certification-desktop-head-moved/);
    // Renamed with the fix: the token now states WHEN it was measured, so a banked verdict is
    // self-describing rather than silently meaning something different than it used to.
    expect(src).toMatch(/certification-source-dirty-at-build-end/);
    expect(
      src,
      'the old verdict-time token is back on a live RED — see WI-10002288',
    ).not.toMatch(/certification-source-dirty-at-verdict/);
  });

  // ── BEHAVIORAL leg ──────────────────────────────────────────────────────────
  it('banks parseable JSON when GATE_POSTLEGS_* is unset (the set -u / unbound-variable trap)', () => {
    // Evals the REAL helpers out of the shipping script, so this cannot drift from what ships.
    const helpers = gate.match(/^__json_str\(\) \{[\s\S]*?^verdict\(\) \{.*\}$/m)?.[0];
    expect(helpers, 'could not extract the banking helpers from the gate source').toBeTruthy();

    const dir = mkdtempSync(join(tmpdir(), 'lfg-certwindow-'));
    const harness = [
      // The shipping script's own options. `set -u` is the whole point of this case.
      'set -uo pipefail',
      'log() { :; }',
      'now_s() { date +%s; }',
      `STATE_DIR=${JSON.stringify(dir)}`,
      `DESKTOP_DIR=${JSON.stringify(join(ROOT, 'papercusp-desktop'))}`,
      'WORK=/tmp/fake-work',
      'GATE_VERDICT_LOG="$STATE_DIR/verdicts.jsonl"',
      'GATE_VERDICT_KEEP=5',
      'GATE_VERDICT_SCHEMA_VERSION=2',
      'GATE_SUCCESS_TTL_H=22',
      'GATE_SOURCE_MODE=rebuilt',
      'GATE_SOURCE_HEAD=0123456789ab',
      'GATE_SOURCE_DESKTOP_HEAD=abcdef012345',
      'GATE_SOURCE_DIRTY_FILES=0',
      'GATE_TERMINAL_HEAD=0123456789ab',
      'GATE_TERMINAL_DESKTOP_HEAD=abcdef012345',
      'GATE_TERMINAL_DIRTY_FILES=0',
      'GATE_CERTIFICATION_TARGET_SHA=0123456789abcdef0123456789abcdef01234567',
      // ── deliberately NOT set: GATE_POSTLEGS_HEAD / _DESKTOP_HEAD / _DIRTY_FILES ──
      // This models every caller that reaches bank_verdict without passing through §4:
      // an early-exit path, and the sibling guard harnesses that source the helpers
      // standalone and know nothing about fields added later.
      helpers!,
      'SUMMARY="content-matrix=PASS"',
      'verdict "GATE: GREEN — certified-source window probe" >/dev/null',
    ].join('\n');

    const harnessPath = join(dir, 'harness.sh');
    writeFileSync(harnessPath, harness);
    const r = spawnSync('bash', [harnessPath], { encoding: 'utf8', timeout: 60_000 });
    expect(
      r.status,
      `bank_verdict aborted with GATE_POSTLEGS_* unset — under the script's own \`set -u\` a bare ` +
        `"$GATE_POSTLEGS_*" is an unbound variable. Default at the POINT OF USE inside ` +
        `bank_verdict, not only in the top-level defaults block.\n${r.stderr}`,
    ).toBe(0);

    const raw = readFileSync(join(dir, 'verdicts.jsonl'), 'utf8').trim().split('\n');
    expect(raw).toHaveLength(1);
    // The parse is the real parity check on bank_verdict's printf: a specifier/argument
    // mismatch, or an unquoted numeric field emitted empty, produces `"postlegs_dirty_files":,`
    // and invalidates the ENTIRE record rather than just the one field.
    expect(() => JSON.parse(raw[0]!)).not.toThrow();
    const rec = JSON.parse(raw[0]!) as Record<string, unknown>;

    // The certified values survive untouched...
    expect(rec).toMatchObject({
      verdict: 'GREEN',
      source_dirty_files: 0,
      terminal_dirty_files: 0,
      certification_target_sha: '0123456789abcdef0123456789abcdef01234567',
    });
    // ...and the diagnostics degrade to their sentinels rather than corrupting the record.
    expect(rec).toMatchObject({
      postlegs_head: 'unknown',
      postlegs_desktop_head: 'unknown',
      postlegs_dirty_files: -1,
    });
    // -1 is the "not measured" sentinel, and it must stay NUMERIC: the field is unquoted in
    // the format string, so a non-numeric value is unparseable JSON, not just a wrong value.
    expect(typeof rec.postlegs_dirty_files).toBe('number');
  }, 60_000);
});
