/**
 * Just-in-time authentication of the exact sealed agent generation a workspace host will receive.
 *
 * Delivery proves that bytes named by `(reference, generation)` reached the guest; it does not
 * prove those bytes still authenticate. The controller's ambient HOME cannot answer that question:
 * it may hold a newer, healthy account while the immutable stored generation is revoked. This
 * verifier resolves the exact stored bundle, installs it only into a private temporary home, and
 * delegates authentication to the existing closed workspace-host agent probe contract.
 */
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir, userInfo } from 'node:os';
import { dirname, join } from 'node:path';

import {
  DEFAULT_WORKSPACE_HOST_AGENT_VERIFICATION_PROBES,
  NodeWorkspaceHostAgentProbeRunner,
  WORKSPACE_HOST_AGENT_HOME_OMP_LOCAL_MODELS_YML,
  WORKSPACE_HOST_AGENT_VERIFICATION_CONTRACT_VERSION,
  WORKSPACE_HOST_CANARY_AGENTS,
  assertWorkspaceHostSecretIsolation,
  parseWorkspaceHostAgentHomeBundle,
  parseWorkspaceHostCredentialReference,
  probeWorkspaceHostAgentVerification,
  workspaceHostAgentHomeDirectories,
  workspaceHostAgentHomeOmpModelsPath,
  workspaceHostAgentHomePaths,
  workspaceHostCredentialReferenceDigest,
  type ProbeWorkspaceHostAgentsInput,
  type WorkspaceHostAgentHomeBundle,
  type WorkspaceHostAgentProbeRunner,
  type WorkspaceHostAgentVerificationEvidence,
  type WorkspaceHostCanaryAgent,
  type WorkspaceHostCredentialDelivery,
  type WorkspaceHostCredentialFamily,
  type WorkspaceHostCredentialRefs,
} from '@papercusp/deployment-driver';

import type { WorkspaceHostCredentialMaterialSource } from './credential-material-source';

export const WORKSPACE_HOST_AGENT_CREDENTIAL_ADMISSION_CONTRACT_VERSION =
  'papercusp-workspace-host-agent-credential-admission-v1';

type AgentCredentialRef = NonNullable<WorkspaceHostCredentialRefs['agentCredentialRef']>;

export interface WorkspaceHostAgentCredentialAdmissionInput {
  readonly credentialRef: AgentCredentialRef;
  readonly delivery: WorkspaceHostCredentialDelivery;
  readonly materialSource: WorkspaceHostCredentialMaterialSource;
}

export interface WorkspaceHostAgentCredentialAdmissionEvidence {
  readonly contractVersion: typeof WORKSPACE_HOST_AGENT_CREDENTIAL_ADMISSION_CONTRACT_VERSION;
  readonly sourceKind: 'operator-integration-credentials';
  readonly binding: {
    readonly channel: 'agent';
    readonly family: WorkspaceHostCredentialFamily;
    readonly generation: number;
    /** Digest of PUBLIC reference metadata only — never of credential material (D-215). */
    readonly referenceDigest: string;
  };
  readonly observedAt: string;
  readonly verification: {
    readonly contractVersion: typeof WORKSPACE_HOST_AGENT_VERIFICATION_CONTRACT_VERSION;
    readonly observedAt: string;
    readonly allReady: boolean;
    readonly agents: Readonly<Partial<Record<WorkspaceHostCanaryAgent, WorkspaceHostAgentVerificationEvidence>>>;
    /** Agents whose bundle member is intentionally null and therefore has no credential to authenticate. */
    readonly credentialFreeAgents: readonly WorkspaceHostCanaryAgent[];
  };
}

export class WorkspaceHostAgentCredentialAdmissionError extends Error {
  constructor(readonly evidence: WorkspaceHostAgentCredentialAdmissionEvidence) {
    const failed = Object.entries(evidence.verification.agents)
      .filter(([, result]) => !result.ready)
      .map(([agent, result]) => `${agent}:${result.failure ?? 'not-ready'}`);
    super(
      `Workspace-host agent credential generation ${evidence.binding.generation} failed ` +
        `authentication admission (${failed.join(', ') || 'verification-incomplete'})`,
    );
    this.name = 'WorkspaceHostAgentCredentialAdmissionError';
  }
}

