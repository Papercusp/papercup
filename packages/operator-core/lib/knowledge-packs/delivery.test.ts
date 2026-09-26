/**
 * delivery unit tests (knowledge-pack-loop-integrity-2026-07-19 P-006) —
 * the last-mile tick against injected deps: one code path for install AND
 * upgrade (planPackUpgrade's newItems), the muted-pack opt-out, the remote-
 * hive skip, the per-tick cap, and best-effort per-hive failure isolation.
 */
import { describe, expect, it, vi } from 'vitest';
import { runFleetLessonsDeliveryTick, type DeliveryTickDeps } from './delivery';
import type { KnowledgePack } from './pack-format';
import type { InstallReview } from './manage';

const pack: KnowledgePack = {
  manifest: { id: 'fleet-lessons', title: 'Fleet lessons', description: 'x', version: '0.1.0' },
  items: [
    { id: 'lesson-a', title: 'A', kind: 'feedback', appliesTo: ['any'], text: 'Lesson A.' },
    { id: 'lesson-b', title: 'B', kind: 'feedback', appliesTo: ['any'], text: 'Lesson B.' },
  ],
};

const review = (n: number): InstallReview => ({
  packId: 'fleet-lessons',
  packVersion: '0.1.0',
  items: Array.from({ length: n }, (_, i) => ({
    itemId: `lesson-${i}`,
    title: `L${i}`,
    incoming: `L${i} — text`,
    status: 'clean' as const,
    defaultAction: 'install' as const,
  })),
  clean: n,
  duplicates: 0,
  conflicts: 0,
  present: 0,
});

const deps = (over: Partial<DeliveryTickDeps> = {}): DeliveryTickDeps => ({
  loadPack: async () => pack,
  listHives: async () => [{ slug: 'hive-1' }, { slug: 'hive-2' }],
  disabledPacks: async () => [],
  declaredDomains: async () => undefined,
  plan: async (slug) => ({
    packId: 'fleet-lessons',
    installedVersions: [],
    availableVersion: '0.1.0',
    newItems: review(slug === 'hive-2' ? 0 : 2),
    presentRows: 0,
  }),
  apply: async (_slug, _pack, r) => ({
    ok: true,
    packId: 'fleet-lessons',
    packVersion: '0.1.0',
    installed: r.items.length,
    skipped: 0,
    replaced: 0,
    failed: 0,
    resources: [],
    failures: [],
  }),
  ...over,
});

describe('runFleetLessonsDeliveryTick', () => {
  it('delivers new items to a behind hive and skips a current one', async () => {
    const r = await runFleetLessonsDeliveryTick({ workspaceId: 'ws' }, deps());
    expect(r).toMatchObject({
      packVersion: '0.1.0',
      hivesSeen: 2,
      hivesDelivered: 1,
      hivesSkipped: 1,
      installed: 2,
      failed: 0,
      capped: false,
    });
  });

  it('no-ops when the pack is absent or empty', async () => {
    const r = await runFleetLessonsDeliveryTick({ workspaceId: 'ws' }, deps({ loadPack: async () => null }));
    expect(r.packVersion).toBeNull();
    expect(r.hivesSeen).toBe(0);
  });

  it('honors the muted-pack per-hive opt-out — a muted hive is never written', async () => {
    const apply = vi.fn();
    const r = await runFleetLessonsDeliveryTick(
      { workspaceId: 'ws' },
      deps({
        listHives: async () => [{ slug: 'muted' }],
        disabledPacks: async () => ['fleet-lessons'],
        apply: apply as never,
      }),
    );
    expect(r.hivesSkipped).toBe(1);
    expect(apply).not.toHaveBeenCalled();
  });

  it('skips remote hives and caps the batch (capped ⇒ next tick continues)', async () => {
    const r = await runFleetLessonsDeliveryTick(
      { workspaceId: 'ws', maxHivesPerTick: 1 },
      deps({
        listHives: async () => [{ slug: 'remote', remote: true }, { slug: 'a' }, { slug: 'b' }],
      }),
    );
    expect(r.hivesSeen).toBe(1);
    expect(r.capped).toBe(true);
  });

  it('a throwing hive is counted failed and never stops the sweep', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const r = await runFleetLessonsDeliveryTick(
      { workspaceId: 'ws' },
      deps({
        plan: async (slug) => {
          if (slug === 'hive-1') throw new Error('pool unreachable');
          return {
            packId: 'fleet-lessons',
            installedVersions: [],
            availableVersion: '0.1.0',
            newItems: review(1),
            presentRows: 3,
          };
        },
      }),
    );
    expect(r).toMatchObject({ hivesSeen: 2, hivesDelivered: 1, installed: 1, failed: 1 });
    warn.mockRestore();
  });
});
