/**
 * live-federation-gate-matrix-leg-staleness.test.ts — regression guard for EI-18657324526667507.
 *
 * THE BUG: the live-federation gate's `local-matrix` leg had THREE independent suppression
 * paths — the LOAD_GATE defer, the MATRIX_TTL_H (144h) cadence window, and the §0z rig-busy
 * pre-check — and every one of them is an individually-correct, well-logged no-op that
 * **exits 0**. None was distinguishable from "ran and was fine" at any consuming surface, so
 * the leg could sit dark for days while every surface read healthy (measured live: 205 triage
 * banks, `last-matrix-green` ABSENT — i.e. the leg had NEVER produced a verdict — while
 * `last-run` was minutes old).
 *
 * WHY check_staleness() did NOT already cover it: that function only watches the GATE-WIDE
 * `last-green`, and it early-returns while that is fresh. The cheap content-matrix leg keeps
 * `last-green` fresh on its own, so a GREEN gate actively HID a never-running local-matrix leg.
 * That is the load-bearing subtlety this test pins.
 *
 * THE FIX: a `last-matrix-verdict` stamp ("when did this leg last DECIDE anything", distinct
 * from `last-matrix-green` = "when was it last GOOD") + a `check_matrix_staleness()` detector
 * called on every exit path INCLUDING the green one, with a threshold DERIVED from MATRIX_TTL_H
 * so raising the TTL can never silently disarm its own detector.
 *
 * STATIC leg: pins the structural invariants in source (derived threshold, the green-path call,
 * the ordering inside check_staleness, starvation != verdict) so a later edit cannot quietly
 * reintroduce the silent-suppression shape.
 * BEHAVIORAL leg: extracts the REAL helpers + detector out of the shipping script and evals
 * them under bash against a temp state dir — proving the detector fires when the leg has never
 * decided, STILL fires when the gate-wide green is fresh (the actual bug), stays silent on a
 * fresh verdict, and dedups.
 *
 *   cd packages/operator-core && npx vitest run lib/live-federation-gate-matrix-leg-staleness.test.ts
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
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
const GATE_PATH = join(ROOT, 'papercusp-desktop', 'bin', 'live-federation-gate.sh');
const gate = readFileSync(GATE_PATH, 'utf8');

/** Pull a multi-line `name() { … }` (closing brace at column 0) out of the shipping script. */
function extractBlockFn(name: string): string {
  const m = gate.match(new RegExp(`^${name}\\(\\) \\{[\\s\\S]*?\\n\\}$`, 'm'));
  expect(m?.[0], `could not extract ${name}() from the gate source`).toBeTruthy();
  return m![0];
}
/** Pull a single-line `name() { … }` out of the shipping script. */
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

const HOUR = 3600;

/**
 * Run the REAL detector (plus the real now_s/age_h helpers) from the shipping script against a
 * scratch state dir. `log`/`file_ei` are stubbed to observable markers — those are the gate's
 * I/O edges (journald + curl-MCP), not the logic under test.
 */
function runDetector(state: Record<string, number>, env: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'fedgate-legstale-'));
  const nowS = Math.floor(Date.now() / 1000);
  for (const [file, ageH] of Object.entries(state)) {
    writeFileSync(join(dir, file), String(nowS - ageH * HOUR));
  }
  const script = [
    'set -uo pipefail',
    `STATE_DIR=${JSON.stringify(dir)}`,
    extractLineFn('now_s'),
    extractLineFn('age_h'),
    'log() { echo "LOG:$*"; }',
    'file_ei() { echo "EI_TITLE:$1"; echo "EI_BODY:$2"; }',
    extractLine(/^MATRIX_STALE_H=.*$/m, 'the MATRIX_STALE_H default-resolution line'),
    extractLine(/^MATRIX_LEG_STALE=0$/m, 'the MATRIX_LEG_STALE initializer'),
    extractBlockFn('check_matrix_staleness'),
    extractLineFn('matrix_stale_suffix'),
    // Called twice on purpose so a single invocation proves the dedup guard too.
    'check_matrix_staleness',
    'echo "SUFFIX:$(matrix_stale_suffix)"',
    'echo "---SECOND---"',
    'check_matrix_staleness',
  ].join('\n');
  const out = execFileSync('bash', ['-c', script], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH ?? '', ...env },
    timeout: 60_000,
    killSignal: 'SIGKILL',
  });
  const [first, second = ''] = out.split('---SECOND---');
  return { first, second, all: out, dir };
}

