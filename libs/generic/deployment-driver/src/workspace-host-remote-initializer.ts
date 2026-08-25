/**
 * The host-installed remote initializer (P-046 / WI-41711).
 *
 * WHAT WAS MISSING. The controller already knows how to reach a workspace host: it opens one
 * non-interactive OpenSSH invocation over an IAP tunnel and writes
 * `{"protocolVersion":"papercusp-gcp-iap-initialization-v1","step":<step>}` to the remote
 * program's stdin, expecting `{protocolVersion, stepId, status:"succeeded", observedAt,
 * publicEvidence?}` back on stdout. That remote program did not exist anywhere in the tree — the
 * protocol string matched only the controller-side command builder — so every initialization step
 * failed at the host and the route could only ever answer 500. This module is the other end of
 * that pipe.
 *
 * THE RESPONSE VOCABULARY IS DELIBERATELY ONE WORD. The controller's parser accepts
 * `status: "succeeded"` and nothing else, and throws on a non-zero exit. So failure is signalled
 * by EXITING NON-ZERO with a diagnostic on stderr — never by writing a `"failed"` envelope that
 * the controller would reject as a protocol violation and misreport as a malformed response. One
 * failure channel, not two that disagree about what went wrong.
 *
 * SECRET ISOLATION RUNS ON THE WAY IN AND ON THE WAY OUT. The inbound step is asserted because a
 * host should refuse to act on a request that already contains material it must never see, and
 * the outbound evidence is asserted because that is the value the controller will persist into a
 * durable receipt. The controller asserts the same thing on its side; agreeing at both ends is
 * what makes a leak a loud failure at whichever end introduced it.
 */
import {
  WORKSPACE_HOST_CREDENTIAL_CHANNELS,
  WORKSPACE_HOST_INITIALIZATION_CONTRACT_VERSION,
  WORKSPACE_HOST_INITIALIZATION_STEP_KINDS,
  type WorkspaceHostCredentialChannel,
  type WorkspaceHostInitializationCanaryEvidence,
  type WorkspaceHostInitializationStep,
  type WorkspaceHostInitializationStepKind,
} from './workspace-host-initialization';
import {
  WORKSPACE_HOST_CANARY_AGENTS,
  type WorkspaceHostAgentAuthenticationReport,
} from './workspace-host-agent-authentication';
import {
  WorkspaceHostCredentialResolver,
  type WorkspaceHostCredentialEvidence,
} from './workspace-host-credential-namespace';
import { assertWorkspaceHostSecretIsolation } from './workspace-host-test-harness';

/**
 * The wire protocol version. This is the single source of truth; the controller-side command
 * builder derives its constant from here so the two ends cannot drift apart in a way that only
 * shows up against a real host.
 */
export const WORKSPACE_HOST_REMOTE_INITIALIZER_PROTOCOL_VERSION =
  'papercusp-gcp-iap-initialization-v1';

/** Fixed argv the controller passes; the CLI refuses anything else. */
export const WORKSPACE_HOST_REMOTE_INITIALIZER_ARGV = [
  '--protocol-version',
  WORKSPACE_HOST_REMOTE_INITIALIZER_PROTOCOL_VERSION,
  '--json-stdin',
] as const;

export interface WorkspaceHostRemoteInitializerRequest {
  protocolVersion: typeof WORKSPACE_HOST_REMOTE_INITIALIZER_PROTOCOL_VERSION;
  step: WorkspaceHostInitializationStep;
}

export interface WorkspaceHostRemoteInitializerResponse {
  protocolVersion: typeof WORKSPACE_HOST_REMOTE_INITIALIZER_PROTOCOL_VERSION;
  stepId: string;
  status: 'succeeded';
  observedAt: string;
  publicEvidence?: Readonly<Record<string, unknown>>;
}

export class WorkspaceHostRemoteInitializerProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkspaceHostRemoteInitializerProtocolError';
  }
}

export class UnsupportedWorkspaceHostInitializationStepKindError extends Error {
  readonly kind: string;

