/**
 * The green-gate timing chain — the recurrence guard for WI-6112.
 *
 * Four constants bound one green-checkpoint run, and they live in THREE files across
 * TWO workspaces because operator-core cannot import from apps/operator. Each file
 * carried a prose "whoever retunes one must retune the others" note, and nothing
 * enforced it — so when the suite budget was raised 55m→120m (EI-7553) the DBOS
 * reaper's no-output window stayed at 60m and silently became the TIGHTEST bound in
 * the chain: it cancelled the bookkeeping row of healthy 60–90m runs while their own
 * timeout still had 30m to go, re-arming the 2026-06-29 "reaper kills a healthy
 * checkpoint" incident that freezes `main` (→ every fleet deploy) for hours.
 *
 * This test is the missing enforcement. It is deliberately a pure-constant assertion
 * with no I/O: it is cheap enough to run in the affected-tests loop, and it fails at
 * EDIT time rather than at the next multi-hour gate freeze.
 *
 * If you are here because this test just went red: do not "fix" it by nudging one
 * number until it passes. Read the chain below, decide which link genuinely needs to
 * move, and move the OTHERS to keep the ordering — the whole point is that these four
 * numbers are one decision, not four.
 */
import { describe, expect, it } from "vitest";

import { DEFAULT_STALE_ROUTINE_FIRE_NO_OUTPUT_MS } from "@papercusp/operator-core/lib/dbos/dbos-executor-reaper";
import { GREEN_CHECKPOINT_SUITE_TIMEOUT_MS } from "@papercusp/operator-core/lib/harness/routines/release-actions";
import {
  CHECKPOINT_MAX_RUNTIME_SEC,
  MANUAL_CHECKPOINT_WATCHDOG_ENV,
  MANUAL_CHECKPOINT_WATCHDOG_MS,
  REPLACE_STALE_MIN_AGE_SEC,
} from "@papercusp/operator-core/lib/release-checkpoint-launch";

import {
  CHECKPOINT_LOCK_STALE_MS,
  DEFAULT_REFIRE_RUN_BUDGET_MS,
  MANUAL_SELF_WATCHDOG_ENV,
  MIN_MANUAL_SELF_WATCHDOG_MS,
  SELF_WATCHDOG_MS,
} from "./green-checkpoint";

const MIN = 60_000;
const m = (ms: number) => `${Math.round(ms / MIN)}m`;

type Link = readonly [name: string, ms: number];

/** The whole chain, in the order a single run passes through it. */
const CHAIN: readonly Link[] = [
  [
    "GREEN_CHECKPOINT_SUITE_TIMEOUT_MS (release-actions.ts)",
    GREEN_CHECKPOINT_SUITE_TIMEOUT_MS,
  ],
  ["SELF_WATCHDOG_MS (green-checkpoint.ts)", SELF_WATCHDOG_MS],
  [
    "DEFAULT_STALE_ROUTINE_FIRE_NO_OUTPUT_MS (dbos-executor-reaper.ts)",
    DEFAULT_STALE_ROUTINE_FIRE_NO_OUTPUT_MS,
  ],
  ["CHECKPOINT_LOCK_STALE_MS (green-checkpoint.ts)", CHECKPOINT_LOCK_STALE_MS],
];

/**
 * Returns a human-readable report of the FIRST place the chain stops increasing, or
 * null when it is strictly monotonic. Pure + exported-shaped on purpose: the test below
 * feeds it the historical BROKEN configuration, so this guard is itself guarded — an
 * always-green detector would silently stop protecting the gate.
 */
function firstInversion(chain: readonly Link[]): string | null {
  for (let i = 1; i < chain.length; i += 1) {
    const [prevName, prev] = chain[i - 1];
    const [name, cur] = chain[i];
    if (cur <= prev) {
      // Report the WHOLE chain — the link that moved is rarely the one to fix.
      const rendered = chain.map(([n, ms]) => `${n} = ${m(ms)}`).join("\n  ");
      return (
        `${name} (${m(cur)}) must be STRICTLY GREATER than ${prevName} (${m(prev)}).\n` +
        `The gate's timing chain is:\n  ${rendered}\n` +
        "See the INVARIANT comments on all four constants before changing any of them."
      );
    }
  }
  return null;
}

