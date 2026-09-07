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
import type { KnowledgePack } from './pack-format';

let settingRec: { value: unknown } | null = null;

const pack: KnowledgePack = {
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
  it('P-006 binds review/application to one memory pool and refuses stale pinned knowledge', async () => {
    const { backend } = fakeBackend({ pool: [{ id: 'old', scope: 'harness:member', text: 'old content',
      metadata: { source: 'pack', pack_id: pack.manifest.id, pack_item_id: 'a', pack_version: '1.0.0' } }] });
    const review = await classifyPackInstall({ potSlug: 'member', pack, requireExactContent: true,
      memoryTarget: { kind: 'harness', slug: 'member' } }, { judge: noConflictJudge });
    expect(review.memoryScope).toBe('harness:member');
    expect(backend.list).toHaveBeenCalledWith({ scope: 'harness:member' });
    expect(review.items.find((entry) => entry.itemId === 'a')).toMatchObject({ status: 'conflict', defaultAction: 'skip' });
    await expect(applyPackInstall({ workspaceId: 'w', potSlug: 'different', pack, review }))
      .rejects.toThrow(/different memory scope/);
    expect(backend.remember).not.toHaveBeenCalled();
  });

  it('P-006 exact package provisioning refuses an unreadable memory pool', async () => {
    const { backend } = fakeBackend({});
    backend.list.mockRejectedValueOnce(new Error('pool unavailable'));
    await expect(classifyPackInstall({ potSlug: 'h', pack, requireExactContent: true }))
      .rejects.toThrow(/pool unavailable/);
    expect(backend.remember).not.toHaveBeenCalled();
  });
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
    const review = await classifyPackInstall({ potSlug: 'h', pack }, { backend: backend as never, judge });
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
    const review = await classifyPackInstall({ potSlug: 'h', pack }, { backend: backend as never, judge: noConflictJudge });
    expect(review.clean).toBe(3);
  });

  it('LP-2: a pack_item_id already present is `present` (skip) even when search scores it BELOW dupThreshold', async () => {
    // The double-install hazard: the 3 rows ARE present (provenance), but the
    // embedding search returns each at 0.7 (< 0.9 dupThreshold). Without the
    // provenance guard, all 3 classify as 'clean' → 'install' → duplicate
    // pack_item_id rows. The guard reads them as 'present' (no embedding lookup).
    const present: Entry[] = pack.items.map((it) => ({
      id: `existing-${it.id}`,
      text: `${it.title} — ${it.text}`,
      scope: 'hive:h',
      metadata: { source: 'pack', pack_id: 'rails-pack', pack_item_id: it.id },
    }));
    const { backend } = fakeBackend({
      pool: present,
      // search returns the matching row, but only at 0.7 (below threshold).
      neighborsFor: {
        'always do a': [{ ...present[0], score: 0.7 }],
        'always do b': [{ ...present[1], score: 0.7 }],
        'always do c': [{ ...present[2], score: 0.7 }],
      },
    });
    const review = await classifyPackInstall(
      { potSlug: 'h', pack },
      { backend: backend as never, judge: noConflictJudge },
    );
    expect(review).toMatchObject({ present: 3, clean: 0, duplicates: 0, conflicts: 0 });
    for (const c of review.items) expect(c.status).toBe('present');
    // The provenance guard short-circuits BEFORE the embedding search.
    expect(backend.search).not.toHaveBeenCalled();
  });

  it('LP-2: applyPackInstall never re-writes a `present` item, even if a resolution says install', async () => {
    const present: Entry[] = pack.items.map((it) => ({
      id: `existing-${it.id}`,
      text: `${it.title} — ${it.text}`,
      scope: 'hive:h',
      metadata: { source: 'pack', pack_id: 'rails-pack', pack_item_id: it.id },
    }));
    const { backend, remembered } = fakeBackend({ pool: present });
    const review = await classifyPackInstall(
      { potSlug: 'h', pack },
      { backend: backend as never, judge: noConflictJudge },
    );
    const res = await applyPackInstall(
      {
        workspaceId: 'ws',
        potSlug: 'h',
        pack,
        review,
        // Adversarial: force-install every present item.
        resolutions: pack.items.map((it) => ({ itemId: it.id, action: 'install' as const })),
      },
      { backend: backend as never },
    );
    expect(res).toMatchObject({ installed: 0, skipped: 3 });
    expect(remembered).toEqual([]); // no duplicate pack_item_id rows written
  });

  it('LP-2: a NEW pack item still installs while present siblings skip (guard is per-item)', async () => {
    // Only items a,b are present; c is genuinely new and clean.
    const present: Entry[] = [
      {
        id: 'existing-a',
        text: 'A — always do a',
        scope: 'hive:h',
        metadata: { source: 'pack', pack_id: 'rails-pack', pack_item_id: 'a' },
      },
      {
        id: 'existing-b',
        text: 'B — always do b',
        scope: 'hive:h',
        metadata: { source: 'pack', pack_id: 'rails-pack', pack_item_id: 'b' },
      },
    ];
    const { backend, remembered } = fakeBackend({ pool: present });
    const review = await classifyPackInstall(
      { potSlug: 'h', pack },
      { backend: backend as never, judge: noConflictJudge },
    );
    expect(review).toMatchObject({ present: 2, clean: 1 });
    const res = await applyPackInstall(
      { workspaceId: 'ws', potSlug: 'h', pack, review },
      { backend: backend as never },
    );
    expect(res).toMatchObject({ installed: 1, skipped: 2 });
    expect(remembered.map((r) => r.text)).toEqual(['C — always do c']);
  });
});