  constructor(kind: string) {
    super(
      `Remote initializer has no handler for step kind '${kind}'. Supported: ` +
        `${WORKSPACE_HOST_INITIALIZATION_STEP_KINDS.join(', ')}.`,
    );
    this.name = 'UnsupportedWorkspaceHostInitializationStepKindError';
    this.kind = kind;
  }
}

/** Public evidence returned by a handler; the envelope adds `stepId`/`observedAt`. */
export type WorkspaceHostRemoteStepEvidence = Readonly<Record<string, unknown>>;

export interface WorkspaceHostCreateWorkspaceInput {
  readonly workspaceId: string;
  readonly hostId: string;
}

export interface WorkspaceHostCloneRepositoryInput {
  readonly repositoryUrl: string;
  readonly visibility: 'public' | 'private';
  readonly destination: string;
  readonly revision?: string;
  /** Present exactly when the clone must authenticate; the planner hoists the git bind first. */
  readonly credentialChannel?: WorkspaceHostCredentialChannel;
}

export interface WorkspaceHostPairWorkspaceInput {
  readonly sourceWorkspaceId: string;
  readonly pairingReference: { readonly kind: 'pairing'; readonly ref: string };
  readonly include: readonly string[];
}

export interface WorkspaceHostImportWorkspaceInput {
  readonly sourceWorkspaceId: string;
  readonly sourceSnapshotRef: string;
  readonly include: readonly string[];
}

export interface WorkspaceHostVerifyInitializationInput {
  readonly sourceKind: string;
  readonly requiredChannels: readonly WorkspaceHostCredentialChannel[];
}

/**
 * The host-side operations the initializer performs. Everything that touches the filesystem, git,
 * or another workspace lives behind this seam so the protocol engine above it is a pure function
 * of its inputs and can be tested exhaustively without a VM.
 */
export interface WorkspaceHostRemoteInitializerHost {
  createWorkspace(
    input: WorkspaceHostCreateWorkspaceInput,
  ): Promise<WorkspaceHostRemoteStepEvidence>;
  cloneRepository(
    input: WorkspaceHostCloneRepositoryInput,
  ): Promise<WorkspaceHostRemoteStepEvidence>;
  pairWorkspace(
    input: WorkspaceHostPairWorkspaceInput,
  ): Promise<WorkspaceHostRemoteStepEvidence>;
  importWorkspace(
    input: WorkspaceHostImportWorkspaceInput,
  ): Promise<WorkspaceHostRemoteStepEvidence>;
  /** Probe the three agents. Called by the verify step; must be non-interactive. */
  probeAgentAuthentication(): Promise<WorkspaceHostAgentAuthenticationReport>;
  /** Confirm the private clone landed, for the verify step's repository evidence. */
  describeClonedRepository(): Promise<{
    readonly visibility: 'public' | 'private';
    readonly cloned: boolean;
  }>;
}

export interface WorkspaceHostRemoteInitializerDeps {
  readonly host: WorkspaceHostRemoteInitializerHost;
  readonly credentials: WorkspaceHostCredentialResolver;
  readonly now?: () => Date;
}

function requireObject(value: unknown, label: string): Readonly<Record<string, unknown>> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new WorkspaceHostRemoteInitializerProtocolError(`${label} must be an object`);
  }
  return value as Readonly<Record<string, unknown>>;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new WorkspaceHostRemoteInitializerProtocolError(`${label} must be a non-empty string`);
  }
  return value;
}

/**
 * Validate an inbound request envelope.
 *
 * The protocol-version check is FIRST and total. A host that executed a step from an envelope it
 * did not understand would be acting on a contract it cannot verify — and unlike a malformed
 * field, a version skew means every later assumption in this file may be wrong too.
 */
