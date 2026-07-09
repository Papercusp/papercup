/**
 * hive-directory-meta.test.ts — owned-hive metadata persistence (p2p-hive P-004).
 *
 * Mocks the registry blob (loadHarnessRegistry/mutateHarnessRegistry) so the
 * create/edit/list/delete + the invite-secret guard test without PG.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const store: { reg: Record<string, unknown> } = { reg: { projects: [] } };
vi.mock('./harness-registry', () => ({
  loadHarnessRegistry: async () => JSON.parse(JSON.stringify(store.reg)),
  mutateHarnessRegistry: async (
    mutator: (reg: Record<string, unknown>) => Record<string, unknown>,
  ) => {
    store.reg = JSON.parse(JSON.stringify(mutator(JSON.parse(JSON.stringify(store.reg)))));
    return store.reg;
  },
}));

const { listOwnedHiveMeta, getOwnedHiveMeta, saveOwnedHiveMeta, deleteOwnedHiveMeta } = await import('./hive-directory-meta');
import type { HiveDirectoryMeta } from './hive-publish';

function meta(over: Partial<HiveDirectoryMeta> & { potId: string }): HiveDirectoryMeta {
  return { title: over.potId, description: '', visibility: 'public', memberTopics: [], createdAt: 1000, ...over };
}

beforeEach(() => {
  store.reg = { projects: [] };
});

describe('hive-directory-meta (P-004 persistence)', () => {
  it('saves + reads back a hive listing', async () => {
    await saveOwnedHiveMeta(meta({ potId: 'h1', title: 'Hive One' }));
    expect(await getOwnedHiveMeta('h1')).toMatchObject({ potId: 'h1', title: 'Hive One', visibility: 'public' });
  });

  it('lists owned hives newest-created first', async () => {
    await saveOwnedHiveMeta(meta({ potId: 'old', createdAt: 1000 }));
    await saveOwnedHiveMeta(meta({ potId: 'new', createdAt: 5000 }));
    expect((await listOwnedHiveMeta()).map((m) => m.potId)).toEqual(['new', 'old']);
  });

  it('edit overwrites the same potId (idempotent create-or-edit)', async () => {
    await saveOwnedHiveMeta(meta({ potId: 'h1', title: 'v1' }));
    await saveOwnedHiveMeta(meta({ potId: 'h1', title: 'v2' }));
    expect((await listOwnedHiveMeta())).toHaveLength(1);
    expect((await getOwnedHiveMeta('h1'))?.title).toBe('v2');
  });

  it('rejects invite visibility without a secret', async () => {
    await expect(saveOwnedHiveMeta(meta({ potId: 'h1', visibility: 'invite' }))).rejects.toThrow(/inviteSecret/);
  });

  it('accepts invite visibility WITH a secret', async () => {
    await saveOwnedHiveMeta(meta({ potId: 'h1', visibility: 'invite', inviteSecret: 's' }));
    expect((await getOwnedHiveMeta('h1'))?.inviteSecret).toBe('s');
  });

  it('delete removes the listing', async () => {
    await saveOwnedHiveMeta(meta({ potId: 'h1' }));
    await deleteOwnedHiveMeta('h1');
    expect(await getOwnedHiveMeta('h1')).toBeNull();
    expect(await listOwnedHiveMeta()).toHaveLength(0);
  });

  it('does not clobber sibling registry fields (projects, hiveControlFrames)', async () => {
    store.reg = { projects: [{ slug: 'x' }], hiveControlFrames: { hv: { target: 't' } } };
    await saveOwnedHiveMeta(meta({ potId: 'h1' }));
    expect((store.reg as { projects: unknown[] }).projects).toHaveLength(1);
    expect((store.reg as { hiveControlFrames: object }).hiveControlFrames).toBeTruthy();
  });
});