describe('applyPackInstall', () => {
  it('honors per-item resolutions; replace forgets the clashing row first', async () => {
    const { backend, forgotten, remembered } = fakeBackend({
      neighborsFor: {
        'always do a': [{ id: 'org-1', text: 'A — always do a', scope: 'hive:h', score: 0.95 }],
      },
    });
    const review = await classifyPackInstall({ potSlug: 'h', pack }, { backend: backend as never, judge: noConflictJudge });
    const res = await applyPackInstall(
      {
        workspaceId: 'ws',
        potSlug: 'h',
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
    const review = await classifyPackInstall({ potSlug: 'h', pack }, { backend: backend as never, judge: noConflictJudge });
    const res = await applyPackInstall(
      { workspaceId: 'ws', potSlug: 'h', pack, review },
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
    const res = await uninstallPack({ potSlug: 'h', packId: 'rails-pack', pack }, { backend: backend as never });
    expect(res.removed).toBe(1);
    expect(forgotten).toEqual(['p1']);
    expect(res.kept).toEqual([{ id: 'p2', text: 'B — but we do it our way' }]);
  });

  it('keepEdited: false removes everything with the pack provenance', async () => {
    const { backend, forgotten } = fakeBackend({ pool });
    const res = await uninstallPack(
      { potSlug: 'h', packId: 'rails-pack', pack, keepEdited: false },
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
      m.sweepHiveConflicts({ potSlug: 'h' }, { backend: backend as never, judge }),
    );
    expect(res.scanned).toBe(3);
    expect(res.capped).toBe(false);
    // r1↔r2 found from both directions but reported ONCE.
    expect(res.pairs).toHaveLength(1);
    expect(res.pairs[0]).toMatchObject({ summary: 'tabs vs spaces' });
    expect([res.pairs[0].aId, res.pairs[0].bId].sort()).toEqual(['r1', 'r2']);
  });

  it('LP-5: caps the scan at SWEEP_MAX_ROWS (200) and reports capped:true on a bigger pool', async () => {
    const pool: Entry[] = Array.from({ length: 201 }, (_, i) => ({
      id: `r${i}`,
      text: `fact ${i}`,
      scope: 'hive:h',
      metadata: {},
    }));
    const { backend } = fakeBackend({ pool });
    backend.search = vi.fn(async () => []); // no neighbors → no pairs
    const res = await import('./manage').then((m) =>
      m.sweepHiveConflicts({ potSlug: 'h' }, { backend: backend as never, judge: noConflictJudge }),
    );
    expect(res.scanned).toBe(200); // only the first 200 are searched
    expect(res.capped).toBe(true); // 201 > 200 ⇒ tail skipped, loud partial
    // The 201st row (r200) is never searched.
    const searched = backend.search.mock.calls.map((c) => c[0]);
    expect(searched).not.toContain('fact 200');
  });

  it("LP-5: a conflict partner OUTSIDE the scanned cap shows bText '(not in this pool)'", async () => {
    // Row r0 (in-cap) conflicts with 'outsider' whose row is beyond the cap, so
    // byId.get(outsider) is undefined ⇒ the placeholder text.
    const pool: Entry[] = Array.from({ length: 201 }, (_, i) => ({
      id: i === 0 ? 'r0' : `r${i}`,
      text: `fact ${i}`,
      scope: 'hive:h',
      metadata: {},
    }));
    const { backend } = fakeBackend({ pool });
    backend.search = vi.fn(async (q: string) =>
      q === 'fact 0' ? [{ id: 'outsider', text: 'beyond the cap', scope: 'hive:h', score: 0.8 }] : [],
    );
    const judge = vi.fn(async (input: { newText: string }) =>
      input.newText === 'fact 0'
        ? { conflicts: [{ memory_id: 'outsider', summary: 'clashes with a row past the cap' }] }
        : { conflicts: [] },
    );
    const res = await import('./manage').then((m) =>
      m.sweepHiveConflicts({ potSlug: 'h' }, { backend: backend as never, judge }),
    );
    expect(res.capped).toBe(true);
    const pair = res.pairs.find((p) => p.aId === 'r0');
    expect(pair).toBeTruthy();
    expect(pair!.bId).toBe('outsider');
    expect(pair!.bText).toBe('(not in this pool)');
  });

  it('LP-5: a per-row search/judge throw degrades that row to [] (sweep is hygiene, never load-bearing)', async () => {
    const pool: Entry[] = [
      { id: 'r1', text: 'always use tabs', scope: 'hive:h', metadata: {} },
      { id: 'r2', text: 'boom row', scope: 'hive:h', metadata: {} },
    ];
    const { backend } = fakeBackend({ pool });
    backend.search = vi.fn(async (q: string) => {
      if (q === 'boom row') throw new Error('pg blip on this row');
      return [];
    });
    const res = await import('./manage').then((m) =>
      m.sweepHiveConflicts({ potSlug: 'h' }, { backend: backend as never, judge: noConflictJudge }),
    );
    // The throw on r2 doesn't abort the sweep; r1 still scans, no pairs surface.
    expect(res.scanned).toBe(2);
    expect(res.pairs).toEqual([]);
  });
});

describe('enable/disable + upgrade plan', () => {
  it('setPackEnabled round-trips through the hive setting', async () => {
    settingRec = null;
    expect(await disabledPacksFor('ws', 'h')).toEqual([]);
    const off = await setPackEnabled({ workspaceId: 'ws', potSlug: 'h', packId: 'rails-pack', enabled: false });
    expect(off.disabled).toEqual(['rails-pack']);
    expect(await disabledPacksFor('ws', 'h')).toEqual(['rails-pack']);
    const on = await setPackEnabled({ workspaceId: 'ws', potSlug: 'h', packId: 'rails-pack', enabled: true });
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
    const plan = await planPackUpgrade({ potSlug: 'h', pack }, { backend: backend as never, judge: noConflictJudge });
    expect(plan).toMatchObject({
      packId: 'rails-pack',
      installedVersions: ['1.0.0'],
      availableVersion: '2.0.0',
      presentRows: 1,
    });
    expect(plan.newItems.items.map((i) => i.itemId).sort()).toEqual(['b', 'c']);
  });
});
