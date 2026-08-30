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

const GROUPED_COMPLETION = CURRENT.replace(
  '**State:** P-001 is done.\n\n**Next:** Continue with P-002.',
  '**State:** NOT COMPLETE: The engineering half (P-001/P-002/P-003/P-004/P-005/P-007) is code-truth audited and independently accepted; P-008 remains blocked.\n\n**Next:** Continue with P-008.',
).replace(
  '- **P-002** `todo` Open item.',
  '- **P-002** `done` Finished item.\n- **P-003** `done` Finished item.\n- **P-004** `done` Finished item.\n- **P-005** `done` Finished item.\n- **P-006** `todo` Open item.\n- **P-007** `done` Finished item.',
);

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

  it('allows grouped affirmative completion evidence before unrelated blocked work', () => {
    expect(detectNowItemContradictions(parsePlan(GROUPED_COMPLETION))).toEqual([]);
  });

  it('allows terminal IDs in an explicit historical promotion reference', () => {
    const proposed = parsePlan(
      CURRENT.replace(
        '**State:** P-001 is done.\n\n**Next:** Continue with P-002.',
        '**State:** COMPLETE: all items are terminal. Historical promotion record: P-001–P-001/WI-41306.',
      ),
    );

    expect(detectNowItemContradictions(proposed)).toEqual([]);
  });

  it('allows a neutral cross-ledger implementation mapping for a terminal item', () => {
    const proposed = parsePlan(
      CURRENT.replace(
        '**State:** P-001 is done.\n\n**Next:** Continue with P-002.',
        '**State:** The consumer lane is now WI-41755/P-001 under D-081; its affected-radius verification remains in progress.\n\n**Next:** Continue the affected-radius verification.',
      ),
    );

    expect(detectNowItemContradictions(proposed)).toEqual([]);
  });

  it('still flags action or active-status wording around a cross-ledger reference', () => {
    const action = parsePlan(
      CURRENT.replace(
        '**State:** P-001 is done.\n\n**Next:** Continue with P-002.',
        '**State:** Revisit WI-41755/P-001 under D-081 before continuing.',
      ),
    );
    const active = parsePlan(
      CURRENT.replace(
        '**State:** P-001 is done.\n\n**Next:** Continue with P-002.',
        '**State:** Active implementation lane: WI-41755/P-001 under D-081.',
      ),
    );

    expect(detectNowItemContradictions(action)).toEqual([
      expect.objectContaining({ id: 'P-001', status: 'done' }),
    ]);
    expect(detectNowItemContradictions(active)).toEqual([
      expect.objectContaining({ id: 'P-001', status: 'done' }),
    ]);
  });

  it('still flags an action-oriented mention inside a historical note', () => {
    const proposed = parsePlan(
      CURRENT.replace(
        '**State:** P-001 is done.\n\n**Next:** Continue with P-002.',
        '**State:** COMPLETE: the prior run is recorded. Historical note: revisit P-001.',
      ),
    );

    expect(detectNowItemContradictions(proposed)).toEqual([
      expect.objectContaining({ id: 'P-001', status: 'done' }),
    ]);
  });

  it('exempts a P-NNN mention explicitly prefixed by a DIFFERENT plan slug', () => {
    // EI-21900747713795768: "Audited under <other-plan> P-001" cites the
    // OTHER plan's P-001, not this plan's own (terminal) P-001 — even though
    // the reference reads exactly like the action-oriented shape this guard
    // otherwise flags.
    const proposed = parsePlan(
      CURRENT.replace(
        '**Next:** Continue with P-002.',
        '**Next:** Audited under pui-tui-ship-drive-2026-08-30 P-001.',
      ),
      { filePath: `${SLUG}.md` },
    );

    expect(detectNowItemContradictions(proposed)).toEqual([]);
  });

  it('still flags a P-NNN mention prefixed by THIS plan\'s own slug', () => {
    // The slug-prefix exemption is scoped to a genuinely DIFFERENT plan — a
    // citation of this plan's own slug is not a foreign reference and must
    // not silently defeat the guard.
    const proposed = parsePlan(
      CURRENT.replace(
        '**Next:** Continue with P-002.',
        `**Next:** Revisit ${SLUG} P-001 before continuing.`,
      ),
      { filePath: `${SLUG}.md` },
    );

    expect(detectNowItemContradictions(proposed)).toEqual([
      expect.objectContaining({ id: 'P-001', status: 'done' }),
    ]);
  });

  it('does not exempt a bare terminal-status word merely resembling a slug segment', () => {
    // Guard against a regression that treats any hyphenated word before the
    // id as a foreign-plan citation: without a trailing -YYYY-MM-DD date the
    // prefix regex must not match at all, so ordinary action wording is
    // still caught.
    const proposed = parsePlan(
      CURRENT.replace('**Next:** Continue with P-002.', '**Next:** re-revisit P-001 before continuing.'),
      { filePath: `${SLUG}.md` },
    );

    expect(detectNowItemContradictions(proposed)).toEqual([
      expect.objectContaining({ id: 'P-001', status: 'done' }),
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

  it('accepts grouped affirmative completion evidence in an incomplete plan', () => {
    const result = evaluateNowUpdate(
      GROUPED_COMPLETION,
      'NOT COMPLETE: The engineering half (P-001/P-002/P-003/P-004/P-005/P-007) is code-truth audited and independently accepted; P-008 remains blocked.',
      'Continue with P-008.',
      SLUG,
    );

    expect(result.value).toEqual({ ok: true });
  });

  it('accepts a neutral cross-ledger implementation mapping while verification continues', () => {
    const result = evaluateNowUpdate(
      CURRENT,
      'The consumer lane is now WI-41755/P-001 under D-081; its affected-radius verification remains in progress.',
      'Continue the affected-radius verification.',
      SLUG,
    );

    expect(result.value).toEqual({ ok: true });
  });

  it('accepts a cross-plan P-NNN citation even when this plan has its own terminal item of the same number', () => {
    // EI-21900747713795768's exact reproduction shape: citing another
    // plan's item id by writing "<other-plan-slug> P-001" into a plan whose
    // OWN P-001 happens to already be done must not be read as a
    // contradiction about this plan's P-001.
    const result = evaluateNowUpdate(
      CURRENT,
      'Audited under pui-tui-ship-drive-2026-08-30 P-001.',
      'Continue with P-002.',
      SLUG,
    );

    expect(result.value).toEqual({ ok: true });
  });
});
