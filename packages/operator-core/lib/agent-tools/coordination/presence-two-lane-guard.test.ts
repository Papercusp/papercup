/**
 * presence-two-lane-guard.test.ts — P-013(d) / D-005 / D-008 drift guard: the
 * EMIT boundary of the two-lane rule. CONTINUOUS liveness (heartbeat,
 * last_active, load) stays snapshot + SSE and is NEVER injected as a [coord+N]
 * delta — injecting liveness churn is exactly the notify-storm the rule forbids.
 *
 * The [coord+N] deltas are produced by the lifecycle auto-emit REACTION RULES
 * (coord-lifecycle/lifecycle-rules.ts) firing coord:emit on a trigger tool. This
 * guard asserts NO rule fires on a presence READ or LIVENESS signal — so a future
 * change that, say, makes activity:report (which fires on EVERY tool call) emit a
 * delta, or hangs a rule on coord:presence/coord:inbox, fails here.
 *
 * The complementary DATA-level guard (liveness fields ∉ the delta-eligible field
 * set) lives in presence-payload.test.ts; this is the same invariant at the
 * emit-trigger level.
 *
 * P-013 coverage map (the other three clauses, already guarded elsewhere):
 *   (a) 60s keepalive ≠ last_active (D-003) → the shared PresenceStore conformance
 *       (packages/coordination/src/presence/presence.test.ts + the live-PG
 *       __tests__/presence-conformance.test.ts): touchHeartbeat bumps heartbeat
 *       only, touchActivity bumps both.
 *   (b) deterministic ownerId ordering (D-006) → the same conformance (list() is
 *       ownerId-sorted).
 *   (c) re-bootstrap-on-compaction (D-007) → presence-rebootstrap.test.ts.
 */
import { describe, beforeAll, it, expect, vi } from 'vitest';
import { listReactionRules } from '../../events';
// Importing the lifecycle rules registers them (module side effect) so
// listReactionRules() sees the real auto-emit set.
import '../../coord-lifecycle/lifecycle-rules';
import { PRESENCE_LIVENESS_FIELDS, PRESENCE_DELTA_FIELDS } from './presence-payload';

// That import registers ONCE per worker, but the registry is process-global and any file
// calling `_resetReactionsForTests()` can clear it first — after which a cached re-import
// restores nothing (see the hazard note on that function). This matters MORE here than in a
// normal test: the emptiness assertions below would pass VACUOUSLY against a cleared
// registry, i.e. this guard would go green having guarded nothing.
beforeAll(async () => {
  vi.resetModules();
  await import('../../coord-lifecycle/lifecycle-rules');
});

describe('two-lane emit boundary (P-013(d) / D-005 / D-008)', () => {
  it('no reaction rule emits a [coord+N] delta from a presence read or liveness signal', () => {
    const rules = listReactionRules();
    // CALIBRATION — the assertions below are all "expect nothing"; against an empty
    // registry they hold trivially. Prove we are looking at a populated registry first,
    // so a vacuous pass can never be mistaken for a real one.
    expect(rules.some((r) => r.id === 'lifecycle:intent')).toBe(true);
    // A rule on any of these would turn liveness churn / a read into an injected
    // delta. activity:report is the sharpest case — it fires on EVERY tool call,
    // so a rule there would be a fleet-wide notify-storm.
    const LIVENESS_OR_READ_TRIGGERS = ['activity:report', 'coord:inbox', 'coord:presence'];
    for (const trigger of LIVENESS_OR_READ_TRIGGERS) {
      expect(rules.filter((r) => r.on === trigger).map((r) => r.id)).toEqual([]);
    }
  });

  it('the presence STATE transition that DOES auto-emit is intent (declare-intent) — a state field, not liveness', () => {
    const rules = listReactionRules();
    const intentRule = rules.find((r) => r.id === 'lifecycle:intent');
    // The intent rule exists and fires on the declared-intent (state) transition,
    // never on a liveness write. (Its absence would mean the lifecycle layer was
    // unloaded — a different regression, also worth catching here.)
    expect(intentRule).toBeDefined();
    expect(intentRule?.on).toBe('coord:declare-intent');
  });

  it('(data lane) liveness fields are disjoint from the delta-eligible set', () => {
    const deltaEligible = PRESENCE_DELTA_FIELDS as readonly string[];
    expect(PRESENCE_LIVENESS_FIELDS.filter((k) => deltaEligible.includes(k))).toEqual([]);
  });
});
