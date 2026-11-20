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
import { judgeProducerField, fillRate, rollupCensus, auditKnownUnbuiltRefs, isWorkItemRef, TERMINAL_STATUSES, PLANE_PRODUCER_FIELDS, PRODUCER_VERDICTS } from '../../../scripts/check-plane-producers.mjs';

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

describe('⚠ EI-18850142725126359 — a `knownUnbuilt` pointer must not go stale in silence', () => {
  const row = (id: string, knownUnbuilt?: string) => ({
    id,
    producer: 'someone',
    why: 'because',
    verdict: 'no-producer',
    ...(knownUnbuilt ? { knownUnbuilt } : {}),
  });
  const isTerminal = (s: string) => TERMINAL_STATUSES.has(s);

  it('tells a work-item ref (which expires) from a ruling (which does not)', () => {
    expect(isWorkItemRef('WI-6548')).toBe(true);
    expect(isWorkItemRef('EI-18850142725126359')).toBe(true);
    expect(isWorkItemRef('D-103 (ruled)')).toBe(false);
    expect(isWorkItemRef(undefined)).toBe(false);
  });

  it('flags a ref whose item has CLOSED — the exact WI-6465 stale pointer', () => {
    // Four fields cited WI-6465 for 90 minutes after it closed, and every run
    // exited 0 while printing "reported, not failing the build" for each of them.
    const audit = auditKnownUnbuiltRefs(
      [row('a.b', 'WI-6465'), row('c.d', 'WI-6465'), row('e.f', 'WI-6548')],
      new Map([
        ['WI-6465', 'done'],
        ['WI-6548', 'open'],
      ]),
      isTerminal,
    );
    const stale = audit.find((a: { ref: string }) => a.ref === 'WI-6465');
    expect(stale).toMatchObject({ verdict: 'closed', status: 'done' });
    expect(stale.fields).toEqual(['a.b', 'c.d']);
    expect(audit.find((a: { ref: string }) => a.ref === 'WI-6548')).toMatchObject({ verdict: 'open' });
  });

  it('flags a ref that matches NO work-item — an exemption nobody can verify', () => {
    const audit = auditKnownUnbuiltRefs([row('a.b', 'WI-9999')], new Map(), isTerminal);
    expect(audit[0]).toMatchObject({ ref: 'WI-9999', verdict: 'missing' });
  });

  it('leaves a RULING alone — a decision is permanent, not a promise that can lapse', () => {
    const audit = auditKnownUnbuiltRefs([row('a.b', 'D-103 (ruled)')], new Map(), isTerminal);
    expect(audit[0]).toMatchObject({ verdict: 'ruling' });
  });

  it('⚠ REPORTS the stale ref without failing the build — no second candidate-independent trap', () => {
    // Making this fail would add a SECOND live-DB fleet-gate trap, which is the very
    // defect EI-18850142725126359 filed against the first one. The hard transition
    // stays P-003's, singular. Pinned as a test because the tempting "fix" is to
    // give this teeth, and the reason not to is not obvious from the code.
    const rows = [row('a.b', 'WI-6465')];
    const audit = auditKnownUnbuiltRefs(rows, new Map([['WI-6465', 'done']]), isTerminal);
    expect(audit[0].verdict).toBe('closed');
    expect(rollupCensus(rows).failures).toHaveLength(0);
  });

  it('matches the ratchet gate on what "closed" means', () => {
    // Divergence here would make the two plane lints disagree AGAIN, in the other
    // direction: this one silent about a close the ratchet has already acted on.
    for (const s of ['done', 'dropped', 'resolved', 'closed', 'passed', 'deprecated']) {
      expect(TERMINAL_STATUSES.has(s), `${s} is terminal for the ratchet but not here`).toBe(true);
    }
    for (const s of ['open', 'wip', 'blocked', 'needs-human']) {
      expect(TERMINAL_STATUSES.has(s)).toBe(false);
    }
  });
});

describe('P-001 — the census spec itself is non-vacuous', () => {
  it('dependency writes must exist even after the separate stale-value metric gap closes', () => {
    const field = PLANE_PRODUCER_FIELDS.find((f: { id: string }) => f.id === 'agent_facts.depends_on');
    expect(field).toBeDefined();

    const dead = { ...field, verdict: judgeProducerField({ populated: 0, total: 17 }) };
    expect(rollupCensus([dead]).failures).toEqual([dead]);

    const producing = { ...field, verdict: judgeProducerField({ populated: 17, total: 17 }) };
    expect(rollupCensus([producing]).failures).toEqual([]);
    expect(auditKnownUnbuiltRefs([producing], new Map([['WI-6548', 'done']]),
      (status: string) => TERMINAL_STATUSES.has(status))).toEqual([]);
  });

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