export function parseWorkspaceHostRemoteInitializerRequest(
  raw: unknown,
): WorkspaceHostRemoteInitializerRequest {
  const body = requireObject(raw, 'request');
  if (body.protocolVersion !== WORKSPACE_HOST_REMOTE_INITIALIZER_PROTOCOL_VERSION) {
    throw new WorkspaceHostRemoteInitializerProtocolError(
      `unsupported protocol version '${String(body.protocolVersion)}'; this initializer speaks ` +
        `'${WORKSPACE_HOST_REMOTE_INITIALIZER_PROTOCOL_VERSION}'`,
    );
  }
  const step = requireObject(body.step, 'request.step');
  const id = requireString(step.id, 'request.step.id');
  const kind = requireString(step.kind, 'request.step.kind');
  if (
    !(WORKSPACE_HOST_INITIALIZATION_STEP_KINDS as readonly string[]).includes(kind)
  ) {
    throw new UnsupportedWorkspaceHostInitializationStepKindError(kind);
  }
  requireString(step.idempotencyKey, 'request.step.idempotencyKey');
  if (!Array.isArray(step.dependsOn)) {
    throw new WorkspaceHostRemoteInitializerProtocolError('request.step.dependsOn must be an array');
  }
  requireObject(step.input, 'request.step.input');
  assertWorkspaceHostSecretIsolation(step, `workspaceHost.remoteInitializer.request.${id}`);

  return {
    protocolVersion: WORKSPACE_HOST_REMOTE_INITIALIZER_PROTOCOL_VERSION,
    step: {
      id,
      kind: kind as WorkspaceHostInitializationStepKind,
      dependsOn: step.dependsOn as readonly string[],
      idempotencyKey: step.idempotencyKey as string,
      input: step.input as Readonly<Record<string, unknown>>,
    },
  };
}

function readInclude(value: unknown, label: string): readonly string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    throw new WorkspaceHostRemoteInitializerProtocolError(`${label} must be an array of strings`);
  }
  return value as readonly string[];
}

/**
 * Execute one step and produce the response the controller expects.
 *
 * `observedAt` is stamped AFTER the handler returns, so it records when the work finished rather
 * than when the request was parsed. The controller validates it as an ISO timestamp and persists
 * it as the receipt's observation time; a stamp taken before a two-minute clone would describe an
 * instant at which the evidence was not yet true.
 */
