/**
 * The PRODUCTION host adapter behind the remote initializer's protocol engine (D-110).
 *
 * `workspace-host-remote-initializer.ts` defines `WorkspaceHostRemoteInitializerHost` as a seam so
 * the protocol engine can be tested without a VM. Until this file existed the ONLY implementations
 * of that seam were `RecordingHost` in the test file and `RecordingMaterializer` in two others —
 * so every initialization step had a contract, an envelope, and a passing test suite, and no code
 * that could actually create a workspace on a host. D-110 named that gap; this file closes it.
 *
 * WHY A SYSTEM SEAM RATHER THAN DIRECT `node:child_process` CALLS. Every operation here is a
 * process spawn or a filesystem mutation on a real VM, which is exactly the code a unit test
 * cannot exercise. Routing all of it through one small `WorkspaceHostSystem` interface — whose
 * default is the real node implementation below — means the adapter's DECISIONS (which command,
 * which arguments, what counts as failure, what becomes evidence) are testable, while the
 * irreducible I/O stays in one place that is obviously correct. That is the same split the
 * protocol engine already uses, one layer down.
 *
 * EVIDENCE NEVER CARRIES AUTHORIZATION MATERIAL. The protocol engine runs
 * `assertWorkspaceHostSecretIsolation` over every response, and the credential resolver runs it
 * over every materializer detail. Both reject a key matching
 * `(api[_-]?key|access[_-]?key|secret|token|password|passphrase|private[_-]?key)` and any value
 * containing a PEM private-key header. Evidence below is therefore restricted to paths, booleans,
 * exit codes, counts and already-digested references — never a credential, and never a command
 * line that could have one interpolated into it.
 *
 * FAILURE IS LOUD. A non-zero exit throws `WorkspaceHostOperationError`, which the CLI wrapper
 * turns into exit 1 plus a stderr diagnostic. It is deliberate that no operation here can report
 * partial or optimistic success: the controller treats a failed step as failed and stops, whereas
 * a step that reported success it had not achieved would leave a half-initialized host that every
 * later step then builds on.
 */
import { execFile } from 'node:child_process';
import { mkdir, rm, stat } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';

import {
  NodeWorkspaceHostAgentProbeRunner,
  probeWorkspaceHostAgents,
  type WorkspaceHostAgentAuthenticationReport,
  type WorkspaceHostAgentProbeRunner,
} from './workspace-host-agent-authentication';
import {
  WorkspaceHostCredentialResolver,
  workspaceHostCredentialReferenceDigest,
  type WorkspaceHostCredentialBindingDescriptor,
  type WorkspaceHostCredentialFamily,
  type WorkspaceHostCredentialMaterializer,
} from './workspace-host-credential-namespace';
import type {
  WorkspaceHostCloneRepositoryInput,
  WorkspaceHostCreateWorkspaceInput,
  WorkspaceHostImportWorkspaceInput,
  WorkspaceHostPairWorkspaceInput,
  WorkspaceHostRemoteInitializerDeps,
  WorkspaceHostRemoteInitializerHost,
  WorkspaceHostRemoteStepEvidence,
} from './workspace-host-remote-initializer';

/** Default root under which per-workspace directories are created on the host. */
export const WORKSPACE_HOST_DEFAULT_WORKSPACE_ROOT = '/var/lib/papercusp/workspaces';

/** Default bundled CLI used for pair/import. `sidecar/bin` is on the runtime PATH. */
export const WORKSPACE_HOST_DEFAULT_WORKSPACE_COMMAND = 'papercup';

/** Default bound on any single host command, so a hung child cannot stall a step forever. */
export const WORKSPACE_HOST_DEFAULT_COMMAND_TIMEOUT_MS = 300_000;

export interface WorkspaceHostCommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface WorkspaceHostCommandInput {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd?: string;
  readonly timeoutMs?: number;
}

/**
 * The irreducible host I/O. Small on purpose: everything above it is decision logic that a test
 * can drive, and everything in it is a direct call to node with no branching worth testing.
 */
