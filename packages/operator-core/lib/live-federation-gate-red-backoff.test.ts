/**
 * live-federation-gate-red-backoff.test.ts — regression guard for WI-37464.
 *
 * THE BUG: a RED had NO backoff of any kind. The gate's cheap fresh-exit path read exactly two
 * markers — `last-green` (GATE_SUCCESS_TTL_H, 22h) and `last-downgrade` (GATE_DOWNGRADE_TTL_H,
 * 3h) — and `last-green` is written on the GREEN path ONLY. So the moment the gate went red,
 * `last-green` stopped advancing and NOTHING suppressed the next window: every hourly fire ran
 * the FULL heavy gate again, indefinitely, reproducing the same red at full cost.
 *
 * MEASURED 2026-08-09 (the filing evidence): the timer fires hourly
 * (`OnCalendar=*-*-* *:37:00`, `RandomizedDelaySec=600`), while live state read
 * `last-green`=2026-08-01T19:01:14Z (8 days, >> 22h) and `last-downgrade`=2026-08-03T22:43:32Z
 * (6 days, >> 3h). The five consecutive reds of 2026-08-06 were five consecutive full heavy
 * runs, and that churn on the owner's box is what got the timer stopped.
 *
 * THE FIX: a third fresh-exit leg keyed on a new `last-red` marker (GATE_RED_TTL_H, default 6h),
 * with three deliberate asymmetries that are the actual content of this guard:
 *   1. It is checked LAST of the three, so it can never mask a fresher green or downgrade.
 *   2. `last-red` is stamped ONLY when the red was confirmed TRACKED somewhere durable. An
 *      untracked red (filing unconfirmed, no open duplicate) deliberately re-runs next window —
 *      a duplicate item is cheap, a silently-dropped release-gate red is not.
 *   3. A non-red outcome CLEARS it, so the longer red TTL cannot keep governing after the state
 *      has moved on and over-suppress the shorter downgrade retry.
 * The TTL is longer than the downgrade TTL on purpose: a starvation downgrade is ENVIRONMENTAL
 * and may clear on its own, whereas a RED is a STABLE code fact that re-running cannot change.
 *
 * STATIC leg: pins the marker's single writer, its two clearers, and the ordering/nesting the
 * three asymmetries above depend on.
 * BEHAVIORAL leg: evals the REAL fresh-exit block and the REAL stamp block out of the shipping
 * script under bash against a scratch state dir, proving each branch fires on the state it
 * claims to fire on — including the GATE_FORCE bypass and the strict-< TTL boundary.
 *
 *   cd packages/operator-core && npx vitest run lib/live-federation-gate-red-backoff.test.ts
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
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
// PROBE_SCRIPT lets scripts/mutation-probe.sh point this suite at a MUTATED COPY outside the
// tree (tier 2), so proving the guard falsifiable never dirties the shared checkout — the
// sweep race that committed a mutant in EI-19450431506682666.
const GATE_PATH = process.env.PROBE_SCRIPT || join(ROOT, 'papercusp-desktop', 'bin', 'live-federation-gate.sh');
const gate = readFileSync(GATE_PATH, 'utf8');

/** Extract a ONE-LINE shell function (`name() { ...; }` all on a single line). */
function extractOneLineFn(name: string): string {
  const m = gate.match(new RegExp(`^${name}\\(\\) \\{.*\\}$`, 'm'));
  expect(m?.[0], `could not extract the one-line ${name}() from the gate source`).toBeTruthy();
  return m![0];
}
/** Extract a top-level `if ...; then ... fi` block whose `fi` sits at column 0. */
function extractIfBlock(firstLine: RegExp, what: string): string {
  const m = gate.match(new RegExp(`^${firstLine.source}\\n[\\s\\S]*?\\n^fi$`, 'm'));
  expect(m?.[0], `could not extract ${what} from the gate source`).toBeTruthy();
  return m![0];
}
function extractLine(re: RegExp, what: string): string {
  const m = gate.match(re);
  expect(m?.[0], `could not extract ${what} from the gate source`).toBeTruthy();
  return m![0];
}

