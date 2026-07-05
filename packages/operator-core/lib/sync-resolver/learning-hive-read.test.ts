/**
 * learning-hive-read tests (learning-packs-2026-06-11 P-008) — injected deps,
 * no PG/FS. Pins the pack/organic split, pristine-vs-modified detection, the
 * per-pack rollups, and the unavailable degradation.
 */
import { describe, expect, it, vi } from 'vitest';
import { readHiveLearnings } from './learning-hive-read';
import type { LearningPack } from '../learning-packs/pack-format';

// The LP-6 cross-check exercises planPackUpgrade, which reads getMemoryBackend.
vi.mock('../memory/backend', () => ({ getMemoryBackend: vi.fn() }));

const pack: LearningPack = {
  manifest: { id: 'papercusp-default', title: 'T', description: 'd', version: '1.0.0' },
  items: [
    { id: 'a', title: 'A', kind: 'feedback', appliesTo: ['any'], text: 'body a' },
    { id: 'b', title: 'B', kind: 'feedback', appliesTo: ['any'], text: 'body b' },
    { id: 'c', title: 'C', kind: 'feedback', appliesTo: ['ui'], text: 'body c' },
  ],
};

const packMeta = (itemId: string) => ({
  source: 'pack',
  pack_id: 'papercusp-default',
  pack_version: '1.0.0',
  pack_item_id: itemId,
  applies_to: ['any'],
});

const deps = (entries: Array<{ id: string; text: string; kind?: string; metadata?: Record<string, unknown> }>) => ({
  listPool: async (scope: string) => entries.map((e) => ({ ...e, scope })),
  loadPack: async (id: string) => (id === 'papercusp-default' ? { pack } : null),
});

describe('readHiveLearnings', () => {
  it('splits pack vs organic, detects pristine vs modified, rolls up per pack', async () => {
    const snap = await readHiveLearnings('my-hive', deps([
      { id: 'm1', text: 'A — body a', kind: 'feedback', metadata: packMeta('a') }, // pristine
      { id: 'm2', text: 'B — body b (we do it differently)', kind: 'feedback', metadata: packMeta('b') }, // modified
      { id: 'm3', text: 'This project: make test', kind: 'reference', metadata: { created_by: 'mug' } }, // organic
    ]));
    expect(snap.hive).toBe('my-hive');
    expect(snap.organicCount).toBe(1);
    expect(snap.rows.find((r) => r.id === 'm1')).toMatchObject({ packId: 'papercusp-default', packState: 'pristine' });
    expect(snap.rows.find((r) => r.id === 'm2')).toMatchObject({ packState: 'modified' });
    expect(snap.rows.find((r) => r.id === 'm3')).toMatchObject({ createdBy: 'mug' });
    expect(snap.rows.find((r) => r.id === 'm3')?.packId).toBeUndefined();
    expect(snap.packs).toEqual([
      {
        packId: 'papercusp-default',
        packVersion: '1.0.0',
        present: 2,
        modified: 1,
        notPresent: 1, // 'c' has no row (removed or shape-filtered)
        packTotal: 3,
      },
    ]);
  });

  it('an unresolvable pack still lists rows (packState modified, no totals)', async () => {
    const meta = { source: 'pack', pack_id: 'gone-pack', pack_version: '2.0.0', pack_item_id: 'x' };
    const snap = await readHiveLearnings('h', deps([{ id: 'm1', text: 'X — y', metadata: meta }]));
    expect(snap.rows[0]).toMatchObject({ packId: 'gone-pack', packState: 'modified' });
    expect(snap.packs[0]).toMatchObject({ packId: 'gone-pack', present: 1, notPresent: 0 });
    expect(snap.packs[0].packTotal).toBeUndefined();
  });

  it('store unreachable → unavailable snapshot, never a throw', async () => {
    const snap = await readHiveLearnings('h', {
      listPool: async () => { throw new Error('pg down'); },
      loadPack: async () => null,
    });
    expect(snap).toMatchObject({ hive: 'h', rows: [], packs: [], organicCount: 0, unavailable: true });
  });

  it('LP-6: a mixed-version pool reports the FIRST-SEEN packVersion (order-dependent rollup)', async () => {
    // Two rows of the same pack carry different pack_version stamps (a partial
    // upgrade). The rollup's packVersion is `mine.find(r => r.packVersion)` —
    // first by pool order. This pins that contract so a reordering regression
    // is caught; planPackUpgrade (below) is the source of truth for the FULL set.
    const v1 = { source: 'pack', pack_id: 'papercusp-default', pack_version: '1.0.0', pack_item_id: 'a' };
    const v2 = { source: 'pack', pack_id: 'papercusp-default', pack_version: '2.0.0', pack_item_id: 'b' };
    const snap = await readHiveLearnings('h', deps([
      { id: 'm1', text: 'A — body a', metadata: v1 }, // first → 1.0.0
      { id: 'm2', text: 'B — body b', metadata: v2 },
    ]));
    expect(snap.packs[0]).toMatchObject({ packId: 'papercusp-default', packVersion: '1.0.0', present: 2 });

    // Reversed pool order → first-seen flips to 2.0.0 (documents the dependence).
    const snapRev = await readHiveLearnings('h', deps([
      { id: 'm2', text: 'B — body b', metadata: v2 }, // first → 2.0.0
      { id: 'm1', text: 'A — body a', metadata: v1 },
    ]));
    expect(snapRev.packs[0].packVersion).toBe('2.0.0');
  });
});

describe('LP-6: cross-check — planPackUpgrade captures the FULL version set the rollup collapses', async () => {
  const { planPackUpgrade } = await import('../learning-packs/manage');
  const { getMemoryBackend } = await import('../memory/backend');

  it('installedVersions lists EVERY distinct pack_version in the pool (not just first-seen)', async () => {
    const pool = [
      { id: 'm1', text: 'A — body a', scope: 'hive:h', metadata: { source: 'pack', pack_id: 'papercusp-default', pack_version: '1.0.0', pack_item_id: 'a' } },
      { id: 'm2', text: 'B — body b', scope: 'hive:h', metadata: { source: 'pack', pack_id: 'papercusp-default', pack_version: '2.0.0', pack_item_id: 'b' } },
    ];
    const backend = {
      name: 'fake',
      available: async () => ({ ok: true as const }),
      list: async () => pool,
      search: async () => [],
    };
    vi.mocked(getMemoryBackend).mockReturnValue(backend as unknown as ReturnType<typeof getMemoryBackend>);
    const plan = await planPackUpgrade(
      { hiveSlug: 'h', pack },
      { backend: backend as never, judge: async () => ({ conflicts: [] }) },
    );
    // The rollup keeps only first-seen; the upgrade planner keeps the whole set.
    expect(plan.installedVersions.sort()).toEqual(['1.0.0', '2.0.0']);
    // 'c' (the only item with no present row) is the adoptable set.
    expect(plan.newItems.items.map((i) => i.itemId)).toEqual(['c']);
  });
});