export interface WorkspaceHostSystem {
  run(input: WorkspaceHostCommandInput): Promise<WorkspaceHostCommandResult>;
  ensureDirectory(path: string): Promise<void>;
  pathExists(path: string): Promise<boolean>;
  removePath(path: string): Promise<void>;
}

/** A host operation that did not achieve what it claimed. Never carries the child's argv. */
export class WorkspaceHostOperationError extends Error {
  readonly operation: string;
  readonly exitCode: number;

  constructor(operation: string, exitCode: number, detail: string) {
    super(`workspace host operation '${operation}' failed with exit ${exitCode}: ${detail}`);
    this.name = 'WorkspaceHostOperationError';
    this.operation = operation;
    this.exitCode = exitCode;
  }
}

/**
 * Trim a child's stderr for a diagnostic.
 *
 * Bounded because a failing command can emit megabytes, and the whole diagnostic ends up in a
 * protocol error the controller reads. The tail is kept rather than the head: the actual error
 * from a CLI is almost always its last lines, while the head is usually banner and progress.
 */
function diagnosticTail(text: string, maxChars = 2_000): string {
  const trimmed = text.trim();
  if (trimmed.length <= maxChars) return trimmed || '(no diagnostic output)';
  return `…${trimmed.slice(-maxChars)}`;
}

