/**
 * plans:set-item-blocked-by — the pure body-mutation helper setBlockedByInBody
 * (plan-templates-and-rubric-v2-2026-06-20 P-003). Mirrors set-importance's
 * setImportanceInBody: anchor on the P-NNN id, rewrite ONLY the `blocked-by:`
 * keyword, preserve every other token. The handler wiring (withPlanLock + revision +
 * invalidate) mirrors the tested plans:set-importance.
 */
import { describe, it, expect } from 'vitest';
import { setBlockedByInBody } from './set-item-blocked-by';
import { flipStatusInBody } from './set-status';
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

/**
 * EI-20577635585381178 — a `blocked-by:` edge must SURVIVE a subsequent
 * set-status-with-note write, and a note must survive a subsequent blocked-by write.
 *
 * The defect: NOTE_SUFFIX_RE is `/\s*—\s*note:.*$/` (matches to END OF LINE) and
 * set-status strips an existing note with `rest.replace(NOTE_MARKER_RE, '')` before
 * re-appending. So a keyword emitted AFTER the note was swallowed whole by the next
 * status write — silently destroying the dependency edge with no error.
 *
 * Measured in the wild: plan release-build-vm-dev-parity-audit-2026-08-13 item P-006
 * had `blocked-by: P-002, P-001` applied (revision seq 48) and eaten 0.4s later by a
 * set-status note write (seq 50). The item re-derived as `todo` with zero blockers and
 * was re-offered by the scheduler, stalling WI-38602 for 43+ consecutive cold wakes.
 *
 * These assert the ORDERING INVARIANT that prevents it: keywords precede the note.
 */
describe('blocked-by survives a set-status note write (EI-20577635585381178)', () => {
  const WITH_NOTE = [
    '## Phase 1 — Alpha',
    '- **P-006** `wip` Run the dev baseline — note: an earlier injected note',
    '',
  ].join('\n');

  it('emits the keyword BEFORE an existing note suffix', () => {
    const { newBody, found } = setBlockedByInBody(WITH_NOTE, 'P-006', ['P-002', 'P-001']);
    expect(found).toBe(true);
    // the clause must sit before the em-dash note marker, not trail it
    const line = newBody.split('\n').find((l) => l.includes('P-006')) ?? '';
    expect(line.indexOf('blocked-by:')).toBeGreaterThan(-1);
    expect(line.indexOf('blocked-by:')).toBeLessThan(line.indexOf('— note:'));
    expect(parsePlan(newBody).items.find((i) => i.id === 'P-006')?.blockedBy).toEqual([
      'P-002',
      'P-001',
    ]);
  });

  it('THE REGRESSION: the edge survives a following set-status that replaces the note', () => {
    const withEdge = setBlockedByInBody(WITH_NOTE, 'P-006', ['P-002', 'P-001']).newBody;
    // this is the exact call shape that destroyed the edge in the wild
    const { newBody, found } = flipStatusInBody(withEdge, 'P-006', 'todo', '← WI-38602 released');
    expect(found).toBe(true);

    const item = parsePlan(newBody).items.find((i) => i.id === 'P-006');
    expect(item?.blockedBy).toEqual(['P-002', 'P-001']); // was [] before the fix
    expect(item?.storedStatus).toBe('todo');
    expect(newBody).toContain('← WI-38602 released');
  });

  it('the note survives a following blocked-by write (the other direction)', () => {
    const flipped = flipStatusInBody(WITH_NOTE, 'P-006', 'blocked', 'gated on P-001').newBody;
    const { newBody } = setBlockedByInBody(flipped, 'P-006', ['P-001']);

    expect(newBody).toContain('— note: gated on P-001');
    expect(parsePlan(newBody).items.find((i) => i.id === 'P-006')?.blockedBy).toEqual(['P-001']);
  });

  it('clearing the edge leaves the note intact', () => {
    const withEdge = setBlockedByInBody(WITH_NOTE, 'P-006', ['P-001']).newBody;
    const { newBody } = setBlockedByInBody(withEdge, 'P-006', []);

    expect(newBody).toContain('— note: an earlier injected note');
    expect(newBody).not.toContain('blocked-by:');
    expect(parsePlan(newBody).items.find((i) => i.id === 'P-006')?.blockedBy).toEqual([]);
  });
});

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

  it('normalizes every repeated blocked-by clause when replacing the list', () => {
    const duplicated = PLAN.replace(
      '- **P-002** `wip` Second item blocked-by: P-001 importance: high',
      '- **P-002** `wip` Second item blocked-by: P-001 blocked-by: P-003 importance: high — note: stale',
    );
    const { newBody, found, oldBlockedBy } = setBlockedByInBody(duplicated, 'P-002', ['P-004']);

    expect(found).toBe(true);
    expect(oldBlockedBy).toEqual(['P-001', 'P-003']);
    expect(newBody.match(/blocked-by:/g)).toHaveLength(1);
    expect(newBody).toContain('— note: stale');
    const item = parsePlan(newBody).items.find((i) => i.id === 'P-002');
    expect(item?.blockedBy).toEqual(['P-004']);
    expect(item?.importance).toBe('high');
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
