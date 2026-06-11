/**
 * learning-hive-read tests (learning-packs-2026-06-11 P-008) — injected deps,
 * no PG/FS. Pins the pack/organic split, pristine-vs-modified detection, the
 * per-pack rollups, and the unavailable degradation.
 */
import { describe, expect, it } from 'vitest';
import { readHiveLearnings } from './learning-hive-read';
import type { LearningPack } from '../learning-packs/pack-format';

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
      { id: 'm3', text: 'This project: make test', kind: 'reference', metadata: { created_by: 'queen' } }, // organic
    ]));
    expect(snap.hive).toBe('my-hive');
    expect(snap.organicCount).toBe(1);
    expect(snap.rows.find((r) => r.id === 'm1')).toMatchObject({ packId: 'papercusp-default', packState: 'pristine' });
    expect(snap.rows.find((r) => r.id === 'm2')).toMatchObject({ packState: 'modified' });
    expect(snap.rows.find((r) => r.id === 'm3')).toMatchObject({ createdBy: 'queen' });
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
});