/** The real implementation. Used by the packaged `bin/papercusp-remote-initializer`. */
export class NodeWorkspaceHostSystem implements WorkspaceHostSystem {
  async run(input: WorkspaceHostCommandInput): Promise<WorkspaceHostCommandResult> {
    return await new Promise<WorkspaceHostCommandResult>((resolve) => {
      execFile(
        input.command,
        [...input.args],
        {
          cwd: input.cwd,
          timeout: input.timeoutMs ?? WORKSPACE_HOST_DEFAULT_COMMAND_TIMEOUT_MS,
          maxBuffer: 16 * 1024 * 1024,
          // The child must never inherit an interactive terminal: every command here runs
          // unattended, and a CLI that decides to prompt would hang the step until the timeout.
          windowsHide: true,
        },
        (error, stdout, stderr) => {
          const code =
            error && typeof (error as { code?: unknown }).code === 'number'
              ? ((error as { code: number }).code as number)
              : error
                ? 1
                : 0;
          resolve({ exitCode: code, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
        },
      );
    });
  }

  async ensureDirectory(path: string): Promise<void> {
    await mkdir(path, { recursive: true, mode: 0o700 });
  }

  async pathExists(path: string): Promise<boolean> {
    try {
      await stat(path);
      return true;
    } catch {
      return false;
    }
  }

  async removePath(path: string): Promise<void> {
    await rm(path, { recursive: true, force: true });
  }
}

export interface ProductionWorkspaceHostOptions {
  readonly system?: WorkspaceHostSystem;
  readonly workspaceRoot?: string;
  readonly workspaceCommand?: string;
  readonly gitCommand?: string;
  readonly agentProbeRunner?: WorkspaceHostAgentProbeRunner;
  readonly now?: () => Date;
}

/**
 * Reject a path that would escape the workspace root.
 *
 * The controller supplies `destination` and the include lists, and those arrive over a network
 * boundary. A relative path containing `..`, or an absolute path pointing anywhere, would let a
 * malformed (or hostile) request write outside the workspace it claims to be initializing.
 */
function resolveWithinRoot(root: string, candidate: string, label: string): string {
  if (isAbsolute(candidate)) {
    throw new WorkspaceHostOperationError(label, 1, `${label} must be workspace-relative`);
  }
  const resolved = join(root, candidate);
  if (resolved !== root && !resolved.startsWith(`${root}/`)) {
    throw new WorkspaceHostOperationError(label, 1, `${label} escapes the workspace root`);
  }
  return resolved;
}

export class ProductionWorkspaceHostRemoteInitializerHost
  implements WorkspaceHostRemoteInitializerHost
{
  private readonly system: WorkspaceHostSystem;
  private readonly workspaceRoot: string;
  private readonly workspaceCommand: string;
  private readonly gitCommand: string;
  private readonly agentProbeRunner: WorkspaceHostAgentProbeRunner;
  private readonly now: () => Date;
  /** Set by `cloneRepository`; read by `describeClonedRepository` for the verify step. */
  private clone: { readonly destination: string; readonly visibility: 'public' | 'private' } | null =
    null;

  constructor(options: ProductionWorkspaceHostOptions = {}) {
    this.system = options.system ?? new NodeWorkspaceHostSystem();
    this.workspaceRoot = options.workspaceRoot ?? WORKSPACE_HOST_DEFAULT_WORKSPACE_ROOT;
    this.workspaceCommand = options.workspaceCommand ?? WORKSPACE_HOST_DEFAULT_WORKSPACE_COMMAND;
    this.gitCommand = options.gitCommand ?? 'git';
    this.agentProbeRunner = options.agentProbeRunner ?? new NodeWorkspaceHostAgentProbeRunner();
    this.now = options.now ?? (() => new Date());
  }

  private async require(
    operation: string,
    input: WorkspaceHostCommandInput,
  ): Promise<WorkspaceHostCommandResult> {
    const result = await this.system.run(input);
    if (result.exitCode !== 0) {
      throw new WorkspaceHostOperationError(operation, result.exitCode, diagnosticTail(result.stderr));
    }
    return result;
  }

  async createWorkspace(
    input: WorkspaceHostCreateWorkspaceInput,
  ): Promise<WorkspaceHostRemoteStepEvidence> {
    const directory = resolveWithinRoot(this.workspaceRoot, input.workspaceId, 'workspaceId');
    await this.system.ensureDirectory(directory);
    // Verify rather than assume: `mkdir -p` succeeding is not the same fact as the directory
    // being there afterwards (a read-only mount and a racing teardown both produce that shape).
    if (!(await this.system.pathExists(directory))) {
      throw new WorkspaceHostOperationError(
        'createWorkspace',
        1,
        `workspace directory ${directory} does not exist after creation`,
      );
    }
    return {
      workspaceId: input.workspaceId,
      hostId: input.hostId,
      directory,
      created: true,
      observedAt: this.now().toISOString(),
    };
  }

  async cloneRepository(
    input: WorkspaceHostCloneRepositoryInput,
  ): Promise<WorkspaceHostRemoteStepEvidence> {
    const destination = resolveWithinRoot(this.workspaceRoot, input.destination, 'destination');
    await this.require('cloneRepository', {
      command: this.gitCommand,
      args: ['clone', '--quiet', input.repositoryUrl, destination],
    });
    if (input.revision) {
      await this.require('cloneRepository.checkout', {
        command: this.gitCommand,
        args: ['-C', destination, 'checkout', '--quiet', input.revision],
      });
    }
    // The clone is only real if the git directory landed. `git clone` exiting 0 with no worktree
    // is the shape a partially-written filesystem takes, and it is the failure the verify step
    // exists to catch — catching it HERE names the step that actually failed.
    if (!(await this.system.pathExists(join(destination, '.git')))) {
      throw new WorkspaceHostOperationError(
        'cloneRepository',
        1,
        `no .git directory at ${destination} after clone`,
      );
    }
    this.clone = { destination, visibility: input.visibility };
    return {
      destination,
      visibility: input.visibility,
      cloned: true,
      ...(input.revision ? { revision: input.revision } : {}),
      // The CHANNEL is public routing metadata; the credential itself never appears here.
      ...(input.credentialChannel ? { credentialChannel: input.credentialChannel } : {}),
      observedAt: this.now().toISOString(),
    };
  }

  async pairWorkspace(
    input: WorkspaceHostPairWorkspaceInput,
  ): Promise<WorkspaceHostRemoteStepEvidence> {
    await this.require('pairWorkspace', {
      command: this.workspaceCommand,
      args: [
        'workspace',
        'pair',
        '--source',
        input.sourceWorkspaceId,
        '--pairing-ref',
        input.pairingReference.ref,
        ...input.include.flatMap((entry) => ['--include', entry]),
      ],
    });
    return {
      sourceWorkspaceId: input.sourceWorkspaceId,
      // A pairing ref is a reference, not material — but it is still an identifier the controller
      // supplied, so it is digested rather than echoed. The controller can match the digest.
      pairingReferenceDigest: workspaceHostCredentialReferenceDigest(input.pairingReference.ref),
      include: [...input.include],
      paired: true,
      observedAt: this.now().toISOString(),
    };
  }

  async importWorkspace(
    input: WorkspaceHostImportWorkspaceInput,
  ): Promise<WorkspaceHostRemoteStepEvidence> {
    await this.require('importWorkspace', {
      command: this.workspaceCommand,
      args: [
        'workspace',
        'import',
        '--source',
        input.sourceWorkspaceId,
        '--snapshot',
        input.sourceSnapshotRef,
        ...input.include.flatMap((entry) => ['--include', entry]),
      ],
    });
    return {
      sourceWorkspaceId: input.sourceWorkspaceId,
      sourceSnapshotRef: input.sourceSnapshotRef,
      include: [...input.include],
      imported: true,
      observedAt: this.now().toISOString(),
    };
  }

  /**
   * Delegate to the existing probe suite rather than reimplementing it.
   *
   * `probeWorkspaceHostAgents` already owns the rules that make this evidence trustworthy — the
   * sequential ordering, the "exit 0 but unparseable is a FAILED probe" rule, and the subject
   * disclosure policy. A second implementation here would be a second set of those rules to keep
   * in sync, and the one that drifted would be the one nobody was reading.
   */
  async probeAgentAuthentication(): Promise<WorkspaceHostAgentAuthenticationReport> {
    return await probeWorkspaceHostAgents({ runner: this.agentProbeRunner, now: this.now });
  }

  async describeClonedRepository(): Promise<{
    readonly visibility: 'public' | 'private';
    readonly cloned: boolean;
  }> {
    if (!this.clone) return { visibility: 'public', cloned: false };
    // Re-observe instead of replaying what cloneRepository recorded. The verify step's job is to
    // confirm the clone is STILL there; answering it from a remembered success would make the
    // check unable to fail, which is the whole reason D-110 exists one layer up.
    const cloned = await this.system.pathExists(join(this.clone.destination, '.git'));
    return { visibility: this.clone.visibility, cloned };
  }
}

/**
 * Production credential materializer.
 *
 * The host is a credential RECIPIENT, never a minter: the controller delivers material out of
 * band (metadata server, injected file, forwarded reference) and the host's job is to confirm the
 * delivery landed, confirm it still holds, and confirm a revocation actually took effect. That is
 * why all four operations are observations and none of them writes a credential.
 *
 * Every returned detail is public: the family, the delivery kind, the generation, and a boolean.
 * The resolver re-asserts secret isolation over whatever this returns, so a materializer that
 * leaked material would fail there — but the design intent is that there is nothing to leak.
 */
export class ProductionWorkspaceHostCredentialMaterializer
  implements WorkspaceHostCredentialMaterializer
{
  readonly family: WorkspaceHostCredentialFamily;
  private readonly system: WorkspaceHostSystem;
  private readonly locate: (binding: WorkspaceHostCredentialBindingDescriptor) => string | null;

  constructor(
    family: WorkspaceHostCredentialFamily,
    system: WorkspaceHostSystem,
    locate: (binding: WorkspaceHostCredentialBindingDescriptor) => string | null,
  ) {
    this.family = family;
    this.system = system;
    this.locate = locate;
  }

  private describe(
    binding: WorkspaceHostCredentialBindingDescriptor,
    present: boolean,
  ): Readonly<Record<string, unknown>> {
    return {
      family: this.family,
      channel: binding.channel,
      deliveryKind: binding.deliveryKind,
      generation: binding.generation,
      present,
    };
  }

  private async present(binding: WorkspaceHostCredentialBindingDescriptor): Promise<boolean> {
    const path = this.locate(binding);
    // A family with no on-host artifact (workload identity is ambient: the metadata server
    // answers, nothing is placed on disk) reports presence as "the binding is in force", which is
    // the honest answer for it. Families that DO place a file are checked on disk.
    if (path === null) return true;
    return await this.system.pathExists(path);
  }

  async bind(
    binding: WorkspaceHostCredentialBindingDescriptor,
  ): Promise<Readonly<Record<string, unknown>>> {
    const present = await this.present(binding);
    if (!present) {
      throw new WorkspaceHostOperationError(
        `credential.${binding.channel}.bind`,
        1,
        `delivered material for family '${this.family}' is not present on the host`,
      );
    }
    return this.describe(binding, true);
  }

  async verifyBound(
    binding: WorkspaceHostCredentialBindingDescriptor,
  ): Promise<Readonly<Record<string, unknown>>> {
    const present = await this.present(binding);
    if (!present) {
      throw new WorkspaceHostOperationError(
        `credential.${binding.channel}.verify-bound`,
        1,
        `binding for family '${this.family}' is no longer present on the host`,
      );
    }
    return this.describe(binding, true);
  }

  async revoke(
    binding: WorkspaceHostCredentialBindingDescriptor,
  ): Promise<Readonly<Record<string, unknown>>> {
    const path = this.locate(binding);
    if (path !== null) await this.system.removePath(path);
    return this.describe(binding, false);
  }

  async verifyRevoked(
    binding: WorkspaceHostCredentialBindingDescriptor,
  ): Promise<Readonly<Record<string, unknown>>> {
    const path = this.locate(binding);
    // Revocation of an ambient family is asserted by the ISSUER, not observable here; saying
    // otherwise would manufacture evidence. Families with an on-host artifact are really checked.
    if (path === null) return this.describe(binding, false);
    if (await this.system.pathExists(path)) {
      throw new WorkspaceHostOperationError(
        `credential.${binding.channel}.verify-revoked`,
        1,
        `material for family '${this.family}' is still present after revocation`,
      );
    }
    return this.describe(binding, false);
  }
}

/** Where each family's delivered material lives on the host, or null when it is ambient. */
export const WORKSPACE_HOST_CREDENTIAL_MATERIAL_ROOT = '/var/lib/papercusp/credentials';

function materialPathFor(
  root: string,
  family: WorkspaceHostCredentialFamily,
): (binding: WorkspaceHostCredentialBindingDescriptor) => string | null {
  return (binding) => {
    // `cloud-workload-identity` is answered by the instance metadata server — there is no file to
    // check, and inventing one would make bind() pass against a path we created ourselves.
    if (family === 'cloud-workload-identity') return null;
    return join(root, family, `${binding.generation}`, 'material');
  };
}

export function createProductionWorkspaceHostCredentialMaterializers(
  system: WorkspaceHostSystem,
  materialRoot: string = WORKSPACE_HOST_CREDENTIAL_MATERIAL_ROOT,
): readonly WorkspaceHostCredentialMaterializer[] {
  // Enumerated explicitly rather than mapped over WORKSPACE_HOST_CREDENTIAL_FAMILIES: adding a
  // family should be a decision that lands here deliberately, not one that silently acquires a
  // default binding policy from a loop.
  const families: readonly WorkspaceHostCredentialFamily[] = [
    'cloud-workload-identity',
    'git-short-lived-delegation',
    'agent-forwarded-reference',
    'agent-encrypted-reference',
  ];
  return families.map(
    (family) =>
      new ProductionWorkspaceHostCredentialMaterializer(
        family,
        system,
        materialPathFor(materialRoot, family),
      ),
  );
}

export interface ProductionWorkspaceHostRemoteInitializerOptions
  extends ProductionWorkspaceHostOptions {
  readonly credentialMaterialRoot?: string;
}

/**
 * The single wiring the packaged executable uses.
 *
 * Keeping this here rather than in the bin file is what makes the bin a three-line program: the
 * dependency graph is assembled by code a test can call, and the only untested lines are the ones
 * that read `process.argv` and `process.stdin`.
 */
export function createProductionWorkspaceHostRemoteInitializerDeps(
  options: ProductionWorkspaceHostRemoteInitializerOptions = {},
): WorkspaceHostRemoteInitializerDeps {
  const system = options.system ?? new NodeWorkspaceHostSystem();
  return {
    host: new ProductionWorkspaceHostRemoteInitializerHost({ ...options, system }),
    credentials: new WorkspaceHostCredentialResolver(
      createProductionWorkspaceHostCredentialMaterializers(
        system,
        options.credentialMaterialRoot,
      ),
    ),
    ...(options.now ? { now: options.now } : {}),
  };
}
