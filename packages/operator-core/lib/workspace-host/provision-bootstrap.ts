/**
 * Server-side render of the workspace-host bootstrap at PROVISION time (P-046 / D-237, D-238).
 *
 * A provisioned host used to receive only the durable-filesystem mount. Nothing delivered the
 * bootstrap, so the instance came up with no privileged conduits, no `papercusp-workspace`
 * service and no reachable SSH account — and it did so SILENTLY, because provisioning itself
 * succeeded. The clean-room fixture was the bootstrap's only producer in the entire tree.
 *
 * This module is that missing producer, and three properties define it:
 *
 * 1. IT IS CONTROLLER-OWNED, NOT CALLER-SUPPLIED. The rendered script pins the release
 *    `bundleUrl`/`bundleSha256`/`signingPublicKey` AND the OpenSSH public key authorized for the
 *    workspace SSH account. Naming any of those chooses which code the host installs and who may
 *    log into it, so the provider REFUSES `desired.provider.startupScript` and reads the render
 *    off the provider context instead. Every input here comes from controller deployment
 *    configuration or the controller's own SSH identity; no per-host row can redirect one.
 *
 * 2. THE AUTHORIZED KEY IS THE CONTROLLER'S OWN PUBLIC KEY. The controller's initialization
 *    profile already names the private `identityFile` it will connect WITH; the host must
 *    authorize the matching public half or initialization cannot reach it. Deriving the key from
 *    that same profile — rather than accepting a second, independently configured value — is what
 *    makes "provisioned" and "reachable by the controller" the same fact instead of two settings
 *    that can disagree. D-238 is precisely what their disagreement costs.
 *
 * 3. IT FAILS CLOSED, LOUDLY, CONTROLLER-SIDE. A provision that cannot render a trusted bootstrap
 *    must refuse rather than create a host. The alternative is not "a host without a bootstrap" —
 *    it is a billing, unreachable brick whose provisioning operation reports success, which is
 *    the exact two-day failure this module exists to end. Every problem is collected and reported
 *    together so a half-configured controller names all of its gaps once.
 */
import { isAbsolute } from 'node:path';
import { readFile } from 'node:fs/promises';
import {
  WORKSPACE_HOST_BOOTSTRAP_CONTRACT_VERSION,
  buildWorkspaceHostBootstrap,
  validateWorkspaceHostImageArtifact,
  type WorkspaceHostBootstrapRelease,
  type WorkspaceHostBootstrapService,
  type WorkspaceHostImageArtifact,
} from '@papercusp/deployment-driver';
import {
  resolveWorkspaceHostInitializationControllerProfile,
  type WorkspaceHostInitializationControllerProfile,
} from './initialization-operations-resolver';

/**
 * Controller deployment configuration. These mirror `CONTROLLER_ENV` in the initialization
 * resolver deliberately: same ownership story, same absolute-path discipline, same
 * collect-every-problem reporting.
 */
export const WORKSPACE_HOST_PROVISION_ENV = {
  /** Absolute path to the published `manifest.json` naming the release to install. */
  releaseManifestFile: 'PAPERCUSP_WORKSPACE_HOST_RELEASE_MANIFEST',
  /** Durable migration identity expected after the bundled migration command succeeds. */
  migrationId: 'PAPERCUSP_WORKSPACE_HOST_MIGRATION_ID',
  minimumNodeMajor: 'PAPERCUSP_WORKSPACE_HOST_MINIMUM_NODE_MAJOR',
  serviceName: 'PAPERCUSP_WORKSPACE_HOST_SERVICE_NAME',
  servicePort: 'PAPERCUSP_WORKSPACE_HOST_SERVICE_PORT',
} as const;

export const DEFAULT_WORKSPACE_HOST_SERVICE_NAME = 'papercusp-workspace';
export const DEFAULT_WORKSPACE_HOST_SERVICE_PORT = 3070;
export const DEFAULT_WORKSPACE_HOST_MINIMUM_NODE_MAJOR = 22;

/** Everything the render needs, with every value already validated. */
export interface WorkspaceHostProvisionBootstrapProfile {
  release: WorkspaceHostBootstrapRelease;
  migrationId: string;
  minimumNodeMajor: number;
  service: WorkspaceHostBootstrapService;
  /** Non-empty. The controller's own SSH public key(s). */
  workspaceAuthorizedKeys: readonly string[];
}

