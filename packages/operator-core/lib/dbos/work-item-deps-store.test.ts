import { describe, expect, it } from 'vitest';
import { workItemBlockingEdge, wouldCreateCycle } from './work-item-deps-store';

// edges are blocked -> [blockers]; a cycle = a circular blocking dependency (deadlock).
const m = (o: Record<string, string[]>): Map<string, string[]> => new Map(Object.entries(o));

// @covers INV-08
describe('wouldCreateCycle (acyclicity guard, P-008)', () => {
  it('allows an edge into an empty graph', () => {
    expect(wouldCreateCycle(new Map(), 'A', ['B'])).toBe(false);
  });

  it('detects a direct 2-cycle (A blocked-by B, B blocked-by A)', () => {
    expect(wouldCreateCycle(m({ B: ['A'] }), 'A', ['B'])).toBe(true);
  });

  it('detects a transitive cycle (A<-C<-B<-A)', () => {
    expect(wouldCreateCycle(m({ B: ['A'], C: ['B'] }), 'A', ['C'])).toBe(true);
  });

  it('allows a safe edge that extends a chain', () => {
    expect(wouldCreateCycle(m({ B: ['A'] }), 'C', ['B'])).toBe(false); // A<-B<-C linear
  });

  it('allows a safe replacement despite an unrelated existing cycle', () => {
    expect(wouldCreateCycle(m({ A: ['B'], B: ['A'] }), 'C', ['D'])).toBe(false);
  });

  it('allows an unchanged blocker set in an existing cycle', () => {
    expect(wouldCreateCycle(m({ A: ['B'], B: ['A'] }), 'A', ['B'])).toBe(false);
  });

  it('still rejects a new cycle when an unrelated cycle already exists', () => {
    expect(wouldCreateCycle(m({ A: ['B'], B: ['A'], D: ['C'] }), 'C', ['D'])).toBe(true);
  });

  it('rejects expanding an existing cycle to include another member', () => {
    expect(wouldCreateCycle(m({ A: ['B'], B: ['A'], C: ['A'] }), 'A', ['B', 'C'])).toBe(true);
  });

  it('allows breaking one cycle while an unrelated cycle remains', () => {
    expect(wouldCreateCycle(m({ A: ['B'], B: ['A'], C: ['D'], D: ['C'] }), 'A', [])).toBe(false);
  });

  it('uses REPLACE semantics — clearing a blocked item breaks its prior cycle', () => {
    // current has A blocked-by B; replacing A's blockers with [] removes the back-edge.
    expect(wouldCreateCycle(m({ A: ['B'], B: ['A'] }), 'A', [])).toBe(false);
  });

  it('drops a self-edge (no-self-block) rather than reporting a cycle', () => {
    expect(wouldCreateCycle(new Map(), 'A', ['A'])).toBe(false);
  });

  it('detects a cycle introduced among multiple new blockers', () => {
    // X blocked-by A,B (fine); but B is blocked-by X already -> X<-B<-X
    expect(wouldCreateCycle(m({ B: ['X'] }), 'X', ['A', 'B'])).toBe(true);
  });
});

describe('workItemBlockingEdge (coord_links → scheduler mirror)', () => {
  it('reverses blocker→blocked into the work_item_deps orientation', () => {
    expect(
      workItemBlockingEdge(
        { kind: 'issue', ref: 'EI-blocker' },
        { kind: 'issue', ref: 'EI-dependent' },
      ),
    ).toEqual({
      blocked_kind: 'issue',
      blocked_ref: 'EI-dependent',
      blocker_kind: 'issue',
      blocker_ref: 'EI-blocker',
      dep_type: 'blocks',
      satisfaction: 'settled',
    });
  });

  it('drops a self-edge before it reaches the database', () => {
    expect(workItemBlockingEdge({ kind: 'issue', ref: 'EI-1' }, { kind: 'issue', ref: 'EI-1' })).toBeNull();
  });
});

