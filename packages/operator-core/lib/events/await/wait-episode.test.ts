import { describe, expect, it } from 'vitest';
import { carryWaitEpisode, claimWaitEpisode, createWaitEpisode, retireWaitEpisode,
  settleWaitEpisode, waitEpisodeFingerprint, type WaitEpisodeContract } from './wait-episode';

const contract: WaitEpisodeContract = {
  dependencyRef: 'WI-producer', predicateKey: 'qualified', sourceOwnerId: 'producer',
  sourceGeneration: 1, expectedCondition: { qualified: true }, payloadFilter: null,
  noDeltaBudget: 2, cadenceMs: 1000,
  evidence: { writer: 'tasks:get', units: 'state', tool: 'tasks:get', args: { id: 'build' }, path: 'state' },
  substages: [{ id: 'build', valueFingerprint: waitEpisodeFingerprint('exited') }],
};
const create = (c = contract) => createWaitEpisode({ workspaceId: 'ws', harness: 'h',
  drivingWorkItemId: 'WI-driver', custodianId: 'leader', contract: c, nowMs: 0 });
const evidence = (value: unknown) => ({ writer: 'tasks:get', units: 'state', observedAtMs: 1000,
  valuePreview: value, valueFingerprint: waitEpisodeFingerprint(value),
  reference: { tool: 'tasks:get', args: { id: 'build' }, path: 'state' }, uncertainty: null });

describe('one finite dependency episode', () => {
  it('preserves allowance across authenticated custody, cold carry and equivalent generation changes', () => {
    const first = claimWaitEpisode(create(), { callback: 'timeout:1', nowMs: 1000 });
    const settled = settleWaitEpisode(first.episode, first.receipt!, { kind: 'observed', checkedAtMs: 1000 }).episode;
    const carried = carryWaitEpisode(JSON.parse(JSON.stringify(settled)), {
      custodianId: 'successor', contract: { ...contract, sourceGeneration: 2 },
    });
    expect(carried).toMatchObject({ id: settled.id, remainingNoDeltaBudget: 1, debits: 1,
      custodyLineage: ['leader', 'successor'] });
    expect(() => carryWaitEpisode(carried, { custodianId: 'successor', contract: { ...contract, noDeltaBudget: 100 } })).toThrow('frozen');
  });

  it('replays crash-before-debit with a rotating revision token and rejects stale and duplicate results', () => {
    const first = claimWaitEpisode(create(), { callback: 'loop:1', nowMs: 1000 });
    expect(claimWaitEpisode(first.episode, { callback: 'timeout:1', nowMs: 1001 }).receipt).toBeNull();
    const recovered = claimWaitEpisode(first.episode, { callback: 'timeout:1', nowMs: 121000 });
    expect(recovered.receipt!.observationId).toBe(first.receipt!.observationId);
    expect(recovered.receipt!.claimToken).not.toBe(first.receipt!.claimToken);
    expect(settleWaitEpisode(recovered.episode, first.receipt!, { kind: 'observed', checkedAtMs: 121000 }).accepted).toBe(false);
    const committed = settleWaitEpisode(recovered.episode, recovered.receipt!, { kind: 'observed', checkedAtMs: 121000 });
    expect(committed.episode.debits).toBe(1);
    expect(settleWaitEpisode(committed.episode, recovered.receipt!, { kind: 'observed', checkedAtMs: 121000 }).accepted).toBe(false);
    expect(claimWaitEpisode(committed.episode, { callback: 'loop:1', nowMs: 200000 }).receipt).toBeNull();
  });

  it('only credits a frozen forward outcome once; final predicate remains unaccepted', () => {
    let episode = create();
    for (const [i, value] of ['running', 'exited', 'exited', { heartbeat: 3000 }].entries()) {
      const claimed = claimWaitEpisode(episode, { callback: `fire:${i}`, nowMs: (i + 1) * 1000 });
      episode = settleWaitEpisode(claimed.episode, claimed.receipt!, {
        kind: 'observed', checkedAtMs: (i + 1) * 1000, evidence: evidence(value),
      }).episode;
    }
    expect(episode).toMatchObject({ state: 'exhausted', stage: 1, debits: 3, remainingNoDeltaBudget: 0 });
    expect(episode.state).not.toBe('complete');
    expect(episode.debits).toBeLessThanOrEqual(contract.noDeltaBudget * (1 + contract.substages.length));
  });

  it('unknown and mismatched evidence preserve the allowance and stop automatic rearm', () => {
    for (const observation of [
      { kind: 'unknown' as const, checkedAtMs: 1000, uncertainty: 'resolver missing' },
      { kind: 'observed' as const, checkedAtMs: 1000, evidence: { ...evidence('exited'), units: 'heartbeat' } },
    ]) {
      const claimed = claimWaitEpisode(create(), { callback: 'fire', nowMs: 1000 });
      const settled = settleWaitEpisode(claimed.episode, claimed.receipt!, observation).episode;
      expect(settled).toMatchObject({ state: 'unknown', remainingNoDeltaBudget: 2, debits: 0, nextProbeAtMs: null });
      expect(claimWaitEpisode(settled, { callback: 'another-arm', nowMs: 999999 }).receipt).toBeNull();
    }
  });

  it.each(['cancelled', 'complete', 'task-terminal'] as const)('%s tombstones survive equivalent re-registration', state => {
    const retired = retireWaitEpisode(create(), state);
    const carried = carryWaitEpisode(retired, { custodianId: 'successor', contract });
    expect(carried.state).toBe(state);
    expect(claimWaitEpisode(carried, { callback: 'new-await', nowMs: 99999 }).receipt).toBeNull();
  });

  it.each([0, -1, 101, 1.5])('rejects a non-admitted budget %s', noDeltaBudget => {
    expect(() => create({ ...contract, noDeltaBudget })).toThrow('finite');
  });
  it('rejects apparent progress from checkpoint prose', () => {
    expect(() => create({ ...contract, evidence: { ...contract.evidence!, path: 'checkpoint.body' } })).toThrow('prose');
  });

  it.each([
    { outcomes: ['exited', 'exited'] },
    { outcomes: ['exited', 'qualified', 'exited'] },
  ])('rejects repeated outcome evidence even under distinct stage names: $outcomes', ({ outcomes }) => {
    expect(() => create({ ...contract, substages: outcomes.map((value, index) => ({
      id: `stage-${index}`, valueFingerprint: waitEpisodeFingerprint(value),
    })) })).toThrow('distinct outcome evidence');
  });
});