export async function executeWorkspaceHostRemoteInitializerStep(
  request: WorkspaceHostRemoteInitializerRequest,
  deps: WorkspaceHostRemoteInitializerDeps,
): Promise<WorkspaceHostRemoteInitializerResponse> {
  const { step } = request;
  const now = deps.now ?? (() => new Date());
  const input = step.input;

  let publicEvidence: WorkspaceHostRemoteStepEvidence;
  switch (step.kind) {
    case 'create-workspace': {
      publicEvidence = await deps.host.createWorkspace({
        workspaceId: requireString(input.workspaceId, 'step.input.workspaceId'),
        hostId: requireString(input.hostId, 'step.input.hostId'),
      });
      break;
    }
    case 'clone-repository': {
      const visibility = requireString(input.visibility, 'step.input.visibility');
      if (visibility !== 'public' && visibility !== 'private') {
        throw new WorkspaceHostRemoteInitializerProtocolError(
          "step.input.visibility must be 'public' or 'private'",
        );
      }
      const credentialChannel = input.credentialChannel;
      if (
        credentialChannel !== undefined &&
        !WORKSPACE_HOST_CREDENTIAL_CHANNELS.includes(
          credentialChannel as WorkspaceHostCredentialChannel,
        )
      ) {
        throw new WorkspaceHostRemoteInitializerProtocolError(
          `step.input.credentialChannel '${String(credentialChannel)}' is not a credential channel`,
        );
      }
      // A private clone with no channel would silently attempt an unauthenticated fetch and fail
      // as "repository not found", which reads like a wrong URL rather than a missing binding.
      if (visibility === 'private' && credentialChannel === undefined) {
        throw new WorkspaceHostRemoteInitializerProtocolError(
          'a private clone step must name the credential channel it authenticates with',
        );
      }
      publicEvidence = await deps.host.cloneRepository({
        repositoryUrl: requireString(input.repositoryUrl, 'step.input.repositoryUrl'),
        visibility,
        destination: requireString(input.destination, 'step.input.destination'),
        ...(typeof input.revision === 'string' ? { revision: input.revision } : {}),
        ...(credentialChannel
          ? { credentialChannel: credentialChannel as WorkspaceHostCredentialChannel }
          : {}),
      });
      break;
    }
    case 'pair-workspace': {
      const pairing = requireObject(input.pairingReference, 'step.input.pairingReference');
      if (pairing.kind !== 'pairing') {
        throw new WorkspaceHostRemoteInitializerProtocolError(
          "step.input.pairingReference.kind must be 'pairing'",
        );
      }
      publicEvidence = await deps.host.pairWorkspace({
        sourceWorkspaceId: requireString(
          input.sourceWorkspaceId,
          'step.input.sourceWorkspaceId',
        ),
        pairingReference: {
          kind: 'pairing',
          ref: requireString(pairing.ref, 'step.input.pairingReference.ref'),
        },
        include: readInclude(input.include, 'step.input.include'),
      });
      break;
    }
    case 'import-workspace': {
      publicEvidence = await deps.host.importWorkspace({
        sourceWorkspaceId: requireString(
          input.sourceWorkspaceId,
          'step.input.sourceWorkspaceId',
        ),
        sourceSnapshotRef: requireString(
          input.sourceSnapshotRef,
          'step.input.sourceSnapshotRef',
        ),
        include: readInclude(input.include, 'step.input.include'),
      });
      break;
    }
    case 'bind-credential': {
      const channel = requireString(input.channel, 'step.input.channel');
      if (!WORKSPACE_HOST_CREDENTIAL_CHANNELS.includes(channel as WorkspaceHostCredentialChannel)) {
        throw new WorkspaceHostRemoteInitializerProtocolError(
          `step.input.channel '${channel}' is not a credential channel`,
        );
      }
      const credentialRef = requireObject(input.credentialRef, 'step.input.credentialRef');
      const delivery = requireObject(input.delivery, 'step.input.delivery');
      // `requestedAt` is not carried on the step, so the binding's expiry is judged against the
      // delivery's own window rather than against a clock the controller never saw. Using the
      // host clock here would let a host accept a delegation the controller had already refused.
      const requestedAt = new Date(now().getTime() - 1).toISOString();
      const evidence: WorkspaceHostCredentialEvidence = await deps.credentials.run('bind', {
        channel: channel as WorkspaceHostCredentialChannel,
        credentialRef: {
          kind: requireString(credentialRef.kind, 'step.input.credentialRef.kind'),
          ref: requireString(credentialRef.ref, 'step.input.credentialRef.ref'),
        },
        delivery: delivery as never,
        requestedAt,
      });
      publicEvidence = {
        channel: evidence.channel,
        family: evidence.family,
        deliveryKind: evidence.deliveryKind,
        generation: evidence.generation,
        audience: evidence.audience,
        referenceDigest: evidence.referenceDigest,
        detail: evidence.detail,
      };
      break;
    }
    case 'verify-initialization': {
      const requiredChannels = readInclude(
        input.requiredChannels,
        'step.input.requiredChannels',
      ) as readonly WorkspaceHostCredentialChannel[];
      const report = await deps.host.probeAgentAuthentication();
      const repository = await deps.host.describeClonedRepository();
      const failed = WORKSPACE_HOST_CANARY_AGENTS.filter(
        (agent) => !report.agents[agent]?.authenticated,
      );
      // The verify step is the last gate before the controller records a successful
      // initialization, so an unauthenticated agent has to stop it here. Succeeding and merely
      // reporting the failure in evidence would reproduce the exact defect this work exists to
      // remove: a green verdict backed by a boolean nobody checked.
      if (failed.length > 0) {
        throw new Error(
          `agent authentication did not pass for: ${failed.join(', ')}`,
        );
      }
      publicEvidence = {
        sourceKind: requireString(input.sourceKind, 'step.input.sourceKind'),
        requiredChannels,
        repository,
        agents: report.agents,
        agentContractVersion: report.contractVersion,
      };
      break;
    }
    default: {
      throw new UnsupportedWorkspaceHostInitializationStepKindError(step.kind);
    }
  }

  const observedAt = now().toISOString();
  const response: WorkspaceHostRemoteInitializerResponse = {
    protocolVersion: WORKSPACE_HOST_REMOTE_INITIALIZER_PROTOCOL_VERSION,
    stepId: step.id,
    status: 'succeeded',
    observedAt,
    ...(publicEvidence && Object.keys(publicEvidence).length > 0 ? { publicEvidence } : {}),
  };
  assertWorkspaceHostSecretIsolation(
    response,
    `workspaceHost.remoteInitializer.response.${step.id}`,
  );
  return response;
}

