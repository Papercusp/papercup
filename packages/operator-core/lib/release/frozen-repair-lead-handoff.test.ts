import { describe, expect, it, vi } from 'vitest';
import { createFrozenCandidateRepairQueue } from './frozen-candidate-repair-queue';
import {
  delegateRepairCausalGroup, reconcileRepairLeadHandoff, recordRepairGroupVerification,
  recordRepairLeadPickup, repairLeadIntake, sendPendingRepairLeadHandoffs, type RepairLeadHandoff, type RepairPickupProof,
} from './frozen-repair-lead-handoff';

const T = 1_800_000_000_000;
const lead = { owner: 'lead-a', workItem: 'WI-LEAD-A' };
const members = (n: number) => Array.from({ length: n }, (_, index) => `packages/core/lib/native-${index}.test.ts`);
const queue = (n = 30) => createFrozenCandidateRepairQueue({
  candidate: 'a'.repeat(40), base: 'b'.repeat(40), failingTests: members(n), nowMs: T,
});
const initial = (n = 30): RepairLeadHandoff => reconcileRepairLeadHandoff({ prior: null, pipeline: 'papercusp',
  intake: repairLeadIntake(queue(n), 'measured-red'), lead, workerStates: new Map(), nowMs: T });
const assignment = (over: Partial<Parameters<typeof delegateRepairCausalGroup>[1]> = {}): Parameters<typeof delegateRepairCausalGroup>[1] => ({
  id: 'shared-loader', caller: lead.owner, worker: 'worker-1', members: members(2),
  sourcePaths: ['packages/core/lib/shared-loader.ts'], causeEvidence: ['test-run:common-import-failure'],
  independentOf: [], sourceWorkItem: 'WI-SOURCE-1', strategy: 'fix-shared-import', attemptId: 'launch-1', atMs: T + 1, ...over,
});
const returnWorker = (state: RepairLeadHandoff, n = 30) => reconcileRepairLeadHandoff({
  prior: JSON.parse(JSON.stringify(state)), pipeline: 'papercusp', intake: repairLeadIntake(queue(n), 'worker-exited'),
  lead, workerStates: new Map([['worker-1', 'ended']]), nowMs: T + 10,
});

