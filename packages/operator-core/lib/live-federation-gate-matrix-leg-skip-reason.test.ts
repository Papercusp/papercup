/**
 * live-federation-gate-matrix-leg-skip-reason.test.ts — regression guard for EI-18715623477356990.
 *
 * THE BUG: §3b of the live-federation gate ran the heavy 8-scenario local-matrix leg only on a
 * window whose CHEAP content-matrix smoke passed:
 *
 *   if [ "${RUN_LOCAL_MATRIX:-1}" = 1 ] && { [ "$MATRIX_RES" = PASS ] || [ "$MATRIX_RES" = PASS-971 ]; } && [ -e … ]
 *
 * The sequencing rationale is sound in isolation. What is NOT sound is the SILENCE: four distinct
 * declines (leg disabled / wrapper missing / content-matrix red / cadence window) all collapsed to
 * the same `MATRIXFULL_RES="SKIPPED"` with no reason anywhere, so a consumer could not tell that
 * the leg had been skipped at all — the skip is not announced, it simply does not appear.
 *
 * WHY THAT MATTERS: local-matrix is the ONLY leg that runs revocation_kcut (order 90) and
 * attestation_unattested_device (order 91). Observed 2026-07-26 (run /tmp/live-fed-gate-20260726-094205):
 * content-matrix was red on incr-B→A, so EVERY hourly window silently skipped the leg, and two
 * agents each waited on a run for revocation/attestation evidence that structurally could not arrive.
 *
 * WHY the EI-18657324526667507 staleness detector did NOT already cover it: MATRIX_STALE_H defaults
 * to MATRIX_TTL_H + 48h = 192h, so a lane blocked by a red content-matrix waits up to EIGHT DAYS
 * before anything notices the leg went dark. That detector answers "has this leg been dark for a
 * week?"; this one answers "did it decide THIS window, and if not, why not?".
 *
 * THE FIX: one MATRIX_SKIP_REASON string set by every decline branch, a DISTINCT
 * SKIPPED-CONTENT-RED result token for the content-red case (so the verdict SUMMARY carries it),
 * and a matrix_skip_suffix() appended to every verdict line.
 *
 * STATIC leg: pins that each exit path carries the suffix and that the token stays SKIPPED*-shaped
 * (so is_skip_result keeps counting it as "nothing proven" — the vacuous-pass trap).
 * BEHAVIORAL leg: evals the REAL §3b branch chain out of the shipping script under bash against a
 * scratch state dir + a stub wrapper, proving each decline names itself and the run path still runs.
 *
 *   cd packages/operator-core && npx vitest run lib/live-federation-gate-matrix-leg-skip-reason.test.ts
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
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
const GATE_PATH = join(ROOT, 'papercusp-desktop', 'bin', 'live-federation-gate.sh');
const gate = readFileSync(GATE_PATH, 'utf8');

function extractLineFn(name: string): string {
  const m = gate.match(new RegExp(`^${name}\\(\\) \\{.*$`, 'm'));
  expect(m?.[0], `could not extract the one-line ${name}() from the gate source`).toBeTruthy();
  return m![0];
}
function extractLine(re: RegExp, what: string): string {
  const m = gate.match(re);
  expect(m?.[0], `could not extract ${what} from the gate source`).toBeTruthy();
  return m![0];
}

/** The whole §3b decision chain, from the result initializer to its trailing reason log. */
function extractSection3b(): string {
  const m = gate.match(
    /^MATRIXFULL_RES="SKIPPED"\n[\s\S]*?\n\[ -n "\$MATRIX_SKIP_REASON" \] && log [^\n]*$/m,
  );
  expect(m?.[0], 'could not extract the §3b local-matrix branch chain from the gate source').toBeTruthy();
  return m![0];
}

const HOUR = 3600;

/**
 * Run the REAL §3b chain from the shipping script. `log` is stubbed to an observable marker and
 * the two frame-starvation helpers to fixed verdicts — those are I/O edges, not the logic here.
 * A stub `local-matrix.sh` stands in for the containerized wrapper so the RUN branch is exercised
 * too (its exit code is `wrapperExit`); omit `wrapper` to simulate it not being installed.
 */
