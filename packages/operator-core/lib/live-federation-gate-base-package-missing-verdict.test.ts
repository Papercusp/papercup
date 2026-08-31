/**
 * live-federation-gate-base-package-missing-verdict.test.ts — regression guard for WI-478707.
 *
 * THE BUG: §2 of the live-federation gate selects the base package to repack with
 *
 *   fed_select_newest_deb_by_package papercusp-gui <4 globs>
 *
 * and on failure sets, at ONE site, `BASE_DEB=""` + `SKIP_MATRIX=1` + `RUN_LOCAL_MATRIX=0` —
 * disabling BOTH federation legs in a single step. The §5 vacuous-pass trap does not catch that,
 * because it requires content-matrix AND from-repo AND local-matrix to ALL be skips, and the
 * from-repo leg still passes. So REDS came back empty and the run stamped `last-green` and
 * reported `GATE: GREEN` having exercised ZERO federation coverage. The 22h GREEN-freshness TTL
 * then short-circuited every subsequent hourly window ("fresh: last GREEN 7h ago (< 22h TTL)"),
 * so one false green silenced the gate for a day.
 *
 * MEASURED 2026-08-28: no Package=papercusp-gui .deb existed anywhere on the gate host (the
 * gate's own selector returned rc=1 for papercusp-gui and rc=0 for papercusp-server as a positive
 * control), and ALL FOUR GREEN rows in the retained 374-row verdict bank were exactly this shape:
 *   legs={content_matrix:SKIPPED, local_matrix:SKIPPED, from_repo:PASS, build:OK}
 *   matrix_skip="leg disabled for this run (RUN_LOCAL_MATRIX=0)"   invoker=systemd
 *
 * WHY IT MATTERS BEYOND THE GATE: packages/operator-core/lib/release/live-release-certification.ts
 * projects exact-SHA DEPLOY certification from these very GREEN records, so the false greens were
 * certifying release SHAs. That consumer-side hole is WI-483569; this guard is the producer side.
 *
 * WHY THE EXISTING GUARDS DID NOT COVER IT — this is the interesting part, and the reason this
 * file exists rather than another case in the skip-reason suite:
 *   · EI-18715623477356990 (matrix-leg-skip-reason) made every decline ANNOUNCE itself in
 *     MATRIX_SKIP_REASON and appended matrix_skip_suffix() to every verdict line. It did exactly
 *     that here — the GREEN lines literally read "[local-matrix DID NOT DECIDE: leg disabled for
 *     this run (RUN_LOCAL_MATRIX=0)]" — and the verdict stayed GREEN. An annotation is not a
 *     verdict change.
 *   · EI-18657324526667507 (matrix-leg-staleness) fires only after MATRIX_STALE_H (TTL+48h ≈ 8
 *     days) of silence, and files an EI. Also a detector, also no actuator.
 * Both are detectors without actuators, which is precisely how this ran for 15 days in plain
 * sight. The property under test here is therefore about the VERDICT, not about the message.
 *
 * STATIC leg: pins that the flag is set at the same site that disables the two legs, and that the
 * refusal branch sits BEFORE the last-green stamp (a refusal placed after it would still suppress
 * re-runs behind the freshness TTL, which is half the harm).
 * BEHAVIORAL leg: evals the REAL §5 green tail out of the shipping script under bash, both ways —
 * flag set must refuse and must NOT stamp last-green; flag clear must still green and MUST stamp
 * it. The second direction is the positive control: without it, a tail that refused
 * unconditionally would pass every assertion in the first.
 *
 *   cd packages/operator-core && npx vitest run lib/live-federation-gate-base-package-missing-verdict.test.ts
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
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
// Subject path is overridable so falsifiability can be proved against a FROZEN snapshot
// (scripts/mutation-probe.sh --against-last-without) instead of by mutating the shared tree —
// git-sync sweeps the whole checkout on a schedule, so an in-tree mutation held for the length of
// a test run can be committed even when nothing goes wrong. This one line is what buys that.
const GATE_PATH =
  process.env.PROBE_GATE_SCRIPT ?? join(ROOT, 'papercusp-desktop', 'bin', 'live-federation-gate.sh');
const gate = readFileSync(GATE_PATH, 'utf8');

/**
 * The REAL §5 tail, from this guard's refusal branch through the GREEN verdict — i.e. the exact
 * span whose ORDERING is the property under test.
 */
