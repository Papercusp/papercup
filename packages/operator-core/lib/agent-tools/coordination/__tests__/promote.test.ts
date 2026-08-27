/**
 * Unit tests for promote.ts — the pure `from_items` validator.
 *
 * The SC-NNN allocator + SPEC.md mutator this file used to cover were
 * removed when plans replaced SPEC.md (plans-central-harness-ux-2026-05-26,
 * D-004/D-005); their tests went with them.
 */

import { describe, expect, it } from 'vitest';

import { findUnknownFromItems } from '../promote';
import { upsertPromotedBlock } from '../tools/promote';

describe('findUnknownFromItems (audit B2)', () => {
  it('returns [] when every from_items id is known', () => {
    const out = findUnknownFromItems(
      [{ from_items: ['P-001', 'P-002'] }, { from_items: ['P-003'] }],
      ['P-001', 'P-002', 'P-003', 'P-004'],
    );
    expect(out).toEqual([]);
  });

  it('returns [] when no feature declares from_items', () => {
    const features: Array<{ from_items?: string[]; title?: string }> = [{ title: 'a' }, {}];
    expect(findUnknownFromItems(features, ['P-001'])).toEqual([]);
  });

  it('surfaces ids absent from the plan, sorted + de-duplicated', () => {
    const out = findUnknownFromItems(
      [{ from_items: ['P-009', 'P-001'] }, { from_items: ['P-009', 'P-007'] }],
      ['P-001', 'P-002'],
    );
    expect(out).toEqual(['P-007', 'P-009']);
  });

  it('treats an empty known set as "everything is unknown"', () => {
    expect(findUnknownFromItems([{ from_items: ['P-001'] }], [])).toEqual(['P-001']);
  });
});

describe('upsertPromotedBlock work-item ids (EI-21594810094177772)', () => {
  it('deduplicates WI-* rows on a repeated plans:start promotion', () => {
    const body = `---\ntitle: plan\nstatus: ready\n---\n\n## Now\n\n**State:** ready\n`;
    const row = '- [ ] WI-123 — Build the API <!-- P-001 -->';
    const once = upsertPromotedBlock(body, [row]);

    expect(upsertPromotedBlock(once, [row])).toBe(once);
  });

  it('continues to deduplicate legacy F-* rows while adding a new WI-* row', () => {
    const body = `---\ntitle: plan\nstatus: ready\n---\n\n## Promoted\n\n<!-- plan-pipeline: do not edit this block manually -->\n- [ ] F-AUTO-1 — Existing\n`;
    const out = upsertPromotedBlock(body, [
      '- [ ] F-AUTO-1 — Existing',
      '- [ ] WI-123 — New <!-- P-001 -->',
    ]);

    expect(out.match(/^- \[ \] /gm)).toHaveLength(2);
    expect(out).toContain('- [ ] WI-123 — New <!-- P-001 -->');
  });
});
