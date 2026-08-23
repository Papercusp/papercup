import { spawn as nodeSpawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHash } from 'node:crypto';

import {
  WORKSPACE_HOST_INITIALIZATION_STEP_KINDS,
  assertWorkspaceHostSecretIsolation,
  type WorkspaceHostInitializationHostOperationResult,
  type WorkspaceHostInitializationHostOperations,
  type WorkspaceHostInitializationStep,
} from '@papercusp/deployment-driver';
import { quotePosixShellArg } from './local-connection-manager';

export const GCP_IAP_INITIALIZATION_PROTOCOL_VERSION = 'papercusp-gcp-iap-initialization-v1';

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_RESPONSE_BYTES = 256 * 1024;
const GCP_NAME = /^[a-z][a-z0-9-]{0,61}[a-z0-9]$/;
const GCP_PROJECT_ID = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/;
const SSH_USER = /^[a-z_][a-z0-9_-]{0,31}$/;
const EXECUTABLE = /^(?:\/[A-Za-z0-9._+-]+)+$|^[A-Za-z0-9._+-]+$/;

export interface GcpIapWorkspaceHostInitializationProfile {
  projectId: string;
  zone: string;
  instanceName: string;
  sshUser: string;
  /** Absolute path to a controller-owned, pre-enrolled known_hosts file. */
  knownHostsFile: string;
  /** Optional explicit OS Login identity; authorization material is never serialized. */
  identityFile?: string;
  /** Fixed binary shipped in the signed workspace-host release. */
  remoteEntrypoint: string;
  sshExecutable?: string;
  gcloudExecutable?: string;
}

export interface GcpIapWorkspaceHostInitializationCommand {
  command: string;
  args: readonly string[];
  stdin: string;
}

export interface GcpIapWorkspaceHostInitializationProcessResult {
  exitCode: number;
  stdout: string;
}

export interface GcpIapWorkspaceHostInitializationCommandRunner {
  run(command: GcpIapWorkspaceHostInitializationCommand): Promise<GcpIapWorkspaceHostInitializationProcessResult>;
}

export interface NodeGcpIapWorkspaceHostInitializationRunnerOptions {
  spawn?: typeof nodeSpawn;
  timeoutMs?: number;
  maxResponseBytes?: number;
}

interface RemoteInitializationResponse {
  protocolVersion: typeof GCP_IAP_INITIALIZATION_PROTOCOL_VERSION;
  stepId: string;
  status: 'succeeded';
  observedAt: string;
  publicEvidence?: Readonly<Record<string, unknown>>;
}

