/**
 * live-federation-gate-admission-pressure.test.ts — regression guard for WI-6151.
 *
 * THE BUG: the gate's §1 admission gate skipped the whole run on the HOST 1-min loadavg:
 *
 *   LOAD1="$(cut -d' ' -f1 /proc/loadavg …)"
 *   if awk "BEGIN{exit !($LOAD1 > $LOAD_GATE)}"; then … echo "GATE: SKIPPED (load …)"; exit 0
 *
 * That made the gate UNRUNNABLE BY CONSTRUCTION on the shared fleet box — observed
 * 2026-07-26: 14:42 "GATE: SKIPPED (load 165.71 > 108)", 15:42 "(load 149.81 > 108)",
 * ~10 SKIPPED fires in 24h and no verdict all day while P-402/WI-5137 (gate-first-green)
 * waited on it. A SKIPPED gate exits 0, so nothing downstream registered the silence.
 *
 * WHY loadavg CANNOT WORK HERE — two independent reasons:
 *  (a) It is the SAME number the gate's own verdict path already documents as
 *      non-representative of the pinned rig frames (WI-5639 / EI-18716933933700596,
 *      guarded by live-federation-gate-frame-pressure-note.test.ts). One file, two paths,
 *      opposite conclusions about whether host loadavg means anything.
 *  (b) loadavg is NICE-BLIND: it counts runnable tasks, not contention, so a nice-19 task
 *      weighs exactly as much as a nice-0 one. The fleet's heavy work is deliberately
 *      deferential (green-checkpoint's heavy legs run at nice 10 via scripts/pc-heavy.sh,
 *      WI-6140) — it yields to the gate by construction yet still counts in full against
 *      LOAD_GATE. Measured 2026-07-26 19:46Z: ~89 cores of nice>=10 work vs ~63 of nice<=0,
 *      loadavg ~150. No throttle/nice/ionice can lower that number, so the old gate was
 *      unsatisfiable by any remedy short of an idle box.
 *
 * THE FIX: admission reads cgroup-v2 CPU PSI (`some avg60`) — STALL time, which deferential
 * work that yields does not generate — against PRESSURE_GATE. LOAD_GATE is UNCHANGED and
 * demoted to the no-PSI fallback (owner decision D-003 forbids raising it; this changes
 * WHICH QUANTITY is measured, not the threshold).
 *
 * STATIC leg: pins that the admission decision no longer compares a loadavg value, that
 * LOAD_GATE's formula is untouched (the D-003 guard), and that the SKIPPED line still
 * starts with the historical `GATE: SKIPPED (` token journal readers grep for.
 * BEHAVIORAL leg: runs the REAL §1 chain out of the shipping script under bash against
 * fake /sys/fs/cgroup/cpu.pressure + /proc/loadavg files, proving the decisive case —
 * calm-but-busy box (low PSI, loadavg far above LOAD_GATE) now ADMITS.
 *
 *   cd packages/operator-core && npx vitest run lib/live-federation-gate-admission-pressure.test.ts
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
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

/** The whole §1 admission chain, from the PSI helper to the closing `fi` of the decision. */
function extractAdmissionChain(): string {
  const m = gate.match(
    /^gate_cpu_pressure_some\(\) \{\n[\s\S]*?\n  echo "ADMISSION: PROCEED [^\n]*\nfi$/m,
  );
  expect(
    m?.[0],
    'could not extract the §1 admission chain from the gate source — did the helper or the ' +
      'trailing `ADMISSION: PROCEED` echo get renamed? Re-anchor this test, do not delete it.',
  ).toBeTruthy();
  return m![0];
}

const PRESSURE_LINES = (some: Record<string, number>) =>
  `some avg10=${some.avg10 ?? 0} avg60=${some.avg60 ?? 0} avg300=${some.avg300 ?? 0} total=57044894497\n` +
  `full avg10=0.00 avg60=0.00 avg300=0.00 total=0\n`;

// `verdict` is also the name of the workspace's browser-automation CLI. Every extracted bash
// harness must shadow it: otherwise a terminal gate branch launches Chromium with the verdict
// text as its CLI argument and can hold spawnSync's inherited pipes open indefinitely.
const VERDICT_SHELL_STUB = 'verdict() { echo "$1"; }';

/**
 * Run the REAL §1 chain from the shipping script.
 *
 * STREAM FIDELITY MATTERS HERE, so the `log` stub writes to STDERR exactly as the real
 * `log()` does. That is not pedantry: this unit's journal carries stdout only — verified
 * empirically, the entire 13:39-14:25 run emitted ZERO `[live-fed-gate …]` lines to journald
 * while its stdout verdict landed fine — so an admission decision written only via `log()` is
 * invisible to anyone watching the service. A stub that folded stderr into stdout would hide
 * exactly that defect, which is how it survived until now.
 *
 * `check_staleness` / `skip_cleanup` are stubbed to markers — I/O edges, not the logic here.
 */
function runAdmission(opts: {
  /** omit to simulate a kernel with no PSI (file absent) */
  pressure?: { avg10?: number; avg60?: number; avg300?: number };
  loadavg: number;
  pressureGate?: number;
  loadGate?: number;
  force?: boolean;
}) {
  const dir = mkdtempSync(join(tmpdir(), 'fedgate-admission-'));
  const loadFile = join(dir, 'loadavg');
  writeFileSync(loadFile, `${opts.loadavg} ${opts.loadavg} ${opts.loadavg} 28/44793 139814\n`);
  const pressureFile = join(dir, 'cpu.pressure');
  if (opts.pressure) writeFileSync(pressureFile, PRESSURE_LINES(opts.pressure));

  const script = [
    'set -uo pipefail',
    `LOADAVG_FILE=${JSON.stringify(loadFile)}`,
    `CPU_PRESSURE_FILE=${JSON.stringify(pressureFile)}`,
    `PRESSURE_GATE=${opts.pressureGate ?? 30}`,
    `LOAD_GATE=${opts.loadGate ?? 108}`,
    `GATE_FORCE=${opts.force ? 1 : 0}`,
    'log() { echo "LOG: $*" >&2; }', // stderr, exactly like the real log()
    'check_staleness() { echo "CALLED: check_staleness" >&2; }',
    'skip_cleanup() { echo "CALLED: skip_cleanup" >&2; }',
    // WI-38285: terminal paths emit through verdict(), which banks the record to
    // $STATE_DIR/verdicts.jsonl and then echoes the byte-identical line. This harness evals the
    // admission chain in isolation with no STATE_DIR, and what it asserts on is the EMITTED
    // line, so the stub keeps just that half.
    VERDICT_SHELL_STUB,
    extractAdmissionChain(),
    'echo "REACHED: past-admission"',
  ].join('\n');

  let stdout = '';
  let stderr = '';
  let code = 0;
  try {
    const out = spawnSync('bash', ['-c', script], { encoding: 'utf8', timeout: 30_000 });
    stdout = out.stdout ?? '';
    stderr = out.stderr ?? '';
    code = out.status ?? -1;
  } catch {
    /* spawnSync does not throw on a nonzero exit; a throw here is a harness failure */
  }
  return {
    stdout,
    stderr,
    /** everything an operator watching journald would actually see */
    journal: stdout,
    code,
    admitted: stdout.includes('REACHED: past-admission'),
    skipLine: stdout.split('\n').find((l) => l.startsWith('GATE: SKIPPED')) ?? '',
  };
}

describe('live-federation gate §1 admission (WI-6151)', () => {
  describe('behavioral — the real chain out of the shipping script', () => {
    it('ADMITS a busy-but-uncontended box: the exact case that skipped all day 2026-07-26', () => {
      // loadavg 149.81 > LOAD_GATE 108 — the old gate skipped here. PSI says the box is not
      // actually stalled (deferential nice-10 work yields), so the run must now proceed.
      const r = runAdmission({ loadavg: 149.81, pressure: { avg10: 3.25, avg60: 2.33 } });
      expect(r.admitted, `expected admission, got:\n${r.stdout}\n---stderr---\n${r.stderr}`).toBe(
        true,
      );
      expect(r.skipLine).toBe('');
      expect(r.stderr).toMatch(/admission OK: cpu-pressure-some-avg60 2\.33 <= gate 30/);
    });

    it('makes the PROCEED decision visible in the journal — stdout, not just log()/stderr', () => {
      // The regression this pins: log() writes to stderr and stderr does NOT reach this
      // unit's journal (verified — the whole 13:39-14:25 run emitted zero "[live-fed-gate …]"
      // lines to journald). So an admission decision recorded only via log() leaves an
      // operator watching the service with "Starting", 45 minutes of silence, then a verdict,
      // and no way to know what admission decided or on what numbers.
      const r = runAdmission({ loadavg: 149.81, pressure: { avg60: 2.33 } });
      const line = r.journal.split('\n').find((l) => l.startsWith('ADMISSION: PROCEED'));
      expect(line, `no ADMISSION line on stdout; stdout was:\n${r.stdout}`).toBeTruthy();
      expect(line).toContain('cpu-pressure-some-avg60 2.33 <= 30');
      // it carries the host loadavg too, so a forensic reader keeps the number
      expect(line).toContain('host loadavg 149.81');
      // and it must NOT squat the verdict namespace consumers pattern-match
      expect(line!.startsWith('GATE: ')).toBe(false);
      expect(r.journal).not.toMatch(/^GATE: /m);
    });

    it('SKIPS a genuinely CPU-contended box, naming the pressure signal', () => {
      const r = runAdmission({ loadavg: 40, pressure: { avg60: 61.5 } });
      expect(r.admitted).toBe(false);
      expect(r.code).toBe(0); // a skip is not a failure
      expect(r.skipLine).toContain('cpu-pressure-some-avg60 61.5 > 30');
      expect(r.stderr).toContain('CALLED: check_staleness');
      expect(r.stderr).toContain('CALLED: skip_cleanup');
    });

    it('falls back to LOAD_GATE — and only then — when the kernel exposes no PSI', () => {
      const high = runAdmission({ loadavg: 149.81 }); // no pressure file at all
      expect(high.admitted).toBe(false);
      expect(high.skipLine).toContain('loadavg-fallback-no-psi 149.81 > 108');

      const low = runAdmission({ loadavg: 12 });
      expect(low.admitted, `expected admission, got:\n${low.stdout}`).toBe(true);
      expect(low.stderr).toMatch(/admission OK: loadavg-fallback-no-psi 12 <= gate 108/);
    });

    it('treats malformed PSI as "no signal" without resolving the browser verdict CLI', () => {
      // Reading a garbled file as 0 would admit blind; it must fall back to LOAD_GATE instead.
      const dir = mkdtempSync(join(tmpdir(), 'fedgate-admission-bad-'));
      const bad = join(dir, 'cpu.pressure');
      writeFileSync(bad, 'this is not psi output\n');
      const loadFile = join(dir, 'loadavg');
      writeFileSync(loadFile, '149.81 1 1 1/1 1\n');
      // Make an omitted shell stub fail immediately and deterministically instead of depending
      // on whether the real browser CLI happens to be installed on the test host.
      const externalVerdict = join(dir, 'verdict');
      writeFileSync(
        externalVerdict,
        '#!/usr/bin/env bash\necho "EXTERNAL_VERDICT_MUST_NOT_RUN" >&2\nexit 97\n',
      );
      chmodSync(externalVerdict, 0o755);
      const script = [
        'set -uo pipefail',
        `LOADAVG_FILE=${JSON.stringify(loadFile)}`,
        `CPU_PRESSURE_FILE=${JSON.stringify(bad)}`,
        'PRESSURE_GATE=30',
        'LOAD_GATE=108',
        'GATE_FORCE=0',
        'log() { echo "LOG: $*" >&2; }',
        'check_staleness() { :; }',
        'skip_cleanup() { :; }',
        VERDICT_SHELL_STUB,
        extractAdmissionChain(),
        'echo "REACHED: past-admission"',
      ].join('\n');
      const out = spawnSync('bash', ['-c', script], {
        encoding: 'utf8',
        timeout: 30_000,
        env: { ...process.env, PATH: `${dir}:${process.env.PATH ?? ''}` },
      });
      const stdout = out.stdout ?? '';
      expect(out.status).toBe(0);
      expect(out.stderr ?? '').not.toContain('EXTERNAL_VERDICT_MUST_NOT_RUN');
      expect(stdout).not.toContain('REACHED: past-admission');
      expect(stdout).toContain('loadavg-fallback-no-psi 149.81 > 108');
    });

    it('GATE_FORCE=1 still overrides the pressure skip (attended validation)', () => {
      const r = runAdmission({ loadavg: 40, pressure: { avg60: 61.5 }, force: true });
      expect(r.admitted).toBe(true);
      expect(r.stderr).toContain('GATE_FORCE=1');
      expect(r.stderr).toContain('storm downgrade still armed');
    });

    it('keeps the historical `GATE: SKIPPED (` token journal readers grep for', () => {
      const r = runAdmission({ loadavg: 40, pressure: { avg60: 61.5 } });
      expect(r.skipLine.startsWith('GATE: SKIPPED (')).toBe(true);
      // and still carries the host loadavg for forensics, explicitly labelled as NOT the signal
      expect(r.skipLine).toContain('host loadavg 40');
      expect(r.skipLine).toContain('NOT the admission signal');
    });
  });

  describe('static — pins the shape of the fix', () => {
    it('no longer decides admission by comparing a loadavg value to LOAD_GATE', () => {
      expect(gate).not.toMatch(/^if awk "BEGIN\{exit !\(\$LOAD1 > \$LOAD_GATE\)\}"; then$/m);
      expect(gate).toMatch(/^if awk "BEGIN\{exit !\(\$ADMIT_VALUE > \$ADMIT_GATE\)\}"; then$/m);
    });

    it('does NOT raise LOAD_GATE — the fix changes the measurand, not the threshold (D-003)', () => {
      // Owner decision D-003 (plan p2p-public-release-remaining-lanes-2026-07-16): the durable
      // fix for the load path is isolation, NOT a bigger number. If this line ever changes,
      // that is a threshold raise wearing this fix as cover — re-read D-003 first.
      expect(gate).toContain(
        'LOAD_GATE="${LOAD_GATE:-$(( NPROC * 85 / 100 > 15 ? NPROC * 85 / 100 : 15 ))}"',
      );
    });

    it('defaults PRESSURE_GATE and keeps both signals overridable from the environment', () => {
      expect(gate).toContain('PRESSURE_GATE="${PRESSURE_GATE:-30}"');
      expect(gate).toContain('${CPU_PRESSURE_FILE:-/sys/fs/cgroup/cpu.pressure}');
      expect(gate).toContain('${LOADAVG_FILE:-/proc/loadavg}');
    });

    it('reads `some`, not `full` (full is structurally 0 on a many-core host)', () => {
      const chain = extractAdmissionChain();
      expect(chain).toContain("grep -m1 '^some '");
      expect(chain).not.toMatch(/grep -m1 '\^full '/);
    });
  });
});
