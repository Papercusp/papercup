/**
 * work-items-stop-the-line.test.ts — the PURE contracts of the P-013/D-012 stop-the-line
 * floor (gate-verdict-liveness-and-repair-reliability-2026-08-31): the exempt-prefix set
 * derivation, the catalog leaf-move re-export identity, and the threshold constant.
 *
 * The floor's SQL BEHAVIOR (who is claimable while the line is stopped) is proven against
 * real Postgres in scheduler/stop-the-line-floor.integration.test.ts; the floor-set wiring
 * (ok_stop_line present in both the subquery and ALL_ISSUE_CLAIM_FLOORS_PASS) is enforced
 * by get-next-exclusion-breakdown.integration.test.ts's metadata equality guard.
 */
import { describe, expect, it } from 'vitest';
import {
  GATE_RED_STREAK_CONDITION_PREFIX,
  LIVE_GATE_OPS_CONDITION_PREFIXES,
  liveGateOpsSelfSelectExplanation,
  STOP_THE_LINE_EXEMPT_CONDITION_PREFIXES,
  STOP_THE_LINE_RED_HOURS,
  stopTheLineExplanation,
} from './work-items-admission';
import * as leaf from './coord/actionable-conditions';
import * as bridge from './coord/condition-bridge';

describe('stop-the-line pure contracts (P-013/D-012)', () => {
  it('the exempt set is DERIVED from the actionable-condition catalog, plus deploy-parity:', () => {
    for (const p of leaf.ACTIONABLE_CONDITION_PREFIXES) {
      expect(STOP_THE_LINE_EXEMPT_CONDITION_PREFIXES).toContain(p);
    }
    // P-015's directly-filed condition (outside the bridge catalog by design).
    expect(STOP_THE_LINE_EXEMPT_CONDITION_PREFIXES).toContain('deploy-parity:');
    // Exactly the catalog + the one direct-filer — a new exempt class must be a
    // deliberate edit here, not an accident of the spread.
    expect(STOP_THE_LINE_EXEMPT_CONDITION_PREFIXES).toHaveLength(leaf.ACTIONABLE_CONDITION_PREFIXES.length + 1);
    // The trigger prefix itself is exempt (the gate item must stay claimable while
    // the line it opened is stopped — otherwise the throttle would starve its own fix).
    expect(STOP_THE_LINE_EXEMPT_CONDITION_PREFIXES).toContain(GATE_RED_STREAK_CONDITION_PREFIX);
    // Every prefix ends in ':' — a bare word would prefix-match unrelated keys via LIKE.
    for (const p of STOP_THE_LINE_EXEMPT_CONDITION_PREFIXES) {
      expect(p.endsWith(':')).toBe(true);
    }
  });

  it('the trigger prefix matches the trackGateStall producer key shape', () => {
    expect(GATE_RED_STREAK_CONDITION_PREFIX).toBe('gate-red-streak:');
    expect(STOP_THE_LINE_RED_HOURS).toBe(24);
  });

  it('reserves only the two LIVE_GATE_OPS singleton prefixes for explicit by-id claims', () => {
    expect(LIVE_GATE_OPS_CONDITION_PREFIXES).toEqual(['gate-red-streak:', 'green-stall:']);
    for (const prefix of LIVE_GATE_OPS_CONDITION_PREFIXES) expect(prefix.endsWith(':')).toBe(true);

    const text = liveGateOpsSelfSelectExplanation();
    expect(text).toContain('gate-red-streak:');
    expect(text).toContain('green-stall:');
    expect(text).toContain('BY ID');
    expect(text).toContain('gate.greenCheckpoint.ownership');
  });

  it('condition-bridge re-exports ARE the leaf module (identity, not a copy)', () => {
    // The catalog moved to the zero-import leaf (D-012); the bridge re-exports it for
    // compatibility. Reference equality proves nobody re-forked the array — the exact
    // second-copy drift the derived-truth ladder forbids.
    expect(bridge.ACTIONABLE_CONDITIONS).toBe(leaf.ACTIONABLE_CONDITIONS);
    expect(bridge.ACTIONABLE_CONDITION_PREFIXES).toBe(leaf.ACTIONABLE_CONDITION_PREFIXES);
    expect(bridge.GITHUB_BRIDGE_AGENT_ACTIONABLE_CONDITION_PREFIX).toBe(
      leaf.GITHUB_BRIDGE_AGENT_ACTIONABLE_CONDITION_PREFIX,
    );
    expect(bridge.actionableConditionFor).toBe(leaf.actionableConditionFor);
    expect(bridge.isActionableConditionKey).toBe(leaf.isActionableConditionKey);
  });

  it('the refusal explanation is a verdict with the remedy, naming the harness + threshold', () => {
    const text = stopTheLineExplanation('papercusp');
    expect(text).toContain('papercusp');
    expect(text).toContain(`${STOP_THE_LINE_RED_HOURS}h`);
    expect(text).toContain('gate-red-streak:papercusp');
    // The three load-bearing clauses: repair still flows, by-id still works, and the
    // stale-item remedy (the kill-switch is the condition item, not a flag).
    expect(text).toMatch(/bugs and\s+alarm-condition items are exempt/);
    expect(text).toContain('BY ID');
    expect(text).toMatch(/settling it\s+lifts the throttle immediately/);
  });
});
