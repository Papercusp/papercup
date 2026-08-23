import { describe, expect, it } from 'vitest';
import { parsePlan } from '../parser';
import { detectNowItemContradictions } from '../now-item-contradictions';
import { evaluateSetContent } from '../set-content';
import { evaluateNowUpdate } from '../set-now';

const SLUG = 'now-item-contradictions-2026-08-23';

const CURRENT = `---
title: Now contradiction test
slug: ${SLUG}
status: active
created: 2026-08-23
updated: 2026-08-23
---

# Now contradiction test

## Now

**State:** P-001 is done.

**Next:** Continue with P-002.

## Phase 1

- **P-001** \`done\` Finished item.
- **P-002** \`todo\` Open item.

## Decisions
`;

describe('detectNowItemContradictions', () => {
  it('flags an action-oriented mention of a terminal item', () => {
    const proposed = parsePlan(
      CURRENT.replace('**Next:** Continue with P-002.', '**Next:** Revisit P-001 before continuing.'),
    );

    expect(detectNowItemContradictions(proposed)).toEqual([
      expect.objectContaining({ id: 'P-001', status: 'done' }),
    ]);
  });

  it('allows terminal items to be described as completed', () => {
    const parsed = parsePlan(CURRENT);

    expect(detectNowItemContradictions(parsed)).toEqual([]);
  });

  it('flags negated completion instead of treating it as closure', () => {
    const proposed = parsePlan(
      CURRENT.replace('**State:** P-001 is done.', '**State:** P-001 is not done yet.'),
    );

    expect(detectNowItemContradictions(proposed)).toEqual([
      expect.objectContaining({ id: 'P-001', status: 'done' }),
    ]);
  });

  it('preserves dropped as the terminal status in contradiction evidence', () => {
    const proposed = parsePlan(
      CURRENT
        .replace('- **P-001** `done` Finished item.', '- **P-001** `dropped` Dropped item.')
        .replace('**Next:** Continue with P-002.', '**Next:** Revisit P-001 before continuing.'),
    );

    expect(detectNowItemContradictions(proposed)).toEqual([
      expect.objectContaining({ id: 'P-001', status: 'dropped' }),
    ]);
  });
});

describe('evaluateSetContent — Now/item contradiction guard', () => {
  it('rejects a whole-document write that introduces a terminal-item contradiction', async () => {
    const proposed = CURRENT.replace(
      '**Next:** Continue with P-002.',
      '**Next:** Revisit P-001 before continuing.',
    );
    const result = await evaluateSetContent(CURRENT, proposed, SLUG, undefined, {
      wholeDocumentRewrite: true,
    });

    expect(result.newBody).toBeNull();
    expect(result.value.ok).toBe(false);
    if (!result.value.ok) {
      expect(result.value.code).toBe('lint_failed');
      if (result.value.code === 'lint_failed') {
        expect(result.value.errors).toEqual([
          expect.objectContaining({ code: 'now_item_status_contradiction', itemId: 'P-001' }),
        ]);
      }
    }
  });
});

describe('evaluateNowUpdate — Now/item contradiction guard', () => {
  it('rejects a structured Now write that points back at a terminal item', () => {
    const result = evaluateNowUpdate(CURRENT, 'Work remains.', 'Revisit P-001.', SLUG);

    expect(result.newBody).toBeNull();
    expect(result.value).toEqual({
      ok: false,
      code: 'now_item_status_contradiction',
      contradictions: [expect.objectContaining({ id: 'P-001', status: 'done' })],
    });
  });

  it('accepts a structured Now write that records completion and advances to open work', () => {
    const result = evaluateNowUpdate(CURRENT, 'P-001 is done.', 'Continue with P-002.', SLUG);

    expect(result.value).toEqual({ ok: true });
    expect(result.newBody).toContain('**Next:** Continue with P-002.');
  });
});