/** Validate a receipt before a caller persists or reuses it as an admission decision. */
export function assertWorkspaceHostAgentCredentialAdmissionEvidence(
  evidence: WorkspaceHostAgentCredentialAdmissionEvidence,
): void {
  if (
    evidence.contractVersion !== WORKSPACE_HOST_AGENT_CREDENTIAL_ADMISSION_CONTRACT_VERSION ||
    evidence.sourceKind !== 'operator-integration-credentials' ||
    evidence.binding.channel !== 'agent' ||
    !Number.isSafeInteger(evidence.binding.generation) ||
    evidence.binding.generation < 1 ||
    !evidence.binding.referenceDigest ||
    !Number.isFinite(Date.parse(evidence.observedAt)) ||
    evidence.verification.contractVersion !== WORKSPACE_HOST_AGENT_VERIFICATION_CONTRACT_VERSION ||
    evidence.verification.allReady !== true
  ) {
    throw new Error('workspace-host agent credential admission evidence is incomplete or not ready');
  }
  assertWorkspaceHostSecretIsolation(evidence, 'workspaceHost.agentCredentialAdmission');
}

const FORWARDED_PROBE_ENVIRONMENT = [
  'PATH',
  'LANG',
  'LANGUAGE',
  'LC_ALL',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'NODE_EXTRA_CA_CERTS',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'no_proxy',
] as const;

export interface WorkspaceHostAgentCredentialAdmissionDependencies {
  readonly runner?: WorkspaceHostAgentProbeRunner;
  readonly probes?: ProbeWorkspaceHostAgentsInput['probes'];
  readonly now?: () => Date;
  /** Test seam. Values outside the fixed connectivity allowlist are deliberately discarded. */
  readonly environment?: Readonly<Record<string, string>>;
  readonly temporaryParent?: string;
}

function probeEnvironment(
  home: string,
  supplied: Readonly<Record<string, string | undefined>> = process.env,
): Readonly<Record<string, string>> {
  const environment: Record<string, string> = {};
  for (const name of FORWARDED_PROBE_ENVIRONMENT) {
    const value = supplied[name];
    if (typeof value === 'string' && value.length > 0) environment[name] = value;
  }
  if (!environment.PATH) {
    throw new Error('workspace-host agent credential admission requires a controller PATH');
  }
  const username = userInfo().username;
  return { ...environment, HOME: home, USER: username, LOGNAME: username };
}

async function installTemporaryAgentHome(home: string, material: Buffer): Promise<WorkspaceHostAgentHomeBundle> {
  const bundle = parseWorkspaceHostAgentHomeBundle(material);
  for (const directory of workspaceHostAgentHomeDirectories(home)) {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
  }
  const paths = workspaceHostAgentHomePaths(home);
  for (const agent of Object.keys(paths) as Array<keyof typeof paths>) {
    const bytes = bundle.files[agent];
    if (bytes === null) continue;
    await writeFile(paths[agent], bytes, { flag: 'wx', mode: 0o600 });
  }
  if (bundle.files.omp === null) {
    const modelsPath = workspaceHostAgentHomeOmpModelsPath(home);
    await mkdir(dirname(modelsPath), { recursive: true, mode: 0o700 });
    await writeFile(modelsPath, WORKSPACE_HOST_AGENT_HOME_OMP_LOCAL_MODELS_YML, {
      flag: 'wx',
      mode: 0o600,
    });
  }
  return bundle;
}

