/**
 * register-scout-action.test.ts — Scout P-008 activation keystone.
 * Pins that importing the boot wire self-registers `system:scout-cycle` (so a
 * refactor can't silently un-activate the autonomous loop), and that the no-op
 * archive + setScoutArchive seam behave (the P-012 hand-off point).
 */
import { describe, it, expect } from 'vitest';
import { noopArchive, setScoutArchiveBuilder, productionScoutRunner } from './register-scout-action';

describe('register-scout-action (Scout production runner provider)', () => {
  it('exports productionScoutRunner — the scout:cycle blueprint op’s production cycle deps (P-130)', () => {
    // Scout runs as the `scout` BLUEPRINT now: the seed fires system:blueprint-run
    // {blueprintId:'scout'} → the scout:cycle deterministic step → runScoutCycleTick,
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
});