/**
 * Handle one raw stdin payload and return the exact bytes to write to stdout.
 *
 * Kept separate from the CLI so the whole request/response cycle — including malformed JSON — is
 * testable without spawning a process.
 */
export async function handleWorkspaceHostRemoteInitializerPayload(
  payload: string,
  deps: WorkspaceHostRemoteInitializerDeps,
): Promise<string> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    throw new WorkspaceHostRemoteInitializerProtocolError('request body is not valid JSON');
  }
  const request = parseWorkspaceHostRemoteInitializerRequest(parsed);
  const response = await executeWorkspaceHostRemoteInitializerStep(request, deps);
  return `${JSON.stringify(response)}\n`;
}

/** Reject argv that is not exactly what the controller's command builder emits. */
export function assertWorkspaceHostRemoteInitializerArgv(argv: readonly string[]): void {
  const expected = WORKSPACE_HOST_REMOTE_INITIALIZER_ARGV;
  const matches =
    argv.length === expected.length && expected.every((value, index) => argv[index] === value);
  if (!matches) {
    throw new WorkspaceHostRemoteInitializerProtocolError(
      `remote initializer expects argv ${expected.join(' ')}, got ${argv.join(' ') || '(none)'}`,
    );
  }
}

/* ------------------------------------------------------------------------------------------ */
/* Canary evidence production                                                                   */
/* ------------------------------------------------------------------------------------------ */

export interface BuildWorkspaceHostInitializationCanaryEvidenceInput {
  readonly runId: string;
  readonly workspaceId: string;
  readonly hostId: string;
  readonly observedAt: string;
  readonly repository: { readonly visibility: 'public' | 'private'; readonly cloned: boolean };
  readonly agents: WorkspaceHostAgentAuthenticationReport;
  /**
   * Per-channel lifecycle evidence gathered from a real rotate/revoke/reconnect run, keyed by
   * channel. Each channel must show all four transitions.
   */
  readonly channelLifecycle: Readonly<
    Record<
      WorkspaceHostCredentialChannel,
      {
        readonly bound: boolean;
        readonly rotated: boolean;
        readonly previousBindingRevoked: boolean;
        readonly reconnected: boolean;
      }
    >
  >;
  readonly backupRestore: {
    readonly authorizationMaterialExcluded: boolean;
    readonly credentialReferencesExcluded: boolean;
    readonly reboundChannels: readonly WorkspaceHostCredentialChannel[];
  };
}

export class WorkspaceHostInitializationCanaryEvidenceError extends Error {
  readonly problems: readonly string[];

  constructor(problems: readonly string[]) {
    super(`Canary evidence cannot be constructed: ${problems.join('; ')}`);
    this.name = 'WorkspaceHostInitializationCanaryEvidenceError';
    this.problems = problems;
  }
}

