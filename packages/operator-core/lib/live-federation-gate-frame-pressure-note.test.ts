/**
 * live-federation-gate-frame-pressure-note.test.ts — regression guard for EI-18716933933700596.
 *
 * THE BUG: every load-flavoured line the live-federation gate emitted named the HOST 1-min
 * loadavg and nothing else:
 *
 *   echo "GATE: SKIPPED-STORM (load $LOAD1_END; would-be-red: ${REDS[*]})…"
 *   echo "GATE: RED (${REDS[*]}) — $SUMMARY… ; logs in $WORK"
 *
 * Host loadavg is a SHARED-BOX aggregate and is not cgroup-scoped (WI-5639 — read from inside a
 * frame it still reports the host), so it cannot distinguish "this rig's frames were starved"
 * from "unrelated containers on the shared dev box were busy". By naming only that number, the
 * failure line actively steered every investigating agent toward "the box was too loaded" and a
 * stop — the exact false-cause the standing evidence rule forbids.
 *
 * MEASURED 2026-07-26 (the filing evidence): host /proc/loadavg 129.64 while the rig frames sat
 * at CPU 8.21%/2.34% with frame-scoped cpu.pressure some+full avg10/60/300 all 0.00. The frames
 * were idle; the load came from three unrelated long-lived pgvector containers doing D-state
 * I/O. Nothing on the failure line made that visible without a manual docker-stats correlation.
 *
 * THE FIX: one frame_pressure_note() — built on the SAME banked-serve.log scan the starvation
 * downgrade already decides on (_frame_lag_scan, so the printed number can never disagree with
 * the decided one) — appended to the STORM downgrade line, the RED verdict line, and the filed
 * EI body. It reports three distinguishable states, and says UNKNOWN rather than "clean" when
 * there is no evidence.
 *
 * STATIC leg: pins that each load-naming failure path actually carries the note.
 * BEHAVIORAL leg: evals the REAL helpers out of the shipping script under bash against a
 * scratch bank dir, proving each of the three states is reported correctly and that the
 * refactor kept check_local_matrix_frame_starvation's verdict identical to the note's.
 *
 *   cd packages/operator-core && npx vitest run lib/live-federation-gate-frame-pressure-note.test.ts
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

/** Extract a whole multi-line shell function (terminated by a `}` at column 0). */
function extractFn(name: string): string {
  const m = gate.match(new RegExp(`^${name}\\(\\) \\{[\\s\\S]*?\\n\\}$`, 'm'));
  expect(m?.[0], `could not extract ${name}() from the gate source`).toBeTruthy();
  return m![0];
}
function extractLine(re: RegExp, what: string): string {
  const m = gate.match(re);
  expect(m?.[0], `could not extract ${what} from the gate source`).toBeTruthy();
  return m![0];
}

