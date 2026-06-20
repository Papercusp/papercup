/**
 * plans:set-item-phase — the pure helpers moveItemToPhase + normalizePhaseHeading
 * (plan-templates-and-rubric-v2-2026-06-20 P-003). The move relocates the whole item
 * line (every token preserved) and reuses add-item's appendItemToBody for insertion.
 * The handler's no-op-when-already-there + legacy guards mirror the tested
 * plans:add-item / plans:set-importance handlers.
 */
import { describe, it, expect } from 'vitest';
import { moveItemToPhase, normalizePhaseHeading } from './set-item-phase';
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
  '## Phase 2 — Beta',
  '- **P-003** `todo` Third item',
  '',
  '## Decisions',
  '',
  '### D-001 — A decision',
  'Date: 2026-06-20',
  'Body.',
  '',
].join('\n');

describe('normalizePhaseHeading', () => {
  it('strips a leading numeric heading prefix (matches the parser)', () => {
    expect(normalizePhaseHeading('1. Phase X')).toBe('Phase X');
    expect(normalizePhaseHeading('  Phase 2 — Beta ')).toBe('Phase 2 — Beta');
  });
});

describe('moveItemToPhase', () => {
  it('moves an item to an existing phase, preserving its tokens', () => {
    const { newBody, found, createdPhase } = moveItemToPhase(PLAN, 'P-002', 'Phase 2 — Beta');
    expect(found).toBe(true);
    expect(createdPhase).toBe(false);
    const item = parsePlan(newBody).items.find((i) => i.id === 'P-002');
    expect(item?.phase).toBe('Phase 2 — Beta');
    // tokens preserved through the relocation
    expect(item?.storedStatus).toBe('wip');
    expect(item?.importance).toBe('high');
    expect(item?.blockedBy).toEqual(['P-001']);
    expect(item?.text).toBe('Second item');
  });

  it('creates the target phase section when it does not exist', () => {
    const { newBody, found, createdPhase } = moveItemToPhase(PLAN, 'P-001', 'Phase 3 — Gamma');
    expect(found).toBe(true);
    expect(createdPhase).toBe(true);
    const parsed = parsePlan(newBody);
    expect(parsed.items.find((i) => i.id === 'P-001')?.phase).toBe('Phase 3 — Gamma');
    // the new phase section landed before ## Decisions (so D-001 still parses)
    expect(parsed.decisions.find((d) => d.id === 'D-001')).toBeTruthy();
  });

  it('does not duplicate the item (it is removed from its old phase)', () => {
    const { newBody } = moveItemToPhase(PLAN, 'P-001', 'Phase 2 — Beta');
    const matches = parsePlan(newBody).items.filter((i) => i.id === 'P-001');
    expect(matches).toHaveLength(1);
    expect(matches[0]?.phase).toBe('Phase 2 — Beta');
  });

  it('returns found:false for an unknown item id (body unchanged)', () => {
    const { newBody, found } = moveItemToPhase(PLAN, 'P-999', 'Phase 2 — Beta');
    expect(found).toBe(false);
    expect(newBody).toBe(PLAN);
  });
});