describe('one repair lead and complete intake', () => {
  it.each([11, 12, 13, 107, 500])('retains all %i failures in one lead group beyond the old display boundary', n => {
    const state = initial(n);
    expect(state.groups).toHaveLength(1);
    expect(state.groups[0]).toMatchObject({ owner: lead.owner, disposition: 'lead', attempts: [] });
    expect(state.groups[0].members).toEqual([...members(n)].sort());
    expect(state.intakes[0].queue.failingTests).toEqual(members(n));
    expect(state.intakes[0].queue.signature.map(entry => entry.id)).toEqual(members(n));
  });

  it('keeps original membership and source evidence across many rounds and JSON restarts', () => {
    let state = initial(13);
    const decisive = state.intakes[0].queue.failingTests[12];
    for (let round = 1; round <= 25; round++) {
      const current = { ...queue(13), repairHead: round.toString(16).padStart(40, '0'), attempts: 3 };
      state = reconcileRepairLeadHandoff({ prior: JSON.parse(JSON.stringify(state)), pipeline: 'papercusp',
        intake: repairLeadIntake(current, 'same-strategy-exhausted'), lead, workerStates: new Map(), nowMs: T + round });
    }
    expect(state.intakes).toHaveLength(26);
    for (const intake of state.intakes) expect(intake.queue.failingTests).toContain(decisive);
    expect(state.groups).toHaveLength(1);
    expect(state.groups[0].attempts).toEqual([]); // inventory publication never launches a worker
  });

  it('replaying the same intake does not duplicate groups, evidence or delivery intent', () => {
    const original = initial(13);
    const reordered = queue(13);
    reordered.failingTests.reverse(); reordered.signature.reverse();
    const next = reconcileRepairLeadHandoff({ prior: JSON.parse(JSON.stringify(original)), pipeline: 'papercusp',
      intake: repairLeadIntake(reordered, 'same-red'), lead, workerStates: new Map(), nowMs: T + 1 });
    expect(next.intakes).toHaveLength(1);
    expect(next.groups).toEqual(original.groups);
  });

  it('does not duplicate a wide inventory when only precheck clocks and progress change', () => {
    const files = Array.from({ length: 11_475 }, (_, i) => `lib/radius-${i}.test.ts`);
    const precheck = { schemaVersion: 1 as const, operationId: 'precheck-1', status: 'running' as const,
      candidate: queue().candidate, repairHead: queue().repairHead, builtCommit: 'c'.repeat(40), files,
      actor: lead.owner, startedAtMs: T, updatedAtMs: T, expiresAtMs: T + 60_000, heartbeatAtMs: T,
      currentFile: files[0], completedCount: 0, totalCount: files.length };
    let state = reconcileRepairLeadHandoff({ prior: null, pipeline: 'papercusp',
      intake: repairLeadIntake({ ...queue(13), admissionPrecheck: precheck }, 'precheck-start'),
      lead, workerStates: new Map(), nowMs: T });
    const original = structuredClone(state.intakes[0]);
    const delivery = state.groups[0].delivery!.id;
    for (let round = 1; round <= 30; round++) {
      const current = { ...queue(13), updatedAtMs: T + round, fixerStateChangedAtMs: T + round,
        admissionPrecheck: { ...precheck, updatedAtMs: T + round, heartbeatAtMs: T + round,
          expiresAtMs: T + 60_000 + round, completedCount: round, currentFile: files[round] } };
      state = reconcileRepairLeadHandoff({ prior: JSON.parse(JSON.stringify(state)), pipeline: 'papercusp',
        intake: repairLeadIntake(current, 'diagnostic-progress'), lead, workerStates: new Map(), nowMs: T + round });
    }
    expect(state.intakes).toEqual([original]);
    expect(state.currentQueue.admissionPrecheck).toMatchObject({ files, completedCount: 30, heartbeatAtMs: T + 30 });
    expect(state.groups[0].delivery!.id).toBe(delivery);
    expect(state.groups[0].delivery!.pickup).toBe('pending');
    const changed = reconcileRepairLeadHandoff({ prior: state, pipeline: 'papercusp',
      intake: repairLeadIntake({ ...state.currentQueue, attempts: 1 }, 'actual-attempt'),
      lead, workerStates: new Map(), nowMs: T + 31 });
    expect(changed.intakes).toHaveLength(2);
    expect(changed.intakes[0]).toEqual(original);
    const measured = reconcileRepairLeadHandoff({ prior: state, pipeline: 'papercusp',
      intake: repairLeadIntake({ ...state.currentQueue,
        admissionPrecheck: { ...state.currentQueue.admissionPrecheck!, status: 'failed' } }, 'terminal-precheck'),
      lead, workerStates: new Map(), nowMs: T + 32 });
    expect(measured.intakes).toHaveLength(2);
    expect(measured.intakes[1].queue.admissionPrecheck?.status).toBe('failed');
  });

  it('does not replace a frozen candidate to recover routing', () => {
    expect(() => reconcileRepairLeadHandoff({ prior: initial(), pipeline: 'papercusp',
      intake: repairLeadIntake({ ...queue(), candidate: 'c'.repeat(40) }, 'new-tip'), lead,
      workerStates: new Map(), nowMs: T + 1 })).toThrow('identity changed');
  });
});

