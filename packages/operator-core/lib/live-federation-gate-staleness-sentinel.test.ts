/**
 * live-federation-gate-staleness-sentinel.test.ts — regression guard for
 * agent-pipeline-state-truthfulness-2026-08-02 P-005 (see plan Decision D-002).
 *
 * THE BUG (a) — A SENTINEL RENDERED AS A MEASUREMENT. `age_h` returns the sentinel 999999
 * when its marker file does not exist:
 *
 *   age_h() { local f="$1"; [ -f "$f" ] || { echo 999999; return; }; … }
 *
 * As a COMPARISON value that is correct and deliberate: 999999 fails every `-lt <threshold>`
 * guard, so "no marker" reads as "stale", which is the safe direction. The defect is that
 * `check_staleness` then interpolated it straight into a human-facing title, and shipped
 *
 *   "live-federation-gate STALE: no green run for 999999h — the shared-hive release signal is dark"
 *
 * on four real work-items (WI-3235, WI-3442, WI-5629, WI-5718 — the last two still open).
 * 999999h is ~114 years; it reads as a measured duration and is not one.
 *
 * WHY ONLY THIS CALL SITE LEAKED: every other age_h consumer sits behind an `-lt` that the
 * sentinel fails, so the sentinel never reaches their prose. In check_staleness the `-lt` IS
 * the early return, so the sentinel path is precisely the one that falls THROUGH into the
 * message. That asymmetry is why a single site leaked, repeatedly.
 *
 * WHY IT MATTERS BEYOND COSMETICS: "went stale after a green" and "has never once been green"
 * are different diagnoses with different first moves — a fresh/never-working install versus a
 * regression. The sentinel collapsed the second into a nonsense version of the first.
 *
 * THE BUG (b) — REPEAT FILING. The RED path already carries two corrections the STALE path
 * never received: `find_open_duplicate` (bug-drain-200k, 2026-07-20 — the local ephemeral
 * marker cannot see a still-OPEN item once it ages out) and "stamp the marker ONLY on a
 * CONFIRMED filing" (2026-08-01 — stamping unconditionally turns an unconfirmed filing into a
 * silently SUPPRESSED one). Both WI-5629 and WI-5718 were filed AFTER find_open_duplicate
 * existed; it was simply never wired into this path.
 *
 * STATIC leg: pins that age_h KEEPS the 999999 comparison sentinel (the fix is at the render
 * layer, not by weakening the guard) and that find_open_duplicate is defined before its
 * callers. BEHAVIORAL leg: evals the REAL check_staleness out of the shipping script under
 * bash against a scratch state dir with stubbed I/O, proving what it would actually file.
 *
 *   cd packages/operator-core && npx vitest run lib/live-federation-gate-staleness-sentinel.test.ts
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

/** Extract a multi-line shell function by name, from its header to the column-0 `}`. */
function extractFn(name: string): string {
  const m = gate.match(new RegExp(`^${name}\\(\\) \\{[\\s\\S]*?\\n\\}$`, 'm'));
  expect(m?.[0], `could not extract ${name}() from the gate source`).toBeTruthy();
  return m![0];
}

