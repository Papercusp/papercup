import { describe, expect, it, vi } from 'vitest';
import type { Sql } from 'postgres';
import { dreamCycleSummary, readDreamControlSnapshot, setDreamControl, type DreamControlReadDeps } from './dream-control';

const scope = { workspaceId: 'ws', potSlug: 'pot' };
const sql = {} as Sql;
function reads(overrides: Partial<DreamControlReadDeps> = {}): DreamControlReadDeps {
  return {
    flags: async () => ({ feature: true, governor: true }),
    ensureSetup: async () => {},
    routines: async () => ['manual', 'auto'].map((mode) => ({ name: `dream-cycle-${mode}`, active: false, next_fire_at: null, metadata: {} })),
    autoEnabled: async () => false,
    sourceAvailable: async () => true,
    budget: async () => ({ allow: true }),
    rolling: async () => 0,
    latestCycle: async () => null,
    ...overrides,
  };
}

describe('Dream Learning control snapshot', () => {
  it('prepares an existing pot before reading its routines and budget without opting into spending', async () => {
    let prepared = false;
    const snapshot = await readDreamControlSnapshot(sql, scope, reads({
      ensureSetup: async () => { prepared = true; },
      routines: async () => {
        expect(prepared).toBe(true);
        return ['manual', 'auto'].map(mode => ({ name: `dream-cycle-${mode}`, active: false, next_fire_at: null, metadata: {} }));
      },
      budget: async () => { expect(prepared).toBe(true); return { allow: true }; },
    }));
    expect(snapshot).toMatchObject({ manual: { active: false }, automatic: { enabled: false }, blocker: null });
  });

  it.each([{ feature: false, source: true }, { feature: true, source: false }])(
    'does not materialize controls for a disabled feature or unregistered source (%j)', async ({ feature, source }) => {
      const ensureSetup = vi.fn(async () => {});
      await readDreamControlSnapshot(sql, scope, reads({
        ensureSetup, flags: async () => ({ feature, governor: true }), sourceAvailable: async () => source,
      }));
      expect(ensureSetup).not.toHaveBeenCalled();
    },
  );

  it('keeps manual and automatic paused when neither has been opted into', async () => {
    expect(await readDreamControlSnapshot(sql, scope, reads())).toMatchObject({
      manual: { active: false }, automatic: { enabled: false }, lastCycle: null,
      limits: { attempts: 3, cycleUsd: 1, rollingUsd: 5 }, blocker: null,
    });
  });

  it.each([[true, false, false], [false, true, false], [true, true, true]])(
    'requires BOTH the automatic routine (%s) and explicit toggle (%s)', async (active, toggle, expected) => {
      const snapshot = await readDreamControlSnapshot(sql, scope, reads({
        routines: async () => ['manual', 'auto'].map((mode) => ({ name: `dream-cycle-${mode}`, active, next_fire_at: null, metadata: {} })),
        autoEnabled: async () => toggle,
      }));
      expect(snapshot.automatic.enabled).toBe(expected);
    },
  );

  it.each([
    [{ flags: async () => ({ feature: false, governor: true }) }, 'feature settings'],
    [{ flags: async () => ({ feature: true, governor: false }) }, 'governor is disabled'],
    [{ sourceAvailable: async () => false }, 'source repository'],
    [{ routines: async () => [] }, 'not set up'],
    [{ budget: async () => ({ allow: false, reason: 'pot-disabled' }) }, 'pot-disabled'],
    [{ rolling: async () => 5 }, '24 hours is exhausted'],
  ] as Array<[Partial<DreamControlReadDeps>, string]>)('explains a refused start', async (overrides, message) => {
    const snapshot = await readDreamControlSnapshot(sql, scope, reads(overrides));
    expect(snapshot.blocker).toContain(message);
    const transaction = vi.fn();
    await expect(setDreamControl({ begin: transaction } as unknown as Sql,
      { ...scope, mode: 'manual', enabled: true, actor: 'test' }, async () => snapshot)).rejects.toThrow(message);
    expect(transaction).not.toHaveBeenCalled();
  });

  it('propagates a settings read failure instead of presenting a known-off toggle', async () => {
    await expect(readDreamControlSnapshot(sql, scope, reads({ autoEnabled: async () => { throw new Error('settings unavailable'); } }))).rejects.toThrow('settings unavailable');
  });

  it('retains a cycle refused before any run row could be written', async () => {
    const last = { cycleId: 'c', mode: 'manual', attempts: 0, accepted: 0, running: 0, costUsd: 0, reason: 'governor-refused', updatedAt: '2026-09-07T17:00:00Z' };
    const snapshot = await readDreamControlSnapshot(sql, scope, reads({
      routines: async () => [{ name: 'dream-cycle-manual', active: true, next_fire_at: null, metadata: { dreamLastCycle: last } }],
    }));
    expect(snapshot.lastCycle).toEqual(last);
    expect(dreamCycleSummary({ ...last, costUsd: 'unknown' })).toBeNull();
  });
});
