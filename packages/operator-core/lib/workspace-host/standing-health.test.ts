import { describe, expect, it, vi } from 'vitest';
import type { WorkspaceHostHealthAttestation } from '@papercusp/deployment-driver';
import type { WorkspaceHostAgentCredentialExpiryReading } from './agent-credential-expiry';
import type { WorkspaceHostSoakInstanceReading, WorkspaceHostSoakReachOutcome, WorkspaceHostSoakSubject } from './soak';
import {
  probeWorkspaceHostStandingHealth,
  runWorkspaceHostStandingHealthPass,
  workspaceHostStandingHealthIsFresh,
  WORKSPACE_HOST_STANDING_HEALTH_FRESH_MS,
  WORKSPACE_HOST_STANDING_HEALTH_SUBJECT_ID,
  type WorkspaceHostStandingHealthRuntime,
  type WorkspaceHostStandingHealthSeams,
  type WorkspaceHostStandingHealthTarget,
} from './standing-health';

const NOW = new Date('2026-10-01T18:00:00.000Z');
const CONTROLLER = 'papercusp-workspace-host-controller:bg-host-3270';
const WS = 'papercusp-workspace';
const IMAGE = 'projects/ubuntu-os-cloud/global/images/ubuntu-2404-noble-amd64-v20260918';

function running(instanceId: string): WorkspaceHostSoakInstanceReading {
  return { kind: 'observed', status: 'RUNNING', instanceId, sourceImage: IMAGE };
}

interface HostScript {
  reading?: WorkspaceHostSoakInstanceReading | Error;
  reach?: WorkspaceHostSoakReachOutcome | Error;
  seamsError?: Error;
  /** When set, the seam exposes `readAgentCredentialExpiry` and answers with this. */
  agentLogins?: WorkspaceHostAgentCredentialExpiryReading | Error;
}

function fakeRuntime(
  targets: WorkspaceHostStandingHealthTarget[],
  hosts: Record<string, HostScript>,
  options: { recordFails?: Set<string> } = {},
) {
  const recorded: { workspaceId: string; attestation: WorkspaceHostHealthAttestation }[] = [];
  const steps: string[] = [];
  const reachSubjects: WorkspaceHostSoakSubject[] = [];
  const agentLoginReads: string[] = [];
  const listTargets = vi.fn(async () => targets);
  const runtime: WorkspaceHostStandingHealthRuntime = {
    step: async (name, fn) => {
      steps.push(name);
      return fn();
    },
    controllerId: CONTROLLER,
    listTargets,
    resolveSeams: async ({ hostId }): Promise<WorkspaceHostStandingHealthSeams> => {
      const script = hosts[hostId] ?? {};
      if (script.seamsError) throw script.seamsError;
      return {
        readInstance: async () => {
          if (script.reading instanceof Error) throw script.reading;
          return script.reading ?? running(`inst-${hostId}`);
        },
        probeFor: (subject) => ({
          probeReach: async () => {
            reachSubjects.push(subject);
            if (script.reach instanceof Error) throw script.reach;
            return script.reach ?? { kind: 'reached' };
          },
          ...(script.agentLogins !== undefined
            ? {
                readAgentCredentialExpiry: async () => {
                  agentLoginReads.push(subject.hostId);
                  if (script.agentLogins instanceof Error) throw script.agentLogins;
                  return script.agentLogins!;
                },
              }
            : {}),
        }),
      };
    },
    recordHealth: async (workspaceId, attestation) => {
      if (options.recordFails?.has(attestation.hostId)) throw new Error('connection closed');
      recorded.push({ workspaceId, attestation });
    },
    now: () => NOW,
  };
  return { runtime, recorded, steps, reachSubjects, agentLoginReads, listTargets };
}

const target = (hostId: string, healthAttestedAt: string | null = null): WorkspaceHostStandingHealthTarget => ({
  workspaceId: WS,
  hostId,
  healthAttestedAt,
});