function requireCondition(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function requireGcpName(value: string, label: string): string {
  requireCondition(typeof value === 'string' && GCP_NAME.test(value), `${label} has an invalid value`);
  return value;
}

function requireExecutable(value: string, label: string, absolute = false): string {
  requireCondition(
    typeof value === 'string' && EXECUTABLE.test(value) && (!absolute || value.startsWith('/')),
    `${label} must be ${absolute ? 'an absolute ' : 'a '}single executable path`,
  );
  return value;
}

function requireAbsolutePath(value: string, label: string): string {
  requireCondition(
    typeof value === 'string' && value.startsWith('/') && !/[\0\r\n\s]/.test(value),
    `${label} must be an absolute path without whitespace`,
  );
  return value;
}

function positiveInteger(value: number, label: string): number {
  requireCondition(Number.isSafeInteger(value) && value > 0, `${label} must be a positive safe integer`);
  return value;
}

function hostKeyAlias(profile: GcpIapWorkspaceHostInitializationProfile): string {
  return `gcp-iap-${createHash('sha256')
    .update(`${profile.projectId}\0${profile.zone}\0${profile.instanceName}`)
    .digest('hex')
    .slice(0, 32)}`;
}

/**
 * Build one non-interactive OpenSSH invocation over GCP IAP. The remote side
 * receives one typed request on stdin; no shell script, scp staging, or resolved
 * credential bytes cross this boundary.
 */
export function buildGcpIapWorkspaceHostInitializationCommand(
  profile: GcpIapWorkspaceHostInitializationProfile,
  step: WorkspaceHostInitializationStep,
): GcpIapWorkspaceHostInitializationCommand {
  requireCondition(GCP_PROJECT_ID.test(profile.projectId), 'GCP project id has an invalid value');
  const zone = requireGcpName(profile.zone, 'GCP zone');
  const instanceName = requireGcpName(profile.instanceName, 'GCP instance name');
  requireCondition(SSH_USER.test(profile.sshUser), 'OpenSSH user has an invalid value');
  const knownHostsFile = requireAbsolutePath(profile.knownHostsFile, 'OpenSSH known_hosts file');
  const identityFile = profile.identityFile
    ? requireAbsolutePath(profile.identityFile, 'OpenSSH identity file')
    : undefined;
  const sshExecutable = requireExecutable(profile.sshExecutable ?? 'ssh', 'OpenSSH executable');
  const gcloudExecutable = requireExecutable(profile.gcloudExecutable ?? 'gcloud', 'gcloud executable');
  const remoteEntrypoint = requireExecutable(profile.remoteEntrypoint, 'Remote initializer', true);
  assertWorkspaceHostSecretIsolation(step, `workspaceHost.gcpIap.initialization.${step.id}`);

  const protocolRequest = {
    protocolVersion: GCP_IAP_INITIALIZATION_PROTOCOL_VERSION,
    step,
  };
  assertWorkspaceHostSecretIsolation(protocolRequest, 'workspaceHost.gcpIap.initialization.request');

  const proxyCommand = [
    gcloudExecutable,
    'compute',
    'start-iap-tunnel',
    '%h',
    '%p',
    '--listen-on-stdin',
    `--project=${profile.projectId}`,
    `--zone=${zone}`,
    '--verbosity=error',
  ].join(' ');
  const target = `${profile.sshUser}@${instanceName}`;
  const remoteCommand = [
    remoteEntrypoint,
    '--protocol-version',
    GCP_IAP_INITIALIZATION_PROTOCOL_VERSION,
    '--json-stdin',
  ]
    .map(quotePosixShellArg)
    .join(' ');

  return {
    command: sshExecutable,
    args: [
      '-T',
      '-o',
      'BatchMode=yes',
      '-o',
      'ClearAllForwardings=yes',
      '-o',
      'StrictHostKeyChecking=yes',
      '-o',
      `UserKnownHostsFile=${knownHostsFile}`,
      '-o',
      `HostKeyAlias=${hostKeyAlias(profile)}`,
      ...(identityFile ? ['-o', 'IdentitiesOnly=yes', '-i', identityFile] : []),
      '-o',
      `ProxyCommand=${proxyCommand}`,
      '--',
      target,
      remoteCommand,
    ],
    stdin: `${JSON.stringify(protocolRequest)}\n`,
  };
}

/** Real process runner with bounded output and secret-safe failures. */
export class NodeGcpIapWorkspaceHostInitializationCommandRunner implements GcpIapWorkspaceHostInitializationCommandRunner {
  private readonly spawn: typeof nodeSpawn;
  private readonly timeoutMs: number;
  private readonly maxResponseBytes: number;

  constructor(options: NodeGcpIapWorkspaceHostInitializationRunnerOptions = {}) {
    this.spawn = options.spawn ?? nodeSpawn;
    this.timeoutMs = positiveInteger(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, 'Initialization timeout');
    this.maxResponseBytes = positiveInteger(
      options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES,
      'Initialization response limit',
    );
  }

  async run(
    command: GcpIapWorkspaceHostInitializationCommand,
  ): Promise<GcpIapWorkspaceHostInitializationProcessResult> {
    return await new Promise((resolve, reject) => {
      const child = this.spawn(command.command, command.args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: false,
      }) as ChildProcessWithoutNullStreams;
      const stdout: Buffer[] = [];
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let settled = false;

      const fail = (message: string): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        child.kill('SIGKILL');
        reject(new Error(message));
      };
      const timer = setTimeout(
        () => fail(`GCP IAP initialization timed out after ${this.timeoutMs}ms`),
        this.timeoutMs,
      );
      timer.unref?.();

      child.stdout.on('data', (chunk: Buffer) => {
        stdoutBytes += chunk.byteLength;
        if (stdoutBytes > this.maxResponseBytes) {
          fail('GCP IAP initialization response exceeded the configured limit');
          return;
        }
        stdout.push(chunk);
      });
      child.stderr.on('data', (chunk: Buffer) => {
        stderrBytes += chunk.byteLength;
        if (stderrBytes > this.maxResponseBytes) {
          fail('GCP IAP initialization diagnostic output exceeded the configured limit');
        }
      });
      child.once('error', () => fail('Failed to start GCP IAP initialization transport'));
      child.once('close', (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({
          exitCode: typeof code === 'number' ? code : 1,
          stdout: Buffer.concat(stdout).toString('utf8'),
        });
      });
      child.stdin.once('error', () => fail('Failed to write GCP IAP initialization request'));
      child.stdin.end(command.stdin, 'utf8');
    });
  }
}