function runSection3b(opts: {
  matrixRes: string;
  lastMatrixGreenAgeH?: number;
  runLocalMatrix?: string;
  wrapper?: boolean;
  wrapperExit?: number;
  starvation?: boolean;
}) {
  const dir = mkdtempSync(join(tmpdir(), 'fedgate-skipreason-'));
  const work = join(dir, 'work');
  const state = join(dir, 'state');
  const desktop = join(dir, 'papercusp-desktop');
  mkdirSync(work);
  mkdirSync(state);
  mkdirSync(join(desktop, 'bin'), { recursive: true });
  if (opts.wrapper !== false) {
    writeFileSync(
      join(desktop, 'bin', 'local-matrix.sh'),
      `#!/usr/bin/env bash\necho "STUB local-matrix ran"\nexit ${opts.wrapperExit ?? 0}\n`,
    );
  }
  if (opts.lastMatrixGreenAgeH !== undefined) {
    writeFileSync(
      join(state, 'last-matrix-green'),
      String(Math.floor(Date.now() / 1000) - opts.lastMatrixGreenAgeH * HOUR),
    );
  }

  const script = [
    'set -uo pipefail',
    `STATE_DIR=${JSON.stringify(state)}`,
    `WORK=${JSON.stringify(work)}`,
    `DESKTOP_DIR=${JSON.stringify(desktop)}`,
    `MATRIX_RES=${JSON.stringify(opts.matrixRes)}`,
    'GATE_DEB=""',
    extractLineFn('now_s'),
    extractLineFn('age_h'),
    extractLineFn('is_skip_result'),
    'log() { echo "LOG:$*"; }',
    `local_matrix_only_starvation_prone_fails() { return ${opts.starvation ? 0 : 1}; }`,
    `check_local_matrix_frame_starvation() { return ${opts.starvation ? 0 : 1}; }`,
    extractLine(/^MATRIX_SKIP_REASON=""$/m, 'the MATRIX_SKIP_REASON initializer'),
    extractLineFn('matrix_skip_suffix'),
    extractSection3b(),
    'echo "RES:$MATRIXFULL_RES"',
    'echo "REASON:$MATRIX_SKIP_REASON"',
    'echo "SUFFIX:$(matrix_skip_suffix)"',
    'is_skip_result "$MATRIXFULL_RES" && echo "IS_SKIP:yes" || echo "IS_SKIP:no"',
  ].join('\n');

  const out = execFileSync('bash', ['-c', script], {
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH ?? '',
      ...(opts.runLocalMatrix !== undefined ? { RUN_LOCAL_MATRIX: opts.runLocalMatrix } : {}),
    },
  });
  const field = (k: string) => out.match(new RegExp(`^${k}:(.*)$`, 'm'))?.[1] ?? '';
  return { out, res: field('RES'), reason: field('REASON'), suffix: field('SUFFIX'), isSkip: field('IS_SKIP') };
}

