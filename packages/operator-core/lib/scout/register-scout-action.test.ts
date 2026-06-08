/**
 * register-scout-action.test.ts — Scout P-008 activation keystone.
 * Pins that importing the boot wire self-registers `system:scout-cycle` (so a
 * refactor can't silently un-activate the autonomous loop), and that the no-op
 * archive + setScoutArchive seam behave (the P-012 hand-off point).
 */
import { describe, it, expect } from 'vitest';
import { listSystemActions, getSystemAction } from '../harness/routines/system-actions';
import './register-scout-action'; // side-effect import: registers system:scout-cycle
import { noopArchive, setScoutArchiveBuilder } from './register-scout-action';

describe('register-scout-action (activation keystone)', () => {
  it('self-registers system:scout-cycle on import', () => {
    expect(listSystemActions()).toContain('scout-cycle');
    expect(getSystemAction('scout-cycle')).toBeTypeOf('function');
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
