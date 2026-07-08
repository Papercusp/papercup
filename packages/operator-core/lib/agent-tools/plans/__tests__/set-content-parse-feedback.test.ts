/**
 * set-content-parse-feedback.test.ts — item-parse feedback flowing through the
 * shared whole-body write core (WI-3363).
 *
 * evaluateSetContent computes the parse-feedback once, so plans:set-content,
 * plans:set-content-chunk (commit), AND plans:edit all report itemsParsed +
 * echoed items + a hint when list-like lines look like items but did not parse.
 * echoParsedItem is the plans:add-item echo. Pure — no PG / lock.
 */
import { describe, expect, it } from 'vitest';
import { evaluateSetContent } from '../set-content';
import { evaluatePlanEdit } from '../edit';
import { echoParsedItem } from '../item-parse-feedback';

const SLUG = 'test-plan-2026-07-08';
const FM = `---
title: Test Plan
slug: ${SLUG}
created: 2026-07-08
updated: 2026-07-08
status: active
---

# Test Plan

## Now

**State:** Where things stand.

**Next:** The next concrete action.

`;
const PROSE_ONLY = FM + '## Background\n\nSome prose, no items.\n\n## Decisions\n';
const TWO_ITEMS =
  FM +
  '## Phase 1\n\n- **P-001** `todo` first item\n- **P-002** `todo` second item\n\n## Decisions\n';
const ONE_GOOD_ONE_BAD =
  FM +
  '## Phase 1\n\n- **P-001** `todo` a valid item\n- [ ] a malformed one\n\n## Decisions\n';

describe('evaluateSetContent — item-parse feedback (WI-3363)', () => {
  it('a well-formed item body reports itemsParsed + echoes, no hint', async () => {
    const r = await evaluateSetContent(PROSE_ONLY, TWO_ITEMS, SLUG, undefined);
    expect(r.value.ok).toBe(true);
    if (r.value.ok) {
      expect(r.value.parseFeedback.itemsParsed).toBe(2);
      expect(r.value.parseFeedback.items.map((i) => i.id)).toEqual(['P-001', 'P-002']);
      expect(r.value.parseFeedback.hint).toBeUndefined();
      expect(r.value.parseFeedback.unparsedItemLines).toBeUndefined();
    }
  });

  it('a malformed item line is flagged (the trap fires through set-content too)', async () => {
    const r = await evaluateSetContent(PROSE_ONLY, ONE_GOOD_ONE_BAD, SLUG, undefined);
    expect(r.value.ok).toBe(true);
    if (r.value.ok) {
      expect(r.value.parseFeedback.itemsParsed).toBe(1);
      expect(r.value.parseFeedback.unparsedItemLines).toBe(1);
      expect(r.value.parseFeedback.hint).toContain('plans:set-content');
    }
  });

  it('a prose-only rewrite (0 items) produces NO bare-0-item hint', async () => {
    const r = await evaluateSetContent(TWO_ITEMS, PROSE_ONLY, SLUG, undefined);
    expect(r.value.ok).toBe(true);
    if (r.value.ok) {
      expect(r.value.parseFeedback.itemsParsed).toBe(0);
      expect(r.value.parseFeedback.hint).toBeUndefined();
    }
  });
});

describe('evaluatePlanEdit — item-parse feedback flows through', () => {
  it('an edit that leaves items intact reports itemsParsed + the edited text', async () => {
    const r = await evaluatePlanEdit(TWO_ITEMS, 'second item', 'second item (edited)', false, SLUG, undefined);
    expect(r.value.ok).toBe(true);
    if (r.value.ok) {
      expect(r.value.parseFeedback.itemsParsed).toBe(2);
      expect(r.value.parseFeedback.items.find((i) => i.id === 'P-002')?.text).toContain('edited');
    }
  });

  it('an edit that breaks an item line flags it as unparsed', async () => {
    const r = await evaluatePlanEdit(
      TWO_ITEMS,
      '- **P-002** `todo` second item',
      '- [ ] second item, now broken',
      false,
      SLUG,
      undefined,
    );
    expect(r.value.ok).toBe(true);
    if (r.value.ok) {
      expect(r.value.parseFeedback.itemsParsed).toBe(1); // P-001 survives
      expect(r.value.parseFeedback.unparsedItemLines).toBe(1);
      expect(r.value.parseFeedback.hint).toContain('plans:set-content');
    }
  });
});

describe('echoParsedItem — plans:add-item echo (WI-3363)', () => {
  it('echoes a present item in parsed form', () => {
    expect(echoParsedItem(TWO_ITEMS, 'P-002')).toMatchObject({
      id: 'P-002',
      status: 'todo',
      text: 'second item',
    });
  });

  it('returns null for an id not present as a parsed item', () => {
    expect(echoParsedItem(TWO_ITEMS, 'P-999')).toBeNull();
  });
});
