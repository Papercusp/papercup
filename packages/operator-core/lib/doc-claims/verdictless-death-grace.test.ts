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
const GREEN_CHECKPOINT = join(ROOT, 'apps/operator/lib/release/green-checkpoint.ts');
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
      expect(source).toMatch(
        /GREEN_CHECKPOINT_SUITE_TIMEOUT_MS in\s+packages\/operator-core\/lib\/release\/green-checkpoint-schedule\.ts — 115m/,
      );
      const minutes = (ms: number) => Math.round(ms / 60_000);
      expect(source).toContain(
        `timeout ${minutes(suiteTimeout)}m < self-watchdog ${minutes(selfWatchdog)}m < stale-reclaim ${minutes(staleReclaim)}m`,
      );
    });
  });
});
