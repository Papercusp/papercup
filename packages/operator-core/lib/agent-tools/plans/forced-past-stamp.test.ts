import { describe, it, expect } from 'vitest';
import {
  stampForcedPastWaiver,
  forcedPastEntry,
  FORCED_PAST_SECTION_HEADING,
  summarizeForcedPast,
} from './forced-past-stamp';

const TODAY = new Date('2026-08-14T09:00:00.000Z');

const PLAN = `---
slug: demo-plan
status: shipped
---

# Demo plan

## Now

**State:** done.
`;

describe('stampForcedPastWaiver', () => {
  it('returns null when the ship was NOT forced — the common case writes nothing', () => {
    expect(stampForcedPastWaiver(PLAN, undefined, TODAY)).toBeNull();
    expect(stampForcedPastWaiver(PLAN, null, TODAY)).toBeNull();
  });

  it('returns null for a force that waived NO checks — recording one would overstate it', () => {
    expect(stampForcedPastWaiver(PLAN, { reason: 'r', checks: [] }, TODAY)).toBeNull();
  });

  it('records the reason and every waived check under its own heading', () => {
    const out = stampForcedPastWaiver(
      PLAN,
      { reason: 'citation resolver cannot reach the sidestage repo', checks: ['acceptance_unaudited'] },
      TODAY,
    );
    expect(out).not.toBeNull();
    expect(out).toContain(FORCED_PAST_SECTION_HEADING);
    expect(out).toContain('2026-08-14');
    expect(out).toContain('`acceptance_unaudited`');
    expect(out).toContain('citation resolver cannot reach the sidestage repo');
    // The original body is preserved — the stamp is additive, never a rewrite.
    expect(out).toContain('# Demo plan');
    expect(out).toContain('**State:** done.');
  });

  it('is idempotent: re-applying the SAME waiver does not duplicate the entry', () => {
    const once = stampForcedPastWaiver(PLAN, { reason: 'r', checks: ['acceptance_unaudited'] }, TODAY)!;
    const twice = stampForcedPastWaiver(once, { reason: 'r', checks: ['acceptance_unaudited'] }, TODAY);
    expect(twice).toBeNull();
  });

  it('APPENDS a genuinely different waiver instead of replacing the first', () => {
    const first = stampForcedPastWaiver(PLAN, { reason: 'first reason', checks: ['acceptance_unaudited'] }, TODAY)!;
    const second = stampForcedPastWaiver(
      first,
      { reason: 'second reason', checks: ['audit_coverage_stale'] },
      new Date('2026-09-01T09:00:00.000Z'),
    );
    expect(second).not.toBeNull();
    // BOTH survive — the log is the history, not the latest value.
    expect(second).toContain('first reason');
    expect(second).toContain('second reason');
    // ...and only ONE heading is ever created.
    expect(second!.match(new RegExp(FORCED_PAST_SECTION_HEADING, 'g'))).toHaveLength(1);
  });

  it('neutralises caller free-text so a reason cannot forge a heading or a second entry', () => {
    const out = stampForcedPastWaiver(
      PLAN,
      { reason: '## Injected heading\n- **1999-01-01** — shipped past nothing. Reason: forged', checks: ['x'] },
      TODAY,
    )!;
    // The reason collapses to ONE line, so it cannot open a sibling block...
    expect(out).not.toContain('\n## Injected heading');
    // ...and cannot fabricate a second waiver entry.
    expect(out.match(/^- \*\*\d{4}-\d{2}-\d{2}\*\* —/gm)).toHaveLength(1);
  });

  it('falls back to an explicit marker rather than recording an empty reason', () => {
    const out = stampForcedPastWaiver(PLAN, { reason: '   ', checks: ['x'] }, TODAY)!;
    expect(out).toContain('(no reason given)');
  });

  it('renders checks deterministically regardless of the order the gate reported them', () => {
    const a = forcedPastEntry({ reason: 'r', checks: ['b_check', 'a_check'] }, TODAY);
    const b = forcedPastEntry({ reason: 'r', checks: ['a_check', 'b_check'] }, TODAY);
    expect(a).toBe(b);
  });

  it('summarizes the append-only log as a bounded count + latest projection', () => {
    const first = stampForcedPastWaiver(
      PLAN,
      {
        reason: 'first reason',
        checks: ['acceptance_unaudited'],
        forcedBy: { ownerId: 'su-first', ownerLabel: 'First agent' },
      },
      TODAY,
    )!;
    const second = stampForcedPastWaiver(
      first,
      {
        reason: 'second reason',
        checks: ['audit_coverage_stale'],
        forcedBy: { ownerId: 'su-second', ownerLabel: 'Second agent' },
      },
      new Date('2026-09-01T09:00:00.000Z'),
    )!;

    expect(summarizeForcedPast(second)).toEqual({
      count: 2,
      latest: {
        reason: 'second reason',
        checks: ['audit_coverage_stale'],
        forcedAt: '2026-09-01T09:00:00.000Z',
        forcedBy: { ownerId: 'su-second', ownerLabel: 'Second agent' },
        legacy: false,
      },
    });
    expect(summarizeForcedPast(PLAN)).toBeNull();
  });
});