describe('runWorkspaceHostStandingHealthPass', () => {
  it('attests each due host, skips a host an active soak attested moments ago, and writes no vacuous stability checks', async () => {
    const soakAttestedAt = new Date(NOW.getTime() - 2 * 60_000).toISOString();
    const { runtime, recorded, steps, reachSubjects, listTargets } = fakeRuntime(
      [target('host-healthy'), target('host-iap-down'), target('host-soaking', soakAttestedAt)],
      { 'host-iap-down': { reach: { kind: 'transport-failure', detail: 'ssh exited 255' } } },
    );

    const result = await runWorkspaceHostStandingHealthPass(runtime);

    expect(listTargets).toHaveBeenCalledWith(CONTROLLER);
    expect(steps).toEqual([
      'standing-health-list',
      `standing-health-host:${WS}:host-healthy`,
      `standing-health-host:${WS}:host-iap-down`,
    ]);
    expect(result.outcomes.map((outcome) => [outcome.hostId, outcome.kind])).toEqual([
      ['host-healthy', 'attested'],
      ['host-iap-down', 'attested'],
      ['host-soaking', 'skipped-fresh'],
    ]);
    expect(recorded.map((row) => row.attestation.hostId)).toEqual(['host-healthy', 'host-iap-down']);

    const healthy = recorded[0]!.attestation;
    expect(healthy).toEqual({
      hostId: 'host-healthy',
      observedAt: NOW.toISOString(),
      status: 'healthy',
      checks: [
        { name: 'compute-running', ok: true, detail: 'RUNNING' },
        { name: 'controller-reach', ok: true, detail: 'conduit executable' },
      ],
    });
    expect(recorded[0]!.workspaceId).toBe(WS);

    const iapDown = recorded[1]!.attestation;
    expect(iapDown.status).toBe('degraded');
    expect(iapDown.checks).toContainEqual({
      name: 'controller-reach',
      ok: false,
      detail: 'transport-failure: ssh exited 255',
    });

    // The reach is pinned to the instance the provider just reported, under the standing subject id.
    expect(reachSubjects.map((subject) => [subject.hostId, subject.instanceId, subject.soakId])).toEqual([
      ['host-healthy', 'inst-host-healthy', WORKSPACE_HOST_STANDING_HEALTH_SUBJECT_ID],
      ['host-iap-down', 'inst-host-iap-down', WORKSPACE_HOST_STANDING_HEALTH_SUBJECT_ID],
    ]);
    for (const row of recorded) {
      expect(row.attestation.checks.map((check) => check.name)).not.toContain('incarnation-stable');
      expect(row.attestation.checks.map((check) => check.name)).not.toContain('image-stable');
    }
  });

  it('keeps going after one host fails to record, and reports that host as not recorded', async () => {
    const { runtime, recorded } = fakeRuntime([target('host-a'), target('host-b')], {}, { recordFails: new Set(['host-a']) });

    const result = await runWorkspaceHostStandingHealthPass(runtime);

    expect(result.outcomes[0]).toEqual({ kind: 'record-failed', workspaceId: WS, hostId: 'host-a', error: 'connection closed' });
    expect(result.outcomes[1]).toMatchObject({ kind: 'attested', hostId: 'host-b', status: 'healthy' });
    expect(recorded.map((row) => row.attestation.hostId)).toEqual(['host-b']);
  });

  it('lists nothing and probes nothing for a process that controls no host', async () => {
    const { runtime, recorded, steps } = fakeRuntime([], {});
    const result = await runWorkspaceHostStandingHealthPass(runtime);
    expect(result).toEqual({ controllerId: CONTROLLER, outcomes: [] });
    expect(steps).toEqual(['standing-health-list']);
    expect(recorded).toEqual([]);
  });
});

describe('probeWorkspaceHostStandingHealth', () => {
  it('reports a stopped instance as unreachable and does not spend an IAP reach on it', async () => {
    const { runtime, reachSubjects } = fakeRuntime([], {
      h: { reading: { kind: 'observed', status: 'TERMINATED', instanceId: 'i-1', sourceImage: IMAGE } },
    });
    const attestation = await probeWorkspaceHostStandingHealth({ workspaceId: WS, hostId: 'h' }, runtime);
    expect(attestation.status).toBe('unreachable');
    expect(attestation.checks).toEqual([
      { name: 'compute-running', ok: false, detail: 'TERMINATED' },
      { name: 'controller-reach', ok: null, detail: 'not attempted: the instance is TERMINATED, not RUNNING' },
    ]);
    expect(reachSubjects).toEqual([]);
  });

  it('reports an absent instance as unreachable', async () => {
    const { runtime } = fakeRuntime([], { h: { reading: { kind: 'absent' } } });
    const attestation = await probeWorkspaceHostStandingHealth({ workspaceId: WS, hostId: 'h' }, runtime);
    expect(attestation.status).toBe('unreachable');
    expect(attestation.checks[0]).toEqual({ name: 'compute-running', ok: false, detail: 'instance absent' });
  });

  it('attests "unknown", never healthy and never silence, when the provider cannot be read', async () => {
    const { runtime, reachSubjects } = fakeRuntime([], { h: { reading: { kind: 'unreadable', detail: 'ETIMEDOUT' } } });
    const attestation = await probeWorkspaceHostStandingHealth({ workspaceId: WS, hostId: 'h' }, runtime);
    expect(attestation.status).toBe('unknown');
    expect(attestation.checks).toEqual([
      { name: 'compute-running', ok: null, detail: 'provider read failed: ETIMEDOUT' },
      { name: 'controller-reach', ok: null, detail: 'not attempted: the provider could not be read' },
    ]);
    expect(reachSubjects).toEqual([]);
  });

  it('treats a provider read that throws like an unreadable one', async () => {
    const { runtime } = fakeRuntime([], { h: { reading: new Error('socket hang up') } });
    const attestation = await probeWorkspaceHostStandingHealth({ workspaceId: WS, hostId: 'h' }, runtime);
    expect(attestation.status).toBe('unknown');
    expect(attestation.checks[0]).toEqual({ name: 'compute-running', ok: null, detail: 'provider read failed: socket hang up' });
  });

  it('still attests a host whose seams the controller cannot resolve, naming why', async () => {
    const { runtime } = fakeRuntime([], { h: { seamsError: new Error('gcp_workspace_host_hosted_connection_missing') } });
    const attestation = await probeWorkspaceHostStandingHealth({ workspaceId: WS, hostId: 'h' }, runtime);
    expect(attestation.status).toBe('unknown');
    expect(attestation.checks.every((check) => check.ok === null)).toBe(true);
    expect(attestation.checks[0]!.detail).toContain('gcp_workspace_host_hosted_connection_missing');
  });

  it('records a reach that throws as a transport failure', async () => {
    const { runtime } = fakeRuntime([], { h: { reach: new Error('iap tunnel refused') } });
    const attestation = await probeWorkspaceHostStandingHealth({ workspaceId: WS, hostId: 'h' }, runtime);
    expect(attestation.status).toBe('degraded');
    expect(attestation.checks[1]).toEqual({
      name: 'controller-reach',
      ok: false,
      detail: 'transport-failure: iap tunnel refused',
    });
  });

  it('distinguishes a host that answered without its conduit from one that never answered', async () => {
    const { runtime } = fakeRuntime([], { h: { reach: { kind: 'conduit-missing', detail: 'initializer absent' } } });
    const attestation = await probeWorkspaceHostStandingHealth({ workspaceId: WS, hostId: 'h' }, runtime);
    expect(attestation.checks[1]).toEqual({
      name: 'controller-reach',
      ok: false,
      detail: 'conduit-missing: initializer absent',
    });
  });
});