/** Raised when the controller cannot render a trusted bootstrap for a provision. */
export class WorkspaceHostProvisionBootstrapProfileError extends Error {
  readonly problems: readonly string[];

  constructor(problems: readonly string[]) {
    super(
      'Workspace-host provision bootstrap cannot be rendered; provisioning would create an ' +
        `unreachable host: ${problems.join('; ')}`,
    );
    this.name = 'WorkspaceHostProvisionBootstrapProfileError';
    this.problems = problems;
  }
}

export interface ResolveWorkspaceHostProvisionBootstrapProfileInput {
  env?: Readonly<Record<string, string | undefined>>;
  /** Test seam; production reads the real filesystem. */
  readTextFile?: (path: string) => Promise<string>;
  /**
   * Test seam. Production derives it from the controller's initialization profile, so the key the
   * host authorizes is by construction the key the controller connects with.
   */
  controllerProfile?: WorkspaceHostInitializationControllerProfile;
}

/**
 * The controller's OWN public key, read from `${identityFile}.pub`.
 *
 * The `.pub` sibling is OpenSSH's own convention and is what `ssh-keygen` writes, so this reads
 * the key the controller already has rather than introducing a second place to configure one.
 * A controller with no `identityFile` cannot authorize anything, and saying so here is better
 * than rendering a bootstrap whose authorized-keys file is empty — `harden-os` would then lock
 * the host to publickey-only for an account with no key, which is D-238 exactly.
 */
export async function resolveWorkspaceHostControllerAuthorizedKeys(
  profile: WorkspaceHostInitializationControllerProfile,
  readTextFile: (path: string) => Promise<string> = (path) => readFile(path, 'utf8'),
): Promise<{ keys: readonly string[]; problems: readonly string[] }> {
  const identityFile = profile.identityFile;
  if (!identityFile) {
    return {
      keys: [],
      problems: [
        'controller has no identityFile, so no public key can be authorized on the host ' +
          '(set PAPERCUSP_WORKSPACE_HOST_IDENTITY_FILE)',
      ],
    };
  }
  const publicKeyFile = `${identityFile}.pub`;
  let contents: string;
  try {
    contents = await readTextFile(publicKeyFile);
  } catch (error) {
    return {
      keys: [],
      problems: [`controller public key '${publicKeyFile}' could not be read: ${message(error)}`],
    };
  }
  const keys = contents
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'));
  if (keys.length === 0) {
    return { keys: [], problems: [`controller public key '${publicKeyFile}' is empty`] };
  }
  return { keys, problems: [] };
}

/**
 * Build the controller's provision profile, or throw naming every gap.
 *
 * The release is read from the published manifest and validated with
 * `validateWorkspaceHostImageArtifact` — the SAME validator that admits a release everywhere
 * else, so the provision surface cannot drift away from the surface that accepts one. That
 * validator already proves `signingKeySha256 === sha256(signingPublicKey)` and that the release
 * version matches the image, which is why this function does not restate those checks.
 */
