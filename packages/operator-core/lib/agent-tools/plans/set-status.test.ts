import { describe, expect, it } from 'vitest';
import { shouldPushNeedsHuman, itemImportance, flipStatusInBody } from './set-status';

// P-020 (planning-attention-importance): plans:set-status pushes a
// notification when an item transitions INTO needs-human at importance
// >= high. These cover the two pure pieces of that gate; the push itself
// (notifyWorkspace) is the proven mobile-delivery path exercised elsewhere.

describe('shouldPushNeedsHuman', () => {
  it('fires on a fresh needs-human flip at urgent/high', () => {
    expect(shouldPushNeedsHuman('wip', 'needs-human', 'urgent')).toBe(true);
    expect(shouldPushNeedsHuman('todo', 'needs-human', 'high')).toBe(true);
    expect(shouldPushNeedsHuman(null, 'needs-human', 'urgent')).toBe(true);
  });

  it('does NOT fire below high importance', () => {
    expect(shouldPushNeedsHuman('wip', 'needs-human', 'normal')).toBe(false);
    expect(shouldPushNeedsHuman('wip', 'needs-human', 'low')).toBe(false);
  });

  it('does NOT fire when the item was already needs-human (re-set, not a transition)', () => {
    expect(shouldPushNeedsHuman('needs-human', 'needs-human', 'urgent')).toBe(false);
  });

  it('does NOT fire for non-needs-human target statuses', () => {
    expect(shouldPushNeedsHuman('todo', 'done', 'urgent')).toBe(false);
    expect(shouldPushNeedsHuman('wip', 'blocked', 'high')).toBe(false);
  });
});

describe('itemImportance', () => {
  const body = [
    '## Phase 1',
    '',
    '- **P-001** `todo` plain item, no keyword',
    '- **P-002** `wip` urgent one importance: urgent',
    '- **P-003** `todo` high one blocked-by: P-001 importance: high',
    '- **P-004** `done` explicit normal importance: normal',
    '- **P-005** `todo` bogus value importance: spicy',
    '',
  ].join('\n');

  it('defaults to normal when the keyword is absent', () => {
    expect(itemImportance(body, 'P-001')).toBe('normal');
  });

  it('reads the importance keyword regardless of position on the line', () => {
    expect(itemImportance(body, 'P-002')).toBe('urgent');
    expect(itemImportance(body, 'P-003')).toBe('high');
    expect(itemImportance(body, 'P-004')).toBe('normal');
  });

  it('degrades an unrecognised value to normal (no throw)', () => {
    expect(itemImportance(body, 'P-005')).toBe('normal');
  });

  it('returns normal for an unknown item id', () => {
    expect(itemImportance(body, 'P-999')).toBe('normal');
  });

  it('ignores an importance keyword that only appears inside a fenced example', () => {
    const fenced = [
      '## Phase 1',
      '',
      '- **P-010** `todo` real item',
      '',
      '```',
      '- **P-010** `todo` example importance: urgent',
      '```',
      '',
    ].join('\n');
    expect(itemImportance(fenced, 'P-010')).toBe('normal');
  });
});

// Guard the status-flip helper the push gate rides on, so a regression in
// the regex (which also feeds importance lookup) trips here.
describe('flipStatusInBody', () => {
  it('flips a status token and reports the old one', () => {
    const body = '- **P-001** `wip` do the thing';
    const out = flipStatusInBody(body, 'P-001', 'needs-human');
    expect(out.found).toBe(true);
    expect(out.oldStatus).toBe('wip');
    expect(out.newBody).toContain('`needs-human`');
  });
});