/**
 * P-005 / D-009 — the kind↔ref-FORM invariant.
 *
 * The plan item asked for the two ref conventions to be normalized into one. Measured against
 * live data that premise was false (all 188 endpoint-sides already agree with their kind), and
 * unifying them would OVER-GATE the feature family — D-007's retraction. What was genuinely
 * missing was ENFORCEMENT: both link doors funnel through workItemBlockingEdge, but only
 * linkWorkItem checked a form, only on the dst, and only for features; linkIssue checked nothing.
 *
 * These tests pin the invariant at the seam, in BOTH directions, because a violation is not
 * cosmetic: a form-mismatched endpoint is invisible to BOTH blocking floors, so the edge is
 * silently inert — a dependency that looks recorded and gates nothing.
 *
 * ⚠ SCOPE: this is the ref-FORM half only. It cannot catch an endpoint whose form is correct but
 * whose TARGET is the other family (live: offsite-planner-demo#WI-247/248/249 declare
 * blocked_kind='feature' with a properly qualified ref, yet point at item_kind='task' rows) —
 * that needs a DB read, so it is a separate guard. Do not extend these tests to imply otherwise.
 */
// @covers INV-01
describe('work_item_deps endpoint ref-form invariant (P-005 / D-009)', () => {
  const issue = { kind: 'issue', ref: 'EI-1' };
  const feature = { kind: 'feature', ref: 'papercusp#F-1' };

  it('accepts the two canonical shapes: qualified feature, bare issue', () => {
    expect(workItemBlockingEdge(feature, issue)).toMatchObject({
      blocked_kind: 'issue',
      blocked_ref: 'EI-1',
      blocker_kind: 'feature',
      blocker_ref: 'papercusp#F-1',
    });
    expect(workItemBlockingEdge(issue, feature)).toMatchObject({
      blocked_kind: 'feature',
      blocked_ref: 'papercusp#F-1',
      blocker_kind: 'issue',
      blocker_ref: 'EI-1',
    });
  });

  it('REJECTS a feature endpoint carrying a bare ref — on either side', () => {
    // The exact live corruption: an endpoint declared 'feature' whose ref is not harness-qualified.
    expect(() => workItemBlockingEdge(issue, { kind: 'feature', ref: 'F-1' })).toThrow(/harness-qualified/);
    expect(() => workItemBlockingEdge({ kind: 'feature', ref: 'F-1' }, issue)).toThrow(/harness-qualified/);
  });

  it('REJECTS an issue endpoint carrying a harness-qualified ref — on either side', () => {
    // The mirror-image mistake, and the one linkWorkItem's dst-only feature check could never see.
    expect(() => workItemBlockingEdge(feature, { kind: 'issue', ref: 'papercusp#WI-249' })).toThrow(/BARE ref/);
    expect(() => workItemBlockingEdge({ kind: 'issue', ref: 'papercusp#WI-249' }, feature)).toThrow(/BARE ref/);
  });

  it('names the offending endpoint and its role, so the caller bug is locatable', () => {
    // A guard that rejects without saying WHICH endpoint just moves the debugging cost.
    expect(() => workItemBlockingEdge(issue, { kind: 'feature', ref: 'F-9' })).toThrow(/blocked endpoint/);
    expect(() => workItemBlockingEdge({ kind: 'feature', ref: 'F-9' }, issue)).toThrow(/blocker endpoint/);
    expect(() => workItemBlockingEdge(issue, { kind: 'feature', ref: 'F-9' })).toThrow(/'F-9'/);
  });

  it('THROWS rather than returning null, so a caller bug can never be silently dropped', () => {
    // null already means "self-edge, skip". Reusing it for "malformed" would reintroduce exactly
    // the silence this guard exists to remove — the edge would vanish and nothing would say so.
    let threw = false;
    try {
      workItemBlockingEdge(issue, { kind: 'feature', ref: 'F-1' });
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
  });

  it('still returns a quiet null for a self-edge, even when the endpoints are malformed', () => {
    // Order matters: the self-edge no-op is a contract callers rely on, so it is checked FIRST.
    const bad = { kind: 'feature', ref: 'F-1' };
    expect(workItemBlockingEdge(bad, { ...bad })).toBeNull();
  });

  it('leaves kinds outside the two families alone (a validator, not a kind whitelist)', () => {
    // Both callers already restrict the mirror to issue|feature. Rejecting other kinds here would
    // make this a second, competing gate on WHICH kinds may be linked — not this guard's job.
    expect(() => workItemBlockingEdge({ kind: 'plan_item', ref: 'some-plan#P-001' }, issue)).not.toThrow();
  });
});
