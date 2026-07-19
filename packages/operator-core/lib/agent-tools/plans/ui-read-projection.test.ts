/**
 * projectPlansReadForUi — UI display-projection unit pins
 * (whole-app-sync-payload-audit-2026-07-19 P-005).
 */
import { describe, expect, it } from 'vitest';
import { projectPlansReadForUi, UI_TEXT_PREVIEW_MAX } from './ui-read-projection';

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

describe('projectPlansReadForUi — passthrough verbs (WI-5078: attention/get untouched)', () => {
  it('leaves plans:attention byte-identical — body/ref/actions are load-bearing', () => {
    const att = {
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
              actions: [{ id: 'answer', label: 'Answer' }],
            },
          ],
        },
      ],
    };
    expect(projectPlansReadForUi('attention', att)).toEqual(att);
  });

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
