/**
 * projectPlansReadForUi — UI display-projection unit pins
 * (whole-app-sync-payload-audit-2026-07-19 P-005; attention split added by
 * slim-plans-attention-sync-payload-2026-07-26 P-003).
 */
import { describe, expect, it } from 'vitest';
import {
  projectPlansReadForUi,
  UI_TEXT_PREVIEW_MAX,
  UI_ATTENTION_BODY_PREVIEW_MAX,
} from './ui-read-projection';

const long = (n: number) => 'x'.repeat(n);

describe('projectPlansReadForUi — plans:items', () => {
  it('clips item.text to a preview and drops non-display blobs, keeping display fields', () => {
    const text = long(1000);
    const input = {
      items: [
        {
          plan: 'my-plan',
          archived: false,
          coverage: { level: 'partial', workers: ['a', 'b', 'c'] },
          blockedByIssues: [{ id: 'x' }],
          item: {
            id: 'P-001',
            storedStatus: 'todo',
            effectiveStatus: 'todo',
            importance: 'high',
            phase: 'Phase 1',
            blockedBy: ['P-000'],
            decisionRefs: ['D-001'],
            lineNumber: 12,
            lastEditedBy: { handle: 'ada' },
            text,
            rawLine: '- [ ] P-001 …',
            unresolvedBlockers: ['P-000'],
          },
        },
      ],
    };
    const out = projectPlansReadForUi('items', input) as typeof input;
    const row = out.items[0] as Record<string, unknown>;
    const item = row.item as Record<string, unknown>;

    // text clipped to a preview with an ellipsis
    expect((item.text as string).length).toBe(UI_TEXT_PREVIEW_MAX);
    expect(item.text as string).toMatch(/…$/);
    // non-display blobs dropped
    expect(row).not.toHaveProperty('coverage');
    expect(row).not.toHaveProperty('blockedByIssues');
    expect(item).not.toHaveProperty('rawLine');
    expect(item).not.toHaveProperty('unresolvedBlockers');
    // display fields preserved verbatim
    expect(row.plan).toBe('my-plan');
    expect(row.archived).toBe(false);
    expect(item.id).toBe('P-001');
    expect(item.storedStatus).toBe('todo');
    expect(item.effectiveStatus).toBe('todo');
    expect(item.importance).toBe('high');
    expect(item.phase).toBe('Phase 1');
    expect(item.blockedBy).toEqual(['P-000']);
    expect(item.decisionRefs).toEqual(['D-001']);
    expect(item.lineNumber).toBe(12);
    expect(item.lastEditedBy).toEqual({ handle: 'ada' });
  });

  it('leaves a short item.text unchanged (no ellipsis on sub-cap text)', () => {
    const out = projectPlansReadForUi('items', {
      items: [{ plan: 'p', archived: false, item: { id: 'P-1', text: 'short' } }],
    }) as { items: Array<{ item: { text: string } }> };
    expect(out.items[0].item.text).toBe('short');
  });

  it('is a no-op when items is not an array (error/empty envelope passes through)', () => {
    expect(projectPlansReadForUi('items', { error: 'nope' })).toEqual({ error: 'nope' });
    expect(projectPlansReadForUi('items', { items: [] })).toEqual({ items: [] });
  });
});

describe('projectPlansReadForUi — plans:list', () => {
  it('clips nextAction to a preview and preserves every other field', () => {
    const nextAction = long(900);
    const input = {
      plans: [
        {
          slug: 'my-plan',
          title: 'Title',
          status: 'active',
          updated: '2026-07-19',
          nextAction,
          itemCounts: { todo: 3, done: 1 },
          ownerIdentity: { handle: 'ada' },
          maxImportance: 'high',
        },
      ],
    };
    const out = projectPlansReadForUi('list', input) as typeof input;
    const row = out.plans[0] as Record<string, unknown>;
    expect((row.nextAction as string).length).toBe(UI_TEXT_PREVIEW_MAX);
    expect(row.nextAction as string).toMatch(/…$/);
    expect(row.slug).toBe('my-plan');
    expect(row.title).toBe('Title');
    expect(row.status).toBe('active');
    expect(row.itemCounts).toEqual({ todo: 3, done: 1 });
    expect(row.ownerIdentity).toEqual({ handle: 'ada' });
    expect(row.maxImportance).toBe('high');
  });

  it('leaves a null nextAction untouched', () => {
    const out = projectPlansReadForUi('list', {
      plans: [{ slug: 'p', nextAction: null }],
    }) as { plans: Array<{ nextAction: unknown }> };
    expect(out.plans[0].nextAction).toBeNull();
  });
});

