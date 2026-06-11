/**
 * manage tests (learning-packs-2026-06-11 P-009/P-010/P-013) — fake backend +
 * fake judge; pins the classify→review→apply contract (never a silent union),
 * provenance-driven uninstall with keep-edited, enable/disable settings, and
 * the new-items-only upgrade plan.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('../memory/backend', () => ({ getMemoryBackend: vi.fn() }));
vi.mock('../hive-settings-store', () => ({
  getHiveSetting: vi.fn(async () => settingRec),
  setHiveSetting: vi.fn(async (input: { value: unknown }) => {
    settingRec = { value: input.value };
    return settingRec;
  }),
}));

import { getMemoryBackend } from '../memory/backend';
import {
  applyPackInstall,
  classifyPackInstall,
  disabledPacksFor,
  planPackUpgrade,
  setPackEnabled,
  uninstallPack,
} from './manage';
import type { LearningPack } from './pack-format';

let settingRec: { value: unknown } | null = null;

const pack: LearningPack = {
  manifest: { id: 'rails-pack', title: 'Rails', description: 'd', version: '2.0.0' },
  items: [
    { id: 'a', title: 'A', kind: 'feedback', appliesTo: ['any'], text: 'always do a' },
    { id: 'b', title: 'B', kind: 'feedback', appliesTo: ['any'], text: 'always do b' },
    { id: 'c', title: 'C', kind: 'feedback', appliesTo: ['any'], text: 'always do c' },
  ],
};

type Entry = { id: string; text: string; scope: string; score?: number; metadata?: Record<string, unknown> };

/** Fake store: search returns canned neighbors per incoming-text substring. */
const fakeBackend = (opts: {
  neighborsFor?: Record<string, Entry[]>;
  pool?: Entry[];
}) => {
  const forgotten: string[] = [];
  const remembered: Array<{ text: string; meta: Record<string, unknown> }> = [];
  const backend = {
    name: 'fake',
    available: vi.fn(async () => ({ ok: true as const })),
    search: vi.fn(async (q: string) => {
      for (const [needle, rows] of Object.entries(opts.neighborsFor ?? {})) {
        if (q.includes(needle)) return rows;
      }
      return [];
    }),
    list: vi.fn(async () => opts.pool ?? []),
    forget: vi.fn(async (id: string) => {
      forgotten.push(id);
    }),
    remember: vi.fn(async (text: string, o: { metadata?: Record<string, unknown> }) => {
      remembered.push({ text, meta: o.metadata ?? {} });
      return { ids: [`new-${remembered.length}`] };
    }),
  };
  vi.mocked(getMemoryBackend).mockReturnValue(backend as unknown as ReturnType<typeof getMemoryBackend>);
  return { backend, forgotten, remembered };
};

const noConflictJudge = async () => ({ conflicts: [] });

describe('classifyPackInstall', () => {
  it('clean / duplicate / conflict per item, defaults skip on clashes (D-003)', async () => {
    const { backend } = fakeBackend({
      neighborsFor: {
        // 'A — always do a' → near-dup of an organic row
        'always do a': [{ id: 'org-1', text: 'A — always do a', scope: 'hive:h', score: 0.95 }],
        // 'B — always do b' → semantically related, judge says conflict
        'always do b': [{ id: 'org-2', text: 'never do b', scope: 'hive:h', score: 0.6, metadata: {} }],
      },
    });
    const judge = vi.fn(async (input: { newText: string }) =>
      input.newText.includes('do b')
        ? { conflicts: [{ memory_id: 'org-2', summary: 'b is contradicted' }] }
        : { conflicts: [] },
    );
    const review = await classifyPackInstall({ hiveSlug: 'h', pack }, { backend: backend as never, judge });
    expect(review).toMatchObject({ packId: 'rails-pack', clean: 1, duplicates: 1, conflicts: 1 });
    const byId = Object.fromEntries(review.items.map((i) => [i.itemId, i]));
    expect(byId.a).toMatchObject({ status: 'duplicate', defaultAction: 'skip' });
    expect(byId.a.existing).toMatchObject({ id: 'org-1', organic: true, score: 0.95 });
    expect(byId.b).toMatchObject({ status: 'conflict', defaultAction: 'skip', summary: 'b is contradicted' });
    expect(byId.c).toMatchObject({ status: 'clean', defaultAction: 'install' });
  });

  it('search/judge failure degrades that item to clean, never throws', async () => {
    const { backend } = fakeBackend({});
    backend.search = vi.fn(async () => {
      throw new Error('pg down');
    });
    const review = await classifyPackInstall({ hiveSlug: 'h', pack }, { backend: backend as never, judge: noConflictJudge });
    expect(review.clean).toBe(3);
  });
});

