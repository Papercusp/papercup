import { access, readFile } from 'node:fs/promises';

import {
  WorkspaceHostCredentialMaterial,
  buildWorkspaceHostCredentialReference,
  encodeWorkspaceHostAgentHomeBundle,
  workspaceHostAgentHomePaths,
  workspaceHostCredentialReferenceDigest,
  type WorkspaceHostAgentProbeInvocation,
  type WorkspaceHostAgentProbeOutcome,
  type WorkspaceHostAgentProbeRunner,
  type WorkspaceHostAgentVerificationProbeSpec,
} from '@papercusp/deployment-driver';
import { describe, expect, it } from 'vitest';

import {
  WORKSPACE_HOST_AGENT_CREDENTIAL_ADMISSION_CONTRACT_VERSION,
  WorkspaceHostAgentCredentialAdmissionError,
  assertWorkspaceHostAgentCredentialAdmissionEvidence,
  verifyWorkspaceHostAgentCredentialAdmission,
} from './agent-credential-admission';
import type {
  WorkspaceHostCredentialMaterialRequest,
  WorkspaceHostCredentialMaterialSource,
} from './credential-material-source';

const AGENT_REF = buildWorkspaceHostCredentialReference('agent-encrypted-reference', {
  hostId: 'host-1',
  agentSet: 'claude-codex-omp',
});
const DELIVERY = {
  kind: 'encrypted-reference' as const,
  generation: 5,
  audience: 'host-1',
  revocationRef: 'pc-agent-revocation://host-1/claude-codex-omp/5',
};
const NOW = () => new Date('2026-09-07T06:00:00.000Z');

function probe(agent: 'claude' | 'codex' | 'omp'): WorkspaceHostAgentVerificationProbeSpec {
  return {
    agent,
    verificationKind: 'authenticated-account',
    command: `probe-${agent}`,
    args: [],
    endpoint: `https://probe.invalid/${agent}`,
    proofPattern: /^(READY)$/m,
    subjectDisclosure: 'digest',
  };
}

const PROBES = {
  claude: [probe('claude')],
  codex: [probe('codex')],
  omp: [probe('omp')],
} satisfies Record<'claude' | 'codex' | 'omp', readonly WorkspaceHostAgentVerificationProbeSpec[]>;

function bundle(codex: 'healthy' | 'revoked'): Buffer {
  const file = (agent: string, status: string) => Buffer.from(JSON.stringify({ agent, status }), 'utf8');
  return encodeWorkspaceHostAgentHomeBundle({
    claude: file('claude', 'healthy'),
    codex: file('codex', codex),
    omp: file('omp', 'healthy'),
  });
}

async function healthyEvidence() {
  return verifyWorkspaceHostAgentCredentialAdmission(
    {
      credentialRef: { kind: 'agent', ref: AGENT_REF },
      delivery: DELIVERY,
      materialSource: source(bundle('healthy'), []),
    },
    { runner: new BundleAwareRunner(), probes: PROBES, now: NOW, environment: { PATH: '/usr/bin:/bin' } },
  );
}

function source(material: Buffer, seen: WorkspaceHostCredentialMaterialRequest[]): WorkspaceHostCredentialMaterialSource {
  return {
    async resolve(request) {
      seen.push(request);
      return new WorkspaceHostCredentialMaterial(material);
    },
  };
}

class BundleAwareRunner implements WorkspaceHostAgentProbeRunner {
  readonly homes: string[] = [];
  readonly observed: Record<string, string> = {};
  readonly environments: Readonly<Record<string, string>>[] = [];

  async run(invocation: WorkspaceHostAgentProbeInvocation): Promise<WorkspaceHostAgentProbeOutcome> {
    const agent = invocation.command.replace(/^probe-/, '') as 'claude' | 'codex' | 'omp';
    const home = invocation.env?.HOME;
    if (!home) throw new Error('probe did not receive an isolated HOME');
    this.homes.push(home);
    this.environments.push(invocation.env ?? {});
    expect(invocation.cwd).toBe(home);
    const body = JSON.parse((await readFile(workspaceHostAgentHomePaths(home)[agent], 'utf8'))) as {
      status: string;
    };
    this.observed[agent] = body.status;
    return body.status === 'healthy'
      ? { exitCode: 0, stdout: 'READY\n' }
      : { exitCode: 1, stdout: '', failureHint: 'credential-revoked' };
  }
}