function extractGreenTail(): string {
  const m = gate.match(
    /^ {2}if \[ "\$\{MATRIX_BASE_DEB_MISSING:-0\}" = 1 \]; then\n[\s\S]*?\n {2}verdict "GATE: GREEN[^\n]*$/m,
  );
  expect(
    m?.[0],
    'could not extract the §5 green tail (base-package refusal → last-green stamp → GREEN verdict) from the gate source',
  ).toBeTruthy();
  return m![0];
}

/**
 * Run the REAL §5 green tail with REDS already empty. `verdict` is stubbed to an observable
 * marker and the two suffix helpers + check_matrix_staleness to no-ops — those are presentation
 * and I/O edges, not the branch logic under test. STATE_DIR is a scratch dir so the last-green
 * stamp is directly observable as a filesystem effect rather than inferred from the output.
 */
function runGreenTail(baseDebMissing: '0' | '1'): {
  stdout: string;
  exitCode: number;
  stampedLastGreen: boolean;
} {
  const dir = mkdtempSync(join(tmpdir(), 'fedgate-basedeb-'));
  const script = [
    'set -u',
    `STATE_DIR=${JSON.stringify(dir)}`,
    'SUMMARY="content-matrix=SKIPPED from-repo=PASS from-repo-witness=SKIPPED local-matrix=SKIPPED build=OK"',
    'MATRIXFULL_RES="SKIPPED"',
    `MATRIX_BASE_DEB_MISSING=${baseDebMissing}`,
    'now_s() { echo 1787900000; }',
    'verdict() { echo "VERDICT_LINE:$1"; }',
    'check_matrix_staleness() { :; }',
    'matrix_stale_suffix() { :; }',
    "matrix_skip_suffix() { printf ' [local-matrix DID NOT DECIDE: leg disabled for this run (RUN_LOCAL_MATRIX=0)]'; }",
    extractGreenTail(),
  ].join('\n');

  let stdout = '';
  let exitCode = 0;
  try {
    stdout = execFileSync('bash', ['-c', script], { encoding: 'utf8', timeout: 30_000 });
  } catch (err) {
    const e = err as { stdout?: string; status?: number };
    stdout = e.stdout ?? '';
    exitCode = typeof e.status === 'number' ? e.status : -1;
  }
  return { stdout, exitCode, stampedLastGreen: existsSync(join(dir, 'last-green')) };
}