describe('EI-18657324526667507: local-matrix leg staleness is visible regardless of WHY it did not run', () => {
  describe('static: the structural invariants that keep the signal un-suppressible', () => {
    it('stamps a last-matrix-verdict distinct from last-matrix-green ("decided" vs "was good")', () => {
      expect(gate).toMatch(/last-matrix-verdict/);
      // Both must exist: collapsing them back into one file re-hides a leg that only ever FAILs.
      expect(gate).toMatch(/last-matrix-green/);
    });

    it('derives MATRIX_STALE_H from MATRIX_TTL_H, so raising the TTL cannot disarm the detector', () => {
      const line = extractLine(/^MATRIX_STALE_H=.*$/m, 'MATRIX_STALE_H');
      expect(line).toMatch(/MATRIX_TTL_H/);
      // A bare independent literal (e.g. `${MATRIX_STALE_H:-192}`) is exactly the drift this avoids.
      expect(line).not.toMatch(/MATRIX_STALE_H:-\d+\s*}/);
    });

    it('check_staleness() invokes the leg check BEFORE its own gate-wide green early-return', () => {
      const fn = extractBlockFn('check_staleness');
      const callIdx = fn.indexOf('check_matrix_staleness');
      const earlyReturnIdx = fn.indexOf('return 0');
      expect(callIdx, 'check_staleness must call check_matrix_staleness').toBeGreaterThan(-1);
      expect(
        callIdx,
        'the leg check must run BEFORE the fresh-green early-return, or a fresh gate-wide green suppresses it — the original bug',
      ).toBeLessThan(earlyReturnIdx);
    });

    it('the GREEN exit path calls check_matrix_staleness (the state that hid the dark leg)', () => {
      const greenBlock = gate.match(/echo "\$\(now_s\)" >"\$STATE_DIR\/last-green"[\s\S]*?GATE: GREEN[^\n]*\n/);
      expect(greenBlock?.[0], 'could not locate the GREEN exit path').toBeTruthy();
      expect(greenBlock![0]).toMatch(/check_matrix_staleness/);
    });

    it('the GREEN path does NOT clear the leg-staleness dedup file (a green gate is not proof the leg ran)', () => {
      const greenRm = gate.match(/last-green"; rm -f [^\n]*/);
      expect(greenRm?.[0]).toBeTruthy();
      expect(greenRm![0]).not.toMatch(/matrix-stale-ei-filed/);
    });

    it('a starvation downgrade does not count as a verdict (it means nothing was proven)', () => {
      // The stamp must be gated on the result still being FAIL after the SKIPPED-STARVATION downgrade.
      expect(gate).toMatch(
        /\[ "\$MATRIXFULL_RES" = FAIL \] && \{ echo "\$\(now_s\)" >"\$STATE_DIR\/last-matrix-verdict"/,
      );
    });

    it('the script still parses (bash -n) after the edit', () => {
      expect(() =>
        execFileSync('bash', ['-n', GATE_PATH], {
          encoding: 'utf8',
          timeout: 10_000,
          killSignal: 'SIGKILL',
        }),
      ).not.toThrow();
    });
  });

  describe('behavioral: the real detector, evaluated under bash', () => {
    it('default threshold resolves to MATRIX_TTL_H + 48h grace, and follows a raised TTL', () => {
      const line = extractLine(/^MATRIX_STALE_H=.*$/m, 'MATRIX_STALE_H');
      const read = (env: Record<string, string>) =>
        execFileSync('bash', ['-c', `${line}; echo "$MATRIX_STALE_H"`], {
          encoding: 'utf8',
          env: { PATH: process.env.PATH ?? '', ...env },
          timeout: 30_000,
          killSignal: 'SIGKILL',
        }).trim();
      expect(read({})).toBe('192'); // 144 + 48
      expect(read({ MATRIX_TTL_H: '300' })).toBe('348'); // detector moves WITH the cadence
      expect(read({ MATRIX_STALE_H: '24' })).toBe('24'); // explicit override still wins
    });

    it('fires when the leg has NEVER produced a verdict (the live state that went unnoticed)', () => {
      const { first } = runDetector({});
      expect(first).toMatch(/LOG:STALE-LEG/);
      expect(first).toMatch(/NEVER/);
      expect(first).toMatch(/EI_TITLE:.*LEG STALE/);
      expect(first).toMatch(/SUFFIX: \[WARN: local-matrix leg STALE/);
    });

    it('THE BUG: still fires when the gate-wide green is FRESH but the leg is dark', () => {
      // Precisely the state that read healthy for days: content-matrix keeps last-green fresh
      // while local-matrix has decided nothing. A fresh green must NOT suppress the leg signal.
      const { first } = runDetector({ 'last-green': 1, 'last-matrix-verdict': 400 });
      expect(first).toMatch(/LOG:STALE-LEG/);
      expect(first).toMatch(/400h ago/);
      expect(first).toMatch(/EI_TITLE:.*LEG STALE/);
    });

    it('stays silent while the leg is producing verdicts on cadence (no false alarm)', () => {
      const { all } = runDetector({ 'last-matrix-verdict': 100 }); // < 192h threshold
      expect(all).not.toMatch(/STALE-LEG/);
      expect(all).not.toMatch(/EI_TITLE/);
      expect(all).toMatch(/SUFFIX:\s*$/m); // no marker appended to the verdict line
    });

    it('a stale-but-recently-green leg is still stale (last-matrix-green is not a verdict clock)', () => {
      // Green 200h ago, no verdict since: the leg has been suppressed ever since and must surface.
      const { first } = runDetector({ 'last-matrix-green': 200, 'last-matrix-verdict': 200 });
      expect(first).toMatch(/LOG:STALE-LEG/);
    });

    it('dedups: a second call inside the window does not re-file (hourly timer would spam otherwise)', () => {
      const { first, second } = runDetector({});
      expect(first).toMatch(/EI_TITLE/);
      expect(second).not.toMatch(/EI_TITLE/);
      expect(second).not.toMatch(/STALE-LEG/);
    });
  });
});
