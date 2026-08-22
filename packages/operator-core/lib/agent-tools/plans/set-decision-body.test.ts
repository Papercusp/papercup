/**
 * plans:set-decision-body — the pure helper setDecisionBodyInBody
 * (plan-templates-and-rubric-v2-2026-06-20 P-003). Replaces a decision's body while
 * preserving the `### D-NNN — title` head + the `Date:` and `Related:` lines. The handler wiring
 * (withPlanLock + revision + legacy/not-found guards) mirrors the tested
 * plans:add-decision.
 */
import { describe, it, expect } from 'vitest';
import { setDecisionBodyInBody } from './set-decision-body';
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
  'Another body.',
  '',
].join('\n');

describe('setDecisionBodyInBody', () => {
  it('replaces a middle decision body, preserving head + Date and leaving siblings intact', () => {
    const { newBody, found, oldBody } = setDecisionBodyInBody(PLAN, 'D-001', 'New body content.', '2026-06-19');
    expect(found).toBe(true);
    expect(oldBody).toBe('Original body text.\nRelated: P-001');

    const parsed = parsePlan(newBody);
    const d1 = parsed.decisions.find((d) => d.id === 'D-001');
    expect(d1?.title).toBe('First decision'); // head preserved
    expect(d1?.date).toBe('2026-06-19'); // Date preserved
    expect(d1?.body).toContain('New body content.');
    expect(d1?.body).not.toContain('Original body text.');
    expect(d1?.itemRefs).toEqual(['P-001']); // generated refs survive a body edit
    // sibling untouched
    const d2 = parsed.decisions.find((d) => d.id === 'D-002');
    expect(d2?.title).toBe('Second decision');
    expect(d2?.body).toContain('Another body.');
  });

  it('replaces the LAST decision body (block runs to EOF)', () => {
    const { newBody, found } = setDecisionBodyInBody(PLAN, 'D-002', 'Replaced tail.', '2026-06-20');
    expect(found).toBe(true);
    const parsed = parsePlan(newBody);
    expect(parsed.decisions.find((d) => d.id === 'D-002')?.body).toContain('Replaced tail.');
    // first decision untouched
    expect(parsed.decisions.find((d) => d.id === 'D-001')?.body).toContain('Original body text.');
  });

  it('preserves the existing Related line when refs are omitted', () => {
    const { newBody } = setDecisionBodyInBody(PLAN, 'D-001', 'Body without refs.', '2026-06-19');
    const d1 = parsePlan(newBody).decisions.find((d) => d.id === 'D-001');
    expect(d1?.itemRefs).toEqual(['P-001']);
  });

  it('replaces the Related line when refs are supplied explicitly', () => {
    const { newBody } = setDecisionBodyInBody(PLAN, 'D-001', 'Body with replacement refs.', '2026-06-19', ['P-002']);
    const d1 = parsePlan(newBody).decisions.find((d) => d.id === 'D-001');
    expect(d1?.itemRefs).toEqual(['P-002']);
  });

  it('clears the Related line when refs is explicitly empty', () => {
    const { newBody } = setDecisionBodyInBody(PLAN, 'D-001', 'Body with no refs.', '2026-06-19', []);
    const d1 = parsePlan(newBody).decisions.find((d) => d.id === 'D-001');
    expect(d1?.itemRefs).toEqual([]);
  });

  it('omits the Date line when the decision had no date', () => {
    const { newBody, found } = setDecisionBodyInBody(PLAN, 'D-001', 'No date here.', null);
    expect(found).toBe(true);
    const d1 = parsePlan(newBody).decisions.find((d) => d.id === 'D-001');
    expect(d1?.date).toBeNull();
    expect(d1?.body).toContain('No date here.');
  });

  it('returns found:false for an unknown decision id (body unchanged)', () => {
    const { newBody, found, oldBody } = setDecisionBodyInBody(PLAN, 'D-099', 'x', '2026-06-20');
    expect(found).toBe(false);
    expect(oldBody).toBe('');
    expect(newBody).toBe(PLAN);
  });
});
