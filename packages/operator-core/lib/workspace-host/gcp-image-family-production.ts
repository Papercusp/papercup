/**
 * Production composition for the GCP workspace-host image release contract.
 *
 * The contract and its concrete adapter are deliberately dependency-injected so they can be
 * exercised in isolation.  This module is the small, typed seam used by release automation:
 * it binds the persisted connection's project and credential reference, removes forbidden
 * process-global key-file credentials from child commands, and then invokes the real seven-step
 * release executor.  A factory by itself is not a production call path; the exported execute
 * function is the call path consumed by the release CLI.
 */
import { access } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { delimiter, isAbsolute, resolve } from 'node:path';

import type { WorkspaceHostProviderConnection } from '@papercusp/deployment-driver';

import {
  createGcpWorkspaceHostAcquireAuth,
  GCP_GCLOUD_ACTIVE_USER_CREDENTIAL_REF,
  type GcpResolvedAuth,
} from '../cloud-workspaces/gcp-preflight';
import {
  executeGcpImageFamilyRelease,
  type GcpImageFamilyReleaseAdapter,
  type GcpImageFamilyReleaseRequest,
  type GcpImageFamilyReleaseResult,
} from './gcp-image-family';
import {
  createGcpImageFamilyReleaseAdapter,
  NodeGcpImageFamilyCommandRunner,
  type GcpImageFamilyCommand,
  type GcpImageFamilyCommandResult,
  type GcpImageFamilyCommandRunner,
  type GcpImageFamilyReleaseAdapterOptions,
} from './gcp-image-family-adapter';

const GCP_TARGET = 'gcp';
const PROJECT_ID = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/;
const SAFE_CREDENTIAL_REF = /^adc:\/\/[^\s]+$/;
const SAFE_EXECUTABLE = /^[A-Za-z0-9_./:+-]+$/;

/** Executable defaults owned by the image release protocol. */
export const GCP_IMAGE_FAMILY_RELEASE_EXECUTABLES = {
  packer: 'packer',
  scanner: 'papercusp-image-scan',
  /** POST-build canary: boots the built candidate image and proves it self-attests. */
  cleanRoom: 'papercusp-gcp-clean-room',
  /**
   * PRE-build acceptance: boots stock Ubuntu and proves the signed bundle installs and
   * self-attests there. Its report is what the release gate ratifies BEFORE authorizing the
   * image build, which is why it cannot boot the candidate image.
   */
  bootstrapAcceptance: 'papercusp-gcp-bootstrap-acceptance',
} as const;

/**
 * Options accepted by the production composition.  Adapter seams remain injectable for tests,
 * while credential selection is owned by the persisted connection and cannot be overridden by a
 * second, accidentally divergent field.
 */
export interface GcpImageFamilyReleaseCompositionOptions extends Omit<
  GcpImageFamilyReleaseAdapterOptions,
  'credentialRef' | 'acquireAuth' | 'commandRunner' | 'commands' | 'packerRunner'
> {
  /** Optional test seam; production callers should use the connection's reference. */
  commandRunner?: GcpImageFamilyCommandRunner;
  /** Optional auth seam for deterministic tests; production auth is derived from credentialRef. */
  acquireAuth?: () => Promise<GcpResolvedAuth>;
}

export interface GcpImageFamilyReleaseComposition {
  projectId: string;
  credentialRef: string;
  adapter: GcpImageFamilyReleaseAdapter;
}

export interface GcpImageFamilyCredentialProbe {
  ok: boolean;
  projectId: string;
  credentialRef: string;
  identity?: string;
  resolvedProjectId?: string;
  error?: string;
}

function requiredProject(value: unknown, path: string): string {
  if (typeof value !== 'string' || !PROJECT_ID.test(value.trim())) {
    throw new Error(`${path} must be a valid GCP project id`);
  }
  return value.trim();
}

function connectionProject(connection: WorkspaceHostProviderConnection): string {
  if (!connection || connection.target !== GCP_TARGET) {
    throw new Error(`GCP image-family release requires a '${GCP_TARGET}' connection`);
  }
  if (connection.scope && connection.scope.kind !== 'project') {
    throw new Error('GCP image-family connection scope must be a project');
  }
  const scopeProject = connection.scope?.kind === 'project' ? connection.scope.id : undefined;
  const providerProject =
    typeof connection.provider?.projectId === 'string' ? connection.provider.projectId : undefined;
  const projectId = requiredProject(scopeProject ?? providerProject, 'connection.projectId');
  if (scopeProject && providerProject && scopeProject.trim() !== providerProject.trim()) {
    throw new Error('GCP image-family connection project scope and provider project disagree');
  }
  return projectId;
}

