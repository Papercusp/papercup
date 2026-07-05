/**
 * register-scout-action.test.ts — Scout P-008 activation keystone.
 * Pins that importing the boot wire self-registers `system:scout-cycle` (so a
 * refactor can't silently un-activate the autonomous loop), and that the no-op
 * archive + setScoutArchive seam behave (the P-012 hand-off point).
 */
import { afterEach, describe, it, expect, vi } from 'vitest';
import { noopArchive, resolveArchive, setScoutArchiveBuilder, productionScoutRunner } from './register-scout-action';

afterEach(() => {
  delete process.env.PAPERCUSP_SCOUT_ARCHIVE_RESOLVE_TIMEOUT_MS;
  setScoutArchiveBuilder(async () => noopArchive);
});

describe('register-scout-action (Scout production runner provider)', () => {
  it('exports productionScoutRunner — the blender:cycle blueprint op’s production cycle deps (P-130)', () => {
    // Scout runs as the `scout` BLUEPRINT now: the seed fires system:blueprint-run
    // {blueprintId:'scout'} → the blender:cycle deterministic step → runScoutCycleTick,
    // which calls productionScoutRunner. The bespoke system:scout-cycle action is RETIRED,
    // so this module no longer self-registers — it stays as the production-runner home.
    expect(productionScoutRunner).toBeTypeOf('function');
  });

  it('noopArchive reads empty + admits nothing (gym rail safe fallback)', async () => {
    expect(noopArchive.listElites()).toEqual([]);
    const r = noopArchive.seed({
      candidateId: 'x',
      descriptor: { coords: { scope: 'module', domain: 'Sync', risk: 'low' }, features: [0.5, 0.5] },
    });
    expect(r).toEqual({ admitted: false, nicheKey: 'module|sync|low' });
    await expect(noopArchive.flush()).resolves.toBeUndefined();
  });

  it('exposes setScoutArchiveBuilder so the archive can be overridden (tests / alternate store)', () => {
    expect(setScoutArchiveBuilder).toBeTypeOf('function');
  });

  it('falls back to noopArchive when archive resolution throws', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    setScoutArchiveBuilder(async () => {
      throw new Error('archive down');
    });

    const archive = await resolveArchive({ workspaceId: 'ws', harnessSlug: 'h' });

    expect(archive).toBe(noopArchive);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('archive unavailable'), 'archive down');
    warn.mockRestore();
  });

  it('falls back to noopArchive when archive resolution hangs', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    process.env.PAPERCUSP_SCOUT_ARCHIVE_RESOLVE_TIMEOUT_MS = '5';
    setScoutArchiveBuilder(() => new Promise(() => undefined));

    const archive = await resolveArchive({ workspaceId: 'ws', harnessSlug: 'h' });

    expect(archive).toBe(noopArchive);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('archive unavailable'), 'archive resolve timed out after 5ms');
    warn.mockRestore();
  });
});
