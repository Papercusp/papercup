import { describe, expect, it } from 'vitest';

import {
  DEFAULT_WORKSPACE_HOST_AGENT_AUTHENTICATION_PROBES,
  WORKSPACE_HOST_CANARY_AGENTS,
  probeWorkspaceHostAgentAuthentication,
  probeWorkspaceHostAgents,
  workspaceHostAgentSubjectDigest,
  type WorkspaceHostAgentProbeInvocation,
  type WorkspaceHostAgentProbeOutcome,
  type WorkspaceHostAgentProbeRunner,
  type WorkspaceHostCanaryAgent,
} from './workspace-host-agent-authentication';

const NOW = () => new Date('2026-08-25T22:30:00.000Z');

class ScriptedRunner implements WorkspaceHostAgentProbeRunner {
  readonly invocations: WorkspaceHostAgentProbeInvocation[] = [];

  constructor(
    private readonly script: Record<string, WorkspaceHostAgentProbeOutcome | Error>,
  ) {}

  run(invocation: WorkspaceHostAgentProbeInvocation): Promise<WorkspaceHostAgentProbeOutcome> {
    this.invocations.push(invocation);
    const scripted = this.script[invocation.command];
    if (!scripted) return Promise.reject(new Error(`no script for ${invocation.command}`));
    if (scripted instanceof Error) return Promise.reject(scripted);
    return Promise.resolve(scripted);
  }
}

const AUTHENTICATED = {
  claude: { exitCode: 0, stdout: 'Authentication status: logged in as canary@papercup.ai\n' },
  codex: { exitCode: 0, stdout: 'Login status: signed in as canary@papercup.ai (Team)\n' },
  omp: {
    exitCode: 0,
    stdout: JSON.stringify({ providers: [{ id: 'anthropic', accounts: [{ account: 'can…4f2' }] }] }),
  },
} satisfies Record<WorkspaceHostCanaryAgent, WorkspaceHostAgentProbeOutcome>;