export async function resolveWorkspaceHostProvisionBootstrapProfile(
  input: ResolveWorkspaceHostProvisionBootstrapProfileInput = {},
): Promise<WorkspaceHostProvisionBootstrapProfile> {
  const env = input.env ?? process.env;
  const readTextFile = input.readTextFile ?? ((path: string) => readFile(path, 'utf8'));
  const problems: string[] = [];

  const manifestPath = (env[WORKSPACE_HOST_PROVISION_ENV.releaseManifestFile] ?? '').trim();
  let release: WorkspaceHostBootstrapRelease | undefined;
  if (!manifestPath) {
    problems.push(`${WORKSPACE_HOST_PROVISION_ENV.releaseManifestFile} is not set`);
  } else if (!isAbsolute(manifestPath)) {
    // Same reasoning as the controller trust store: a relative path resolves against whatever
    // working directory the controller happened to start in, which makes the release a function
    // of how the process was launched.
    problems.push(
      `${WORKSPACE_HOST_PROVISION_ENV.releaseManifestFile} must be an absolute path (got '${manifestPath}')`,
    );
  } else {
    release = await readRelease(manifestPath, readTextFile, problems);
  }

  const migrationId = (env[WORKSPACE_HOST_PROVISION_ENV.migrationId] ?? '').trim();
  if (!migrationId) problems.push(`${WORKSPACE_HOST_PROVISION_ENV.migrationId} is not set`);

  const minimumNodeMajor = readInteger(
    env[WORKSPACE_HOST_PROVISION_ENV.minimumNodeMajor],
    WORKSPACE_HOST_PROVISION_ENV.minimumNodeMajor,
    DEFAULT_WORKSPACE_HOST_MINIMUM_NODE_MAJOR,
    problems,
  );
  const servicePort = readInteger(
    env[WORKSPACE_HOST_PROVISION_ENV.servicePort],
    WORKSPACE_HOST_PROVISION_ENV.servicePort,
    DEFAULT_WORKSPACE_HOST_SERVICE_PORT,
    problems,
  );
  const serviceName =
    (env[WORKSPACE_HOST_PROVISION_ENV.serviceName] ?? '').trim() || DEFAULT_WORKSPACE_HOST_SERVICE_NAME;

  let controllerProfile = input.controllerProfile;
  if (!controllerProfile) {
    try {
      controllerProfile = resolveWorkspaceHostInitializationControllerProfile(env);
    } catch (error) {
      problems.push(`controller initialization profile is unusable: ${message(error)}`);
    }
  }
  let workspaceAuthorizedKeys: readonly string[] = [];
  if (controllerProfile) {
    const resolved = await resolveWorkspaceHostControllerAuthorizedKeys(controllerProfile, readTextFile);
    workspaceAuthorizedKeys = resolved.keys;
    problems.push(...resolved.problems);
  }

  if (problems.length > 0 || !release) {
    throw new WorkspaceHostProvisionBootstrapProfileError(
      problems.length > 0 ? problems : ['release could not be resolved'],
    );
  }

  return {
    release,
    migrationId,
    minimumNodeMajor,
    service: { name: serviceName, port: servicePort },
    workspaceAuthorizedKeys,
  };
}

/**
 * Render the install bootstrap for one host.
 *
 * Separate from resolution so the expensive, IO-bound profile can be resolved once per operation
 * while the render stays a pure function of (hostId, profile) — which is also what makes the
 * rendered script reproducible for a given controller configuration.
 */
export function renderWorkspaceHostProvisionBootstrap(
  hostId: string,
  profile: WorkspaceHostProvisionBootstrapProfile,
): string {
  return buildWorkspaceHostBootstrap({
    contractVersion: WORKSPACE_HOST_BOOTSTRAP_CONTRACT_VERSION,
    action: 'install',
    hostId,
    release: profile.release,
    migrationId: profile.migrationId,
    minimumNodeMajor: profile.minimumNodeMajor,
    service: profile.service,
    workspaceAuthorizedKeys: profile.workspaceAuthorizedKeys,
  });
}

async function readRelease(
  manifestPath: string,
  readTextFile: (path: string) => Promise<string>,
  problems: string[],
): Promise<WorkspaceHostBootstrapRelease | undefined> {
  let raw: string;
  try {
    raw = await readTextFile(manifestPath);
  } catch (error) {
    problems.push(`release manifest '${manifestPath}' could not be read: ${message(error)}`);
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    problems.push(`release manifest '${manifestPath}' is not valid JSON: ${message(error)}`);
    return undefined;
  }
  const artifact = (parsed as { artifact?: unknown } | null)?.artifact;
  if (!artifact || typeof artifact !== 'object') {
    problems.push(`release manifest '${manifestPath}' has no 'artifact' object`);
    return undefined;
  }
  // The validator is fed UNTRUSTED file bytes here, unlike its in-process callers who hand it an
  // artifact they just built. It reaches into nested build-manifest structure, so a
  // partially-shaped document makes it throw rather than return errors. A throw escaping this
  // function would surface as a bare TypeError instead of the fail-closed, named refusal the rest
  // of this module promises — so an unparseable manifest is reported as what it is.
  let errors: readonly string[];
  try {
    errors = validateWorkspaceHostImageArtifact(artifact as WorkspaceHostImageArtifact);
  } catch (error) {
    problems.push(`release manifest '${manifestPath}' is not a valid image artifact: ${message(error)}`);
    return undefined;
  }
  if (errors.length > 0) {
    problems.push(`release manifest '${manifestPath}' is not a valid image artifact: ${errors.join('; ')}`);
    return undefined;
  }
  return (artifact as WorkspaceHostImageArtifact).release;
}

function readInteger(
  raw: string | undefined,
  label: string,
  fallback: number,
  problems: string[],
): number {
  const value = (raw ?? '').trim();
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    problems.push(`${label} must be a positive integer (got '${value}')`);
    return fallback;
  }
  return parsed;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