function connectionCredentialRef(connection: WorkspaceHostProviderConnection): string {
  const ref = connection.cloudCredentialRef?.ref?.trim();
  if (!ref) throw new Error('GCP image-family connection requires cloudCredentialRef');
  // Local image release is intentionally restricted to the same short-lived Google chains as
  // workspace-host provisioning. Hosted/encrypted references need a hosted resolver and are not
  // silently interpreted as process-global ADC here.
  if (ref !== GCP_GCLOUD_ACTIVE_USER_CREDENTIAL_REF && !SAFE_CREDENTIAL_REF.test(ref)) {
    throw new Error(
      'GCP image-family credentialRef must use adc://<safe-chain> or gcloud://active-user; hosted references require an explicit resolver',
    );
  }
  return ref;
}

/**
 * Child commands must not inherit a service-account key selected by
 * GOOGLE_APPLICATION_CREDENTIALS.  Setting the entries to undefined lets Node omit them from
 * the spawned environment without mutating the parent process.  The gcloud/ADC resolver still
 * supplies short-lived authorization through the selected reference.
 */
export function safeGcpImageFamilyCommandEnvironment(
  env: Readonly<Record<string, string | undefined>> = process.env,
): Readonly<Record<string, string | undefined>> {
  return {
    ...env,
    GOOGLE_APPLICATION_CREDENTIALS: undefined,
    GOOGLE_OAUTH_ACCESS_TOKEN: undefined,
    CLOUDSDK_AUTH_ACCESS_TOKEN: undefined,
  };
}

/** Command runner wrapper that applies the credential-safety environment to every invocation. */
export class CredentialScopedGcpImageFamilyCommandRunner implements GcpImageFamilyCommandRunner {
  constructor(
    private readonly inner: GcpImageFamilyCommandRunner,
    private readonly environment: Readonly<Record<string, string | undefined>> = safeGcpImageFamilyCommandEnvironment(),
  ) {}

  run(
    command: string | GcpImageFamilyCommand,
    args: readonly string[] = [],
    options: Omit<GcpImageFamilyCommand, 'command' | 'args'> = {},
  ): Promise<GcpImageFamilyCommandResult> {
    const callerEnv = typeof command === 'string' ? options.env : command.env;
    const merged = { ...this.environment, ...(callerEnv ?? {}) };
    // A caller may add harmless build variables, but may not re-introduce one of the forbidden
    // process-global token/key channels through the per-call override.
    merged.GOOGLE_APPLICATION_CREDENTIALS = undefined;
    merged.GOOGLE_OAUTH_ACCESS_TOKEN = undefined;
    merged.CLOUDSDK_AUTH_ACCESS_TOKEN = undefined;
    if (typeof command === 'string') {
      return this.inner.run(command, args, { ...options, env: merged });
    }
    return this.inner.run({ ...command, env: merged });
  }

  execute(
    command: string | GcpImageFamilyCommand,
    args?: readonly string[],
    options?: Omit<GcpImageFamilyCommand, 'command' | 'args'>,
  ): Promise<GcpImageFamilyCommandResult> {
    if (this.inner.execute) {
      const callerEnv = typeof command === 'string' ? options?.env : command.env;
      const merged = { ...this.environment, ...(callerEnv ?? {}) };
      merged.GOOGLE_APPLICATION_CREDENTIALS = undefined;
      merged.GOOGLE_OAUTH_ACCESS_TOKEN = undefined;
      merged.CLOUDSDK_AUTH_ACCESS_TOKEN = undefined;
      if (typeof command === 'string') return this.inner.execute(command, args, { ...options, env: merged });
      return this.inner.execute({ ...command, env: merged });
    }
    return this.run(command, args, options);
  }
}

/**
 * Resolve a connection-bound production adapter.  This is intentionally the only constructor
 * used by the release CLI, so a release cannot accidentally fall back to ambient ADC or an
 * unscoped command environment.
 */
export function composeGcpImageFamilyReleaseAdapter(
  connection: WorkspaceHostProviderConnection,
  options: GcpImageFamilyReleaseCompositionOptions = {},
): GcpImageFamilyReleaseComposition {
  const projectId = connectionProject(connection);
  const credentialRef = connectionCredentialRef(connection);
  const acquireAuth =
    options.acquireAuth ??
    createGcpWorkspaceHostAcquireAuth(credentialRef, {
      env: safeGcpImageFamilyCommandEnvironment(),
    });
  const commandRunner = new CredentialScopedGcpImageFamilyCommandRunner(
    options.commandRunner ?? new NodeGcpImageFamilyCommandRunner(),
  );
  const { acquireAuth: _acquireAuth, commandRunner: _commandRunner, ...adapterOptions } = options;
  const adapter = createGcpImageFamilyReleaseAdapter({
    ...adapterOptions,
    acquireAuth,
    credentialRef,
    commandRunner,
  });
  return { projectId, credentialRef, adapter };
}