const AGE_H = (() => {
  const m = gate.match(/^age_h\(\) \{.*$/m);
  expect(m?.[0], 'could not extract the one-line age_h() from the gate source').toBeTruthy();
  return m![0];
})();

interface RunOpts {
  /** Write a last-green marker this many hours old. Omit ⇒ the marker never existed. */
  lastGreenAgeH?: number;
  /** What the stubbed find_open_duplicate prints (an existing open WI id, or nothing). */
  duplicateId?: string;
  /** Whether the stubbed file_ei reports a CONFIRMED filing. */
  fileEiSucceeds?: boolean;
}

/**
 * Run the REAL check_staleness out of the shipping script, with only its I/O stubbed:
 * file_ei records what it was asked to file, find_open_duplicate is injectable, and
 * check_matrix_staleness is neutralized so this exercises the gate-wide path alone.
 */
function runCheckStaleness(opts: RunOpts = {}): { out: string; markerStamped: boolean } {
  const { lastGreenAgeH, duplicateId = '', fileEiSucceeds = true } = opts;
  const dir = mkdtempSync(join(tmpdir(), 'lfg-stale-'));
  const nowS = Math.floor(Date.now() / 1000);
  if (lastGreenAgeH != null) {
    writeFileSync(join(dir, 'last-green'), String(nowS - lastGreenAgeH * 3600));
  }

  const script = `
set -uo pipefail
STATE_DIR=${JSON.stringify(dir)}
GATE_STALE_DAYS=3
now_s() { date +%s; }
log() { printf 'LOG:%s\\n' "$1"; }
# Stubs for the two I/O boundaries — everything else below is the shipping source.
file_ei() { printf 'FILED_TITLE:%s\\n' "$1"; printf 'FILED_BODY:%s\\n' "$2"; return ${fileEiSucceeds ? 0 : 1}; }
find_open_duplicate() { printf '%s' ${JSON.stringify(duplicateId)}; }
check_matrix_staleness() { :; }   # isolate the gate-wide path

${AGE_H}
${extractFn('check_staleness')}

check_staleness
`;
  const out = execFileSync('bash', ['-c', script], { encoding: 'utf8', timeout: 30_000 });
  return { out, markerStamped: existsSync(join(dir, 'stale-ei-filed')) };
}

describe('P-005 (a) — the 999999 age_h sentinel must never render as a duration', () => {
  it('NO last-green marker ever written: files "NEVER RECORDED", never the raw sentinel', () => {
    const { out } = runCheckStaleness(); // no marker at all ⇒ age_h returns 999999

    // The regression, stated exactly: this is the string that shipped on four work-items.
    expect(out).not.toContain('999999');
    expect(out).not.toContain('no green run for 999999h');

    const title = out.match(/^FILED_TITLE:(.*)$/m)?.[1] ?? '';
    expect(title).toContain('NO GREEN RUN EVER RECORDED');
    // The rest of the alarm must survive the rewrite.
    expect(title).toContain('the shared-hive release signal is dark');
    // The body must carry the same distinction, not just the title.
    expect(out).toMatch(/^FILED_BODY:.*NO GREEN RUN EVER RECORDED/m);
  });

  it('a REAL stale age still renders as a real duration (the fix does not blanket-erase ages)', () => {
    const { out } = runCheckStaleness({ lastGreenAgeH: 100 }); // > GATE_STALE_DAYS(3)*24 = 72h

    const title = out.match(/^FILED_TITLE:(.*)$/m)?.[1] ?? '';
    expect(title).toMatch(/no green run for 100h/);
    expect(title).not.toContain('NEVER');
    expect(out).not.toContain('999999');
  });

  it('a FRESH green short-circuits before filing anything at all', () => {
    const { out, markerStamped } = runCheckStaleness({ lastGreenAgeH: 1 }); // < 72h
    expect(out).not.toContain('FILED_TITLE:');
    expect(markerStamped).toBe(false);
  });
});

describe('P-005 (b) — the STALE path gets the RED path\'s two corrections', () => {
  it('a still-OPEN duplicate suppresses the filing (find_open_duplicate is wired in)', () => {
    const { out, markerStamped } = runCheckStaleness({ duplicateId: 'WI-5718' });

    expect(out).not.toContain('FILED_TITLE:');
    expect(out).toMatch(/already tracked as still-OPEN WI-5718/);
    // The marker IS stamped here: the condition is genuinely tracked, so staying quiet
    // for the window is correct — that is the whole point of the dedup.
    expect(markerStamped).toBe(true);
  });

  it('an UNCONFIRMED filing does NOT stamp the marker — an unconfirmed alarm must not self-suppress', () => {
    const { out, markerStamped } = runCheckStaleness({ fileEiSucceeds: false });

    expect(out).toContain('FILED_TITLE:'); // it tried
    expect(markerStamped).toBe(false); // …and refused to claim it succeeded
    expect(out).toMatch(/NOT CONFIRMED/);
  });

  it('a CONFIRMED filing does stamp the marker', () => {
    const { markerStamped } = runCheckStaleness({ fileEiSucceeds: true });
    expect(markerStamped).toBe(true);
  });
});

describe('P-005 — static invariants in the shipping script', () => {
  it('age_h KEEPS the 999999 comparison sentinel — the fix belongs at the render layer', () => {
    // Weakening age_h itself (e.g. returning 0 for a missing marker) would invert every
    // `-lt` guard in the file and make "no marker" read as FRESH — the unsafe direction.
    expect(AGE_H).toContain('999999');
  });

  it('find_open_duplicate is defined BEFORE check_staleness and all of its callers', () => {
    const defIdx = gate.indexOf('\nfind_open_duplicate() {');
    expect(defIdx, 'find_open_duplicate() must be defined exactly once').toBeGreaterThan(-1);
    expect(gate.indexOf('\nfind_open_duplicate() {', defIdx + 1)).toBe(-1);

    // Under `set -uo pipefail` (no -e) a call to a not-yet-defined function is NOT fatal:
    // it returns 127 into the command substitution and yields "", which reads as "no
    // duplicate exists" — i.e. it would fail in the FILE-ANYWAY direction, silently.
    const firstCallerIdx = gate.search(/^\s+check_staleness\b/m);
    expect(firstCallerIdx).toBeGreaterThan(-1);
    expect(defIdx).toBeLessThan(firstCallerIdx);
  });
});
