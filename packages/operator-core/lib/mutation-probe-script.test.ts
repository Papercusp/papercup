/**
 * Recurrence guard for EI-19450431506682666 — a mutation probe must never
 * leave the SHARED tree mutated.
 *
 * The incident: the hand-rolled idiom `cp bak; mutate; test; cp back` was run
 * as one foreground Bash call, hit the 2-min deadline partway through, and the
 * trailing restore never ran. git-sync then committed the mutant
 * (db6d7b02b1) — a version of scripts/verify-tauri-headless.sh in which the
 * fix's function was DEFINED but never CALLED. Inert, `bash -n`-clean, and
 * shaped exactly like a finished change.
 *
 * These tests pin the two properties that make `scripts/mutation-probe.sh`
 * safe, and they are written so that neither can pass on dead code:
 *
 *   - COPY-OUT never touches the tracked file (asserted by content identity,
 *     never by `git status` — on a swept tree a clean status means the sweep
 *     ran, not that the file is unmodified).
 *   - IN-TREE restores PROMPTLY on SIGTERM. The timing is the whole assertion:
 *     the pre-fix foreground form also restored eventually, just deferred
 *     until its child exited (measured: 23s), which is indistinguishable from
 *     "works" unless the deadline is pinned. Bash will not run a trap while
 *     waiting on a FOREGROUND child, and the harness follows SIGTERM with
 *     SIGKILL — so a deferred handler is frequently never a handler at all.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

/**
 * The subject under test, overridable by path. This is the tier-2 pattern the
 * script itself exists to enable: a guard that reads its subject from a
 * REDIRECTABLE path can be falsified against a mutated COPY, so proving this
 * suite is falsifiable never requires dirtying the tracked file. Without the
 * override the only way to falsify it would be an in-tree mutation — i.e. the
 * exact hazard EI-19450431506682666 was filed for.
 */
const SCRIPT = process.env.MUTATION_PROBE_SCRIPT ?? resolve(__dirname, '../../../scripts/mutation-probe.sh');
const ORIGINAL = 'alpha\nbeta\ngamma\n';

let dir: string;
let subject: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mutation-probe-test-'));
  subject = join(dir, 'subject.txt');
  writeFileSync(subject, ORIGINAL);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Run the probe to completion and return its exit code. */
function runProbe(args: string[]): number {
  const r = spawnSync('bash', [SCRIPT, ...args], { encoding: 'utf8', timeout: 60_000 });
  return r.status ?? -1;
}