/**
 * Resolve the connection-bound short-lived credential without exposing the bearer token.  This
 * is intentionally a separate read-only probe so release automation can fail before Packer or
 * any Compute mutation when the selected chain is unavailable.
 */
export async function probeGcpImageFamilyCredential(
  connection: WorkspaceHostProviderConnection,
  options: Pick<GcpImageFamilyReleaseCompositionOptions, 'acquireAuth'> = {},
): Promise<GcpImageFamilyCredentialProbe> {
  const projectId = connectionProject(connection);
  const credentialRef = connectionCredentialRef(connection);
  const acquireAuth =
    options.acquireAuth ??
    createGcpWorkspaceHostAcquireAuth(credentialRef, {
      env: safeGcpImageFamilyCommandEnvironment(),
    });
  try {
    const auth = await acquireAuth();
    if (auth.projectId && auth.projectId !== projectId) {
      return {
        ok: false,
        projectId,
        credentialRef,
        ...(auth.identity ? { identity: auth.identity } : {}),
        resolvedProjectId: auth.projectId,
        error: 'selected credential resolved a different GCP project',
      };
    }
    return {
      ok: true,
      projectId,
      credentialRef,
      ...(auth.identity ? { identity: auth.identity } : {}),
      ...(auth.projectId ? { resolvedProjectId: auth.projectId } : {}),
    };
  } catch (error) {
    return {
      ok: false,
      projectId,
      credentialRef,
      error: error instanceof Error ? error.message : 'GCP credential resolution failed',
    };
  }
}

/**
 * The real production call path.  It binds the connection first, checks that the request targets
 * the same project, and then runs the fail-closed executor with the concrete Google adapter.
 */
export async function executeConfiguredGcpImageFamilyRelease(
  request: GcpImageFamilyReleaseRequest,
  connection: WorkspaceHostProviderConnection,
  options: GcpImageFamilyReleaseCompositionOptions = {},
): Promise<GcpImageFamilyReleaseResult> {
  const composition = composeGcpImageFamilyReleaseAdapter(connection, options);
  const requestProject = requiredProject(request?.projectId, 'request.projectId');
  if (requestProject !== composition.projectId) {
    throw new Error('GCP image-family release request project does not match the selected connection');
  }
  return executeGcpImageFamilyRelease(request, composition.adapter);
}

/**
 * Read-only executable preflight used before a potentially billable release.  It resolves PATH
 * without spawning a shell and reports every missing binary; callers can stop before Packer or a
 * provider mutation starts.
 */
export async function probeGcpImageFamilyExecutables(
  options: Pick<
    GcpImageFamilyReleaseCompositionOptions,
    | 'packerExecutable'
    | 'packerPath'
    | 'scanExecutable'
    | 'scannerExecutable'
    | 'cleanRoomExecutable'
    | 'cleanRoomCommand'
  > = {},
): Promise<{ ok: boolean; executables: Readonly<Record<string, string | null>>; missing: readonly string[] }> {
  const configured = {
    packer: options.packerExecutable ?? options.packerPath ?? GCP_IMAGE_FAMILY_RELEASE_EXECUTABLES.packer,
    scanner: options.scanExecutable ?? options.scannerExecutable ?? GCP_IMAGE_FAMILY_RELEASE_EXECUTABLES.scanner,
    cleanRoom:
      options.cleanRoomExecutable ?? options.cleanRoomCommand ?? GCP_IMAGE_FAMILY_RELEASE_EXECUTABLES.cleanRoom,
  };
  const found: Record<string, string | null> = {};
  const missing: string[] = [];
  for (const [name, raw] of Object.entries(configured)) {
    const executable = String(raw).trim();
    if (!SAFE_EXECUTABLE.test(executable) || executable.includes(' ')) {
      found[name] = null;
      missing.push(name);
      continue;
    }
    const candidates = isAbsolute(executable)
      ? [executable]
      : (process.env.PATH ?? '')
          .split(delimiter)
          .filter(Boolean)
          .map((entry) => resolve(entry, executable));
    // Probe sequentially so the result is deterministic and bounded.
    let selected: string | null = null;
    for (const path of candidates) {
      try {
        await access(path, fsConstants.X_OK);
        selected = path;
        break;
      } catch {
        // Keep looking through PATH entries.
      }
    }
    found[name] = selected;
    if (!selected) missing.push(name);
  }
  return { ok: missing.length === 0, executables: found, missing };
}
