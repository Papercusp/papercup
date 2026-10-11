/**
 * Done-without-test detector (enforce-system-on-generic-work-2026-06-29 P-009).
 *
 * The recurrence guard for the "claimed done, no framework test" class: a feature
 * work-item that has reached a TERMINAL/done state (`passed`) but still carries
 * `requires_test` VAL assertions that NO passing test covers. That is exactly the
 * silent gap the harness-test gate exists to close — an item declared done whose
 * required VALs were never proven by a framework test. This module is the PURE
 * detection core (a roll-up + filter over per-item counts); it has NO I/O, so it is
 * fully unit-testable.
 *
 * It REUSES the plan↔test rollup (`computePlanItemTestStatus` /
 * `deriveAssertionStatus`, harness-test-rollup.ts) — the SAME join the testing tab
 * and snapshot loop use — so "is this VAL proven by a passing test?" has one tested
 * implementation. The work-item → plan-item link is `source_plan_slug` +
 * `source_plan_item_ids`; assertions are keyed `(plan_slug, item_id)`, so item ids
 * are composite-keyed by plan before the rollup to avoid a cross-plan `item_id`
 * collision (two plans can both carry a "P-001").
 *
 * RETIRED (verification-system-improvements-2026-10-10 P-003): inline VAL-*
 * assertions are no longer read, so the PG collector and its watchdog registration
 * are removed. Only this pure core remains, uncalled, pending owner deletion.
 */
import {
  computePlanItemTestStatus,
  type RollupAssertion,
  type RollupTest,
} from '../../harness-test-rollup';

/** A terminal/done feature work-item carrying its plan-item provenance. */
export interface DoneWorkItem {
  /** feature_id of the done work-item. */
  workItemId: string;
  harnessSlug: string;
  /** source_plan_slug — the plan this work-item was minted from. */
  planSlug: string;
  /** source_plan_item_ids — the plan-item(s) this work-item covers. */
  planItemIds: readonly string[];
}

/** One inline-VAL assertion (harness_plan_assertions row), already filtered to
 *  requires_test = true at the read site. plan_slug disambiguates a shared item_id. */
export interface DoneItemAssertion {
  planSlug: string;
  itemId: string;
  valId: string;
}

/**
 * A done-without-test finding, shaped to map directly onto a WatchdogSignal at the
 * collector site. Its own type so this pure module needs no import from the large
 * watchdog.ts (and no dependency on the WatchdogSource union). One finding PER
 * HARNESS — the per-harness metric is `count`, the number of flagged done work-items.
 */
export interface DoneWithoutTestFinding {
  source: 'done-without-test';
  /** dedup key — the harness slug (one rolled-up finding per harness). */
  key: string;
  title: string;
  body: string;
  severity: 'major';
  /** harness:<slug> so triage keys off the owning hive. */
  scope: string;
  findingClass: 'test-gate:done-without-test';
  /** Per-harness metric: count of done work-items flagged as done-without-test. */
  count: number;
  /** feature_ids of the flagged work-items (detail; also embedded in `body`). */
  workItemIds: string[];
}

/** Composite plan-item key: assertions are keyed (plan_slug, item_id); two plans can
 *  reuse the same item_id ("P-001"), so the rollup must not merge them. NUL is illegal
 *  in slugs/ids, so it can't collide with a real separator. */
function planItemKey(planSlug: string, itemId: string): string {
  return `${planSlug}\x00${itemId}`;
}

/**
 * Flag terminal/done feature work-items whose required VALs are NOT all proven by a
 * passing test, grouped into one finding per harness. Pure: the caller supplies the
 * done items, their plan assertions (requires_test only), and the harness's tests.
 *
 * Detection predicate (per work-item, summed across its plan-items): roll the item's
 * `requires_test` assertions up against the harness tests via computePlanItemTestStatus
 * (which derives each VAL's status via deriveAssertionStatus), then flag when
 * `valsRequiringTest > 0 && valsPassing < valsRequiringTest` — i.e. it requires at
 * least one test and at least one required VAL has no passing covering test.
 *
 * Tests/assertions MUST be scoped to ONE harness per call (VAL ids are harness-local,
 * not globally unique) — the collector loops per harness.
 */
export function detectDoneWithoutTest(
  doneItems: readonly DoneWorkItem[],
  assertions: readonly DoneItemAssertion[],
  tests: readonly RollupTest[],
): DoneWithoutTestFinding[] {
  // Roll the requires_test assertions up to their (plan, item) once, composite-keyed.
  const rollupAssertions: RollupAssertion[] = assertions.map((a) => ({
    val_id: a.valId,
    item_id: planItemKey(a.planSlug, a.itemId),
    requires_test: true,
  }));
  const byItem = computePlanItemTestStatus(rollupAssertions, [...tests]);

  // Aggregate per harness: a work-item is flagged when, across all its plan-items, it
  // requires ≥1 test and not every required VAL is passing.
  const flaggedByHarness = new Map<string, string[]>();
  for (const wi of doneItems) {
    let requiring = 0;
    let passing = 0;
    for (const itemId of wi.planItemIds) {
      const s = byItem[planItemKey(wi.planSlug, itemId)];
      if (!s) continue;
      requiring += s.valsRequiringTest;
      passing += s.valsPassing;
    }
    if (requiring > 0 && passing < requiring) {
      const ids = flaggedByHarness.get(wi.harnessSlug) ?? [];
      ids.push(wi.workItemId);
      flaggedByHarness.set(wi.harnessSlug, ids);
    }
  }

  return [...flaggedByHarness].map(([harnessSlug, ids]) => ({
    source: 'done-without-test' as const,
    key: harnessSlug,
    title: `Done work-items missing a passing test: ${harnessSlug}`,
    body:
      `${ids.length} work-item(s) in ${harnessSlug} are marked done (terminal/passed) but carry ` +
      `requires_test VAL(s) with no passing covering test: ${ids.join(', ')}. ` +
      `A claimed-done feature whose required VALs were never proven by a framework test is the ` +
      `"done without test" recurrence (enforce-system-on-generic-work P-009) — the harness-test ` +
      `gate must not let it return silently.`,
    severity: 'major' as const,
    scope: `harness:${harnessSlug}`,
    findingClass: 'test-gate:done-without-test' as const,
    count: ids.length,
    workItemIds: ids,
  }));
}

// The PG collector that fed this detector (`collectDoneWithoutTestSignals`, which
// read the inline-VAL assertion store) is RETIRED by
// verification-system-improvements-2026-10-10 P-003 (SPEC-P-003-VAL-READERS) and is
// no longer registered in the watchdog. SUCCESSOR SIGNAL: spec-test-adequacy
// (SPEC-P-003-DETECTOR-SUCCESSOR). `specTestAdequacyCompletionGate`
// (agent-tools/work_items/spec-test-adequacy-gate.ts) runs inside work_items:complete
// and refuses a close whose current spec revisions lack adequate bound test evidence,
// so the "done without a test" state this detector flagged after the fact is now
// refused at the close; plans:evaluate-spec-test-adequacy grades the same rows on
// demand. The P-002 `verification.health` cell reports the fleet-wide share of active
// clauses with bound evidence. The pure detector above has no caller; this file is
// pending owner deletion with the rest of the VAL-* residue.