describe('workspaceHostStandingHealthIsFresh', () => {
  const nowMs = NOW.getTime();
  it('is fresh only strictly inside the window', () => {
    expect(workspaceHostStandingHealthIsFresh(target('h', new Date(nowMs - 60_000).toISOString()), nowMs)).toBe(true);
    expect(
      workspaceHostStandingHealthIsFresh(
        target('h', new Date(nowMs - WORKSPACE_HOST_STANDING_HEALTH_FRESH_MS).toISOString()),
        nowMs,
      ),
    ).toBe(false);
  });

  it('is never fresh for a host that was never attested or whose timestamp does not parse', () => {
    expect(workspaceHostStandingHealthIsFresh(target('h', null), nowMs)).toBe(false);
    expect(workspaceHostStandingHealthIsFresh(target('h', 'not-a-date'), nowMs)).toBe(false);
  });

  it('a 15-minute standing write is not fresh at the next tick, so the pass never starves itself', () => {
    expect(workspaceHostStandingHealthIsFresh(target('h', new Date(nowMs - 15 * 60_000).toISOString()), nowMs)).toBe(false);
  });
});

describe('agent-login expiry in the standing attestation (WI-10003720)', () => {
  const at = (offsetMs: number) => new Date(NOW.getTime() + offsetMs).toISOString();
  const logins = (claudeAt: string, codex: 'absent' | 'self-renewing' = 'absent'): WorkspaceHostAgentCredentialExpiryReading => ({
    kind: 'read',
    slots: [
      { slot: 'claude', kind: 'fixed', accessExpiresAt: claudeAt },
      codex === 'absent' ? { slot: 'codex', kind: 'absent' } : { slot: 'codex', kind: 'self-renewing', accessExpiresAt: null },
    ],
  });

  async function attest(script: HostScript) {
    const { runtime, recorded, agentLoginReads } = fakeRuntime([target('host-a')], { 'host-a': script });
    await runWorkspaceHostStandingHealthPass(runtime);
    return { attestation: recorded[0]!.attestation, agentLoginReads };
  }

  it('goes DEGRADED once a delivered login has expired, and names the agent', async () => {
    const { attestation } = await attest({ agentLogins: logins(at(-60_000), 'self-renewing') });
    expect(attestation.status).toBe('degraded');
    expect(attestation.checks.map((check) => [check.name, check.ok])).toEqual([
      ['compute-running', true],
      ['controller-reach', true],
      ['agent-credential:claude', false],
      ['agent-credential:codex', true],
    ]);
  });

  it('stays HEALTHY but flags amber while the login is inside the warning window', async () => {
    const { attestation } = await attest({ agentLogins: logins(at(30 * 60_000)) });
    expect(attestation.status).toBe('healthy');
    expect(attestation.checks.find((check) => check.name === 'agent-credential:claude')).toMatchObject({
      ok: true,
      warn: true,
    });
  });

  it('does not ask an UNREACHED host about its logins (the reach check already says why)', async () => {
    const { attestation, agentLoginReads } = await attest({
      reach: { kind: 'transport-failure', detail: 'ssh exited 255' },
      agentLogins: logins(at(-60_000)),
    });
    expect(agentLoginReads).toEqual([]);
    expect(attestation.checks.map((check) => check.name)).toEqual(['compute-running', 'controller-reach']);
  });

  it('a login read that throws is NOT MEASURED, never a silent pass', async () => {
    const { attestation } = await attest({ agentLogins: new Error('ssh exited 255') });
    expect(attestation.status).toBe('unknown');
    expect(attestation.checks.at(-1)).toEqual({
      name: 'agent-credentials',
      ok: null,
      detail: 'not measured: ssh exited 255',
    });
  });
});
