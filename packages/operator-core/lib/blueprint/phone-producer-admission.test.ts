import { describe, expect, it, vi } from 'vitest';
import { admitPhoneProducer, type PhoneProducerAdmission } from './phone-producer-admission';
import type { ExternalRuntimeProducerBinding } from './operation-worker-binding';

function fixture() {
  const snapshot: PhoneProducerAdmission = { workspaceId: 'workspace', harnessSlug: 'phone-app', storageHarnessSlug: 'home',
    executionOwnerId: 'voice-run-a', ownerId: 'owner-a', roomName: 'room-a', callKey: 'inbound:room-a', callId: 'call-a',
    runId: 'run-a', jobId: 'job-a', configFingerprint: 'llm=vendor/model', sessionStartedAt: '2026-10-07T13:00:00Z',
    workerAdmitted: true, contentDeleted: false, sessionEndedAt: null };
  let registration: ExternalRuntimeProducerBinding | null = null;
  let row: { id: string; harness: string; assignee: string; payload: unknown } | null = null;
  const host = {
    readAdmission: vi.fn(async () => ({ ...snapshot })),
    readRegistration: vi.fn(async () => registration && { ...registration }),
    reserveRegistration: vi.fn(async (_snapshot: PhoneProducerAdmission, proposed: ExternalRuntimeProducerBinding) => {
      registration ??= { ...proposed }; return { ...registration };
    }),
  };
  const store = {
    allocateId: vi.fn(async () => 'WI-voice'), read: vi.fn(async () => row),
    create: vi.fn(async (input: { id?: string; assignee?: string; payload?: unknown }) => {
      row = { id: input.id!, harness: 'home', assignee: input.assignee!, payload: input.payload }; return row;
    }),
  };
  return { snapshot, host, store, read: () => admitPhoneProducer(host, 'room-a', store),
    get registration() { return registration; }, get row() { return row; } };
}

describe('Phone producer canonical admission', () => {
  it('reserves before canonical create and reads back the rehomed holder/binding', async () => {
    const f = fixture(); const binding = await f.read();
    expect(f.host.reserveRegistration.mock.invocationCallOrder[0]).toBeLessThan(f.store.create.mock.invocationCallOrder[0]);
    expect(f.store.create).toHaveBeenCalledWith(expect.objectContaining({ id: 'WI-voice', harness: 'phone-app',
      workspaceId: 'workspace', assignee: 'voice-run-a', payload: { externalRuntimeProducer: binding } }));
    expect(binding.configurationSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(Object.isFrozen(binding)).toBe(true);
    expect(f.store.read).toHaveBeenLastCalledWith('WI-voice', 'home');
  });
  it('recovers a reserved ID after canonical create fails', async () => {
    const f = fixture(); f.store.create.mockRejectedValueOnce(new Error('offline'));
    await expect(f.read()).rejects.toThrow('offline');
    await f.read();
    expect(f.store.allocateId).toHaveBeenCalledTimes(1);
    expect(f.host.reserveRegistration).toHaveBeenCalledTimes(1);
    expect(f.store.create.mock.calls.map(([input]) => input.id)).toEqual(['WI-voice', 'WI-voice']);
  });
  it('replays an existing binding after worker expiry/session end', async () => {
    const f = fixture(); const binding = await f.read();
    f.snapshot.workerAdmitted = false; f.snapshot.sessionEndedAt = '2026-10-07T13:05:00Z';
    expect(await f.read()).toEqual(binding);
    expect(f.store.create).toHaveBeenCalledTimes(1);
    expect(f.store.allocateId).toHaveBeenCalledTimes(1);
  });
  it.each(['worker', 'ended', 'deleted', 'room'] as const)('refuses fresh %s admission before allocation', async (kind) => {
    const f = fixture();
    if (kind === 'worker') f.snapshot.workerAdmitted = false;
    if (kind === 'ended') f.snapshot.sessionEndedAt = '2026-10-07T13:05:00Z';
    if (kind === 'deleted') f.snapshot.contentDeleted = true;
    if (kind === 'room') f.snapshot.roomName = 'foreign';
    await expect(f.read()).rejects.toThrow(/phone_producer_/);
    expect(f.store.allocateId).not.toHaveBeenCalled(); expect(f.store.create).not.toHaveBeenCalled();
  });
  it('uses the concurrent reservation winner ID', async () => {
    const f = fixture();
    f.host.reserveRegistration.mockImplementationOnce(async (_snapshot, proposed) => {
      const winner = { ...proposed, workItemId: 'WI-winner' };
      f.host.readRegistration.mockResolvedValue(winner); return winner;
    });
    expect((await f.read()).workItemId).toBe('WI-winner');
    expect(f.store.create).toHaveBeenCalledWith(expect.objectContaining({ id: 'WI-winner' }));
  });
  it.each(['ownerId', 'runId', 'jobId', 'executionOwnerId', 'workspaceId', 'configFingerprint'] as const)(
    'refuses changed retained %s without a new create', async (field) => {
      const f = fixture(); await f.read(); f.snapshot[field] = 'foreign';
      await expect(f.read()).rejects.toThrow('registration_conflict');
      expect(f.store.create).toHaveBeenCalledTimes(1);
    });
  it.each(['holder', 'binding', 'harness'] as const)('refuses contradictory canonical %s', async (kind) => {
    const f = fixture(); await f.read();
    if (kind === 'holder') f.row!.assignee = 'foreign';
    if (kind === 'binding') f.row!.payload = {};
    if (kind === 'harness') f.row!.harness = 'foreign';
    await expect(f.read()).rejects.toThrow('canonical_binding_conflict');
  });
  it('recovers a lost create response only after canonical readback', async () => {
    const f = fixture(); const create = f.store.create.getMockImplementation()!;
    f.store.create.mockImplementationOnce(async (input) => { await create(input); throw new Error('lost response'); });
    expect((await f.read()).workItemId).toBe('WI-voice');
    expect(f.store.create).toHaveBeenCalledTimes(1);
  });
  it.each(['deleted', 'runtime', 'registration'] as const)('refuses %s changing during create', async (kind) => {
    const f = fixture(); const create = f.store.create.getMockImplementation()!;
    f.store.create.mockImplementationOnce(async (input) => {
      const row = await create(input);
      if (kind === 'deleted') f.snapshot.contentDeleted = true;
      if (kind === 'runtime') f.snapshot.jobId = 'replacement';
      if (kind === 'registration') f.host.readRegistration.mockResolvedValue(null);
      return row;
    });
    await expect(f.read()).rejects.toThrow('registration_changed');
  });
});
