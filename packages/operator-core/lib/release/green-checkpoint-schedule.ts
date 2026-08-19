/**
 * The green-checkpoint gate's SCHEDULE — the cron it is seeded with, the fire period
 * that cron implies, and the margin its run budget must leave against that period.
 *
 * WHY THIS IS ITS OWN FILE (WI-39841 follow-on). The cron used to be a bare string
 * literal repeated at every site that seeds the routine, plus a fourth copy exported
 * from `harness/routines/release-actions.ts` for the phase invariant to check. That is
 * the exact mirror-drift shape WI-39841 was filed about, one level up: the invariant
 * test reads the EXPORTED constant, so editing a seed site alone leaves the guard green
 * while the real schedule diverges — and the phase collision the guard exists to catch
 * comes straight back.
 *
 * It cannot live in `release-actions.ts` because that module calls
 * `registerSystemAction()` at import time (green-checkpoint, release-trigger). The seed
 * scripts run standalone under `tsx`; importing 2.5k lines of run orchestration and
 * registering two system actions as a side effect, to read one string, is not a trade
 * worth making. So the schedule facts live HERE, in a leaf with no imports at all, and
 * everything that needs them — seeders, retrofit, the invariant test — depends on this
 * file and nothing else.
 *
 * The run BUDGET (`GREEN_CHECKPOINT_SUITE_TIMEOUT_MS`) deliberately stays in
 * `release-actions.ts`: it is a property of how a run is orchestrated, it is used there,
 * and its doc comment carries the whole timing-chain ordering. This file holds only what
 * the schedule itself asserts. `release-timing-invariants.test.ts` is where the two meet.
 */

/**
 * The cron every green-checkpoint seed site writes into `harness_shared.routines`:
 * `seed-hive-release-routines.ts`, `apps/operator/lib/release/seed-release-routines.ts`,
 * and `apps/operator/lib/release/retrofit-hive-to-gate.ts`. Hourly at :15, offset from
 * git-sync's every-10-minute ticks.
 *
 * ⚠ Not every routine firing at `0 15 * * * *` is THIS routine. `autoloop-release-readiness-monitor`
 * (seed-autoloop-release-readiness-routine.ts) independently chose the same slot to sit
 * clear of telemetry-retention/hive-canary/cargo-test, and is deliberately NOT wired to
 * this constant — coupling it would mean retuning the gate silently moved an unrelated
 * monitor. Match on the routine NAME before assuming a literal is a copy of this one.
 */
export const GREEN_CHECKPOINT_CRON = '0 15 * * * *';

/** The fire period `GREEN_CHECKPOINT_CRON` implies — one hour. */
export const GREEN_CHECKPOINT_FIRE_PERIOD_MS = 60 * 60_000;

/**
 * Minimum gap the suite timeout must leave between a deadline-kill and the next
 * scheduled fire, so the lock is demonstrably free when that fire lands.
 *
 * The slack it is compared against is `(period - (timeout % period)) % period`, and the
 * OUTER modulo is load-bearing: at a timeout that is an exact multiple of the period,
 * `timeout % period === 0` and `period - 0` reads as a FULL period of slack when the
 * truth is zero — the boundary lands epsilon inside the run, which is precisely the
 * refused fire WI-39841 measured. See `release-timing-invariants.test.ts`, which keeps
 * the old 120m value as a permanent control so a "simplification" of that expression
 * fails there instead of in production.
 */
export const GREEN_CHECKPOINT_PHASE_MARGIN_MS = 5 * 60_000;
