/**
 * plans:set-item-blocked-by — the pure body-mutation helper setBlockedByInBody
 * (plan-templates-and-rubric-v2-2026-06-20 P-003). Mirrors set-importance's
 * setImportanceInBody: anchor on the P-NNN id, rewrite ONLY the `blocked-by:`
 * keyword, preserve every other token. The handler wiring (withPlanLock + revision +
 * invalidate) mirrors the tested plans:set-importance.
 */
import { describe, it, expect } from 'vitest';
import { setBlockedByInBody } from './set-item-blocked-by';
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
  '## Phase 1 — Alpha',
  '- **P-001** `todo` First item',
  '- **P-002** `wip` Second item blocked-by: P-001 importance: high',
  '',
].join('\n');

describe('setBlockedByInBody', () => {
  it('adds a blocked-by keyword to a line that had none', () => {
    const { newBody, found, oldBlockedBy } = setBlockedByInBody(PLAN, 'P-001', ['P-009']);
    expect(found).toBe(true);
    expect(oldBlockedBy).toEqual([]);
    expect(newBody).toContain('- **P-001** `todo` First item blocked-by: P-009');
    // round-trips through the parser
    expect(parsePlan(newBody).items.find((i) => i.id === 'P-001')?.blockedBy).toEqual(['P-009']);
  });

  it('replaces an existing blocked-by list, preserving other keywords (importance)', () => {
    const { newBody, found, oldBlockedBy } = setBlockedByInBody(PLAN, 'P-002', ['P-001', 'P-004']);
    expect(found).toBe(true);
    expect(oldBlockedBy).toEqual(['P-001']);
    const item = parsePlan(newBody).items.find((i) => i.id === 'P-002');
    expect(item?.blockedBy).toEqual(['P-001', 'P-004']);
    // importance survives the edit
    expect(item?.importance).toBe('high');
    // text survives the edit (keywords stripped by the parser)
    expect(item?.text).toBe('Second item');
  });

  it('clears the blocked-by keyword when given an empty list', () => {
    const { newBody, found, oldBlockedBy } = setBlockedByInBody(PLAN, 'P-002', []);
    expect(found).toBe(true);
    expect(oldBlockedBy).toEqual(['P-001']);
    expect(newBody).not.toContain('blocked-by:');
    const item = parsePlan(newBody).items.find((i) => i.id === 'P-002');
    expect(item?.blockedBy).toEqual([]);
    expect(item?.importance).toBe('high'); // other keyword untouched
  });

  it('returns found:false for an unknown item id (body unchanged)', () => {
    const { newBody, found, oldBlockedBy } = setBlockedByInBody(PLAN, 'P-999', ['P-001']);
    expect(found).toBe(false);
    expect(oldBlockedBy).toEqual([]);
    expect(newBody).toBe(PLAN);
  });

  it('does not touch an item id that only appears inside a fenced code block', () => {
    const fenced = [
      '---',
      'title: T',
      'slug: t',
      'status: ready',
      '---',
      '',
      '## Phase 1 — Alpha',
      '```',
      '- **P-050** `todo` example in a fence',
      '```',
      '- **P-001** `todo` Real item',
      '',
    ].join('\n');
    const { found } = setBlockedByInBody(fenced, 'P-050', ['P-001']);
    expect(found).toBe(false); // the fenced line is not a real item
  });
});
