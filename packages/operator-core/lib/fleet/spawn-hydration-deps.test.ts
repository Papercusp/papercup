/**
 * spawn-hydration-deps.test.ts — the PRODUCTION binding of the spawn/wake-hydration
 * sources (the impure half of P-021/P-012; the pure assembler `./spawn-hydration` is
 * tested separately). Both spawn paths bind through this ONE function, so its
 * projections are load-bearing. Pins the genuine per-binding logic (not the thin
 * pass-throughs):
 *
 *  - getHandoff: returns null WITHOUT a featureId (no feature ⇒ no handoff), else
 *    delegates with the threaded args.
 *  - getRoster: maps harness→hiveSlug, fetches the snapshot, then renders it.
 *  - getDossier: flag-gated on BEE_WAKE_DOSSIER (off ⇒ null, runner not called), and
 *    falls back to activeWorkspaceId() when no workspaceId is threaded.
 *
 * Every source fn is mocked. Node env. In-tree (operator-core, tab-visible).
 * Run: cd packages/operator-core && npx vitest run lib/fleet/spawn-hydration-deps.test.ts
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@papercusp/flags/server', () => ({ getFlag: vi.fn() }));
vi.mock('./hive-roster', () => ({ listHiveRosterSnapshot: vi.fn(), renderRosterSnapshot: vi.fn() }));
vi.mock('../handoff-context', () => ({ getSpawnHandoffContext: vi.fn() }));
vi.mock('../work-item-checkpoint', () => ({ getWorkItemCheckpoint: vi.fn() }));
vi.mock('../hive/bee-wake-dossier', () => ({ computeBeeWakeDossier: vi.fn() }));
vi.mock('../workspace-registry', () => ({ activeWorkspaceId: vi.fn(() => 'ws-floor') }));

import { getFlag } from '@papercusp/flags/server';
import { listHiveRosterSnapshot, renderRosterSnapshot } from './hive-roster';
import { getSpawnHandoffContext } from '../handoff-context';
import { getWorkItemCheckpoint } from '../work-item-checkpoint';
import { computeBeeWakeDossier } from '../hive/bee-wake-dossier';
import { productionSpawnHydrationDeps } from './spawn-hydration-deps';
import type { SpawnHydrationDeps } from './spawn-hydration';

const flag = vi.mocked(getFlag);
const listRoster = vi.mocked(listHiveRosterSnapshot);
const renderRoster = vi.mocked(renderRosterSnapshot);
const handoff = vi.mocked(getSpawnHandoffContext);
const checkpoint = vi.mocked(getWorkItemCheckpoint);
const dossier = vi.mocked(computeBeeWakeDossier);

type ProductionDeps = Required<Pick<SpawnHydrationDeps, 'getHandoff' | 'getRoster' | 'getCheckpoint' | 'getDossier'>>;
const deps = () => productionSpawnHydrationDeps() as ProductionDeps;
beforeEach(() => vi.clearAllMocks());

describe('getHandoff', () => {
  it('returns null without a featureId (no feature ⇒ no handoff), without calling the source', async () => {
    const out = await deps().getHandoff({ harness: 'h', workspaceId: 'ws' } as never);
    expect(out).toBeNull();
    expect(handoff).not.toHaveBeenCalled();
  });

  it('delegates to getSpawnHandoffContext with the threaded args when a featureId is present', async () => {
    handoff.mockResolvedValue({ body: 'hi' } as never);
    const args = { harness: 'h', featureId: 'F-1', planSlug: 'p', workspaceId: 'ws', role: 'worker', deliverTo: 'x', nowMs: 1 };
    const out = await deps().getHandoff(args as never);
    expect(out).toEqual({ body: 'hi' });
    expect(handoff).toHaveBeenCalledWith(args);
  });
});

describe('getRoster', () => {
  it('maps harness→hiveSlug, fetches, then renders the snapshot', async () => {
    listRoster.mockResolvedValue([{ id: 'bee-1' }] as never);
    renderRoster.mockReturnValue('### Hive peers\n- bee-1' as never);
    const out = await deps().getRoster({ harness: 'hive-a', workspaceId: 'ws' } as never);
    expect(listRoster).toHaveBeenCalledWith({ hiveSlug: 'hive-a', workspaceId: 'ws' });
    expect(renderRoster).toHaveBeenCalledWith([{ id: 'bee-1' }]);
    expect(out).toContain('Hive peers');
  });
});

describe('getCheckpoint', () => {
  it('delegates to getWorkItemCheckpoint with the threaded args', async () => {
    checkpoint.mockResolvedValue({ note: 'carry' } as never);
    const out = await deps().getCheckpoint({ harness: 'h', workItemId: 'WI-1', workspaceId: 'ws' } as never);
    expect(checkpoint).toHaveBeenCalledWith({ harness: 'h', workItemId: 'WI-1', workspaceId: 'ws' });
    expect(out).toEqual({ note: 'carry' });
  });
});

describe('getDossier', () => {
  it('returns null when BEE_WAKE_DOSSIER is off, without computing the dossier', async () => {
    flag.mockResolvedValue(false);
    const out = await deps().getDossier({ harness: 'h', workItemId: 'WI-1', workspaceId: 'ws' } as never);
    expect(out).toBeNull();
    expect(dossier).not.toHaveBeenCalled();
  });

  it('computes the dossier with the threaded workspaceId when the flag is on', async () => {
    flag.mockResolvedValue(true);
    dossier.mockResolvedValue({ section: 'brief' } as never);
    const out = await deps().getDossier({ harness: 'h', workItemId: 'WI-1', workspaceId: 'ws-1' } as never);
    expect(dossier).toHaveBeenCalledWith({ workspaceId: 'ws-1', harness: 'h', workItemId: 'WI-1' });
    expect(out).toEqual({ section: 'brief' });
  });

  it('falls back to activeWorkspaceId() when no workspaceId is threaded', async () => {
    flag.mockResolvedValue(true);
    dossier.mockResolvedValue(null as never);
    await deps().getDossier({ harness: 'h', workItemId: 'WI-1' } as never);
    expect(dossier).toHaveBeenCalledWith({ workspaceId: 'ws-floor', harness: 'h', workItemId: 'WI-1' });
  });
});