/** Run the probe and return its exit code AND combined output (for asserting guidance text). */
function runProbeIO(args: string[]): { code: number; out: string } {
  const r = spawnSync('bash', [SCRIPT, ...args], { encoding: 'utf8', timeout: 60_000 });
  return { code: r.status ?? -1, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

const read = () => readFileSync(subject, 'utf8');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('mutation-probe.sh — copy-out mode (the default)', () => {
  it('leaves the subject file byte-identical while still exercising the guard', () => {
    const code = runProbe(['--file', subject, '--mutate', 's/beta/BETA/', '--test', 'grep -q "^beta$" {}']);
    // The guard fails on the mutant => the mutant was CAUGHT => probe exits 0.
    expect(code).toBe(0);
    expect(read()).toBe(ORIGINAL);
  });

  it('reports a WEAK guard (exit 1) when the mutant survives, rather than passing quietly', () => {
    // The guard only checks "beta", so mutating "gamma" must slip past it.
    const code = runProbe(['--file', subject, '--mutate', 's/gamma/GAMMA/', '--test', 'grep -q "^beta$" {}']);
    expect(code).toBe(1);
    expect(read()).toBe(ORIGINAL);
  });

  it('reports a baseline harness failure as an error, never as a caught mutant', () => {
    const { code, out } = runProbeIO([
      '--file',
      subject,
      '--mutate',
      's/beta/BETA/',
      '--test',
      "bash -c 'exit 2' {}",
    ]);
    expect(code).toBe(2);
    expect(out).toMatch(/BASELINE FAILED/i);
    expect(out).toMatch(/verdict=harness-error/);
    expect(out).not.toMatch(/MUTANT CAUGHT/);
    expect(read()).toBe(ORIGINAL);
  });

  it('reports a mutant harness crash as an error, not as falsifiability evidence', () => {
    const { code, out } = runProbeIO([
      '--file',
      subject,
      '--mutate',
      's/beta/BETA/',
      '--test',
      "bash -c 'if [ \"$PAPERCUSP_MUTATION_PHASE\" = mutant ]; then exit 2; fi' _ {}",
    ]);
    expect(code).toBe(2);
    expect(out).toMatch(/HARNESS ERROR/i);
    expect(out).toMatch(/verdict=harness-error/);
    expect(out).not.toMatch(/MUTANT CAUGHT/);
    expect(read()).toBe(ORIGINAL);
  });

  it('REFUSES a mutation that changed nothing (exit 2) instead of reporting a false weakness', () => {
    // A no-op mutation is the quiet killer of this technique: the "mutant" is
    // identical to the original, so any guard passes and the probe would
    // otherwise report "your guard did not catch it" — a false verdict from a
    // probe that never mutated anything.
    const code = runProbe(['--file', subject, '--mutate', 's/nosuchtext/x/', '--test', 'grep -q "^beta$" {}']);
    expect(code).toBe(2);
    expect(read()).toBe(ORIGINAL);
  });

  it('explains the PERL-metacharacter cause when an unescaped source mutation matches nothing', () => {
    // EI-19460105590596381. --mutate is applied with `perl -pi -e`, so on the PATTERN side
    // ( ) { } are regex metacharacters. That bites hardest on this script's normal use —
    // mutating source code — because the natural mutation of a conditional reads as correct
    // and matches NOTHING: `if (x > 0) {` parses as a capture group plus a quantifier, so it
    // searches for `if x > 0 ` and misses. The refusal was already correct (exit 2, never a
    // false weakness verdict), but it named only the symptom, leaving the reader to guess at
    // their own pattern rather than at their metacharacters.
    writeFileSync(subject, 'if (x > 0) {\n');
    const { code, out } = runProbeIO([
      '--file',
      subject,
      '--mutate',
      's|if (x > 0) {|if (false) {|',
      '--test',
      'test -s {}',
    ]);
    expect(code).toBe(2);
    // The cause, not just "changed NOTHING".
    expect(out).toMatch(/PERL/i);
    // And the fix, spelled out — the escaped pattern form.
    expect(out).toContain('\\(x > 0\\)');
    expect(read()).toBe('if (x > 0) {\n');
  });

  it('the ESCAPED form of that same mutation does apply — so the guidance is correct, not folklore', () => {
    // Calibration for the test above: without this, "unescaped matches nothing" could equally
    // mean the probe is broken for this subject entirely, and the advice would be untested.
    writeFileSync(subject, 'if (x > 0) {\n');
    // The guard asserts the ORIGINAL line is present. If the mutation applied, that line is
    // gone, the guard FAILS on the mutant, and the probe reports CAUGHT (exit 0). Reaching
    // exit 0 here is therefore proof the escaped pattern matched — the exact thing the
    // unescaped form above failed to do.
    const code = runProbe([
      '--file',
      subject,
      '--mutate',
      's|if \\(x > 0\\) \\{|if (false) {|',
      '--test',
      'grep -q "^if (x > 0) {$" {}',
    ]);
    expect(code).toBe(0);
    expect(read()).toBe('if (x > 0) {\n');
  });

  it('refuses a --test with no {} placeholder, so the probe cannot silently target the wrong file', () => {
    const code = runProbe(['--file', subject, '--mutate', 's/beta/BETA/', '--test', 'true']);
    expect(code).toBe(2);
  });
});

describe('mutation-probe.sh — in-tree mode restores the tracked file', () => {
  it('restores after a normal exit', () => {
    runProbe(['--in-tree', '--file', subject, '--mutate', 's/beta/BETA/', '--test', 'grep -q "^beta$" {}']);
    expect(read()).toBe(ORIGINAL);
  });

  /**
   * EI-19455888914364007 — the `{}` requirement is MODE-SPECIFIC, and this pins the asymmetry
   * from BOTH sides with the SAME --test command, so neither half can be "tidied" away:
   *
   *  · in-tree  → ACCEPTED. The tracked file itself is the mutant, so the substitution is a
   *    no-op. This is the normal shape here, because in-tree mode exists precisely for subjects
   *    a suite imports by a FIXED path — such a test has nowhere to put a {} at all. Requiring
   *    it anyway forced callers to thread a dummy `PROBE_FILE={}` env var that nothing reads.
   *  · copy-out → still REFUSED (exit 2). There {} is the only thing pointing the test at the
   *    mutated copy; without it the test runs against the untouched original, every mutant
   *    "survives", and the probe reports a sound guard as weak.
   */
  it('accepts a --test with no {} placeholder, which copy-out mode must still refuse', () => {
    const testCmd = `grep -q "^beta$" ${subject}`;

    // in-tree: the mutation lands in the tracked file the command names, so the guard fails on
    // the mutant => CAUGHT => exit 0. And the file is still restored afterwards.
    expect(runProbe(['--in-tree', '--file', subject, '--mutate', 's/beta/BETA/', '--test', testCmd])).toBe(0);
    expect(read()).toBe(ORIGINAL);

    // Non-vacuousness: the very same command is still rejected without --in-tree, so this is a
    // mode-specific relaxation and not a removed check.
    expect(runProbe(['--file', subject, '--mutate', 's/beta/BETA/', '--test', testCmd])).toBe(2);
    expect(read()).toBe(ORIGINAL);
  });

  it('restores PROMPTLY on SIGTERM mid-probe — not merely eventually', async () => {
    const child = spawn(
      'bash',
      [
        SCRIPT,
        '--in-tree',
        '--file',
        subject,
        '--mutate',
        's/beta/BETA/',
        '--test',
        'if [ "$PAPERCUSP_MUTATION_PHASE" = mutant ]; then sleep 20; fi; test -f {}',
      ],
      { stdio: 'ignore' },
    );
    try {
      // Wait until the probe has actually applied the mutant, so we are
      // measuring the restore path and not a race against startup. Without
      // this the test could pass having never mutated anything at all.
      const deadline = Date.now() + 15_000;
      while (read() === ORIGINAL && Date.now() < deadline) await sleep(100);
      expect(read()).not.toBe(ORIGINAL); // the tree really is dirty right now

      child.kill('SIGTERM');

      // 5s is deliberately far below the child's 20s runtime: the pre-fix
      // foreground form restored only when the child exited (~20s), so this
      // bound FAILS on a revert while passing comfortably on the fix.
      const restoreBy = Date.now() + 5_000;
      while (read() !== ORIGINAL && Date.now() < restoreBy) await sleep(50);
      expect(read()).toBe(ORIGINAL);
    } finally {
      child.kill('SIGKILL');
    }
  }, 40_000);
});