function parseResponse(stdout: string, stepId: string): WorkspaceHostInitializationHostOperationResult {
  let candidate: unknown;
  try {
    candidate = JSON.parse(stdout);
  } catch {
    throw new Error('GCP IAP initializer returned invalid JSON');
  }
  requireCondition(
    candidate !== null && typeof candidate === 'object' && !Array.isArray(candidate),
    'GCP IAP initializer returned an invalid response',
  );
  const response = candidate as Partial<RemoteInitializationResponse>;
  requireCondition(
    response.protocolVersion === GCP_IAP_INITIALIZATION_PROTOCOL_VERSION,
    'GCP IAP initializer returned an incompatible protocol version',
  );
  requireCondition(response.stepId === stepId, 'GCP IAP initializer returned a response for another step');
  requireCondition(response.status === 'succeeded', 'GCP IAP initializer did not report success');
  requireCondition(
    typeof response.observedAt === 'string' && Number.isFinite(Date.parse(response.observedAt)),
    'GCP IAP initializer returned an invalid observedAt timestamp',
  );
  requireCondition(
    response.publicEvidence === undefined ||
      (response.publicEvidence !== null &&
        typeof response.publicEvidence === 'object' &&
        !Array.isArray(response.publicEvidence)),
    'GCP IAP initializer returned invalid public evidence',
  );
  assertWorkspaceHostSecretIsolation(
    response.publicEvidence ?? {},
    `workspaceHost.gcpIap.initialization.receipt.${stepId}`,
  );
  return {
    observedAt: response.observedAt,
    ...(response.publicEvidence ? { publicEvidence: response.publicEvidence } : {}),
  };
}

/** Concrete capability-declaring adapter for the signed remote initializer. */
export class GcpIapWorkspaceHostInitializationOperations implements WorkspaceHostInitializationHostOperations {
  readonly supportedStepKinds = WORKSPACE_HOST_INITIALIZATION_STEP_KINDS;

  private readonly profile: GcpIapWorkspaceHostInitializationProfile;
  private readonly runner: GcpIapWorkspaceHostInitializationCommandRunner;

  constructor(
    profile: GcpIapWorkspaceHostInitializationProfile,
    runner: GcpIapWorkspaceHostInitializationCommandRunner = new NodeGcpIapWorkspaceHostInitializationCommandRunner(),
  ) {
    this.profile = profile;
    this.runner = runner;
  }

  async execute(step: WorkspaceHostInitializationStep): Promise<WorkspaceHostInitializationHostOperationResult> {
    const command = buildGcpIapWorkspaceHostInitializationCommand(this.profile, step);
    const result = await this.runner.run(command);
    if (result.exitCode !== 0) {
      throw new Error(`GCP IAP initialization failed with exit code ${result.exitCode}`);
    }
    return parseResponse(result.stdout, step.id);
  }
}
