/**
 * P-006 (WI-41755). `DEFAULT_VERDICTLESS_GRACE_MS` in
 * packages/operator-core/lib/release/green-stall-watchdog.ts is a SECOND COPY of
 * `SELF_WATCHDOG_MS` from apps/operator/lib/release/green-checkpoint.ts.
 *
 * The copy is deliberate and unavoidable: `operator-core` must not import from `apps/operator`
 * (wrong layering direction). But a second copy of a truth the code owns is exactly what the
 * derived-truth ladder says will drift — so it is PINNED here (rung 2, the same pattern as the
 * sibling `gate-candidate-ref.test.ts`).
 *
 * Why the coupling is load-bearing rather than cosmetic: the grace window is the interval after
 * a fire during which "no verdict yet" is still NORMAL. `SELF_WATCHDOG_MS` is the gate's own
 * maximum lifetime for one run — past it the run kills itself. If someone RAISES the self
 * watchdog (letting runs live longer) without raising the grace, the verdict-less-death alarm
 * starts firing on runs that are legitimately still working — a false "the run vanished" that
 * sends a responder hunting a corpse that does not exist. If someone LOWERS it, the alarm goes
 * quiet for a window in which real deaths are now possible. Either way the failure is silent,
 * which is what makes it worth a build-time check.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_VERDICTLESS_GRACE_MS } from '../release/green-stall-watchdog';
import { DEFAULT_STALE_ROUTINE_FIRE_NO_OUTPUT_MS } from '../dbos/dbos-executor-reaper';
import { GREEN_CHECKPOINT_SUITE_TIMEOUT_MS } from '../release/green-checkpoint-schedule';

// lib/doc-claims → lib → operator-core → packages → <repo root>
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
// Overridable so a mutation probe can point these doc-claims at a COPY of the source
// outside the tree — mutating the tracked file in place would race git-sync's whole-tree
// sweep and can commit the mutant (the same seam dependency-generation.test.ts uses).
const GREEN_CHECKPOINT =
  process.env.DOC_CLAIM_GREEN_CHECKPOINT_SOURCE ??
  join(ROOT, 'apps/operator/lib/release/green-checkpoint.ts');
const GREEN_CHECKPOINT_SCHEDULE = join(ROOT, 'packages/operator-core/lib/release/green-checkpoint-schedule.ts');

/**
 * Pull `export const SELF_WATCHDOG_MS = <expr>;` out of source and evaluate the arithmetic.
 *
 * Returns null rather than throwing when the declaration is absent or its expression is not
 * a plain numeric literal — the caller asserts on that null explicitly, so "the constant was
 * renamed or moved" fails LOUDLY here instead of silently skipping the comparison. Only
 * digits, `_` separators, `*`, `+`, whitespace and parens are accepted; anything else
 * (an identifier, a call) is refused rather than evaluated.
 */
