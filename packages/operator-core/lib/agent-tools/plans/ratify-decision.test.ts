/**
 * plans:ratify-decision — the pure helper ratifyDecisionInBody (EI-458,
 * queen-autonomy-policy-2026-06-13 B-04/P-015 coverage refinement). Appends a
 * `Ratified: <by> on <date>` line to a decision's body while preserving the
 * `### D-NNN — title` head, the `Date:` line, and everything already there.
 * The handler wiring (withPlanLock + revision + legacy/not-found guards)
 * mirrors the tested plans:set-decision-body / plans:add-decision.
 */
import { describe, it, expect } from 'vitest';
import { ratifyDecisionInBody } from './ratify-decision';
import { parsePlan } from './parser';

const PLAN = [
  '---',
  'title: Test',
  'slug: test',
  'status: ready',
  'created: 2026-06-20',
  'updated: 2026-06-20',
  'owner: x@y.com',
  '---',
  '',
  '## Decisions',
  '',
  '### D-001 — First decision',
  'Date: 2026-06-19',
  'Original body text.',
  'Related: P-001',
  '',
  '### D-002 — Second decision',
  'Date: 2026-06-20',
  'Already ratified.',
  'Ratified: Avi on 2026-06-21',
  '',
].join('\n');

describe('ratifyDecisionInBody', () => {
  it('appends a Ratified line, preserving head + Date + existing body content', () => {
    const { newBody, found, alreadyRatified } = ratifyDecisionInBody(PLAN, 'D-001', 'Avi', '2026-07-17');
    expect(found).toBe(true);
    expect(alreadyRatified).toBe(false);

    const parsed = parsePlan(newBody);
    const d1 = parsed.decisions.find((d) => d.id === 'D-001');
    expect(d1?.title).toBe('First decision'); // head preserved
    expect(d1?.date).toBe('2026-06-19'); // Date preserved
    expect(d1?.body).toContain('Original body text.');
    expect(d1?.body).toContain('Related: P-001');
    expect(d1?.body).toContain('Ratified: Avi on 2026-07-17');

    // sibling untouched
    const d2 = parsed.decisions.find((d) => d.id === 'D-002');
    expect(d2?.body).toContain('Already ratified.');
  });

  it('is idempotent — a decision already carrying a Ratified line is left untouched', () => {
    const { newBody, found, alreadyRatified } = ratifyDecisionInBody(PLAN, 'D-002', 'Someone Else', '2026-07-17');
    expect(found).toBe(true);
    expect(alreadyRatified).toBe(true);
    expect(newBody).toBe(PLAN); // unchanged
    const d2 = parsePlan(newBody).decisions.find((d) => d.id === 'D-002');
    expect(d2?.body).toContain('Ratified: Avi on 2026-06-21'); // original stamp, not overwritten
  });

  it('defaults `ratifiedOn` to today when omitted', () => {
    const today = new Date().toISOString().slice(0, 10);
    const { newBody } = ratifyDecisionInBody(PLAN, 'D-001', 'Avi');
    const d1 = parsePlan(newBody).decisions.find((d) => d.id === 'D-001');
    expect(d1?.body).toContain(`Ratified: Avi on ${today}`);
  });

  it('returns found:false for an unknown decision id (body unchanged)', () => {
    const { newBody, found, alreadyRatified } = ratifyDecisionInBody(PLAN, 'D-099', 'Avi', '2026-07-17');
    expect(found).toBe(false);
    expect(alreadyRatified).toBe(false);
    expect(newBody).toBe(PLAN);
  });
});
