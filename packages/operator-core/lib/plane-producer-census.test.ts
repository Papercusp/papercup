/**
 * plane-producer-census.test.ts — the P-001 census predicate
 * (agent-state-plane-verification-2026-07-27).
 *
 * WHAT IS ACTUALLY BEING PROTECTED HERE. The census script runs green today, and
 * a green run proves only the no-false-alarm direction. The direction that
 * matters is the one a clean tree can never exercise: that a field whose producer
 * DIES is reported as dead — and, critically, that a field nobody has any DATA
 * for is reported as neither dead nor alive.
 *
 * That three-way split is the whole point of the gate, and it is the one thing a
 * future simplification will be tempted to collapse ("just fail on zero"). The
 * collapse is silent: it turns a fresh database into a wall of red, everyone
 * learns to pass the gate, and the next WI-6465 arrives unnoticed behind the
 * noise. Same posture as `no-bespoke-state-read-guard.test.ts` — lock the
 * gating property here, because the tree cannot.
 */
import { describe, it, expect } from 'vitest';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — pure JS gate script, no .d.ts; imported for its predicates only. Kept on ONE line: @ts-ignore suppresses only the line that follows it, so a multi-line import leaves the module specifier unguarded and TS7016 reds the build.
import { judgeProducerField, fillRate, rollupCensus, PLANE_PRODUCER_FIELDS, PRODUCER_VERDICTS } from '../../../scripts/check-plane-producers.mjs';

describe('P-001 — the three-verdict split (the vacuous pass this gate exists to avoid)', () => {
  it('a populated field in a populated table is PRODUCING', () => {
    expect(judgeProducerField({ populated: 1383, total: 7795 })).toBe('producing');
  });

  it('⚠ ZERO populated in a NON-EMPTY table is NO-PRODUCER — the WI-6465 case', () => {
    // The real measurement that produced WI-6465: 0 assumption facts out of 2,180
    // rows. The table is busy; the field is dead. That is a defect, not a quiet day.
    expect(judgeProducerField({ populated: 0, total: 2180 })).toBe('no-producer');
  });

  it('⚠ ZERO populated in an EMPTY table is NO-DATA — neither pass nor fail', () => {
    // A fresh box, a pruned window, a new install. Reporting this as a FAILURE
    // trains the fleet to ignore the gate; reporting it as a PASS is a green tick
    // that means "we looked at nothing". It must be its own answer.
    expect(judgeProducerField({ populated: 0, total: 0 })).toBe('no-data');
  });

  it('no-data is NOT silently folded into either direction', () => {
    const empty = judgeProducerField({ populated: 0, total: 0 });
    expect(empty).not.toBe('producing');
    expect(empty).not.toBe('no-producer');
    expect(PRODUCER_VERDICTS).toContain(empty);
  });

  it('a missing/NaN denominator degrades to no-data rather than dividing by it', () => {
    expect(judgeProducerField({ populated: 0, total: undefined as unknown as number })).toBe('no-data');
    expect(fillRate({ populated: 0, total: 0 })).toBeNull();
    expect(fillRate({ populated: 5, total: 10 })).toBe(0.5);
  });
});

describe('P-001 — the rollup decides what actually fails the build', () => {
  const row = (over: Record<string, unknown> = {}) => ({
    id: 'x.y',
    producer: 'someone',
    why: 'because',
    verdict: 'producing',
    ...over,
  });

  it('an UNEXPLAINED dead producer fails the build', () => {
    const roll = rollupCensus([row({ verdict: 'no-producer' })]);
    expect(roll.failures).toHaveLength(1);
  });

  it('a dead producer with a filed, owned ref is REPORTED but does not fail', () => {
    // Re-failing the build for an already-filed, already-owned bug is how a gate
    // becomes noise the fleet routes around — the exact failure mode that nearly
    // killed the no-bespoke-state-read gate (WI-6464, 2 of its 3 rows wrong).
    const roll = rollupCensus([row({ verdict: 'no-producer', knownUnbuilt: 'WI-6465' })]);
    expect(roll.failures).toHaveLength(0);
    expect(roll.knownUnbuilt).toBe(1);
  });

  it('no-data never counts as a pass in the rollup', () => {
    const roll = rollupCensus([row({ verdict: 'no-data' })]);
    expect(roll.producing).toBe(0);
    expect(roll.noData).toBe(1);
  });
});

describe('P-001 — the census spec itself is non-vacuous', () => {
  it('covers the fields whose absence produced WI-6444 and WI-6465', () => {
    // Without this, deleting rows from the spec would green the gate by asking
    // fewer questions — the cheapest possible way to fake a pass.
    const ids = PLANE_PRODUCER_FIELDS.map((f: { id: string }) => f.id);
    for (const required of [
      'tool_invocations.intent_event_id',
      'tool_invocations.goal_ref',
      'tool_invocations.assumption_set_id',
      "agent_facts.kind='assumption'",
      'agent_facts.depends_on',
      'agent_facts.claim',
    ]) {
      expect(ids, `${required} dropped from the census — the gate now asks a smaller question`).toContain(required);
    }
  });

  it('every field NAMES its producer and what breaks — an unowned field is how WI-6465 happened', () => {
    for (const f of PLANE_PRODUCER_FIELDS as Array<{ id: string; producer?: string; why?: string; sinceDays?: number }>) {
      expect(f.producer?.trim(), `${f.id} names no producer`).toBeTruthy();
      expect(f.why?.trim(), `${f.id} does not say what breaks`).toBeTruthy();
      expect(f.sinceDays, `${f.id} has no window`).toBeGreaterThan(0);
    }
  });
});
