import { describe, expect, it, vi } from 'vitest';
import { actionableConditionFor, DISK_SPACE_ALARM_CONDITION_KEY } from '../coord/actionable-conditions';
import { ensureDiskRecoveryOwner, type DiskRecoveryDeps } from './disk-space-recovery';
import { assignAndWakeActionableWorkItems, type ActionableWorkItemDispatchDeps } from '../agent-tools/coordination/actionable-work-item-dispatch';
import type { WorkItem } from '../work-items';

const request = { title: 'Disk below headroom target', body: 'Recover toward 500 GiB; 400 GiB is partial.' };
type DispatchResult = Awaited<ReturnType<DiskRecoveryDeps['dispatch']>>;
function deps(owner: string | null = null): DiskRecoveryDeps {
  return {
    workspaceId: 'fixture-workspace', harness: 'papercusp',
    acquire: vi.fn(async () => ({ workItem: 'one-incident' })),
    readItem: vi.fn(async () => ({ assignee: owner })),
    recipient: vi.fn(async () => ({ kind: 'su' as const, ownerId: 'live-responder', ownerLabel: 'responder', tier: 2 as const, why: 'live workspace agent' })),
    dispatch: vi.fn(async () => ({ ok: true, assignment: { executionWorkItemIds: ['one-incident'] } } as DispatchResult)),
  };
}

describe('disk recovery owner', () => {
  it('drives the real canonical assignment and required-wake path, then retains the same active owner', async () => {
    const item = { id: 'one-incident', kind: 'task', family: 'issue', harness: 'papercusp', state: 'open', assignee: null, payload: {} } as WorkItem;
    const io: ActionableWorkItemDispatchDeps = {
      observe: vi.fn(async () => ({ item, available: item.assignee === null, claimedBy: item.assignee })),
      authorize: vi.fn(async () => ({ allowed: true as const })),
      claim: vi.fn(async (_id, assignee) => { item.assignee = assignee; return item; }),
      explainClaimFloors: vi.fn(async () => []),
      readClaimConcurrency: vi.fn(async () => ({ blocked: false, activeClaims: 0, maxConcurrentClaims: 1, heldIds: [], blockerParkedIds: [] })),
      blockers: vi.fn(async () => []), planBlock: vi.fn(async () => null), planClaim: vi.fn(async () => null),
      resolveTarget: vi.fn(async ({ targetAgent }) => ({ requested: targetAgent, ownerId: targetAgent, present: true, sessionState: 'live', wakeable: true })),
      wake: vi.fn(async (owners) => ({ targets: [...owners], keys: [], queued: 1, woken: 1, pickupConfirmed: false as const, pickup: [], staged: 0, stagedTargets: [], fanoutCapped: [], timedOutTargets: [] })),
    };
    const d = deps();
    d.readItem = async () => item;
    d.dispatch = (args) => assignAndWakeActionableWorkItems(args, io);
    expect(await ensureDiskRecoveryOwner(request, d)).toMatchObject({ status: 'assigned', owner: 'live-responder', pickupConfirmed: false });
    expect(item.assignee).toBe('live-responder');
    expect(io.claim).toHaveBeenCalledOnce();
    expect(io.wake).toHaveBeenCalledWith(['live-responder'], expect.objectContaining({
      source: 'disk-space-alarm', payload: expect.objectContaining({ workItemIds: ['one-incident'], instructions: request.body }),
    }));
    await ensureDiskRecoveryOwner(request, d);
    expect(io.claim).toHaveBeenCalledOnce();
    expect(io.wake).toHaveBeenCalledOnce();
  });

  it('opts the alarm into singleton incident ownership and source-only recovery', () => {
    expect(actionableConditionFor(DISK_SPACE_ALARM_CONDITION_KEY)).toMatchObject({ harnessFrom: 'ambient', lifecycleOwnedBySource: true });
  });

  it('claims and requests required wake through the canonical dispatcher', async () => {
    const d = deps();
    expect(await ensureDiskRecoveryOwner(request, d)).toEqual({ workItem: 'one-incident', owner: 'live-responder', status: 'assigned' });
    expect(d.acquire).toHaveBeenCalledWith(DISK_SPACE_ALARM_CONDITION_KEY, expect.objectContaining({ workspaceId: 'fixture-workspace', harness: 'papercusp' }));
    expect(d.dispatch).toHaveBeenCalledWith(expect.objectContaining({ workItemIds: ['one-incident'], targetAgent: 'live-responder', wakeRetained: false, instructions: request.body }));
  });

  it('reuses an existing cleanup owner without choosing a second agent', async () => {
    const d = deps('active-janitor');
    await ensureDiskRecoveryOwner(request, d);
    await ensureDiskRecoveryOwner(request, d);
    expect(d.recipient).not.toHaveBeenCalled();
    expect(d.dispatch).toHaveBeenLastCalledWith(expect.objectContaining({ targetAgent: 'active-janitor', workItemIds: ['one-incident'], wakeRetained: false }));
  });

  it('exposes missing capacity, refused claims and failed wake instead of asserting pickup', async () => {
    const d = deps();
    d.recipient = async () => ({ kind: 'escalate', why: 'No live agent' });
    expect(await ensureDiskRecoveryOwner(request, d)).toMatchObject({ status: 'unavailable', reason: 'No live agent' });
    expect(d.dispatch).not.toHaveBeenCalled();
    d.recipient = deps().recipient;
    d.dispatch = async () => ({ ok: false, warning: 'target_dead', assignment: { executionWorkItemIds: ['one-incident'] } } as DispatchResult);
    expect(await ensureDiskRecoveryOwner(request, d)).toMatchObject({ status: 'unavailable', reason: 'target_dead' });
    d.dispatch = async () => ({ ok: true, assignment: { executionWorkItemIds: [], skipped: [{ reason: 'admission gated' }] } } as unknown as DispatchResult);
    expect(await ensureDiskRecoveryOwner(request, d)).toMatchObject({ status: 'unavailable', reason: 'admission gated' });
  });

  it('preserves the incident when dependency reads fail', async () => {
    const d = deps();
    d.readItem = async () => { throw new Error('read unavailable'); };
    expect(await ensureDiskRecoveryOwner(request, d)).toMatchObject({ workItem: 'one-incident', status: 'unavailable', reason: expect.stringContaining('read unavailable') });
    expect(d.dispatch).not.toHaveBeenCalled();
  });

  it('retries required wake after a prior failure without treating a queued wake as pickup', async () => {
    const d = deps('active-janitor');
    d.dispatch = vi.fn(async () => ({
      ok: true, assignment: { executionWorkItemIds: ['one-incident'] },
      wake: { pickupConfirmed: false },
    } as DispatchResult));
    expect(await ensureDiskRecoveryOwner({ ...request, retryWake: true }, d)).toMatchObject({
      status: 'assigned', pickupConfirmed: false,
    });
    expect(d.dispatch).toHaveBeenCalledWith(expect.objectContaining({ wakeRetained: true }));
    expect(d.recipient).not.toHaveBeenCalled();
  });

  it('does not treat an absent incumbent as an active cleanup owner', async () => {
    const d = deps('ended-janitor');
    d.dispatch = async () => ({
      ok: true, target: { present: false, sessionState: 'ended' },
      assignment: { executionWorkItemIds: ['one-incident'] },
    } as DispatchResult);
    expect(await ensureDiskRecoveryOwner(request, d)).toMatchObject({ status: 'unavailable' });
    expect(d.recipient).not.toHaveBeenCalled();
  });
});