export function readNumericExport(source: string, name: string): number | null {
  const m = new RegExp(`export\\s+const\\s+${name}\\s*(?::\\s*number\\s*)?=\\s*([^;]+);`).exec(source);
  if (!m) return null;
  const expr = (m[1] ?? '').trim();
  if (!/^[\d_+*()\s]+$/.test(expr)) return null;
  try {
    // eslint-disable-next-line no-new-func -- input is regex-restricted to numeric arithmetic above.
    const value = Function(`"use strict"; return (${expr});`)() as unknown;
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
}

export function readSelfWatchdogMs(source: string): number | null {
  return readNumericExport(source, 'SELF_WATCHDOG_MS');
}

describe('verdict-less-death grace is pinned to the gate’s own self-watchdog deadline', () => {
  describe('fixture controls (the detector must be able to FAIL)', () => {
    it('reads a simple product expression', () => {
      expect(readSelfWatchdogMs('export const SELF_WATCHDOG_MS = 3 * 60 * 60_000;')).toBe(
        10_800_000,
      );
    });

    it('reads a plain literal and a type-annotated form', () => {
      expect(readSelfWatchdogMs('export const SELF_WATCHDOG_MS = 10800000;')).toBe(10_800_000);
      expect(readSelfWatchdogMs('export const SELF_WATCHDOG_MS: number = 60_000;')).toBe(60_000);
    });

    it('CATCHES a changed value — the drift this test exists to stop', () => {
      // The realistic drift: someone doubles the self-watchdog and never touches the copy.
      expect(readSelfWatchdogMs('export const SELF_WATCHDOG_MS = 6 * 60 * 60_000;')).not.toBe(
        DEFAULT_VERDICTLESS_GRACE_MS,
      );
    });

    it('CATCHES the declaration disappearing or being renamed', () => {
      expect(readSelfWatchdogMs('export const SELF_WATCHDOG_TIMEOUT = 3 * 60 * 60_000;')).toBeNull();
      expect(readSelfWatchdogMs('const unrelated = 1;')).toBeNull();
    });

    it('REFUSES a non-literal expression rather than evaluating it', () => {
      expect(readSelfWatchdogMs('export const SELF_WATCHDOG_MS = computeDeadline();')).toBeNull();
      expect(readSelfWatchdogMs('export const SELF_WATCHDOG_MS = OTHER_CONST * 2;')).toBeNull();
    });

    it('reads a named exported numeric expression and refuses a missing declaration', () => {
      expect(readNumericExport('export const CHECKPOINT_LOCK_STALE_MS = 190 * 60_000;', 'CHECKPOINT_LOCK_STALE_MS')).toBe(
        11_400_000,
      );
      expect(readNumericExport('const CHECKPOINT_LOCK_STALE_MS = 190 * 60_000;', 'CHECKPOINT_LOCK_STALE_MS')).toBeNull();
    });
  });

  describe('the live claim', () => {
    const source = readFileSync(GREEN_CHECKPOINT, 'utf8');

    it('SELF_WATCHDOG_MS is still declared where this pin expects it', () => {
      expect(
        readSelfWatchdogMs(source),
        'SELF_WATCHDOG_MS is no longer a numeric literal in green-checkpoint.ts — ' +
          'update this pin (and DEFAULT_VERDICTLESS_GRACE_MS) together, do not delete the check.',
      ).not.toBeNull();
    });

    it('DEFAULT_VERDICTLESS_GRACE_MS equals it', () => {
      expect(
        DEFAULT_VERDICTLESS_GRACE_MS,
        'The verdict-less-death grace window has drifted from the gate’s own self-watchdog ' +
          'deadline. Raising the watchdog without raising the grace makes the alarm fire on ' +
          'runs that are still legitimately working; lowering it blinds the alarm. Change both.',
      ).toBe(readSelfWatchdogMs(source));
    });

    it('pins the timeout-chain comment to the live constants and their source file', () => {
      const scheduleSource = readFileSync(GREEN_CHECKPOINT_SCHEDULE, 'utf8');
      const suiteTimeout = readNumericExport(scheduleSource, 'GREEN_CHECKPOINT_SUITE_TIMEOUT_MS');
      const selfWatchdog = readSelfWatchdogMs(source);
      const staleReclaim = readNumericExport(source, 'CHECKPOINT_LOCK_STALE_MS');

      expect(suiteTimeout).toBe(GREEN_CHECKPOINT_SUITE_TIMEOUT_MS);
      expect(suiteTimeout).not.toBeNull();
      expect(selfWatchdog).not.toBeNull();
      expect(staleReclaim).not.toBeNull();
      if (suiteTimeout === null || selfWatchdog === null || staleReclaim === null) return;

      expect(suiteTimeout).toBeLessThan(selfWatchdog);
      expect(selfWatchdog).toBeLessThan(DEFAULT_STALE_ROUTINE_FIRE_NO_OUTPUT_MS);
      expect(DEFAULT_STALE_ROUTINE_FIRE_NO_OUTPUT_MS).toBeLessThan(staleReclaim);
      const minutes = (ms: number) => Math.round(ms / 60_000);
      const normalizedCommentText = source.replace(/\n\s*\*\s*/g, ' ');
      expect(normalizedCommentText).toContain(
        `GREEN_CHECKPOINT_SUITE_TIMEOUT_MS in packages/operator-core/lib/release/green-checkpoint-schedule.ts — ${minutes(suiteTimeout)}m`,
      );
      expect(normalizedCommentText).toContain(
        `timeout ${minutes(suiteTimeout)}m < self-watchdog ${minutes(selfWatchdog)}m < stale-reclaim ${minutes(staleReclaim)}m`,
      );
    });
  });
});

/**
 * EVERY prose statement of the suite timeout tracks the constant — not just the two
 * phrasings pinned above.
 *
 * Measured 2026-08-27: FIVE comments in green-checkpoint.ts still read "120m" long after
 * GREEN_CHECKPOINT_SUITE_TIMEOUT_MS was deliberately lowered to 115m (the largest value
 * that still clears the hourly fire boundary). The pin above did not catch them because it
 * asserts two EXACT sentences; every other way of saying the same number was unguarded and
 * drifted. That is the derived-truth ladder's own lesson applied to itself: a pin that
 * covers one phrasing of a claim leaves every other phrasing hand-maintained.
 *
 * Why it is worth guarding rather than tolerating: this number is read during gate triage,
 * under time pressure, to decide whether a run "should have finished by now". A comment
 * claiming 120m when the kill lands at 115m sends the reader looking for a 5-minute
 * anomaly that does not exist — and the reader most likely to hit it is one debugging a
 * run that just died verdict-less, which is precisely the confusing case.
 */
describe('every prose mention of the suite timeout in green-checkpoint.ts tracks the constant', () => {
  const PATTERNS: { label: string; re: RegExp }[] = [
    { label: 'GREEN_CHECKPOINT_SUITE_TIMEOUT_MS=<N>m', re: /GREEN_CHECKPOINT_SUITE_TIMEOUT_MS=(\d+)m/g },
    { label: '<N>m suite timeout', re: /(\d+)m suite timeout/g },
    { label: 'gate-wide <N>m parent budget', re: /gate-wide (\d+)m parent budget/g },
    { label: "parent's full kill window (<N>m", re: /parent[’']s full kill window \((\d+)m/g },
    { label: 'parent-side <N>m timeout', re: /parent-side (\d+)m timeout/g },
  ];

  it('states the CURRENT value everywhere it is stated at all', () => {
    const source = readFileSync(GREEN_CHECKPOINT, 'utf-8');
    const expected = Math.round(GREEN_CHECKPOINT_SUITE_TIMEOUT_MS / 60_000);
    const found: { label: string; value: number }[] = [];

    for (const { label, re } of PATTERNS) {
      for (const m of source.matchAll(re)) found.push({ label, value: Number(m[1]) });
    }

    // CALIBRATION: if a refactor rewords every one of these, the loop above finds nothing
    // and the assertion below passes VACUOUSLY — a guard that silently stops guarding. Fail
    // loudly instead, so the patterns get re-anchored rather than quietly retired.
    expect(
      found.length,
      'no suite-timeout prose matched any known phrasing — re-anchor PATTERNS, do not delete this test',
    ).toBeGreaterThanOrEqual(PATTERNS.length);

    const stale = found.filter((f) => f.value !== expected);
    expect(
      stale,
      `these comments state a suite timeout that is not ${expected}m: ${JSON.stringify(stale)}`,
    ).toEqual([]);
  });

  it('control: the detector catches a planted stale value', () => {
    // Proves the assertion can FAIL. Without this, a broken regex and a clean file are
    // indistinguishable — both report success.
    const planted = 'gate-wide 999m parent budget.';
    const hits = [...planted.matchAll(/gate-wide (\d+)m parent budget/g)].map((m) => Number(m[1]));
    expect(hits).toEqual([999]);
    expect(hits[0]).not.toBe(Math.round(GREEN_CHECKPOINT_SUITE_TIMEOUT_MS / 60_000));
  });
});