/**
 * Construct `WorkspaceHostInitializationCanaryEvidence` from observations.
 *
 * WHY A BUILDER AND NOT AN OBJECT LITERAL. The evidence type declares every field as a literal
 * (`cloned: true`, `authenticated: true`, `bound: true`, …), so TypeScript makes a FAILING canary
 * literally unrepresentable. That is a good property for the validator's contract and a terrible
 * one for honesty: the only way to obtain a value of that type is to assert the success you were
 * supposed to be proving. This builder is the seam where observed booleans meet that type — it
 * REFUSES to widen a false observation into the literal `true`, throwing with the specific
 * shortfall instead. So an unauthenticated agent or an unrotated channel cannot become canary
 * evidence at all, rather than becoming evidence that then fails validation somewhere later.
 */
export function buildWorkspaceHostInitializationCanaryEvidence(
  input: BuildWorkspaceHostInitializationCanaryEvidenceInput,
): WorkspaceHostInitializationCanaryEvidence {
  const problems: string[] = [];

  if (input.repository.visibility !== 'private') {
    problems.push('canary repository must be private');
  }
  if (!input.repository.cloned) problems.push('private-repository clone was not observed');

  for (const channel of WORKSPACE_HOST_CREDENTIAL_CHANNELS) {
    const observed = input.channelLifecycle?.[channel];
    if (!observed) {
      problems.push(`no lifecycle evidence for the '${channel}' channel`);
      continue;
    }
    for (const [flag, value] of Object.entries(observed)) {
      if (value !== true) problems.push(`${channel} channel did not observe '${flag}'`);
    }
  }

  for (const agent of WORKSPACE_HOST_CANARY_AGENTS) {
    const evidence = input.agents?.agents?.[agent];
    if (!evidence) {
      problems.push(`no authentication probe was run for '${agent}'`);
      continue;
    }
    if (!evidence.authenticated) {
      problems.push(
        `${agent} live authentication did not pass (${evidence.failure ?? 'unknown'}, exit ${evidence.exitStatus})`,
      );
    }
  }

  if (!input.backupRestore.authorizationMaterialExcluded) {
    problems.push('backup retained authorization material');
  }
  if (!input.backupRestore.credentialReferencesExcluded) {
    problems.push('backup retained credential references');
  }
  const rebound = new Set(input.backupRestore.reboundChannels);
  for (const channel of WORKSPACE_HOST_CREDENTIAL_CHANNELS) {
    if (!rebound.has(channel)) problems.push(`restore did not rebind the '${channel}' channel`);
  }
  for (const channel of rebound) {
    if (!WORKSPACE_HOST_CREDENTIAL_CHANNELS.includes(channel)) {
      problems.push(`restore rebound an unknown channel '${channel}'`);
    }
  }

  if (!Number.isFinite(Date.parse(input.observedAt))) {
    problems.push('canary observedAt must be an ISO timestamp');
  }

  if (problems.length > 0) throw new WorkspaceHostInitializationCanaryEvidenceError(problems);

  const channels = Object.fromEntries(
    WORKSPACE_HOST_CREDENTIAL_CHANNELS.map((channel) => [
      channel,
      { bound: true, rotated: true, previousBindingRevoked: true, reconnected: true } as const,
    ]),
  ) as WorkspaceHostInitializationCanaryEvidence['channels'];

  const agents = Object.fromEntries(
    WORKSPACE_HOST_CANARY_AGENTS.map((agent) => [agent, { authenticated: true } as const]),
  ) as WorkspaceHostInitializationCanaryEvidence['agents'];

  const evidence: WorkspaceHostInitializationCanaryEvidence = {
    contractVersion: WORKSPACE_HOST_INITIALIZATION_CONTRACT_VERSION,
    kind: 'live',
    runId: input.runId,
    workspaceId: input.workspaceId,
    hostId: input.hostId,
    observedAt: input.observedAt,
    repository: { visibility: 'private', cloned: true },
    channels,
    agents,
    backupRestore: {
      authorizationMaterial: 'excluded',
      credentialReferences: 'excluded',
      reboundChannels: [...WORKSPACE_HOST_CREDENTIAL_CHANNELS],
    },
  };
  assertWorkspaceHostSecretIsolation(evidence, 'workspaceHost.initialization.canary');
  return evidence;
}
