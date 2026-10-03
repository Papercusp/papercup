/**
 * wake-executor-headless-presence-stamp.test.ts — WI-10005725.
 *
 * A resume-headless turn runs with no psu launcher, so no supervisor beat ever
 * reports its pid. The presence row kept the DEAD launcher pid of the session
 * being resumed; the liveness oracle's ESRCH probe outranks the turn's own fresh
 * activity, so a working turn read `ended` and the goal-holder respawner replaced
 * it. `defaultAccountHeadlessResumeTurn` must stamp the spawned child's pid/host
 * onto presence, and that best-effort stamp must never reject `pidRecorded`.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { hostname } from 'node:os';

const h = vi.hoisted(() => ({
  touchHeartbeat: vi.fn(async (_ownerId: string, _liveness?: unknown) => {}),
  setAdvSessionPid: vi.fn(async (..._args: unknown[]) => {}),
}));

vi.mock('../../agent-tools/coordination/presence', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../agent-tools/coordination/presence')>()),
  touchHeartbeat: h.touchHeartbeat,
}));
vi.mock('../../adv-sessions', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../adv-sessions')>()),
  setAdvSessionPid: h.setAdvSessionPid,
}));
vi.mock('../../task-manager/enroll-sync', () => ({
  beginSyncEnrolment: () => ({}),
  completeSyncEnrolment: () => {},
  finishSyncEnrolment: () => {},
}));

import { defaultAccountHeadlessResumeTurn, type HeadlessResumeTurnInput } from './wake-executor';

const input: HeadlessResumeTurnInput = {
  pid: 424242,
  advSessionId: 33718,
  sessionWorkspaceId: 'papercusp-workspace',
  deliveryWorkspaceId: 'papercusp-workspace',
  coordOwnerId: 'su-test-resumed-headless',
  agent: 'claude',
  resumeId: '00000000-0000-4000-8000-000000000000',
  cwd: '/tmp',
  argv: ['claude', '--resume', '00000000-0000-4000-8000-000000000000'],
};

describe('WI-10005725 — resume-headless turns stamp their own pid onto presence', () => {
  beforeEach(() => {
    h.touchHeartbeat.mockReset().mockResolvedValue(undefined);
    h.setAdvSessionPid.mockReset().mockResolvedValue(undefined);
  });

  it('stamps the CHILD pid and this host, so the oracle probes the running turn', async () => {
    await defaultAccountHeadlessResumeTurn(input).pidRecorded;
    expect(h.touchHeartbeat).toHaveBeenCalledTimes(1);
    expect(h.touchHeartbeat).toHaveBeenCalledWith(input.coordOwnerId, {
      pid: input.pid,
      host: hostname(),
    });
    // The adv-session write is unchanged by the stamp.
    expect(h.setAdvSessionPid).toHaveBeenCalledWith(
      input.advSessionId,
      input.pid,
      undefined,
      input.sessionWorkspaceId,
    );
  });

  it('a failed presence stamp never rejects pidRecorded', async () => {
    h.touchHeartbeat.mockRejectedValue(new Error('presence store down'));
    await expect(defaultAccountHeadlessResumeTurn(input).pidRecorded).resolves.toBeUndefined();
    expect(h.setAdvSessionPid).toHaveBeenCalledTimes(1);
  });

  it('an adv-session write failure still surfaces through pidRecorded (contract unchanged)', async () => {
    h.setAdvSessionPid.mockRejectedValue(new Error('adv write failed'));
    await expect(defaultAccountHeadlessResumeTurn(input).pidRecorded).rejects.toThrow('adv write failed');
  });
});
