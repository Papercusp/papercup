/**
 * `sweepHost` must FAIL CLOSED when no X display is visible.
 *
 * Why this guard is load-bearing, in the module's own words: an empty live-display
 * set "is exactly what an unreadable /tmp produces, and it is also the one input
 * that makes EVERY bus look reapable — so it must fail closed." Invert or delete
 * the check and a transient /tmp fault turns a maintenance sweep into a kill of
 * every a11y bus on the host.
 *
 * Until WI-42400's measurement, this guard had NO executable coverage: `sweepHost`
 * built its own `nodeSweepIo()` internally, so reaching the refusal branch required
 * a real /proc and /tmp. The optional `makeIo` parameter exists solely to open that
 * seam; production still takes the default.
 *
 * `a11y-bus-sweep.test.ts` covers the sweep POLICY, and
 * `a11y-bus-sweep-wiring.test.ts` covers that the call site stays wired. Neither
 * can see this: the policy tests never construct the host wrapper, and the wiring
 * test reads source text. This file covers the third thing — that the wrapper
 * actually refuses.
 *
 * FALSIFIABILITY: `refusesLikeSweepHost` below is a deliberately-wrong control
 * that fails open. It must FAIL the same assertions the real `sweepHost` passes,
 * which is what keeps these tests evidence that the judge can fail at all rather
 * than three green checks that would also pass against broken code.
 *
 * Run: cd packages/operator-core && npx vitest run lib/desktop/a11y-bus-sweep-io-fail-closed.test.ts
 */
import { describe, expect, it } from 'vitest';
import { sweepHost } from './a11y-bus-sweep-io';
import type { SweepIo } from './a11y-bus-sweep';

type SweepOutcome = { scanned: number; reaped: number[]; raced: number[]; kept: number };

const RAN: SweepOutcome = { scanned: 3, reaped: [11], raced: [], kept: 2 };

/** A SweepIo whose only interesting axis is which displays it reports. */
function fakeIo(displays: readonly string[], log: string[]): SweepIo {
  return {
    listPids: () => [],
    readCmdline: () => null,
    readEnviron: () => null,
    ageSec: () => null,
    liveDisplays: () => new Set(displays),
    kill: () => {
      throw new Error('kill must never be reached in these tests');
    },
    log: (message: string) => void log.push(message),
  };
}

/**
 * DELIBERATELY WRONG control: the same shape as `sweepHost` but fails OPEN.
 * It exists to prove the assertions below can fail; it must never be exported.
 */
function refusesLikeSweepHost(
  run: (io: SweepIo) => SweepOutcome,
  logger?: (message: string) => void,
  makeIo: (logger?: (message: string) => void) => SweepIo = () => fakeIo([], []),
): SweepOutcome | null {
  return run(makeIo(logger));
}

describe('sweepHost fail-closed guard', () => {
  it('refuses to sweep when no X display is visible, and does not call run', () => {
    const log: string[] = [];
    let ranWith: SweepIo | null = null;

    const result = sweepHost(
      (io) => {
        ranWith = io;
        return RAN;
      },
      undefined,
      () => fakeIo([], log),
    );

    expect(result).toBeNull();
    expect(ranWith).toBeNull();
    expect(log.join('\n')).toMatch(/refusing to sweep/i);
  });

  it('runs the sweep when at least one display is live', () => {
    const log: string[] = [];
    let ranWith: SweepIo | null = null;

    const result = sweepHost(
      (io) => {
        ranWith = io;
        return RAN;
      },
      undefined,
      () => fakeIo([':0'], log),
    );

    expect(result).toEqual(RAN);
    expect(ranWith).not.toBeNull();
    expect(log.join('\n')).not.toMatch(/refusing to sweep/i);
  });

  it('threads the caller logger into the io it builds', () => {
    const seen: string[] = [];
    sweepHost(
      () => RAN,
      (message) => void seen.push(message),
      (logger) => {
        logger?.('probe');
        return fakeIo([':0'], []);
      },
    );
    expect(seen).toContain('probe');
  });

  // ---- falsifiability controls -------------------------------------------------
  // The fail-open control must NOT satisfy the refusal contract above. If either
  // of these starts passing, the assertions have stopped discriminating and the
  // two tests above are no longer evidence of anything.

  it('CONTROL: a fail-open implementation does NOT refuse on an empty display set', () => {
    let ran = false;
    const result = refusesLikeSweepHost(() => {
      ran = true;
      return RAN;
    });
    expect(result).not.toBeNull();
    expect(ran).toBe(true);
  });

  it('CONTROL: a fail-open implementation logs no refusal', () => {
    const log: string[] = [];
    refusesLikeSweepHost(() => RAN, undefined, () => fakeIo([], log));
    expect(log.join('\n')).not.toMatch(/refusing to sweep/i);
  });
});
