/**
 * Tests for the assert-integrity lint (scripts/check-assert-integrity.mjs, WI-5788 / P-411).
 *
 * The lint exists to catch rig/scenario asserts whose FAILURE TO RUN can read as a PASS.
 * The thing that makes it worth testing is not that it fires — it is that it CANNOT BE
 * QUIETED BY LOOSENING IT. Two of its rules carry deliberate exemptions (R4's
 * "failure is propagated via a status variable", and the pragma suppression), and every
 * exemption is a place where a future edit could silently turn the whole lint into a
 * no-op that reports green because it stopped looking.
 *
 * So the load-bearing cases below are the FAIL-CLOSED NEGATIVE CONTROLS: the shapes that
 * look almost exactly like an exempt one but are NOT, and must still be reported. If an
 * edit to the lint ever makes one of those go quiet, that is the regression.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore -- plain .mjs lint script, no type declarations
import { scan } from '../../../scripts/check-assert-integrity.mjs';

type Finding = { file: string; line: number; rule: string; msg: string };

const run = (src: string): Finding[] => scan('t.sh', src) as Finding[];
const rules = (src: string): string[] => run(src).map((f) => f.rule);

describe('check-assert-integrity: R1 permissive coercion', () => {
  it('flags an unmeasured baseline coerced to 0 and then threshold-compared', () => {
    // The exact shape that made b9-attestation.sh LEG3/LEG4 able to falsely pass.
    const src = [
      'rc_before="$(psql -c "select count(*)")"',
      '[ -z "$rc_before" ] && rc_before=0',
      'rc_after="$(psql -c "select count(*)")"',
      '[ "$rc_after" -gt "$rc_before" ] && echo PASS',
    ].join('\n');
    expect(rules(src)).toContain('R1-permissive-coercion');
  });

  it('flags the ${X:-0} and $(... || echo 0) spellings of the same coercion', () => {
    const braceDefault = ['n="$(probe)"', 'n="${n:-0}"', '[ "$n" -ge 1 ]'].join('\n');
    const echoFallback = ['n=$(probe || echo 0)', '[ "$n" -ge 1 ]'].join('\n');
    expect(rules(braceDefault)).toContain('R1-permissive-coercion');
    expect(rules(echoFallback)).toContain('R1-permissive-coercion');
  });

  it('does NOT flag the fixed shape, where an unmeasured read fails outright', () => {
    // The remediation actually applied to b9-attestation.sh / the from-repo smoke.
    const src = [
      'rc_before="$(psql -c "select count(*)")"',
      '[ -n "$rc_before" ] || { echo "FAIL — baseline UNMEASURED"; return 1; }',
      'rc_after="$(psql -c "select count(*)")"',
      '[ "$rc_after" -gt "$rc_before" ] && echo PASS',
    ].join('\n');
    expect(rules(src)).not.toContain('R1-permissive-coercion');
  });

  it('does NOT flag a coerced value that never reaches a numeric assert', () => {
    // A config default (local-matrix.sh NCPU) is not an assert — nothing is scored off it.
    const src = ['NCPU="$(nproc || echo 8)"', 'echo "cores=$NCPU"'].join('\n');
    expect(rules(src)).not.toContain('R1-permissive-coercion');
  });
});

describe('check-assert-integrity: R2/R3/R5', () => {
  it('R2 flags a probe var pre-set to the literal its assert treats as success', () => {
    const src = ['ok=1', 'ok="$(probe)"', '[ "$ok" = 1 ] && echo PASS'].join('\n');
    expect(rules(src)).toContain('R2-default-to-pass');
  });

  it('R3 flags an unguarded grep -c count fed into a threshold compare', () => {
    // grep -c prints 0 and exits 1 on a MISSING file: "never ran" is indistinguishable from 0.
    const src = ['hits=$(grep -c PATTERN some.log)', '[ "$hits" -ge 1 ] && echo PASS'].join('\n');
    expect(rules(src)).toContain('R3-grep-c-unguarded');
  });

  it('R5 flags `local X="$(cmd)"` masking the command exit status', () => {
    const src = ['local out="$(probe)"', 'rc=$?', '[ "$rc" = 0 ] && echo PASS'].join('\n');
    expect(rules(src)).toContain('R5-local-masks-rc');
  });
});

describe('check-assert-integrity: R4 empty-read branch', () => {
  it('flags an empty-read branch that only logs and continues', () => {
    const src = ['v="$(probe)"', 'if [ -z "$v" ]; then', '  echo "no value, skipping"', 'fi', 'echo done'].join('\n');
    expect(rules(src)).toContain('R4-empty-read-continues');
  });

  it('does NOT flag a branch that returns/exits directly', () => {
    const src = ['v="$(probe)"', 'if [ -z "$v" ]; then', '  echo "FAIL"', '  return 1', 'fi'].join('\n');
    expect(rules(src)).not.toContain('R4-empty-read-continues');
  });

  it('does NOT flag a status var that IS returned (rc=1 … return "$rc")', () => {
    // scenario-coord-control-plane.sh CC-4/CC-5 — correct code the rule used to over-fire on.
    const src = [
      'v="$(probe)"',
      'if [ -z "$v" ]; then',
      '  echo "CC-4 FAIL — could not resolve"; rc=1',
      'fi',
      'return "$rc"',
    ].join('\n');
    expect(rules(src)).not.toContain('R4-empty-read-continues');
  });

  it('does NOT flag a status var TESTED to guard a nonzero exit (FAIL=1 … if [ "$FAIL" != 0 ]; exit 1)', () => {
    // mac-vm-fd-limit-verify.sh after it grew a third outcome (verified / regression / partial).
    const src = [
      'v="$(probe)"',
      'if [ -z "$v" ]; then',
      '  echo "no line"',
      '  FAIL=1',
      'fi',
      'if [ "$FAIL" != 0 ]; then',
      '  echo "REGRESSION"',
      '  exit 1',
      'fi',
    ].join('\n');
    expect(rules(src)).not.toContain('R4-empty-read-continues');
  });

  // ── FAIL-CLOSED CONTROL ────────────────────────────────────────────────────────────
  it('STILL flags a status var that is set but never returned, tested, or exited', () => {
    // The whole point of requiring PROOF of propagation. `rc=1` that nothing ever reads is
    // precisely the silent-continue this rule exists to catch — if this ever goes quiet,
    // the R4 exemption has been widened into a hole.
    const src = [
      'v="$(probe)"',
      'if [ -z "$v" ]; then',
      '  echo "FAIL — unmeasured"; rc=1',
      'fi',
      'echo "carrying on regardless"',
    ].join('\n');
    expect(rules(src)).toContain('R4-empty-read-continues');
  });

  it('STILL flags when the status var is set to ZERO (not a failure disposition at all)', () => {
    const src = [
      'v="$(probe)"',
      'if [ -z "$v" ]; then',
      '  echo "unmeasured"; rc=0',
      'fi',
      'return "$rc"',
    ].join('\n');
    expect(rules(src)).toContain('R4-empty-read-continues');
  });

  it('STILL flags when a DIFFERENT variable is the one propagated', () => {
    // Setting `other=1` while the function returns an unrelated `rc` is not propagation.
    const src = [
      'v="$(probe)"',
      'if [ -z "$v" ]; then',
      '  echo "unmeasured"; other=1',
      'fi',
      'return "$rc"',
    ].join('\n');
    expect(rules(src)).toContain('R4-empty-read-continues');
  });
});

describe('check-assert-integrity: pragma suppression', () => {
  const offending = ['n="$(probe)"', '[ -z "$n" ] && n=0', '[ "$n" -ge 1 ] && echo PASS'];

  it('suppresses via a pragma on the offending line', () => {
    const src = [offending[0], `${offending[1]} # assert-integrity-ok: config default`, offending[2]].join('\n');
    expect(rules(src)).not.toContain('R1-permissive-coercion');
  });

  it('suppresses via a pragma anywhere in the comment block immediately above', () => {
    // The reason for an exemption is usually several lines; only the first carried the token,
    // which used to mean the suppression silently did nothing.
    const src = [
      offending[0],
      '# assert-integrity-ok: this is a config default, not an assert —',
      '# the fallback is the conservative direction and nothing is scored off it,',
      '# so an unmeasurable probe here cannot make any claim falsely pass.',
      offending[1],
      offending[2],
    ].join('\n');
    expect(rules(src)).not.toContain('R1-permissive-coercion');
  });

  // ── FAIL-CLOSED CONTROL ────────────────────────────────────────────────────────────
  it('does NOT suppress when a blank line detaches the comment block from the line', () => {
    const src = [offending[0], '# assert-integrity-ok: unrelated note', '', offending[1], offending[2]].join('\n');
    expect(rules(src)).toContain('R1-permissive-coercion');
  });

  it('does NOT suppress when code intervenes between the pragma and the finding', () => {
    const src = [
      offending[0],
      '# assert-integrity-ok: applies to the line below only',
      'echo "something else entirely"',
      offending[1],
      offending[2],
    ].join('\n');
    expect(rules(src)).toContain('R1-permissive-coercion');
  });
});

/**
 * The lint is wired into .github/workflows/test.yml, but the LIVE gate on this repo is the
 * green-checkpoint suite (`npm run test:affected`) — it runs tests, not lints, and the GitHub
 * Actions workflow has been red/dormant. A guard that only runs somewhere that never runs is
 * not a guard, so the real-tree scan is asserted HERE too, where the live gate will see it.
 */