describe("green-gate timing chain (WI-6112)", () => {
  it("is strictly monotonic: suite timeout < self-watchdog < reaper no-output < lock stale", () => {
    expect(firstInversion(CHAIN)).toBeNull();
  });

  it("detects the historical inversion it exists to prevent", () => {
    // The exact live configuration on 2026-07-26: the suite budget had been raised to
    // 120m but the reaper's window was still the pre-bump 60m, so the reaper was the
    // tightest link and cancelled healthy runs. If this ever returns null, the detector
    // above has been broken and the real chain is no longer protected.
    const historical: readonly Link[] = [
      ["GREEN_CHECKPOINT_SUITE_TIMEOUT_MS (release-actions.ts)", 120 * MIN],
      ["SELF_WATCHDOG_MS (green-checkpoint.ts)", 180 * MIN],
      [
        "DEFAULT_STALE_ROUTINE_FIRE_NO_OUTPUT_MS (dbos-executor-reaper.ts)",
        60 * MIN,
      ],
      ["CHECKPOINT_LOCK_STALE_MS (green-checkpoint.ts)", 190 * MIN],
    ];
    const report = firstInversion(historical);
    expect(report).not.toBeNull();
    expect(report).toContain("DEFAULT_STALE_ROUTINE_FIRE_NO_OUTPUT_MS");
    // …and it must also catch an EQUAL pair, not just a smaller one.
    expect(
      firstInversion([
        ["a", 5 * MIN],
        ["b", 5 * MIN],
      ]),
    ).not.toBeNull();
  });

  it("gives the reaper a window ABOVE the whole run, not merely above the suite timeout", () => {
    // The reaper's window is a WALL-CLOCK CAP FROM WORKFLOW CREATION, not a
    // since-last-output silence timer (verified 2026-07-26 against the predicate:
    // `created_at < now - window` AND "no operation_outputs row with function_id > 0").
    // The suite writes NO DBOS step checkpoint until its single step returns, however
    // chattily it logs to disk — so a healthy run only escapes reaping by FINISHING
    // inside this window. A parent-dead run is not killed until its own self-watchdog
    // fires, so the window must clear the watchdog too, not just the suite timeout.
    expect(DEFAULT_STALE_ROUTINE_FIRE_NO_OUTPUT_MS).toBeGreaterThan(
      SELF_WATCHDOG_MS,
    );
    expect(DEFAULT_STALE_ROUTINE_FIRE_NO_OUTPUT_MS).toBeGreaterThan(
      GREEN_CHECKPOINT_SUITE_TIMEOUT_MS,
    );
  });

  it("frees the DBOS dedup pin before the run-lock becomes reclaimable", () => {
    // Ordering rationale for the last link: cancelling the non-terminal fire releases
    // the `routine:<id>` dedup pin, which is what lets the routine be requeued. If the
    // lock became stale-reclaimable FIRST, a peer could take the lock while the routine
    // was still dedup-pinned — a reclaimable lock with no fire able to use it.
    expect(DEFAULT_STALE_ROUTINE_FIRE_NO_OUTPUT_MS).toBeLessThan(
      CHECKPOINT_LOCK_STALE_MS,
    );
  });

  it("leaves the reaper enough margin to actually fire inside that gap", () => {
    // The reaper sweeps every DEFAULT_REAP_INTERVAL_MS (2m), so it observes a row up to
    // one interval AFTER the window elapses. That late observation must still land below
    // the lock-stale threshold, or the ordering above holds on paper and inverts in
    // practice. Two sweeps of headroom keeps it honest under host CPU pressure.
    const sweepHeadroom = 2 * 2 * MIN;
    expect(
      CHECKPOINT_LOCK_STALE_MS - DEFAULT_STALE_ROUTINE_FIRE_NO_OUTPUT_MS,
    ).toBeGreaterThanOrEqual(sweepHeadroom);
  });

  it("stops starting refires BEFORE the suite timeout would kill one mid-flight (EI-19343532231631821)", () => {
    // The refire budget is the new TIGHTEST link, and it belongs to the same one decision as the
    // four above. A stale-red auto-refire recurses in-process, so a refire begun near the suite
    // timeout is killed part-way through and the run dies having recorded NO verdict at all —
    // strictly worse than recording the red it already had. Keeping the budget strictly under the
    // suite timeout is what makes "stop refiring" happen before "get killed".
    expect(DEFAULT_REFIRE_RUN_BUDGET_MS).toBeLessThan(
      GREEN_CHECKPOINT_SUITE_TIMEOUT_MS,
    );
    // …with enough headroom that the deadline check (which predicts the next pass from the last
    // one) is not itself racing the timeout it exists to stay clear of.
    expect(
      GREEN_CHECKPOINT_SUITE_TIMEOUT_MS - DEFAULT_REFIRE_RUN_BUDGET_MS,
    ).toBeGreaterThanOrEqual(5 * MIN);
  });

  /**
   * WI-38026 (2026-08-12) — the EXTERNAL link in the same chain, and the one that was missing.
   *
   * The four constants above bound what the run does to ITSELF. `REPLACE_STALE_MIN_AGE_SEC`
   * bounds when someone ELSE may kill it, and it was a hand-written `20 * 60` that nothing
   * tied to the rest of the chain — six times tighter than the suite budget. So a healthy run
   * became "replaceable" ~20 min into a suite allowed to take 120, and with several agents
   * independently reacting to one red gate, three consecutive runs were SIGTERMed mid-suite
   * (1317s, 1358s, each "a replaceStale before producing a verdict"). Zero verdicts landed,
   * `main` stayed frozen 6.5h, and the tests the gate named had ALREADY been fixed in the
   * tree — the gate was simply never allowed to finish judging them.
   *
   * The invariant: a run still inside its own suite budget is not wedged, so replacement
   * cannot unlock before that budget is spent.
   */
  it("does not let a peer kill a run that is still inside its own suite budget (WI-38026)", () => {
    expect(REPLACE_STALE_MIN_AGE_SEC * 1000).toBeGreaterThanOrEqual(
      GREEN_CHECKPOINT_SUITE_TIMEOUT_MS,
    );
  });

  it("gives detached manual runs the scheduled full kill window instead of the 3h orphan backstop", () => {
    // The env name and value are duplicated across the launcher/CLI boundary intentionally:
    // importing release-actions into the low-level launcher registers routines at module load.
    // This one guard makes the duplicate a checked protocol rather than a prose convention.
    expect(MANUAL_CHECKPOINT_WATCHDOG_ENV).toBe(MANUAL_SELF_WATCHDOG_ENV);
    expect(MANUAL_CHECKPOINT_WATCHDOG_MS).toBe(
      GREEN_CHECKPOINT_SUITE_TIMEOUT_MS + 15_000,
    );
    expect(MIN_MANUAL_SELF_WATCHDOG_MS).toBe(MANUAL_CHECKPOINT_WATCHDOG_MS);
    expect(MANUAL_CHECKPOINT_WATCHDOG_MS).toBeLessThan(SELF_WATCHDOG_MS);
    expect(MANUAL_CHECKPOINT_WATCHDOG_MS).toBeLessThan(
      CHECKPOINT_MAX_RUNTIME_SEC * 1000,
    );
  });

  it("detects the historical replace-storm setting it exists to prevent", () => {
    // The literal value that shipped for months and starved the gate on 2026-08-12. If this
    // ever stops being a violation, the assertion above has been loosened into a no-op and
    // healthy runs are killable again — the same way the reaper inversion went unnoticed.
    const historicalReplaceStaleMinAgeSec = 20 * 60;
    expect(historicalReplaceStaleMinAgeSec * 1000).toBeLessThan(
      GREEN_CHECKPOINT_SUITE_TIMEOUT_MS,
    );
  });

  it("keeps replacement possible for a genuinely wedged run, below the lock-stale reclaim", () => {
    // The guard must not swing so far that replaceStale becomes unreachable: past its own
    // suite timeout a still-running process IS the EI-9672 salvage case, and it must be
    // stoppable before the lock would be reclaimed out from under it anyway.
    expect(REPLACE_STALE_MIN_AGE_SEC * 1000).toBeLessThan(
      CHECKPOINT_LOCK_STALE_MS,
    );
  });
});