/**
 * SUPERSEDES the previous "attention passes through byte-identical" pin
 * (slim-plans-attention-sync-payload-2026-07-26 P-003). attention WAS the one
 * fat read left unprojected — 1490KB, 97.9% of it the nested items[] — and it
 * now gets a LIST/DETAIL split. The split is deliberately narrow, and the two
 * KEPT-field tests below are the important ones: both `ref` and `report` look
 * detail-tier but are read from the LIST feed, so dropping them would be a
 * silent regression rather than a saving.
 */
describe('projectPlansReadForUi — attention list/detail split', () => {
  const attentionFixture = () => ({
    tierCounts: { decision: 2 },
    groups: [
      {
        key: 'g1',
        items: [
          {
            id: 'a1',
            title: 't',
            body: long(2000),
            ref: { kind: 'plan-item', slug: 'p', itemId: 'P-1' },
            report: { title: 'r', plans: [] },
            actions: [{ id: 'answer', label: 'Answer' }],
          },
        ],
      },
    ],
  });

  const firstItem = (out: unknown) =>
    (out as { groups: Array<{ items: Array<Record<string, unknown>> }> }).groups[0].items[0];

  it('drops `actions` — the only purely detail-tier field (attention-card reads it on selection)', () => {
    expect(firstItem(projectPlansReadForUi('attention', attentionFixture()))).not.toHaveProperty(
      'actions',
    );
  });

  it('KEEPS `ref` — SessionChatModal filters the whole LIST feed by ref.options', () => {
    // isEscalationWithOptions() narrows the feed before anything is selected, so
    // dropping ref empties the session-chat escalation cards.
    expect(firstItem(projectPlansReadForUi('attention', attentionFixture())).ref).toEqual({
      kind: 'plan-item',
      slug: 'p',
      itemId: 'P-1',
    });
  });

  it('KEEPS `report` — InboxPane.buildDiscussDraft reads it, and it costs ~0 bytes live', () => {
    expect(firstItem(projectPlansReadForUi('attention', attentionFixture()))).toHaveProperty(
      'report',
    );
  });

  it('clips a long `body` to the preview cap and flags it truncated', () => {
    const item = firstItem(projectPlansReadForUi('attention', attentionFixture()));
    expect((item.body as string).length).toBe(UI_ATTENTION_BODY_PREVIEW_MAX);
    expect(item.bodyTruncated).toBe(true);
  });

  it('leaves a short `body` alone and does NOT flag it — search still matches in full', () => {
    const att = attentionFixture();
    att.groups[0].items[0].body = 'short body';
    const item = firstItem(projectPlansReadForUi('attention', att));
    expect(item.body).toBe('short body');
    expect(item).not.toHaveProperty('bodyTruncated');
  });

  it('preserves group-level fields normalizeAttentionGroups requires (key + items)', () => {
    const out = projectPlansReadForUi('attention', attentionFixture()) as {
      tierCounts: unknown;
      groups: Array<{ key: string; items: unknown[] }>;
    };
    expect(out.tierCounts).toEqual({ decision: 2 });
    expect(out.groups[0].key).toBe('g1');
    expect(out.groups[0].items).toHaveLength(1);
  });

  it('is defensive about malformed groups/items rather than throwing', () => {
    const att = { groups: [null, { key: 'no-items' }, { key: 'g', items: [null, 'raw'] }] };
    expect(() => projectPlansReadForUi('attention', att)).not.toThrow();
    const out = projectPlansReadForUi('attention', att) as { groups: unknown[] };
    expect(out.groups).toHaveLength(3);
  });
});

describe('projectPlansReadForUi — passthrough verbs (plans:get stays full fidelity)', () => {
  it('leaves plans:get byte-identical — it is the full-fidelity detail read', () => {
    const plan = { slug: 'p', raw: long(5000), items: [{ id: 'P-1', text: long(1000) }] };
    expect(projectPlansReadForUi('get', plan)).toEqual(plan);
  });

  it('is defensive against non-object / array payloads', () => {
    expect(projectPlansReadForUi('items', null)).toBeNull();
    expect(projectPlansReadForUi('items', 'raw-text')).toBe('raw-text');
    expect(projectPlansReadForUi('list', [1, 2])).toEqual([1, 2]);
  });
});
