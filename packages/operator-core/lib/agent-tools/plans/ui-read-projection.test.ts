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
          specTriadMissing: ['acceptance'],
          item: {
            id: 'P-001',
            storedStatus: 'todo',
            staleBlockedHint: 'blocked by P-000, which is done',
            // false, not null — so only ITEM_DROP can remove it and the
            // assertion below cannot be satisfied by the null-omit instead.
            needsHuman: false,
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

    // ── WI-7086: BOTH halves of the drop are pinned, so a field that comes
    // back (a re-inflation) and a field that goes away (a silent read break)
    // each red exactly one assertion.
    //
    // KEPT — the union of what all four live consumers read.
    expect(row.plan).toBe('my-plan');
    expect(item.id).toBe('P-001');
    expect(item.effectiveStatus).toBe('todo');
    expect(item.importance).toBe('high');
    expect(item.lastEditedBy).toEqual({ handle: 'ada' });

    // DROPPED — verified unread across PlanItemsList / PlansClient /
    // use-create-data / HydratedWorkRefPill. `archived` is read by NOTHING but a
    // comment; `storedStatus`/`needsHuman` only ever backed a SERVER-side filter
    // arg. Together with the nested-null omit this is the bulk of the saving.
    expect(row).not.toHaveProperty('archived');
    expect(item).not.toHaveProperty('storedStatus');
    expect(item).not.toHaveProperty('needsHuman');
    expect(item).not.toHaveProperty('phase');
    expect(item).not.toHaveProperty('blockedBy');
    expect(item).not.toHaveProperty('decisionRefs');
    expect(item).not.toHaveProperty('lineNumber');

    // WI-5910: the last two server-derived annotations no UI consumer reads.
    // Both are absent from the `{actionable:true}` worst case and only appear on
    // `{status:'blocked'}`, which is why they outlived the WI-7086 audit. Each
    // has a FALSE-POSITIVE grep hit on a different object (PromotePlanResult /
    // lint.ts's own resolve) — see ui-read-projection.ts before restoring either.
    expect(row).not.toHaveProperty('specTriadMissing');
    expect(item).not.toHaveProperty('staleBlockedHint');
  });

  it('omits null-valued keys on the nested item (D-025 applied to this feed)', () => {
    const out = projectPlansReadForUi('items', {
      items: [
        {
          plan: 'p',
          item: { id: 'P-1', text: 'short', effectiveStatus: 'todo', lastEditedBy: null, importance: null },
        },
      ],
    }) as { items: Array<Record<string, unknown>> };
    const item = out.items[0].item as Record<string, unknown>;
    // `lastEditedBy: null` was 2,542 of 3,327 rows on the live payload.
    expect(item).not.toHaveProperty('lastEditedBy');
    expect(item).not.toHaveProperty('importance');
    // …without collateral damage to a falsy-but-present value.
    expect(item.id).toBe('P-1');
    expect(item.effectiveStatus).toBe('todo');
  });

  it('keeps falsy-but-not-null item values (0 / "" / false survive the omit)', () => {
    const out = projectPlansReadForUi('items', {
      items: [{ plan: 'p', item: { id: 'P-1', text: '', effectiveStatus: 'todo', count: 0, flag: false } }],
    }) as { items: Array<{ item: Record<string, unknown> }> };
    const item = out.items[0].item;
    expect(item.text).toBe('');
    expect(item.count).toBe(0);
    expect(item.flag).toBe(false);
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
          triggered: true,
          triggerSources: ['external', 'manual'],
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
    expect(row.triggered).toBe(true);
    expect(row.triggerSources).toEqual(['external', 'manual']);
  });

  /**
   * SUPERSEDES the previous "leaves a null nextAction untouched" pin. WI-7045
   * extends D-025's null-key omission to this feed — 125,553 B of a live
   * 823,983 B / 934-row payload (15.2%) — so a null `nextAction` is now DROPPED
   * rather than preserved. Preconditioned on the consumer audit in
   * ui-read-projection.ts's header: zero `=== null` / `'k' in row` /
   * hasOwnProperty / destructuring-with-default sites across the 39 non-test
   * files that read this feed.
   */
  it('drops a null nextAction rather than preserving it (D-025)', () => {
    const out = projectPlansReadForUi('list', {
      plans: [{ slug: 'p', nextAction: null }],
    }) as { plans: Array<Record<string, unknown>> };
    expect(out.plans[0].nextAction).toBeUndefined();
    expect('nextAction' in out.plans[0]).toBe(false);
    expect(out.plans[0].slug).toBe('p');
  });

  it('drops every null-valued key — the columns that are null on nearly every row', () => {
    const out = projectPlansReadForUi('list', {
      plans: [
        {
          slug: 'p',
          status: 'active',
          initiative: null,
          priority: null,
          scheduleKind: null,
          origin: null,
          template: null,
          startStatus: null,
          maxImportance: null,
          owner: null,
          ownerIdentity: null,
          lastEditor: null,
          created: null,
        },
      ],
    }) as { plans: Array<Record<string, unknown>> };
    expect(Object.keys(out.plans[0]).sort()).toEqual(['slug', 'status']);
  });

  it('keeps non-null values, INCLUDING falsy ones (false / 0 / "") — only null goes', () => {
    const out = projectPlansReadForUi('list', {
      plans: [
        { slug: 'p', archived: false, priority: 0, title: '', owner: null, itemCounts: {} },
      ],
    }) as { plans: Array<Record<string, unknown>> };
    const row = out.plans[0];
    expect(row.archived).toBe(false);
    expect(row.priority).toBe(0);
    expect(row.title).toBe('');
    expect(row.itemCounts).toEqual({});
    expect('owner' in row).toBe(false);
  });

  /**
   * SHALLOW, per D-025 — and deliberately still shallow for the IDENTITY objects
   * (EI-19455103442009801). `avatarUrl` inside `lastEditor` / `ownerIdentity` was
   * null on 1,475/1,475 live occurrences and IS worth cutting, but it cannot be
   * cut here: `enrichPlanListRows` runs AFTER this projection and deletes then
   * RE-ATTACHES both keys, so a descent added here is a structural no-op (verified
   * live: 0 bytes changed). The real cut is at that attachment point, and
   * plan-attribution.test.ts is what guards it.
   *
   * This test pins the no-op so the tempting patch cannot land here and look green
   * while production still ships the nulls.
   */
  it('does NOT recurse into nested objects (nested nulls survive)', () => {
    const out = projectPlansReadForUi('list', {
      plans: [{ slug: 'p', lastEditor: { handle: 'ada', avatarUrl: null } }],
    }) as { plans: Array<{ lastEditor: Record<string, unknown> }> };
    expect(out.plans[0].lastEditor).toEqual({ handle: 'ada', avatarUrl: null });
  });

  /** The clip runs before the omit, so the two compose on a real string. */
  it('still clips a long nextAction while omitting the row-s other nulls', () => {
    const out = projectPlansReadForUi('list', {
      plans: [{ slug: 'p', nextAction: long(900), priority: null }],
    }) as { plans: Array<Record<string, unknown>> };
    expect((out.plans[0].nextAction as string).length).toBe(UI_TEXT_PREVIEW_MAX);
    expect('priority' in out.plans[0]).toBe(false);
  });
});

