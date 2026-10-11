import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../integration-credentials', () => ({ readAdmittedElevenLabsIntegrationCredential: vi.fn() }));
import { readAdmittedElevenLabsIntegrationCredential } from '../integration-credentials';
import { createElevenLabsTutorialVoiceLimitVerifier, readReservedElevenLabsTutorialCredential } from './tutorial-voice-reservation-store';
import { PAPERCUP_FRONT_AGENT } from '../voice-engines/elevenlabs-agent-sync';

const read = vi.mocked(readAdmittedElevenLabsIntegrationCredential);
const admitted = { apiKey: 'synthetic-secret', keyId: 'restricted', agentId: 'tutorial', maximumSeconds: 120 };
function options() {
  return { credential: { integrationName: 'TUTORIAL_KEY', metadataApiKey: 'synthetic-metadata',
    allowedPermissions: ['convai_read'], maximumCredits: 1000,
    definition: structuredClone(PAPERCUP_FRONT_AGENT), toolIds: ['tutorial-help'], agentId: 'tutorial',
    fetch, signal: new AbortController().signal },
  dailySeconds: { global: 1200, user: 240, organization: 600, workspace: 600 } };
}
const verify = (reader: ReturnType<typeof createElevenLabsTutorialVoiceLimitVerifier>) =>
  reader(null as never, null as never);
beforeEach(() => { read.mockReset(); read.mockResolvedValue(admitted); });
describe('host-owned tutorial provider limits', () => {
  it('rechecks the exact reserved credential and refuses rotation or duration growth', async () => {
    const reservation = { ok: true as const, reservationId: '11111111-1111-4111-8111-111111111111',
      maximumSeconds: 120, providerLimitRef: 'elevenlabs:restricted:tutorial' };
    expect(await readReservedElevenLabsTutorialCredential(reservation, options().credential)).toEqual(admitted);
    for (const changed of [{ ...admitted, keyId: 'rotated' }, { ...admitted, agentId: 'other' },
      { ...admitted, maximumSeconds: 121 }, { ...admitted, maximumSeconds: 0 }, null]) {
      read.mockResolvedValueOnce(changed);
      expect(await readReservedElevenLabsTutorialCredential(reservation, options().credential)).toBeNull();
    }
  });
  it('snapshots the committed reservation and retains cancellation checks after re-admission', async () => {
    const reservation = { ok: true as const, reservationId: '11111111-1111-4111-8111-111111111111',
      maximumSeconds: 120, providerLimitRef: 'elevenlabs:restricted:tutorial' };
    read.mockImplementationOnce(async () => { reservation.maximumSeconds = 999; return { ...admitted, maximumSeconds: 121 }; });
    expect(await readReservedElevenLabsTutorialCredential(reservation, options().credential)).toBeNull();
    const controller = new AbortController(); const policy = options(); policy.credential.signal = controller.signal;
    read.mockImplementationOnce(async () => { controller.abort(); return admitted; });
    expect(await readReservedElevenLabsTutorialCredential(reservation, policy.credential)).toBeNull();
    read.mockClear();
    expect(await readReservedElevenLabsTutorialCredential(reservation, policy.credential)).toBeNull();
    expect(read).not.toHaveBeenCalled();
  });
  it('freshly admits each reservation and returns no credential', async () => {
    const reader = createElevenLabsTutorialVoiceLimitVerifier(options());
    const result = await verify(reader);
    expect(result).toEqual({ maximumSeconds: 120, providerLimitRef: 'elevenlabs:restricted:tutorial',
      dailySeconds: options().dailySeconds });
    expect(JSON.stringify(result)).not.toContain('synthetic-secret');
    read.mockResolvedValueOnce(null);
    expect(await verify(reader)).toBeNull();
    expect(read).toHaveBeenCalledTimes(2);
  });
  it('snapshots host policy and isolates returned quota mutations', async () => {
    const policy = options(); const reader = createElevenLabsTutorialVoiceLimitVerifier(policy);
    policy.dailySeconds.global = 9999; policy.credential.allowedPermissions.push('write');
    policy.credential.toolIds.push('other'); policy.credential.definition.name = 'changed';
    const first = await verify(reader); first!.dailySeconds.global = 1;
    expect((await verify(reader))?.dailySeconds.global).toBe(1200);
    expect(read.mock.calls[0][0]).toMatchObject({ allowedPermissions: ['convai_read'], toolIds: ['tutorial-help'],
      definition: { name: PAPERCUP_FRONT_AGENT.name } });
  });
  it('refuses cancellation before or during remote admission', async () => {
    const controller = new AbortController(); const policy = options(); policy.credential.signal = controller.signal;
    const reader = createElevenLabsTutorialVoiceLimitVerifier(policy);
    read.mockImplementationOnce(async () => { controller.abort(); return admitted; });
    expect(await verify(reader)).toBeNull();
    expect(await verify(reader)).toBeNull(); expect(read).toHaveBeenCalledTimes(1);
  });
  it('refuses invalid host quotas before provider calls and excessive remote duration', async () => {
    const policy = options(); policy.dailySeconds.user = 0;
    expect(await verify(createElevenLabsTutorialVoiceLimitVerifier(policy))).toBeNull();
    expect(read).not.toHaveBeenCalled();
    const missing = options(); delete (missing.dailySeconds as Partial<typeof missing.dailySeconds>).workspace;
    expect(await verify(createElevenLabsTutorialVoiceLimitVerifier(missing))).toBeNull();
    expect(read).not.toHaveBeenCalled();
    read.mockResolvedValueOnce({ ...admitted, maximumSeconds: 7201 });
    expect(await verify(createElevenLabsTutorialVoiceLimitVerifier(options()))).toBeNull();
  });
});