describe('explicit causal groups', () => {
  it('fences the first delegation against the lead edit scope and requires cause independence', () => {
    const state = initial();
    state.groups[0].sourcePaths = ['packages/core/lib/shared-loader.ts'];
    expect(() => delegateRepairCausalGroup(state, assignment())).toThrow('source paths overlap');
    const separate = assignment({ sourcePaths: ['packages/compiler/src/check.ts'] });
    expect(() => delegateRepairCausalGroup(state, separate)).toThrow('Independent cause evidence');
    expect(delegateRepairCausalGroup(state, { ...separate,
      independentOf: [{ groupId: 'shared-cause-triage', evidenceRefs: ['test-run:disjoint-root'] }] })
      .groups.find(group => group.id === 'shared-loader')!.owner).toBe('worker-1');
    expect(delegateRepairCausalGroup(initial(), assignment()).groups).toHaveLength(2);
  });
  it('keeps a shared cause together with one worker, leaving unclassified failures with the lead', () => {
    const state = delegateRepairCausalGroup(initial(), assignment());
    const grouped = state.groups.find(group => group.id === 'shared-loader')!;
    expect(grouped.members).toEqual(members(2));
    expect(grouped.owner).toBe('worker-1');
    expect(grouped.attempts).toHaveLength(1);
    expect(state.groups.find(group => group.id === 'shared-cause-triage')!.members).toHaveLength(28);
  });

  it('requires measured cause and disjoint edits plus independence evidence for each sibling', () => {
    const state = delegateRepairCausalGroup(initial(), assignment());
    const second = assignment({ id: 'independent-compiler', worker: 'worker-2', members: [members(3)[2]],
      sourceWorkItem: 'WI-SOURCE-2', sourcePaths: ['packages/compiler/src/check.ts'], attemptId: 'compiler-1' });
    expect(() => delegateRepairCausalGroup(state, second)).toThrow('Independent cause evidence');
    expect(() => delegateRepairCausalGroup(state, { ...second, causeEvidence: [] })).toThrow('measured cause');
    expect(() => delegateRepairCausalGroup(state, { ...second, sourcePaths: assignment().sourcePaths,
      independentOf: [{ groupId: 'shared-loader', evidenceRefs: ['test-run:independent'] }] })).toThrow('source paths overlap');
    const next = delegateRepairCausalGroup(state, { ...second,
      independentOf: [{ groupId: 'shared-loader', evidenceRefs: ['test-run:compiler-without-loader'] }] });
    expect(next.groups.filter(group => group.disposition === 'delegated')).toHaveLength(2);
  });

  it('rejects overlapping membership, path aliases, active worker replacement and foreign callers', () => {
    const state = delegateRepairCausalGroup(initial(), assignment());
    expect(() => delegateRepairCausalGroup(state, assignment({ id: 'alias', attemptId: 'other' }))).toThrow('membership overlaps');
    expect(() => delegateRepairCausalGroup(initial(), assignment({ sourcePaths: ['packages/../shared.ts'] }))).toThrow('canonical');
    expect(() => delegateRepairCausalGroup(state, assignment({ attemptId: 'replace' }))).toThrow('already has a worker');
    expect(() => delegateRepairCausalGroup(initial(), assignment({ caller: 'not-lead' }))).toThrow('verified repair lead');
  });

  it('idempotently records an attempt and rejects reusing its key for different work', () => {
    const state = delegateRepairCausalGroup(initial(), assignment());
    expect(delegateRepairCausalGroup(JSON.parse(JSON.stringify(state)), assignment())).toEqual(state);
    expect(() => delegateRepairCausalGroup(state, assignment({ worker: 'other-worker' }))).toThrow('id reused');
  });

  it('returns dead worker membership, attempts, verification and source references to the lead', () => {
    let state = delegateRepairCausalGroup(initial(), assignment());
    state = recordRepairGroupVerification(state, { groupId: 'shared-loader', caller: 'worker-1', evidenceRefs: ['test-run:red-repro', 'file:patch.diff'] });
    const next = returnWorker(state);
    const group = next.groups.find(row => row.id === 'shared-loader')!;
    expect(group).toMatchObject({ owner: lead.owner, disposition: 'lead', sourceWorkItem: 'WI-SOURCE-1',
      verification: ['file:patch.diff', 'test-run:red-repro'], returns: [{ from: 'worker-1', to: lead.owner, reason: 'worker-ended', atMs: T + 10 }] });
    expect(group.members).toEqual(members(2));
    expect(group.attempts).toHaveLength(1);
    expect(group.delivery?.pickup).toBe('pending');
  });

  it('unknown worker state preserves custody; only a verified successor changes lead custody', () => {
    const state = delegateRepairCausalGroup(initial(), assignment());
    const successor = { owner: 'lead-b', workItem: 'WI-LEAD-B' };
    const next = reconcileRepairLeadHandoff({ prior: state, pipeline: 'papercusp', intake: repairLeadIntake(queue(), 'successor'),
      lead: successor, workerStates: new Map([['worker-1', 'unknown']]), nowMs: T + 4 });
    expect(next.groups.find(group => group.id === 'shared-loader')!.owner).toBe('worker-1');
    expect(next.groups[0].owner).toBe('lead-b');
    const recovered = reconcileRepairLeadHandoff({ prior: next, pipeline: 'papercusp', intake: repairLeadIntake(queue(), 'worker-ended'),
      lead: successor, workerStates: new Map([['worker-1', 'ended']]), nowMs: T + 5 });
    expect(recovered.groups.find(group => group.id === 'shared-loader')!.owner).toBe('lead-b');
  });

  it('never resets the same-strategy three-launch cap on repair-head changes or restarts', () => {
    let state = initial();
    for (let index = 1; index <= 3; index++) {
      state = delegateRepairCausalGroup(state, assignment({ attemptId: `launch-${index}` }));
      state = returnWorker(state);
      state = reconcileRepairLeadHandoff({ prior: JSON.parse(JSON.stringify(state)), pipeline: 'papercusp',
        intake: repairLeadIntake({ ...queue(), repairHead: index.toString().repeat(40) }, 'arbitrary-head-advance'),
        lead, workerStates: new Map(), nowMs: T + 20 + index });
    }
    expect(() => delegateRepairCausalGroup(state, assignment({ attemptId: 'launch-4' }))).toThrow('three-launch budget');
    expect(() => delegateRepairCausalGroup(state, assignment({ id: 'renamed-group', attemptId: 'launch-4' }))).toThrow('membership overlaps');
    expect(state.groups.find(group => group.id === 'shared-loader')!.attempts).toHaveLength(3);
    expect(state.groups.find(group => group.id === 'shared-loader')!.owner).toBe(lead.owner);
  });
  it('retains full membership while retrying only a still-open portion of the group', () => {
    const state = returnWorker(delegateRepairCausalGroup(initial(), assignment()));
    const partial = { ...queue(), failingTests: [members(2)[1]], signature: queue().signature.filter(row => row.id === members(2)[1]) };
    const current = reconcileRepairLeadHandoff({ prior: state, pipeline: 'papercusp', intake: repairLeadIntake(partial, 'partial-pass'),
      lead, workerStates: new Map(), nowMs: T + 20 });
    const retried = delegateRepairCausalGroup(current, assignment({ attemptId: 'partial-retry' }));
    expect(retried.groups.find(group => group.id === 'shared-loader')!.members).toEqual(members(2));
  });
});

