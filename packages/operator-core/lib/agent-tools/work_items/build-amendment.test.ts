import { describe, it, expect } from 'vitest';
import { buildAmendment, renderAmendment, AMENDMENT_KINDS } from './build-amendment';

const base = { kind: 'note' as const, rationale: 'r', by: 'agent:x' };

describe('buildAmendment', () => {
  it('authoritative caller ⇒ disposed; bee ⇒ proposed', () => {
    expect(
      buildAmendment(base, { targetState: 'todo', authoritative: true, claimedByOther: false }).disposition,
    ).toBe('disposed');
    expect(
      buildAmendment(base, { targetState: 'todo', authoritative: false, claimedByOther: false }).disposition,
    ).toBe('proposed');
  });

  it('inFlight when the node is in execution (wip/building/failing) or claimed by a peer', () => {
    expect(buildAmendment(base, { targetState: 'wip', authoritative: true, claimedByOther: false }).inFlight).toBe(true);
    expect(buildAmendment(base, { targetState: 'building', authoritative: true, claimedByOther: false }).inFlight).toBe(true);
    expect(buildAmendment(base, { targetState: 'todo', authoritative: true, claimedByOther: true }).inFlight).toBe(true);
    expect(buildAmendment(base, { targetState: 'todo', authoritative: true, claimedByOther: false }).inFlight).toBe(false);
    expect(buildAmendment(base, { targetState: 'passed', authoritative: true, claimedByOther: false }).inFlight).toBe(false);
  });

  it('requiresCompensation only for a DISRUPTIVE kind on an in-flight node', () => {
    expect(
      buildAmendment({ ...base, kind: 'drop' }, { targetState: 'wip', authoritative: true, claimedByOther: false })
        .requiresCompensation,
    ).toBe(true);
    expect(
      buildAmendment({ ...base, kind: 'reapproach' }, { targetState: 'todo', authoritative: true, claimedByOther: true })
        .requiresCompensation,
    ).toBe(true);
    // disruptive but NOT in-flight → no compensation
    expect(
      buildAmendment({ ...base, kind: 'drop' }, { targetState: 'todo', authoritative: true, claimedByOther: false })
        .requiresCompensation,
    ).toBe(false);
    // in-flight but additive (split/expand/note) → no compensation
    expect(
      buildAmendment({ ...base, kind: 'split' }, { targetState: 'wip', authoritative: true, claimedByOther: false })
        .requiresCompensation,
    ).toBe(false);
    expect(
      buildAmendment({ ...base, kind: 'expand' }, { targetState: 'wip', authoritative: true, claimedByOther: false })
        .requiresCompensation,
    ).toBe(false);
  });

  it('renders a greppable structured line with disposition + flags + rationale', () => {
    const rec = buildAmendment(
      { ...base, kind: 'drop', rationale: 'approach X failed' },
      { targetState: 'wip', authoritative: false, claimedByOther: true },
    );
    const line = renderAmendment(rec);
    expect(line).toContain('⟐ amend[drop]');
    expect(line).toContain('proposed');
    expect(line).toContain('in-flight');
    expect(line).toContain('NEEDS-COMPENSATION');
    expect(line).toContain('approach X failed');
  });

  it('exposes the kind vocabulary', () => {
    expect(AMENDMENT_KINDS).toEqual(['split', 'drop', 'reapproach', 'expand', 'note']);
  });
});