const FRESH_EXIT_BLOCK = extractIfBlock(
  /if \[ "\$\{GATE_FORCE:-0\}" != 1 \]; then/,
  'the fresh-exit block',
);
const STAMP_BLOCK = extractIfBlock(
  /if \[ "\$red_tracked" = 1 \]; then/,
  'the last-red stamp block',
);

describe('live-federation gate: a RED backs off instead of re-running the full heavy gate hourly', () => {
  // ── STATIC leg ────────────────────────────────────────────────────────────────
  it('declares GATE_RED_TTL_H with a 6h default, env-overridable', () => {
    const decl = extractLine(/^GATE_RED_TTL_H="\$\{GATE_RED_TTL_H:-\d+\}"$/m, 'the GATE_RED_TTL_H declaration');
    expect(decl).toBe('GATE_RED_TTL_H="${GATE_RED_TTL_H:-6}"');
  });

  it('backs off LONGER for a red than for a starvation downgrade (stable code fact vs environmental)', () => {
    const red = Number(/GATE_RED_TTL_H:-(\d+)/.exec(gate)?.[1]);
    const downgrade = Number(/GATE_DOWNGRADE_TTL_H:-(\d+)/.exec(gate)?.[1]);
    expect(Number.isFinite(red) && Number.isFinite(downgrade)).toBe(true);
    expect(red).toBeGreaterThan(downgrade);
  });

  it('has EXACTLY ONE writer of last-red, and it sits inside the red_tracked branch', () => {
    // The whole "untracked reds still re-run" guarantee rests on there being no other writer.
    const writers = gate.match(/>"\$STATE_DIR\/last-red"/g) ?? [];
    expect(writers).toHaveLength(1);
    expect(STAMP_BLOCK).toContain('>"$STATE_DIR/last-red"');
  });

  it('does NOT stamp last-red when the red is untracked — it says so instead', () => {
    // An unconfirmed filing must leave the next window free to re-run and re-attempt.
    expect(STAMP_BLOCK).toMatch(/^else$/m);
    expect(STAMP_BLOCK).toMatch(/NOT tracked anywhere durable/);
    expect(STAMP_BLOCK).toMatch(/RE-RUNS/);
    // The else-branch must not smuggle a stamp in.
    const elseArm = STAMP_BLOCK.slice(STAMP_BLOCK.search(/^else$/m));
    expect(elseArm).not.toContain('>"$STATE_DIR/last-red"');
  });

  it('stamps AFTER the filing block, so all three tracked branches reach it', () => {
    // fresh marker / existing open duplicate / freshly filed all converge on the same stamp.
    // The RED filing call may carry trailing args (e.g. the condition-upsert key) — the
    // guard is the block ORDERING, not the call's exact argv.
    const idxFileEi = gate.search(/^\s*if file_ei "\$TITLE" "\$BODY".*; then$/m);
    const idxUntracked = gate.indexOf('red_tracked=0');
    const idxStamp = gate.indexOf('if [ "$red_tracked" = 1 ]; then');
    expect(idxFileEi).toBeGreaterThan(0);
    expect(idxUntracked).toBeGreaterThan(idxFileEi);
    expect(idxStamp).toBeGreaterThan(idxUntracked);
    // Default is tracked; only an UNCONFIRMED filing clears it.
    expect(extractLine(/^red_tracked=1$/m, 'the red_tracked default')).toBe('red_tracked=1');
    expect(gate.match(/red_tracked=0/g) ?? []).toHaveLength(1);
  });

  it('clears last-red on BOTH non-red outcomes (green and starvation-downgrade)', () => {
    // Otherwise the longer red TTL keeps governing after the state has moved on.
    const clears = gate.match(/rm -f[^\n]*last-red/g) ?? [];
    expect(clears).toHaveLength(2);
    const green = extractLine(/^\s*echo "\$\(now_s\)" >"\$STATE_DIR\/last-green"[^\n]*$/m, 'the GREEN stamp line');
    expect(green, 'the GREEN path must clear the red backoff').toContain('last-red');
    const idxStarvation = gate.indexOf('>"$STATE_DIR/last-downgrade"');
    const idxStarvationClear = gate.indexOf('rm -f "$STATE_DIR/last-red"');
    expect(idxStarvationClear).toBeGreaterThan(idxStarvation);
  });

  it('checks the red LAST of the three fresh-exit legs, so it can never mask a fresher green or downgrade', () => {
    const idxGreen = FRESH_EXIT_BLOCK.indexOf('last-green');
    const idxDowngrade = FRESH_EXIT_BLOCK.indexOf('last-downgrade');
    const idxRed = FRESH_EXIT_BLOCK.indexOf('last-red');
    expect(idxGreen).toBeGreaterThanOrEqual(0);
    expect(idxGreen).toBeLessThan(idxDowngrade);
    expect(idxDowngrade).toBeLessThan(idxRed);
  });

  it('nests the red leg inside the GATE_FORCE guard, so a forced run is never suppressed by it', () => {
    expect(FRESH_EXIT_BLOCK).toContain('GATE: FRESH-RED');
    expect(FRESH_EXIT_BLOCK).toContain('$GATE_RED_TTL_H');
    // The FRESH-RED verdict exists nowhere outside the GATE_FORCE-guarded block.
    expect(gate.match(/GATE: FRESH-RED/g) ?? []).toHaveLength(1);
  });

  it('labels the FRESH-RED verdict as still-red and NOT a green', () => {
    // A release-gate exit line that reads like a pass is the failure mode this wording prevents.
    // Verb-agnostic since WI-38285 routed every terminal path through verdict() (banks, then
    // emits the identical line); this guard is about the LABEL, not the emitting verb.
    const line = extractLine(/^\s*(?:echo|verdict) "GATE: FRESH-RED[^\n]*$/m, 'the FRESH-RED verdict line');
    expect(line).toMatch(/still red/);
    expect(line).toMatch(/NOT a green/);
    expect(line).toContain('already tracked');
  });

  // ── BEHAVIORAL leg ────────────────────────────────────────────────────────────
  /**
   * Run the REAL fresh-exit block out of the shipping script against a scratch state dir.
   * `markers` are ages in HOURS (a marker is absent unless named). `env` overrides TTLs /
   * GATE_FORCE. Returns the verdict the gate would have printed, or PROCEEDED when it fell
   * through to the heavy run.
   */
  function runFreshExit(
    markers: Partial<Record<'last-green' | 'last-downgrade' | 'last-red', number>>,
    env: Record<string, string> = {},
  ) {
    const dir = mkdtempSync(join(tmpdir(), 'fedgate-redbackoff-'));
    const state = join(dir, 'state');
    mkdirSync(state);
    const nowS = Math.floor(Date.now() / 1000);
    for (const [name, ageH] of Object.entries(markers)) {
      writeFileSync(join(state, name), String(nowS - Math.round((ageH as number) * 3600)));
    }
    const script = `#!/usr/bin/env bash
set -uo pipefail
STATE_DIR=${JSON.stringify(state)}
GATE_SUCCESS_TTL_H="\${GATE_SUCCESS_TTL_H:-22}"
GATE_DOWNGRADE_TTL_H="\${GATE_DOWNGRADE_TTL_H:-3}"
${extractLine(/^GATE_RED_TTL_H="\$\{GATE_RED_TTL_H:-\d+\}"$/m, 'the GATE_RED_TTL_H declaration')}
log() { echo "LOG: $*" >&2; }
skip_cleanup() { echo "CLEANUP" >&2; }
check_matrix_staleness() { :; }
matrix_stale_suffix() { return 0; }
# Keep this hermetic: verdict is also the name of a globally installed browser
# verification CLI on developer hosts. The extracted shipping block calls the
# gate-local function, so the harness must provide that function too.
verdict() { echo "$1"; }
${extractOneLineFn('now_s')}
${extractOneLineFn('age_h')}
${FRESH_EXIT_BLOCK}
echo "PROCEEDED"
`;
    const path = join(dir, 'run.sh');
    writeFileSync(path, script);
    const r = spawnSync('bash', [path], {
      encoding: 'utf8',
      timeout: 30_000,
      env: { ...process.env, ...env },
    });
    expect(r.error, `bash failed: ${r.error?.message}`).toBeUndefined();
    return { out: (r.stdout ?? '').trim(), err: r.stderr ?? '' };
  }

  it('PROCEEDS when nothing has ever been recorded (a box that has never red’d is unaffected)', () => {
    // age_h() returns 999999 for a missing file — the absent marker must not read as "fresh".
    expect(runFreshExit({}).out).toBe('PROCEEDED');
  });

  it('exits FRESH-RED on a tracked red inside the TTL — the hourly re-run this bug was about', () => {
    const { out, err } = runFreshExit({ 'last-red': 0 });
    expect(out).toContain('GATE: FRESH-RED');
    expect(out).not.toContain('PROCEEDED');
    expect(err).toContain('TRACKED RED');
    expect(err, 'the operator must be told how to override it').toContain('GATE_FORCE=1');
  });

  it('PROCEEDS once the red ages past the TTL', () => {
    expect(runFreshExit({ 'last-red': 7 }).out).toBe('PROCEEDED');
  });

  it('treats the TTL as strict < — exactly at the boundary it runs', () => {
    // 5h is suppressed, 6h is not. Pins the comparison the backoff window is defined by.
    expect(runFreshExit({ 'last-red': 5 }).out).toContain('GATE: FRESH-RED');
    expect(runFreshExit({ 'last-red': 6 }).out).toBe('PROCEEDED');
  });

  it('honours a GATE_RED_TTL_H override in both directions', () => {
    expect(runFreshExit({ 'last-red': 7 }, { GATE_RED_TTL_H: '24' }).out).toContain('GATE: FRESH-RED');
    expect(runFreshExit({ 'last-red': 2 }, { GATE_RED_TTL_H: '1' }).out).toBe('PROCEEDED');
  });

  it('GATE_FORCE=1 bypasses the red backoff, as it does every fresh-exit', () => {
    // This is how a fix gets verified without waiting out the TTL.
    expect(runFreshExit({ 'last-red': 0 }, { GATE_FORCE: '1' }).out).toBe('PROCEEDED');
  });

  it('a fresher GREEN wins over a stale red — the red leg cannot mask it', () => {
    const { out } = runFreshExit({ 'last-red': 0, 'last-green': 1 });
    expect(out).toContain('GATE: FRESH (green');
    expect(out).not.toContain('FRESH-RED');
  });

  it('a fresher DOWNGRADE wins over a red — the longer red TTL never over-suppresses the short retry', () => {
    const { out } = runFreshExit({ 'last-red': 0, 'last-downgrade': 1 });
    expect(out).toContain('GATE: FRESH-DOWNGRADE');
    expect(out).not.toContain('FRESH-RED');
  });

  it('still PROCEEDS when green and downgrade are stale and there is no red', () => {
    // The pre-fix production state (green 8d old, downgrade 6d old) — a full heavy run is correct
    // here; the fix must not have made a never-red box go quiet.
    expect(runFreshExit({ 'last-green': 192, 'last-downgrade': 144 }).out).toBe('PROCEEDED');
  });

  /** Run the REAL stamp block against a scratch state dir with the given red_tracked value. */
  function runStamp(redTracked: 0 | 1) {
    const dir = mkdtempSync(join(tmpdir(), 'fedgate-redstamp-'));
    const state = join(dir, 'state');
    mkdirSync(state);
    const script = `#!/usr/bin/env bash
set -uo pipefail
STATE_DIR=${JSON.stringify(state)}
red_tracked=${redTracked}
log() { echo "LOG: $*" >&2; }
${extractOneLineFn('now_s')}
${STAMP_BLOCK}
`;
    const path = join(dir, 'run.sh');
    writeFileSync(path, script);
    const r = spawnSync('bash', [path], { encoding: 'utf8', timeout: 30_000 });
    expect(r.error, `bash failed: ${r.error?.message}`).toBeUndefined();
    return { stamped: existsSync(join(state, 'last-red')), err: r.stderr ?? '' };
  }

  it('stamps last-red when the red is TRACKED', () => {
    expect(runStamp(1).stamped).toBe(true);
  });

  it('does NOT stamp last-red when the red is UNTRACKED, and says why', () => {
    // The asymmetry that keeps an unreported red loud: no marker ⇒ the next window re-runs.
    const { stamped, err } = runStamp(0);
    expect(stamped).toBe(false);
    expect(err).toContain('NOT tracked anywhere durable');
  });
});