describe('check-assert-integrity: the real rig scripts stay clean', () => {
  const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
  const SCOPE = resolve(REPO, 'papercusp-desktop/bin');

  const shellScripts = (dir: string): string[] => {
    const out: string[] = [];
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return out;
    }
    for (const e of entries) {
      const full = resolve(dir, e.name);
      if (e.isDirectory()) out.push(...shellScripts(full));
      else if (e.name.endsWith('.sh')) out.push(full);
    }
    return out;
  };

  it('scans a non-trivial number of scripts (an empty scan is NOT a pass)', () => {
    // papercusp-desktop is a submodule: if it is not checked out, this walk finds nothing and
    // a "no findings" result would mean "I never looked" — the exact can-falsely-pass shape.
    expect(shellScripts(SCOPE).length).toBeGreaterThanOrEqual(10);
  });

  it('reports no can-falsely-pass shapes across papercusp-desktop/bin', () => {
    const findings = shellScripts(SCOPE).flatMap((f) => run(readFileSync(f, 'utf8')).map((x) => ({ ...x, file: f })));
    const rendered = findings.map((f) => `${f.file.replace(REPO, '')}:${f.line} [${f.rule}]`).join('\n');
    expect(rendered).toBe('');
  });
});

describe('check-assert-integrity: scan contract', () => {
  it('reports 1-indexed line numbers against the given file name', () => {
    const src = ['#!/bin/bash', 'n="$(probe)"', '[ -z "$n" ] && n=0', '[ "$n" -ge 1 ]'].join('\n');
    const [finding] = run(src).filter((f) => f.rule === 'R1-permissive-coercion');
    expect(finding.file).toBe('t.sh');
    expect(finding.line).toBe(3);
  });

  it('returns no findings for a script with no probe-derived asserts', () => {
    expect(run(['#!/bin/bash', 'set -euo pipefail', 'echo hello'].join('\n'))).toEqual([]);
  });
});