describe('live-federation gate: every host-loadavg failure line carries the frame-scoped reading', () => {
  // ── STATIC leg ────────────────────────────────────────────────────────────────
  it('computes FRAME_NOTE from frame_pressure_note before the storm branch', () => {
    const assign = extractLine(/^FRAME_NOTE="\$\(frame_pressure_note\)"$/m, 'the FRAME_NOTE assignment');
    expect(assign).toContain('frame_pressure_note');
    // It must be computed BEFORE the storm branch, which exits 0 without reaching the RED line.
    const idxAssign = gate.indexOf('FRAME_NOTE="$(frame_pressure_note)"');
    const idxStorm = gate.indexOf('GATE: SKIPPED-STORM');
    const idxRed = gate.indexOf('GATE: RED (${REDS[*]})');
    expect(idxAssign).toBeGreaterThan(0);
    expect(idxAssign).toBeLessThan(idxStorm);
    expect(idxAssign).toBeLessThan(idxRed);
  });

  it('the SKIPPED-STORM downgrade line names the frame-scoped reading, not just the host load', () => {
    // Verb-agnostic: WI-38285 moved every terminal path from a bare `echo` to `verdict()` (which
    // banks the record before emitting the identical line). This guard is about the frame-scoped
    // READING in the line, not about which verb emits it — a reverted bare echo is caught by
    // live-federation-gate-verdict-bank.test.ts instead.
    const line = extractLine(/^\s*(?:echo|verdict) "GATE: SKIPPED-STORM \([^\n]*$/m, 'the SKIPPED-STORM verdict line');
    expect(line).toContain('load $LOAD1_END');
    expect(line, 'the storm downgrade must not name host load alone').toContain('$FRAME_NOTE');
  });

  it('the STORM downgrade log line names the frame-scoped reading', () => {
    const line = extractLine(/^\s*log "STORM: load rose to [^\n]*$/m, 'the STORM downgrade log line');
    expect(line).toContain('$FRAME_NOTE');
  });

  it('the RED verdict line names the frame-scoped reading', () => {
    const line = extractLine(/^(?:echo|verdict) "GATE: RED \(\$\{REDS\[\*\]\}\)[^\n]*$/m, 'the RED verdict line');
    expect(line, 'the RED verdict must carry the frame-scoped reading').toContain('$FRAME_NOTE');
  });

  it('the filed EI body carries the frame-scoped reading and labels the host load as shared-box', () => {
    const body = extractLine(/^BODY="Automated live-federation gate[^\n]*$/m, 'the filed-EI BODY');
    expect(body).toContain('$FRAME_NOTE');
    expect(body).toContain('$LOAD1_END');
    expect(body).toMatch(/SHARED-BOX|shared-box/);
  });

  it('the starvation predicate and the note share ONE scanner (no second, divergable scan)', () => {
    const predicate = extractFn('check_local_matrix_frame_starvation');
    const note = extractFn('frame_pressure_note');
    expect(predicate).toContain('_frame_lag_scan');
    expect(note).toContain('_frame_lag_scan');
    // The predicate must not re-implement the find/grep walk it used to own.
    expect(predicate).not.toContain('find "$bank_dir"');
  });

  // ── BEHAVIORAL leg ────────────────────────────────────────────────────────────
  /**
   * Run the REAL helpers out of the shipping script against a scratch bank dir.
   * `logs` are written as banked frame serve.logs; `maxMs: null` means a log with no
   * [event-loop-lag] line at all.
   */
  function runNote(logs: Array<{ name: string; maxMs: number | null }>) {
    const dir = mkdtempSync(join(tmpdir(), 'fedgate-framenote-'));
    const bank = join(dir, 'bank');
    mkdirSync(bank);
    for (const l of logs) {
      writeFileSync(
        join(bank, l.name),
        l.maxMs === null
          ? '[2026-07-26T00:00:00.000Z] serve up, nothing interesting\n'
          : `[2026-07-26T00:00:00.000Z] [event-loop-lag] high loop delay — maxMs: ${l.maxMs} p99: 12\n`,
      );
    }
    const script = `#!/usr/bin/env bash
set -uo pipefail
RIG_BANK_DIR=${JSON.stringify(bank)}
MATRIX_LEG_START_TS=0
GATE_RUN_START_TS=0
${extractFn('_frame_lag_scan')}
${extractFn('check_local_matrix_frame_starvation')}
${extractFn('frame_pressure_note')}
echo "SCAN: $(_frame_lag_scan 0)"
# no-arg call exercises the MATRIX_LEG_START_TS/GATE_RUN_START_TS default chain under set -u
echo "NOTE: $(frame_pressure_note)"
if check_local_matrix_frame_starvation 0; then echo "PREDICATE: starved"; else echo "PREDICATE: clean"; fi
`;
    const path = join(dir, 'run.sh');
    writeFileSync(path, script);
    const out = execFileSync('bash', [path], { encoding: 'utf8', timeout: 30_000 });
    return {
      note: /^NOTE: (.*)$/m.exec(out)?.[1] ?? '',
      scan: /^SCAN: (.*)$/m.exec(out)?.[1] ?? '',
      predicate: /^PREDICATE: (.*)$/m.exec(out)?.[1] ?? '',
    };
  }

  it('reports UNKNOWN — never "clean" — when no frame evidence was banked for this run', () => {
    const { note, predicate } = runNote([]);
    expect(note).toContain('frame-scoped: UNKNOWN');
    expect(note).toMatch(/neither rules frame starvation in nor out/);
    // The absence of evidence must not be reported as evidence of absence.
    expect(note).not.toContain('NOT starved');
    expect(predicate).toBe('clean');
  });

  it('reports frames NOT starved (with the do-not-blame-the-host clause) when the frames were idle', () => {
    // THE FILING SCENARIO: host loadavg 129.64, frames idle. The note must actively refute
    // "the box was too loaded" rather than leave the reader to infer it.
    const { note, predicate, scan } = runNote([
      { name: 'serve-a-20260726.log', maxMs: 240 },
      { name: 'serve-b-20260726.log', maxMs: 91 },
    ]);
    expect(note).toContain('frames NOT starved');
    expect(note).toContain('2 banked frame log(s)');
    expect(note).toContain('maxMs 240ms');
    expect(note).toMatch(/do NOT conclude 'the box was too loaded' from it/);
    expect(note).toContain('WI-5639');
    expect(predicate).toBe('clean');
    expect(scan).toBe('2 240 0');
  });

  it('reports STARVED with the worst maxMs when a frame log shows a real >1s stall', () => {
    const { note, predicate, scan } = runNote([
      { name: 'serve-a-20260726.log', maxMs: 4200 },
      { name: 'serve-b-20260726.log', maxMs: 120 },
    ]);
    expect(note).toContain('frame-scoped: STARVED');
    expect(note).toContain('1/2 banked frame log(s)');
    expect(note).toContain('maxMs up to 4200ms');
    expect(predicate).toBe('starved');
    expect(scan).toBe('2 4200 1');
  });

  it('keeps the 1000ms starvation threshold exactly where the downgrade decided it', () => {
    // 1000 is NOT starved (strict >); 1001 is. Pins the boundary the downgrade relies on.
    expect(runNote([{ name: 'serve-a.log', maxMs: 1000 }]).predicate).toBe('clean');
    expect(runNote([{ name: 'serve-a.log', maxMs: 1001 }]).predicate).toBe('starved');
  });

  it('a frame log with no event-loop-lag line counts as evidence-present-and-clean', () => {
    const { note, scan } = runNote([{ name: 'serve-a.log', maxMs: null }]);
    expect(note).toContain('frames NOT starved');
    expect(scan).toBe('1 0 0');
  });
});