describe('durable outbox batch recovery', () => {
  it.each([11, 12, 13, 37])('delivers later members of %i groups despite a failed prefix, then recovers only unresolved sources', async n => {
    const groups = Array.from({ length: n }, (_, i) => ({ ...initial().groups[0], id: 'group-' + i }));
    const delivered = new Set<string>();
    const send = vi.fn(async (group: typeof groups[number]) => {
      if (group.id === 'group-0') throw new Error('prefix transport failure');
      delivered.add(group.id);
    });
    await expect(sendPendingRepairLeadHandoffs(groups, send)).rejects.toThrow('durable pending intents');
    expect(send.mock.calls.map(([group]) => group.id)).toEqual(groups.map(group => group.id));
    expect(delivered.has('group-' + (n - 1))).toBe(true);
    const restarted = JSON.parse(JSON.stringify(groups)) as typeof groups;
    const recover = vi.fn(async (group: typeof groups[number]) => { delivered.add(group.id); });
    await sendPendingRepairLeadHandoffs(restarted.filter(group => !delivered.has(group.id)), recover);
    expect(recover.mock.calls.map(([group]) => group.id)).toEqual(['group-0']);
    expect(delivered.size).toBe(n);
  });
});

describe('actual pickup', () => {
  const proof = (state: RepairLeadHandoff, over: Partial<RepairPickupProof> = {}): RepairPickupProof => ({
    deliveryId: state.groups[0].delivery!.id, owner: lead.owner, offeredAtMs: T,
    deliveredAtMs: T + 1, turnStartedAtMs: T + 2, turnProof: 'observed', ...over,
  });
  it.each(['awaiting', 'coalesced', 'superseded', null])('does not turn queue/delivery state %s into pickup', turnProof => {
    const state = initial();
    expect(recordRepairLeadPickup(state, [proof(state, { turnProof })], T + 3).groups[0].delivery!.pickup).toBe('pending');
  });
  it('requires the exact target, delivery and chronology and retains confirmed proof on retries', () => {
    const state = initial();
    for (const over of [{ owner: 'other' }, { deliveryId: 'other' }, { deliveredAtMs: null },
      { offeredAtMs: T - 1 }, { turnStartedAtMs: T }, { turnStartedAtMs: T + 99 }]) {
      expect(recordRepairLeadPickup(state, [proof(state, over)], T + 3).groups[0].delivery!.pickup).toBe('pending');
    }
    const next = recordRepairLeadPickup(state, [proof(state)], T + 3);
    expect(next.groups[0].delivery).toMatchObject({ pickup: 'confirmed', turnStartedAtMs: T + 2 });
    expect(recordRepairLeadPickup(next, [], T + 4)).toEqual(next);
  });
  it('returns a measured missed delegation to the lead and requires fresh lead pickup', () => {
    const state = delegateRepairCausalGroup(initial(), assignment());
    const group = state.groups.find(row => row.id === 'shared-loader')!;
    const missed = recordRepairLeadPickup(state, [{ deliveryId: group.delivery!.id, owner: 'worker-1',
      offeredAtMs: T + 1, deliveredAtMs: null, turnStartedAtMs: null, turnProof: 'not-picked-up' }], T + 100);
    const next = reconcileRepairLeadHandoff({ prior: missed, pipeline: 'papercusp', intake: repairLeadIntake(queue(), 'missed-pickup'),
      lead, workerStates: new Map([['worker-1', 'live']]), nowMs: T + 101 });
    expect(next.groups.find(row => row.id === 'shared-loader')).toMatchObject({ owner: lead.owner, disposition: 'lead',
      delivery: { owner: lead.owner, pickup: 'pending' } });
  });
});