describe('workspace-host exact-generation agent credential admission', () => {
  it('authenticates the exact stored bundle in an isolated home and returns public binding evidence', async () => {
    const seen: WorkspaceHostCredentialMaterialRequest[] = [];
    const runner = new BundleAwareRunner();
    const evidence = await verifyWorkspaceHostAgentCredentialAdmission(
      {
        credentialRef: { kind: 'agent', ref: AGENT_REF },
        delivery: DELIVERY,
        materialSource: source(bundle('healthy'), seen),
      },
      {
        runner,
        probes: PROBES,
        now: NOW,
        environment: { PATH: '/usr/bin:/bin', OPENAI_API_KEY: 'ambient-must-not-cross' },
      },
    );

    expect(seen).toEqual([
      {
        channel: 'agent',
        credentialRef: AGENT_REF,
        family: 'agent-encrypted-reference',
        generation: 5,
      },
    ]);
    expect(evidence).toMatchObject({
      contractVersion: WORKSPACE_HOST_AGENT_CREDENTIAL_ADMISSION_CONTRACT_VERSION,
      sourceKind: 'operator-integration-credentials',
      binding: {
        channel: 'agent',
        family: 'agent-encrypted-reference',
        generation: 5,
        referenceDigest: workspaceHostCredentialReferenceDigest(AGENT_REF),
      },
      observedAt: '2026-09-07T06:00:00.000Z',
      verification: { allReady: true, credentialFreeAgents: [] },
    });
    expect(runner.observed).toEqual({ claude: 'healthy', codex: 'healthy', omp: 'healthy' });
    expect(runner.environments.every((env) => !('OPENAI_API_KEY' in env))).toBe(true);
    expect(JSON.stringify(evidence)).not.toContain('ambient-must-not-cross');
    await expect(access(runner.homes[0]!)).rejects.toThrow();
  });

  it('fails closed on revoked stored Codex even when an ambient default is healthy', async () => {
    const runner = new BundleAwareRunner();
    let rejected: WorkspaceHostAgentCredentialAdmissionError | undefined;
    try {
      await verifyWorkspaceHostAgentCredentialAdmission(
        {
          credentialRef: { kind: 'agent', ref: AGENT_REF },
          delivery: DELIVERY,
          materialSource: source(bundle('revoked'), []),
        },
        {
          runner,
          probes: PROBES,
          now: NOW,
          environment: { PATH: '/usr/bin:/bin', OPENAI_API_KEY: 'healthy-default' },
        },
      );
    } catch (error) {
      rejected = error as WorkspaceHostAgentCredentialAdmissionError;
    }

    expect(rejected).toBeInstanceOf(WorkspaceHostAgentCredentialAdmissionError);
    expect(rejected?.evidence.verification.agents.codex).toMatchObject({
      ready: false,
      failure: 'credential-revoked',
    });
    expect(runner.observed.codex).toBe('revoked');
    expect(JSON.stringify(rejected)).not.toContain('healthy-default');
    expect(JSON.stringify(rejected)).not.toContain('"status":"revoked"');
    await expect(access(runner.homes[0]!)).rejects.toThrow();
  });

  it('rejects compound receipts that claim readiness without coherent exact agent coverage', async () => {
    const evidence = await healthyEvidence();
    const { claude, codex, omp } = evidence.verification.agents;
    expect(claude).toBeDefined();
    expect(codex).toBeDefined();
    expect(omp).toBeDefined();

    const invalidReceipts: unknown[] = [
      {
        ...evidence,
        verification: { ...evidence.verification, agents: { claude, omp } },
      },
      {
        ...evidence,
        verification: {
          ...evidence.verification,
          agents: { claude, codex: { ...codex!, agent: 'claude' }, omp },
        },
      },
      {
        ...evidence,
        verification: {
          ...evidence.verification,
          agents: { claude, codex: { ...codex!, proofDigest: '' }, omp },
        },
      },
      {
        ...evidence,
        verification: { ...evidence.verification, credentialFreeAgents: ['claude'] },
      },
      {
        ...evidence,
        verification: { ...evidence.verification, credentialFreeAgents: ['omp'] },
      },
      {
        ...evidence,
        verification: { ...evidence.verification, observedAt: '2026-09-07T06:00:01.000Z' },
      },
      {
        ...evidence,
        binding: { ...evidence.binding, referenceDigest: 'not-a-public-reference-digest' },
      },
    ];

    for (const receipt of invalidReceipts) {
      expect(() => assertWorkspaceHostAgentCredentialAdmissionEvidence(receipt)).toThrow(
        /workspace-host agent credential admission evidence/,
      );
    }

    expect(() =>
      assertWorkspaceHostAgentCredentialAdmissionEvidence(evidence, {
        credentialRef: { kind: 'agent', ref: `${AGENT_REF}-different` },
        delivery: DELIVERY,
      }),
    ).toThrow(/does not match the requested binding/);
  });

  it('accepts an intentionally credential-free OMP only when it has no contradictory probe evidence', async () => {
    const seen: WorkspaceHostCredentialMaterialRequest[] = [];
    const runner = new BundleAwareRunner();
    const material = encodeWorkspaceHostAgentHomeBundle({
      claude: Buffer.from('{"agent":"claude","status":"healthy"}', 'utf8'),
      codex: Buffer.from('{"agent":"codex","status":"healthy"}', 'utf8'),
      omp: null,
    });
    const evidence = await verifyWorkspaceHostAgentCredentialAdmission(
      {
        credentialRef: { kind: 'agent', ref: AGENT_REF },
        delivery: DELIVERY,
        materialSource: source(material, seen),
      },
      { runner, probes: PROBES, now: NOW, environment: { PATH: '/usr/bin:/bin' } },
    );

    expect(evidence.verification.credentialFreeAgents).toEqual(['omp']);
    expect(evidence.verification.agents.omp).toBeUndefined();
    expect(runner.observed).toEqual({ claude: 'healthy', codex: 'healthy' });
    expect(() => assertWorkspaceHostAgentCredentialAdmissionEvidence(evidence)).not.toThrow();
  });
});