describe('workspace-host agent authentication probes', () => {
  it('uses a real authenticated-account verb for every agent, never a version check', () => {
    for (const agent of WORKSPACE_HOST_CANARY_AGENTS) {
      const spec = DEFAULT_WORKSPACE_HOST_AGENT_AUTHENTICATION_PROBES[agent];
      expect(spec.agent).toBe(agent);
      expect(spec.args.length).toBeGreaterThan(0);
      // A `--version` probe passes on a host where nobody has ever signed in, which is exactly
      // the state the canary exists to detect.
      expect(spec.args).not.toContain('--version');
      expect(spec.args).not.toContain('-v');
      expect(spec.endpoint.length).toBeGreaterThan(0);
    }
    expect(DEFAULT_WORKSPACE_HOST_AGENT_AUTHENTICATION_PROBES.claude.args).toEqual([
      'auth',
      'status',
    ]);
    expect(DEFAULT_WORKSPACE_HOST_AGENT_AUTHENTICATION_PROBES.codex.args).toEqual([
      'login',
      'status',
    ]);
    expect(DEFAULT_WORKSPACE_HOST_AGENT_AUTHENTICATION_PROBES.omp.args).toEqual([
      'usage',
      '--json',
      '--redact',
    ]);
  });

  it('reports authenticated with only the four permitted discriminators', async () => {
    const runner = new ScriptedRunner({ claude: AUTHENTICATED.claude });
    const evidence = await probeWorkspaceHostAgentAuthentication({
      spec: DEFAULT_WORKSPACE_HOST_AGENT_AUTHENTICATION_PROBES.claude,
      runner,
      now: NOW,
    });

    expect(evidence.authenticated).toBe(true);
    expect(evidence.exitStatus).toBe(0);
    expect(evidence.endpoint).toBe('https://api.anthropic.com');
    expect(evidence.observedAt).toBe('2026-08-25T22:30:00.000Z');
    expect(evidence.subjectDigest).toBe(workspaceHostAgentSubjectDigest('canary@papercup.ai'));
  });

  it('never lets raw stdout or an un-redacted subject reach the evidence', async () => {
    const runner = new ScriptedRunner({ claude: AUTHENTICATED.claude });
    const evidence = await probeWorkspaceHostAgentAuthentication({
      spec: DEFAULT_WORKSPACE_HOST_AGENT_AUTHENTICATION_PROBES.claude,
      runner,
      now: NOW,
    });
    const serialized = JSON.stringify(evidence);
    expect(serialized).not.toContain('canary@papercup.ai');
    expect(serialized).not.toContain('Authentication status');
    // claude's disclosure is `digest`, so no plaintext subject is published at all.
    expect(evidence.subject).toBeUndefined();
  });

  it('publishes the subject verbatim only when the tool itself redacted it', async () => {
    const runner = new ScriptedRunner({ omp: AUTHENTICATED.omp });
    const evidence = await probeWorkspaceHostAgentAuthentication({
      spec: DEFAULT_WORKSPACE_HOST_AGENT_AUTHENTICATION_PROBES.omp,
      runner,
      now: NOW,
    });
    expect(evidence.subjectDisclosure).toBe('redacted');
    expect(evidence.subject).toBe('can…4f2');
    expect(evidence.subjectDigest).toBeDefined();
  });

  it('treats a non-zero exit as unauthenticated and records the status', async () => {
    const runner = new ScriptedRunner({
      claude: { exitCode: 1, stdout: 'Not logged in. Run `claude auth login`.\n' },
    });
    const evidence = await probeWorkspaceHostAgentAuthentication({
      spec: DEFAULT_WORKSPACE_HOST_AGENT_AUTHENTICATION_PROBES.claude,
      runner,
      now: NOW,
    });
    expect(evidence.authenticated).toBe(false);
    expect(evidence.exitStatus).toBe(1);
    expect(evidence.failure).toBe('non-zero-exit');
    expect(JSON.stringify(evidence)).not.toContain('claude auth login');
  });

  it('treats exit 0 with no parseable subject as a FAILED probe, not a nameless success', async () => {
    // A reworded or broken CLI is the realistic shape of this case; calling it authenticated is
    // how an unbacked boolean comes back.
    const runner = new ScriptedRunner({ claude: { exitCode: 0, stdout: 'OK\n' } });
    const evidence = await probeWorkspaceHostAgentAuthentication({
      spec: DEFAULT_WORKSPACE_HOST_AGENT_AUTHENTICATION_PROBES.claude,
      runner,
      now: NOW,
    });
    expect(evidence.authenticated).toBe(false);
    expect(evidence.failure).toBe('no-authenticated-subject');
  });

  it('reduces a thrown probe error to a code, never surfacing the error text', async () => {
    const runner = new ScriptedRunner({
      claude: new Error('spawn /opt/papercusp/current/bin/claude ENOENT --token=abc'),
    });
    const evidence = await probeWorkspaceHostAgentAuthentication({
      spec: DEFAULT_WORKSPACE_HOST_AGENT_AUTHENTICATION_PROBES.claude,
      runner,
      now: NOW,
    });
    expect(evidence.authenticated).toBe(false);
    expect(evidence.failure).toBe('probe-error');
    expect(evidence.exitStatus).toBe(-1);
    expect(JSON.stringify(evidence)).not.toContain('ENOENT');
  });

  it('probes all three agents and reports allAuthenticated only when every one passed', async () => {
    const allGood = new ScriptedRunner({ ...AUTHENTICATED });
    const report = await probeWorkspaceHostAgents({ runner: allGood, now: NOW });
    expect(report.allAuthenticated).toBe(true);
    expect(Object.keys(report.agents).sort()).toEqual(['claude', 'codex', 'omp']);
    // Sequential, in the declared order — three CLIs racing one credential store is a source of
    // spurious failures.
    expect(allGood.invocations.map((i) => i.command)).toEqual(['claude', 'codex', 'omp']);

    const oneBad = new ScriptedRunner({
      ...AUTHENTICATED,
      codex: { exitCode: 1, stdout: '' },
    });
    const degraded = await probeWorkspaceHostAgents({ runner: oneBad, now: NOW });
    expect(degraded.allAuthenticated).toBe(false);
    expect(degraded.agents.codex.authenticated).toBe(false);
    expect(degraded.agents.claude.authenticated).toBe(true);
  });

  it('refuses a probe spec whose declared agent does not match its slot', async () => {
    await expect(
      probeWorkspaceHostAgents({
        runner: new ScriptedRunner({ ...AUTHENTICATED }),
        now: NOW,
        probes: {
          claude: {
            ...DEFAULT_WORKSPACE_HOST_AGENT_AUTHENTICATION_PROBES.codex,
          },
        },
      }),
    ).rejects.toThrow(/declares agent 'codex'/);
  });

  it('passes a bounded timeout to the runner so a prompt cannot hang the step', async () => {
    const runner = new ScriptedRunner({ ...AUTHENTICATED });
    await probeWorkspaceHostAgents({ runner, now: NOW });
    for (const invocation of runner.invocations) {
      expect(invocation.timeoutMs).toBeGreaterThan(0);
      expect(Number.isFinite(invocation.timeoutMs)).toBe(true);
    }
  });

  it('gives the same account a stable digest and different accounts different digests', () => {
    expect(workspaceHostAgentSubjectDigest('a@b.c')).toBe(workspaceHostAgentSubjectDigest('a@b.c'));
    expect(workspaceHostAgentSubjectDigest('a@b.c')).not.toBe(
      workspaceHostAgentSubjectDigest('d@e.f'),
    );
  });
});
