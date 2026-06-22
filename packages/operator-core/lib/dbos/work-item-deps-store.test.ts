import { describe, expect, it } from 'vitest';
import { wouldCreateCycle } from './work-item-deps-store';

// edges are blocked -> [blockers]; a cycle = a circular blocking dependency (deadlock).
const m = (o: Record<string, string[]>): Map<string, string[]> => new Map(Object.entries(o));

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