/**
 * SUPERSEDES the previous "attention passes through byte-identical" pin
 * (slim-plans-attention-sync-payload-2026-07-26 P-003). attention WAS the one
 * fat read left unprojected — 1490KB, 97.9% of it the nested items[] — and it
 * now gets a LIST/DETAIL split. The split is deliberately narrow, and the
 * KEPT-field tests below are the important ones: `actions` paints the selected
 * row's controls immediately, while `ref` and `report` have other list-level
 * consumers. Dropping any of them would be a silent regression.
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
            actions: [
              { id: 'answer', label: 'Answer' },
              { id: 'message-owner', label: 'Message owner' },
              { id: 'open', label: 'Open' },
              { id: 'dismiss', label: 'Dismiss' },
            ],
          },
        ],
      },
    ],
  });

  const firstItem = (out: unknown) =>
    (out as { groups: Array<{ items: Array<Record<string, unknown>> }> }).groups[0].items[0];

  it('KEEPS all `actions` — the selected pane paints them before detail hydration', () => {
    expect(firstItem(projectPlansReadForUi('attention', attentionFixture())).actions).toEqual([
      { id: 'answer', label: 'Answer' },
      { id: 'message-owner', label: 'Message owner' },
      { id: 'open', label: 'Open' },
      { id: 'dismiss', label: 'Dismiss' },
    ]);
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

/**
 * Null-key omission (no-http-anywhere-2026-07-28 D-025 / WI-7039) — 154,971 B of
 * a live 1,062,144 B payload (14.6%). The invariant that matters is the SHAPE of
 * the contract change: a null key becomes ABSENT (⇒ `undefined`), never a
 * falsy-but-present value, and nothing non-null is touched.
 */