describe('EI-18715623477356990: a skipped local-matrix leg always says WHY, this window', () => {
  describe('behavioral: the real §3b branch chain, evaluated under bash', () => {
    it('THE BUG: a content-matrix FAIL no longer voids the leg silently', () => {
      const r = runSection3b({ matrixRes: 'FAIL', lastMatrixGreenAgeH: 500 });
      // Was: MATRIXFULL_RES="SKIPPED" and not one word about it anywhere.
      expect(r.res).toBe('SKIPPED-CONTENT-RED');
      expect(r.reason).toMatch(/content-matrix=FAIL/);
      expect(r.reason).toMatch(/revocation_kcut/);
      expect(r.reason).toMatch(/attestation_unattested_device/);
      expect(r.out).toMatch(/LOG:local-matrix DID NOT DECIDE this window/);
      // …and it reaches the human-facing verdict line, not just journald.
      expect(r.suffix).toMatch(/\[local-matrix DID NOT DECIDE: content-matrix=FAIL/);
    });

    it('the content-red token is still SKIPPED*-shaped, so the vacuous-pass trap still catches it', () => {
      // is_skip_result gates the "all legs skipped ⇒ NOT green" check. A token outside SKIPPED*
      // would make an all-skipped window look like it proved something.
      expect(runSection3b({ matrixRes: 'FAIL', lastMatrixGreenAgeH: 500 }).isSkip).toBe('yes');
    });

    it('names the cadence window when the leg is simply not due yet', () => {
      const r = runSection3b({ matrixRes: 'PASS', lastMatrixGreenAgeH: 10 });
      expect(r.res).toBe('SKIPPED');
      expect(r.reason).toMatch(/cadence window/);
      expect(r.reason).toMatch(/MATRIX_TTL_H=144h/);
    });

    it('names the disabled and missing-wrapper declines too (one reason string for all four)', () => {
      const disabled = runSection3b({ matrixRes: 'PASS', runLocalMatrix: '0', lastMatrixGreenAgeH: 500 });
      expect(disabled.reason).toMatch(/disabled/);
      const noWrapper = runSection3b({ matrixRes: 'PASS', wrapper: false, lastMatrixGreenAgeH: 500 });
      expect(noWrapper.reason).toMatch(/local-matrix\.sh not present/);
    });

    it('still RUNS the leg on a green content-matrix that is due — no silent reason on a real verdict', () => {
      for (const matrixRes of ['PASS', 'PASS-971']) {
        const r = runSection3b({ matrixRes, lastMatrixGreenAgeH: 500 });
        expect(r.out, `${matrixRes} should still run the wrapper`).toMatch(/LOG:running local-matrix/);
        expect(r.res).toBe('PASS');
        expect(r.reason, 'a leg that DECIDED has no skip reason').toBe('');
        expect(r.suffix).toBe('');
        expect(existsSync(join(dirname(GATE_PATH), '..', '..'))).toBe(true); // sanity: paths resolved
      }
    });

    it('a FAILing run is a verdict, not a skip (the reason string stays empty)', () => {
      const r = runSection3b({ matrixRes: 'PASS', lastMatrixGreenAgeH: 500, wrapperExit: 1 });
      expect(r.res).toBe('FAIL');
      expect(r.reason).toBe('');
    });

    it('a frame-starvation downgrade DOES report a reason (nothing was proven — D-005)', () => {
      const r = runSection3b({
        matrixRes: 'PASS',
        lastMatrixGreenAgeH: 500,
        wrapperExit: 1,
        starvation: true,
      });
      expect(r.res).toBe('SKIPPED-STARVATION');
      expect(r.reason).toMatch(/starvation/i);
      expect(r.reason).toMatch(/NOT proven/);
    });
  });

  describe('static: the reason can never be dropped from a verdict line again', () => {
    it.each([
      // Verb-agnostic `(?:echo|verdict)`: WI-38285 moved every terminal path from a bare `echo`
      // to `verdict()`, which banks the record to $STATE_DIR/verdicts.jsonl and then emits the
      // byte-identical line. This guard is about the skip-reason SUFFIX on the line, not about
      // which verb emits it — a reverted bare echo is caught by
      // live-federation-gate-verdict-bank.test.ts instead.
      ['GREEN', /(?:echo|verdict) "GATE: GREEN[^\n]*\n/],
      // The §4 VERDICT red specifically — matched via ${REDS[*]}. The earlier assert-core
      // self-test bail also emits "GATE: RED", but it exits long before §3b runs, so there is
      // no leg decision to report at that point.
      ['RED', /(?:echo|verdict) "GATE: RED \(\$\{REDS\[\*\]\}\)[^\n]*\n/],
      ['SKIPPED (no legs ran)', /(?:echo|verdict) "GATE: SKIPPED \(no legs ran[^\n]*\n/],
      ['SKIPPED-STARVATION', /(?:echo|verdict) "GATE: SKIPPED-STARVATION[^\n]*\n/],
      ['SKIPPED-STORM', /(?:echo|verdict) "GATE: SKIPPED-STORM[^\n]*\n/],
    ])('the %s exit line carries $(matrix_skip_suffix)', (_label, re) => {
      const line = extractLine(re, `the ${_label} exit line`);
      expect(line).toMatch(/matrix_skip_suffix/);
    });

    it('§3b sets a reason on EVERY decline branch (no silent fall-through)', () => {
      const s3b = extractSection3b();
      // Four declines + the starvation downgrade — each must assign the reason.
      const assignments = s3b.match(/MATRIX_SKIP_REASON=/g) ?? [];
      expect(assignments.length).toBeGreaterThanOrEqual(5);
      // …and the chain must stay an if/elif ladder: a compound `&&` condition is the original
      // shape, where a decline cannot name itself because all four collapse into one branch.
      expect(s3b).toMatch(/^elif /m);
    });

    it('the script still parses (bash -n) after the edit', () => {
      expect(() => execFileSync('bash', ['-n', GATE_PATH], { encoding: 'utf8' })).not.toThrow();
    });
  });
});