describe('applyPackInstall', () => {
  it('honors per-item resolutions; replace forgets the clashing row first', async () => {
    const { backend, forgotten, remembered } = fakeBackend({
      neighborsFor: {
        'always do a': [{ id: 'org-1', text: 'A — always do a', scope: 'hive:h', score: 0.95 }],
      },
    });
    const review = await classifyPackInstall({ hiveSlug: 'h', pack }, { backend: backend as never, judge: noConflictJudge });
    const res = await applyPackInstall(
      {
        workspaceId: 'ws',
        hiveSlug: 'h',
        pack,
        review,
        resolutions: [
          { itemId: 'a', action: 'replace' }, // override the skip default
          { itemId: 'b', action: 'skip' },
        ],
        createdBy: 'user-1',
      },
      { backend: backend as never },
    );
    expect(res).toMatchObject({ ok: true, installed: 2, skipped: 1, replaced: 1, failed: 0 });
    expect(forgotten).toEqual(['org-1']);
    expect(remembered.map((r) => r.text)).toEqual(['A — always do a', 'C — always do c']);
    expect(remembered[0].meta).toMatchObject({ pack_id: 'rails-pack', created_by: 'user-1' });
  });

  it('defaults apply when no resolution is given (clashes skipped — no silent union)', async () => {
    const { backend, remembered } = fakeBackend({
      neighborsFor: {
        'always do a': [{ id: 'org-1', text: 'A — always do a', scope: 'hive:h', score: 0.95 }],
      },
    });
    const review = await classifyPackInstall({ hiveSlug: 'h', pack }, { backend: backend as never, judge: noConflictJudge });
    const res = await applyPackInstall(
      { workspaceId: 'ws', hiveSlug: 'h', pack, review },
      { backend: backend as never },
    );
    expect(res).toMatchObject({ installed: 2, skipped: 1 });
    expect(remembered.some((r) => r.text.startsWith('A — '))).toBe(false);
  });
});

describe('uninstallPack', () => {
  const pool: Entry[] = [
    {
      id: 'p1',
      text: 'A — always do a', // pristine
      scope: 'hive:h',
      metadata: { source: 'pack', pack_id: 'rails-pack', pack_item_id: 'a' },
    },
    {
      id: 'p2',
      text: 'B — but we do it our way', // edited
      scope: 'hive:h',
      metadata: { source: 'pack', pack_id: 'rails-pack', pack_item_id: 'b' },
    },
    { id: 'o1', text: 'organic fact', scope: 'hive:h', metadata: {} },
    {
      id: 'x1',
      text: 'other pack row',
      scope: 'hive:h',
      metadata: { source: 'pack', pack_id: 'other', pack_item_id: 'z' },
    },
  ];

  it('removes pristine rows, keeps edited ones by default, never touches other origins', async () => {
    const { backend, forgotten } = fakeBackend({ pool });
    const res = await uninstallPack({ hiveSlug: 'h', packId: 'rails-pack', pack }, { backend: backend as never });
    expect(res.removed).toBe(1);
    expect(forgotten).toEqual(['p1']);
    expect(res.kept).toEqual([{ id: 'p2', text: 'B — but we do it our way' }]);
  });

  it('keepEdited: false removes everything with the pack provenance', async () => {
    const { backend, forgotten } = fakeBackend({ pool });
    const res = await uninstallPack(
      { hiveSlug: 'h', packId: 'rails-pack', pack, keepEdited: false },
      { backend: backend as never },
    );
    expect(res.removed).toBe(2);
    expect(forgotten.sort()).toEqual(['p1', 'p2']);
    expect(res.kept).toEqual([]);
  });
});

describe('sweepHiveConflicts', () => {
  it('reports deduped contradiction pairs across the pool (P-012)', async () => {
    const pool: Entry[] = [
      { id: 'r1', text: 'always use tabs', scope: 'hive:h', metadata: {} },
      { id: 'r2', text: 'always use spaces', scope: 'hive:h', metadata: { source: 'pack', pack_id: 'p' } },
      { id: 'r3', text: 'unrelated fact', scope: 'hive:h', metadata: {} },
    ];
    const { backend } = fakeBackend({
      pool,
      neighborsFor: {
        tabs: [pool[1]],
        spaces: [pool[0]],
      },
    });
    const judge = vi.fn(async (input: { newText: string }) =>
      input.newText.includes('always use')
        ? { conflicts: [{ memory_id: input.newText.includes('tabs') ? 'r2' : 'r1', summary: 'tabs vs spaces' }] }
        : { conflicts: [] },
    );
    const res = await import('./manage').then((m) =>
      m.sweepHiveConflicts({ hiveSlug: 'h' }, { backend: backend as never, judge }),
    );
    expect(res.scanned).toBe(3);
    expect(res.capped).toBe(false);
    // r1↔r2 found from both directions but reported ONCE.
    expect(res.pairs).toHaveLength(1);
    expect(res.pairs[0]).toMatchObject({ summary: 'tabs vs spaces' });
    expect([res.pairs[0].aId, res.pairs[0].bId].sort()).toEqual(['r1', 'r2']);
  });
});

describe('enable/disable + upgrade plan', () => {
  it('setPackEnabled round-trips through the hive setting', async () => {
    settingRec = null;
    expect(await disabledPacksFor('ws', 'h')).toEqual([]);
    const off = await setPackEnabled({ workspaceId: 'ws', hiveSlug: 'h', packId: 'rails-pack', enabled: false });
    expect(off.disabled).toEqual(['rails-pack']);
    expect(await disabledPacksFor('ws', 'h')).toEqual(['rails-pack']);
    const on = await setPackEnabled({ workspaceId: 'ws', hiveSlug: 'h', packId: 'rails-pack', enabled: true });
    expect(on.disabled).toEqual([]);
  });

  it('planPackUpgrade adopts NEW items only; present rows never auto-touched', async () => {
    const { backend } = fakeBackend({
      pool: [
        {
          id: 'p1',
          text: 'A — always do a',
          scope: 'hive:h',
          metadata: { source: 'pack', pack_id: 'rails-pack', pack_item_id: 'a', pack_version: '1.0.0' },
        },
      ],
    });
    const plan = await planPackUpgrade({ hiveSlug: 'h', pack }, { backend: backend as never, judge: noConflictJudge });
    expect(plan).toMatchObject({
      packId: 'rails-pack',
      installedVersions: ['1.0.0'],
      availableVersion: '2.0.0',
      presentRows: 1,
    });
    expect(plan.newItems.items.map((i) => i.itemId).sort()).toEqual(['b', 'c']);
  });
});