describe('projectPlansReadForUi — attention omits null-valued keys', () => {
  const nullyFixture = () => ({
    groups: [
      {
        key: 'g1',
        kind: 'alerts',
        planSlug: null,
        harnessSlug: null,
        title: 'Alerts',
        maxImportance: 'high',
        items: [
          {
            id: 'a1',
            title: 't',
            body: 'short',
            status: 'open',
            needsHuman: false,
            triageNote: null,
            triagedBy: null,
            triagedAt: null,
            ownerAgentId: null,
            ownerLabel: null,
            harnessSlug: null,
            authorizer: null,
            whyGated: null,
            planSlug: null,
            itemRef: null,
            category: null,
            ref: { kind: 'owner-wall', wallOwnerId: null, wallRef: null },
          },
        ],
      },
    ],
  });

  const firstItem = (out: unknown) =>
    (out as { groups: Array<{ items: Array<Record<string, unknown>> }> }).groups[0].items[0];

  it('drops every null-valued key on an item', () => {
    const item = firstItem(projectPlansReadForUi('attention', nullyFixture()));
    for (const k of [
      'triageNote', 'triagedBy', 'triagedAt', 'ownerAgentId', 'ownerLabel',
      'harnessSlug', 'authorizer', 'whyGated', 'planSlug', 'itemRef', 'category',
    ]) {
      expect(item, `${k} should be absent, not null`).not.toHaveProperty(k);
    }
  });

  it('drops null-valued keys on the GROUP too, without losing items', () => {
    const g = (projectPlansReadForUi('attention', nullyFixture()) as {
      groups: Array<Record<string, unknown>>;
    }).groups[0];
    expect(g).not.toHaveProperty('planSlug');
    expect(g).not.toHaveProperty('harnessSlug');
    expect(g.key).toBe('g1');
    expect(g.title).toBe('Alerts');
    expect(g.items).toHaveLength(1);
  });

  it('keeps non-null values, INCLUDING falsy ones (false / 0 / "") — only null goes', () => {
    const att = nullyFixture();
    Object.assign(att.groups[0].items[0], { needsHuman: false, count: 0, note: '' });
    const item = firstItem(projectPlansReadForUi('attention', att));
    expect(item.needsHuman).toBe(false);
    expect(item.count).toBe(0);
    expect(item.note).toBe('');
    expect(item.id).toBe('a1');
    expect(item.status).toBe('open');
  });

  it('does NOT recurse into `ref` — a discriminated union consumers narrow structurally', () => {
    const item = firstItem(projectPlansReadForUi('attention', nullyFixture()));
    expect(item.ref).toEqual({ kind: 'owner-wall', wallOwnerId: null, wallRef: null });
  });

  it('drops group nulls even when the group carries no items array', () => {
    const out = projectPlansReadForUi('attention', {
      groups: [{ key: 'g', planSlug: null, title: 'x' }],
    }) as { groups: Array<Record<string, unknown>> };
    expect(out.groups[0]).not.toHaveProperty('planSlug');
    expect(out.groups[0].title).toBe('x');
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