describe('live-federation gate: a window with no base package can never be GREEN (WI-478707)', () => {
  describe('static — the flag is set where the legs are disabled, and refuses before the stamp', () => {
    it('THE BUG: the selector-failure branch disables BOTH legs, so it must also raise the flag', () => {
      // These three assignments are what make the window prove nothing. They have to travel
      // together: if a later edit moves or drops MATRIX_BASE_DEB_MISSING while leaving the other
      // two, the false green comes straight back and nothing else in the suite notices.
      // RE-ANCHORED 2026-08-31 (test-suite-recovery-2026-08-27 D-026). The invariant below
      // is unchanged and still holds; what broke was this test's LOCATOR. 973fe78f
      // (2026-08-30T19:30Z, papercusp-desktop +53/-8, EI-21713671250062619) inserted the
      // bounded build-one-fresh-base-.deb block between the selector's log line and the
      // disabling assignments, taking the span from under 900 chars to 2378 — so the old
      // `[\s\S]{0,900}?` window could no longer reach the closing `fi` and the match came
      // back undefined. Widening that number would have "fixed" it while weakening the
      // claim: a bigger window lets the four assignments drift into DIFFERENT branches and
      // still match, which is exactly the false green this guard exists to prevent.
      //
      // So it is anchored structurally instead, which is both tighter than the old bound
      // and immune to anything else being inserted above it: the selector failure must
      // clear BASE_DEB immediately, and the three leg-disabling assignments must all live
      // inside the SAME `if [ -z "$BASE_DEB" ]` block (indent-matched to its own `fi`).
      expect(
        gate,
        'the base-package selector failure must clear BASE_DEB before anything else',
      ).toMatch(/no existing Debian candidate declares Package=papercusp-gui"\n\s*BASE_DEB=""\n/);

      const disabling = gate.match(/\n( +)if \[ -z "\$BASE_DEB" \]; then\n[\s\S]*?\n\1fi\n/);
      expect(
        disabling?.[0],
        'could not locate the `if [ -z "$BASE_DEB" ]` block that disables both federation legs',
      ).toBeTruthy();
      expect(disabling![0]).toMatch(/SKIP_MATRIX=1/);
      expect(disabling![0]).toMatch(/RUN_LOCAL_MATRIX=0/);
      expect(disabling![0]).toMatch(/MATRIX_BASE_DEB_MISSING=1/);
    });

    it('the flag is initialized, so `set -u` cannot make a clean run explode on the read', () => {
      expect(gate).toMatch(/^MATRIX_BASE_DEB_MISSING=0$/m);
    });

    it('the refusal precedes the last-green stamp (a refusal after it would still suppress re-runs)', () => {
      const refusal = gate.indexOf('if [ "${MATRIX_BASE_DEB_MISSING:-0}" = 1 ]; then');
      const stamp = gate.indexOf('echo "$(now_s)" >"$STATE_DIR/last-green"');
      expect(refusal, 'refusal branch not found').toBeGreaterThan(-1);
      expect(stamp, 'last-green stamp not found').toBeGreaterThan(-1);
      expect(refusal).toBeLessThan(stamp);
    });

    it('the script still parses (bash -n) after the edit', () => {
      expect(() =>
        execFileSync('bash', ['-n', GATE_PATH], { encoding: 'utf8', timeout: 30_000 }),
      ).not.toThrow();
    });
  });

  describe('behavioral — the real §5 tail, run both ways', () => {
    it('THE BUG: flag set ⇒ refuses the green, names the cause, and does NOT stamp last-green', () => {
      const r = runGreenTail('1');
      expect(r.stdout).toMatch(/VERDICT_LINE:GATE: BLOCKED \(base-package-missing\)/);
      expect(r.stdout).not.toMatch(/VERDICT_LINE:GATE: GREEN/);
      // The stamp is the load-bearing half: it is what silences the next 22h of hourly windows.
      expect(r.stampedLastGreen).toBe(false);
      // Nonzero, like the WI-39359 attestation branch, so the systemd result shows the fault.
      expect(r.exitCode).toBe(1);
    });

    it('the refusal line tells the reader how to produce the missing package', () => {
      // A blocked gate that does not name its own remedy is how a fault sits for 15 days.
      expect(runGreenTail('1').stdout).toMatch(/build-desktop-sidecar\.sh[\s\S]*npm run build/);
    });

    it('POSITIVE CONTROL: flag clear ⇒ still GREEN and still stamps last-green', () => {
      // Without this direction the suite would pass just as happily against a tail that refused
      // unconditionally — i.e. against a gate that can never go green at all.
      const r = runGreenTail('0');
      expect(r.stdout).toMatch(/VERDICT_LINE:GATE: GREEN/);
      expect(r.stdout).not.toMatch(/BLOCKED \(base-package-missing\)/);
      expect(r.stampedLastGreen).toBe(true);
      expect(r.exitCode).toBe(0);
    });
  });
});