/** Authenticate one exact stored agent generation and emit only closed, public evidence. */
export async function verifyWorkspaceHostAgentCredentialAdmission(
  input: WorkspaceHostAgentCredentialAdmissionInput,
  dependencies: WorkspaceHostAgentCredentialAdmissionDependencies = {},
): Promise<WorkspaceHostAgentCredentialAdmissionEvidence> {
  const parsed = parseWorkspaceHostCredentialReference(input.credentialRef.ref, 'agent');
  if (!Number.isSafeInteger(input.delivery.generation) || input.delivery.generation < 1) {
    throw new Error('workspace-host agent credential generation must be a positive safe integer');
  }

  const material = await input.materialSource.resolve({
    channel: 'agent',
    credentialRef: input.credentialRef.ref,
    family: parsed.family,
    generation: input.delivery.generation,
  });
  const materialBytes = material.reveal();
  let temporary: string | undefined;
  let bundle: WorkspaceHostAgentHomeBundle | undefined;
  try {
    temporary = await mkdtemp(join(dependencies.temporaryParent ?? tmpdir(), 'papercusp-agent-admission-'));
    await chmod(temporary, 0o700);
    bundle = await installTemporaryAgentHome(temporary, materialBytes);
    const now = dependencies.now ?? (() => new Date());
    const runner = dependencies.runner ?? new NodeWorkspaceHostAgentProbeRunner();
    const environment = probeEnvironment(temporary, dependencies.environment);
    const agents: Partial<Record<WorkspaceHostCanaryAgent, WorkspaceHostAgentVerificationEvidence>> = {};
    const credentialFreeAgents: WorkspaceHostCanaryAgent[] = [];
    for (const agent of WORKSPACE_HOST_CANARY_AGENTS) {
      if (agent === 'omp' && bundle.files.omp === null) {
        credentialFreeAgents.push(agent);
        continue;
      }
      // A present OMP credential must pass its authenticated-account probe. Falling back to
      // local inference would prove the controller's Ollama runtime while saying nothing about
      // the stored OMP bytes this guard exists to validate.
      const configured =
        dependencies.probes?.[agent] ?? DEFAULT_WORKSPACE_HOST_AGENT_VERIFICATION_PROBES[agent];
      const specs =
        agent === 'omp' ? configured.filter((spec) => spec.verificationKind === 'authenticated-account') : configured;
      if (specs.length === 0) {
        throw new Error(`agent credential admission has no credential-authentication probe for '${agent}'`);
      }
      for (const spec of specs) {
        const result = await probeWorkspaceHostAgentVerification({
          spec,
          runner,
          now,
          env: environment,
          cwd: temporary,
        });
        agents[agent] = result;
        if (result.ready) break;
      }
    }
    const observedAt = now().toISOString();
    const verification = {
      contractVersion: WORKSPACE_HOST_AGENT_VERIFICATION_CONTRACT_VERSION,
      observedAt,
      allReady: WORKSPACE_HOST_CANARY_AGENTS.every(
        (agent) => credentialFreeAgents.includes(agent) || agents[agent]?.ready === true,
      ),
      agents,
      credentialFreeAgents,
    } as const;
    const evidence: WorkspaceHostAgentCredentialAdmissionEvidence = {
      contractVersion: WORKSPACE_HOST_AGENT_CREDENTIAL_ADMISSION_CONTRACT_VERSION,
      sourceKind: 'operator-integration-credentials',
      binding: {
        channel: 'agent',
        family: parsed.family,
        generation: input.delivery.generation,
        referenceDigest: workspaceHostCredentialReferenceDigest(input.credentialRef.ref),
      },
      observedAt,
      verification,
    };
    if (!verification.allReady) throw new WorkspaceHostAgentCredentialAdmissionError(evidence);
    assertWorkspaceHostAgentCredentialAdmissionEvidence(evidence);
    return evidence;
  } finally {
    // This tree contains the only plaintext copy outside the encrypted store. Cleanup failure is
    // therefore allowed to fail the request rather than being swallowed behind a successful probe.
    for (const bytes of bundle ? Object.values(bundle.files) : []) bytes?.fill(0);
    materialBytes.fill(0);
    if (temporary) await rm(temporary, { recursive: true, force: true });
  }
}
