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
import { execFile } from "node:child_process";
import { chmod, lstat, mkdir, rm, stat } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

import {
  NodeWorkspaceHostAgentProbeRunner,
  probeWorkspaceHostAgents,
  type WorkspaceHostAgentVerificationReport,
  type WorkspaceHostAgentProbeRunner,
} from "./workspace-host-agent-authentication";
import {
  WORKSPACE_HOST_CREDENTIAL_FAMILY_SPECS,
  WorkspaceHostCredentialResolver,
  workspaceHostCredentialReferenceDigest,
  type WorkspaceHostCredentialBindingDescriptor,
  type WorkspaceHostCredentialFamily,
  type WorkspaceHostCredentialMaterializer,
} from "./workspace-host-credential-namespace";
import {
  NodeWorkspaceHostCredentialDeliveryFilesystem,
  recordWorkspaceHostCredentialRevocation,
  withWorkspaceHostCredentialFilesystemLock,
  workspaceHostCredentialFamilyLockPath,
  workspaceHostCredentialMaterialPath,
  type WorkspaceHostCredentialDeliveryFilesystem,
} from "./workspace-host-credential-delivery";
import {
  WorkspaceHostAgentHomeConsumer,
  WORKSPACE_HOST_AGENT_HOME_FAMILIES,
  requireExplicitWorkspaceHostHome,
  type WorkspaceHostAgentHomeFamily,
  type WorkspaceHostAgentHomeFilesystem,
} from "./workspace-host-agent-home";
import {
  DEFAULT_WORKSPACE_HOST_AGENT_USER,
  DEFAULT_WORKSPACE_HOST_WORKSPACE_USER,
  WORKSPACE_HOST_DATA_ROOT,
} from "./workspace-host-bootstrap";
import type {
  WorkspaceHostCloneRepositoryInput,
  WorkspaceHostCreateWorkspaceInput,
  WorkspaceHostImportWorkspaceInput,
  WorkspaceHostPairWorkspaceInput,
  WorkspaceHostRemoteInitializerDeps,
  WorkspaceHostRemoteInitializerHost,
  WorkspaceHostRemoteStepEvidence,
} from "./workspace-host-remote-initializer";

/** Default root under which per-workspace directories are created on the host. */
export const WORKSPACE_HOST_DEFAULT_WORKSPACE_ROOT = WORKSPACE_HOST_DATA_ROOT;

/** Default native home used by the dedicated workspace SSH identity. */
export const WORKSPACE_HOST_DEFAULT_WORKSPACE_HOME = `/home/${DEFAULT_WORKSPACE_HOST_WORKSPACE_USER}`;

/**
 * Default native home of the AGENT identity — where delivered Claude/Codex/OMP material lives.
 *
 * A separate constant from the workspace home on purpose: the two were the same path until
 * D-248, which is exactly why the credential exposure was invisible. Keep them distinct even if
 * a future caller wants to override one.
 */
export const WORKSPACE_HOST_DEFAULT_AGENT_HOME = `/home/${DEFAULT_WORKSPACE_HOST_AGENT_USER}`;

/** Exact PATH passed to agent probes; no controller process environment is inherited. */
export const WORKSPACE_HOST_DEFAULT_AGENT_PROBE_PATH =
  "/opt/papercusp/current/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";

/** Default bundled CLI used for pair/import. `sidecar/bin` is on the runtime PATH. */
export const WORKSPACE_HOST_DEFAULT_WORKSPACE_COMMAND = "papercup";

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
  /** Process-only configuration. Callers must never copy this into evidence or diagnostics. */
  readonly env?: Readonly<Record<string, string>>;
}

/**
 * The irreducible host I/O. Small on purpose: everything above it is decision logic that a test
 * can drive, and everything in it is a direct call to node with no branching worth testing.
 */
export interface WorkspaceHostSystem
  extends
    WorkspaceHostCredentialDeliveryFilesystem,
    WorkspaceHostAgentHomeFilesystem {
  run(input: WorkspaceHostCommandInput): Promise<WorkspaceHostCommandResult>;
  pathExists(path: string): Promise<boolean>;
  removePath(path: string): Promise<void>;
  /** Optional only so hermetic systems need not model Unix ownership. Production always provides it. */
  setOwnership?(path: string, owner: string, group: string): Promise<void>;
  setOwnershipRecursively?(
    path: string,
    owner: string,
    group: string,
  ): Promise<void>;
}

/** A host operation that did not achieve what it claimed. Never carries the child's argv. */
export class WorkspaceHostOperationError extends Error {
  readonly operation: string;
  readonly exitCode: number;

  constructor(operation: string, exitCode: number, detail: string) {
    super(
      `workspace host operation '${operation}' failed with exit ${exitCode}: ${detail}`,
    );
    this.name = "WorkspaceHostOperationError";
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
  if (trimmed.length <= maxChars) return trimmed || "(no diagnostic output)";
  return `…${trimmed.slice(-maxChars)}`;
}

/** The real implementation. Used by the packaged `bin/papercusp-remote-initializer`. */
export class NodeWorkspaceHostSystem implements WorkspaceHostSystem {
  async run(
    input: WorkspaceHostCommandInput,
  ): Promise<WorkspaceHostCommandResult> {
    return await new Promise<WorkspaceHostCommandResult>((resolve) => {
      execFile(
        input.command,
        [...input.args],
        {
          cwd: input.cwd,
          ...(input.env ? { env: { ...process.env, ...input.env } } : {}),
          timeout: input.timeoutMs ?? WORKSPACE_HOST_DEFAULT_COMMAND_TIMEOUT_MS,
          maxBuffer: 16 * 1024 * 1024,
          // The child must never inherit an interactive terminal: every command here runs
          // unattended, and a CLI that decides to prompt would hang the step until the timeout.
          windowsHide: true,
        },
        (error, stdout, stderr) => {
          const code =
            error && typeof (error as { code?: unknown }).code === "number"
              ? ((error as { code: number }).code as number)
              : error
                ? 1
                : 0;
          resolve({
            exitCode: code,
            stdout: String(stdout ?? ""),
            stderr: String(stderr ?? ""),
          });
        },
      );
    });
  }

  async ensureDirectory(path: string): Promise<void> {
    await this.deliveryFilesystem.ensureDirectory(path);
  }

  async pathExists(path: string): Promise<boolean> {
    try {
      await stat(path);
      return true;
    } catch {
      return false;
    }
  }

  async pathKind(
    path: string,
  ): Promise<"missing" | "directory" | "file" | "symlink" | "other"> {
    try {
      const info = await lstat(path);
      if (info.isSymbolicLink()) return "symlink";
      if (info.isDirectory()) return "directory";
      if (info.isFile()) return "file";
      return "other";
    } catch (error) {
      if (
        error &&
        typeof error === "object" &&
        "code" in error &&
        (error as { code?: unknown }).code === "ENOENT"
      )
        return "missing";
      throw error;
    }
  }

  async withExclusiveLock<T>(path: string, task: () => Promise<T>): Promise<T> {
    return await this.deliveryFilesystem.withExclusiveLock!(path, task);
  }

  async removePath(path: string): Promise<void> {
    await rm(path, { recursive: true, force: true });
  }

  private async changeOwnership(
    path: string,
    owner: string,
    group: string,
    recursive: boolean,
  ): Promise<void> {
    // Resolve names through the platform command rather than carrying uid/gid assumptions across
    // provider images. Account names are validated by the adapter before reaching this seam.
    await new Promise<void>((resolve, reject) => {
      execFile(
        "chown",
        [...(recursive ? ["-R"] : []), `${owner}:${group}`, path],
        (error) => (error ? reject(error) : resolve()),
      );
    });
  }

  async setOwnership(
    path: string,
    owner: string,
    group: string,
  ): Promise<void> {
    await this.changeOwnership(path, owner, group, false);
  }

  async setOwnershipRecursively(
    path: string,
    owner: string,
    group: string,
  ): Promise<void> {
    await this.changeOwnership(path, owner, group, true);
  }

  // The two credential-delivery operations. Delegated to the delivery module's implementation
  // rather than re-derived here, so the 0600/atomic-rename behaviour has one definition and the
  // packaged delivery entrypoint and this host adapter cannot drift on how material is written.
  async writePrivateFile(path: string, bytes: Buffer): Promise<void> {
    await this.deliveryFilesystem.writePrivateFile(path, bytes);
  }

  async readFileIfPresent(path: string): Promise<Buffer | null> {
    return await this.deliveryFilesystem.readFileIfPresent(path);
  }

  private readonly deliveryFilesystem =
    new NodeWorkspaceHostCredentialDeliveryFilesystem();
}

export interface ProductionWorkspaceHostOptions {
  readonly system?: WorkspaceHostSystem;
  readonly workspaceRoot?: string;
  readonly workspaceCommand?: string;
  readonly gitCommand?: string;
  readonly agentProbeRunner?: WorkspaceHostAgentProbeRunner;
  readonly now?: () => Date;
  readonly gitCredentialBindings?: WorkspaceHostGitCredentialBindingRegistry;
  readonly credentialMaterialRoot?: string;
  /** Explicit native home for the workspace identity; never inferred from ambient HOME. */
  readonly workspaceHome?: string;
  readonly workspaceUser?: string;
  readonly workspaceGroup?: string;
  /**
   * The THIRD identity (D-248) — the account the bundled agent CLIs execute as, and the owner of
   * the delivered agent credential home. Deliberately NOT `workspaceUser`: that account is the
   * customer's SSH login on a BYOC host, and D-043 forbids it reading the runtime at all.
   */
  readonly agentHome?: string;
  readonly agentUser?: string;
  readonly agentGroup?: string;
  readonly agentProbePath?: string;
}

interface WorkspaceHostGitCredentialBinding {
  readonly generation: number;
  readonly materialPath: string;
  readonly expiresAt?: string;
}

/**
 * Filesystem-backed state joining lifecycle bind/revoke to a later private clone.
 *
 * The old implementation kept `active` only in this object. The packaged initializer constructs a
 * new object for every SSH step, so a successful bind was invisible to the next clone process.
 * Every operation below reads the state file afresh; independent processes therefore share the
 * same generation without a controller-side singleton.
 */
export class WorkspaceHostGitCredentialBindingRegistry {
  private readonly filesystem: WorkspaceHostSystem;
  private readonly materialRoot: string;

  constructor(
    filesystem: WorkspaceHostSystem = new NodeWorkspaceHostSystem(),
    materialRoot: string = WORKSPACE_HOST_CREDENTIAL_MATERIAL_ROOT,
  ) {
    this.filesystem = filesystem;
    this.materialRoot = materialRoot;
  }

  static statePath(materialRoot: string): string {
    return join(materialRoot, "active", "git-binding.json");
  }

  private async readState(): Promise<WorkspaceHostGitCredentialBinding | null> {
    const raw = await this.filesystem.readFileIfPresent(
      WorkspaceHostGitCredentialBindingRegistry.statePath(this.materialRoot),
    );
    if (raw === null) return null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw.toString("utf8"));
    } catch {
      throw new WorkspaceHostOperationError(
        "credential.git.state",
        1,
        "active Git binding state is malformed",
      );
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new WorkspaceHostOperationError(
        "credential.git.state",
        1,
        "active Git binding state is malformed",
      );
    }
    const body = parsed as Record<string, unknown>;
    if (
      body.contractVersion !== WORKSPACE_HOST_GIT_BINDING_STATE_VERSION ||
      body.channel !== "git" ||
      body.family !== "git-short-lived-delegation" ||
      !Number.isSafeInteger(body.generation) ||
      (body.generation as number) < 1 ||
      typeof body.materialPath !== "string" ||
      (body.expiresAt !== undefined &&
        (typeof body.expiresAt !== "string" ||
          !Number.isFinite(Date.parse(body.expiresAt))))
    ) {
      throw new WorkspaceHostOperationError(
        "credential.git.state",
        1,
        "active Git binding state is malformed",
      );
    }
    const expectedPath = workspaceHostCredentialMaterialPath(
      this.materialRoot,
      "git-short-lived-delegation",
      body.generation as number,
    );
    if (body.materialPath !== expectedPath) {
      throw new WorkspaceHostOperationError(
        "credential.git.state",
        1,
        "active Git binding state points outside the canonical material path",
      );
    }
    return {
      generation: body.generation as number,
      materialPath: body.materialPath,
      ...(body.expiresAt ? { expiresAt: body.expiresAt } : {}),
    };
  }

  private async bindUnlocked(
    binding: WorkspaceHostCredentialBindingDescriptor,
    materialPath: string,
  ): Promise<void> {
    if (binding.channel !== "git") return;
    const expectedPath = workspaceHostCredentialMaterialPath(
      this.materialRoot,
      "git-short-lived-delegation",
      binding.generation,
    );
    if (materialPath !== expectedPath) {
      throw new WorkspaceHostOperationError(
        "credential.git.bind",
        1,
        "Git binding material path is not the canonical generation path",
      );
    }
    const current = await this.readState();
    if (current && current.generation > binding.generation) {
      throw new WorkspaceHostOperationError(
        "credential.git.bind",
        1,
        `cannot activate generation ${binding.generation} below active generation ${current.generation}`,
      );
    }
    if (
      current &&
      current.generation === binding.generation &&
      (current.materialPath !== materialPath ||
        current.expiresAt !== binding.expiresAt)
    ) {
      throw new WorkspaceHostOperationError(
        "credential.git.bind",
        1,
        `generation ${binding.generation} is already active with different binding state`,
      );
    }
    await this.filesystem.ensureDirectory(join(this.materialRoot, "active"));
    await this.filesystem.writePrivateFile(
      WorkspaceHostGitCredentialBindingRegistry.statePath(this.materialRoot),
      Buffer.from(
        JSON.stringify({
          contractVersion: WORKSPACE_HOST_GIT_BINDING_STATE_VERSION,
          channel: "git",
          family: "git-short-lived-delegation",
          generation: binding.generation,
          materialPath,
          ...(binding.expiresAt ? { expiresAt: binding.expiresAt } : {}),
        }),
        "utf8",
      ),
    );
  }

  async bind(
    binding: WorkspaceHostCredentialBindingDescriptor,
    materialPath: string,
    options: { readonly lockHeld?: boolean } = {},
  ): Promise<void> {
    const task = () => this.bindUnlocked(binding, materialPath);
    if (options.lockHeld) return await task();
    return await withWorkspaceHostCredentialFilesystemLock(
      this.filesystem,
      workspaceHostCredentialFamilyLockPath(
        this.materialRoot,
        "git-short-lived-delegation",
      ),
      task,
    );
  }

  private async revokeUnlocked(
    binding: WorkspaceHostCredentialBindingDescriptor,
  ): Promise<void> {
    if (binding.channel !== "git") return;
    const current = await this.readState();
    // Never let an old process revoke a newer active binding.
    if (!current || current.generation !== binding.generation) return;
    await this.filesystem.removePath(
      WorkspaceHostGitCredentialBindingRegistry.statePath(this.materialRoot),
    );
  }

  async revoke(
    binding: WorkspaceHostCredentialBindingDescriptor,
    options: { readonly lockHeld?: boolean } = {},
  ): Promise<void> {
    const task = () => this.revokeUnlocked(binding);
    if (options.lockHeld) return await task();
    return await withWorkspaceHostCredentialFilesystemLock(
      this.filesystem,
      workspaceHostCredentialFamilyLockPath(
        this.materialRoot,
        "git-short-lived-delegation",
      ),
      task,
    );
  }

  private async verifyBoundUnlocked(
    binding: WorkspaceHostCredentialBindingDescriptor,
    materialPath: string,
  ): Promise<void> {
    if (binding.channel !== "git") return;
    const current = await this.readState();
    if (
      !current ||
      current.generation !== binding.generation ||
      current.materialPath !== materialPath ||
      current.expiresAt !== binding.expiresAt
    ) {
      throw new WorkspaceHostOperationError(
        "credential.git.verify-bound",
        1,
        `generation ${binding.generation} is not the active Git binding`,
      );
    }
  }

  async verifyBound(
    binding: WorkspaceHostCredentialBindingDescriptor,
    materialPath: string,
    options: { readonly lockHeld?: boolean } = {},
  ): Promise<void> {
    const task = () => this.verifyBoundUnlocked(binding, materialPath);
    if (options.lockHeld) return await task();
    return await withWorkspaceHostCredentialFilesystemLock(
      this.filesystem,
      workspaceHostCredentialFamilyLockPath(
        this.materialRoot,
        "git-short-lived-delegation",
      ),
      task,
    );
  }

  private async verifyRevokedUnlocked(
    binding: WorkspaceHostCredentialBindingDescriptor,
  ): Promise<void> {
    if (binding.channel !== "git") return;
    const current = await this.readState();
    if (current?.generation === binding.generation) {
      throw new WorkspaceHostOperationError(
        "credential.git.verify-revoked",
        1,
        `generation ${binding.generation} is still the active Git binding`,
      );
    }
  }

  async verifyRevoked(
    binding: WorkspaceHostCredentialBindingDescriptor,
    options: { readonly lockHeld?: boolean } = {},
  ): Promise<void> {
    const task = () => this.verifyRevokedUnlocked(binding);
    if (options.lockHeld) return await task();
    return await withWorkspaceHostCredentialFilesystemLock(
      this.filesystem,
      workspaceHostCredentialFamilyLockPath(
        this.materialRoot,
        "git-short-lived-delegation",
      ),
      task,
    );
  }

  async resolve(now: Date): Promise<WorkspaceHostGitCredentialBinding> {
    const active = await this.readState();
    if (!active) {
      throw new WorkspaceHostOperationError(
        "cloneRepository.credentials",
        1,
        "no bound git credential material is available for a private clone",
      );
    }
    if (active.expiresAt && Date.parse(active.expiresAt) <= now.getTime()) {
      throw new WorkspaceHostOperationError(
        "cloneRepository.credentials",
        1,
        "the bound git credential material has expired",
      );
    }
    return active;
  }
}

const WORKSPACE_HOST_GIT_BINDING_STATE_VERSION =
  "papercusp-workspace-host-git-binding-state-v1";

/**
 * Reject a path that would escape the workspace root.
 *
 * The controller supplies `destination` and the include lists, and those arrive over a network
 * boundary. A relative path containing `..`, or an absolute path pointing anywhere, would let a
 * malformed (or hostile) request write outside the workspace it claims to be initializing.
 */
function resolveWithinRoot(
  root: string,
  candidate: string,
  label: string,
): string {
  if (isAbsolute(candidate)) {
    throw new WorkspaceHostOperationError(
      label,
      1,
      `${label} must be workspace-relative`,
    );
  }
  const resolved = join(root, candidate);
  if (resolved !== root && !resolved.startsWith(`${root}/`)) {
    throw new WorkspaceHostOperationError(
      label,
      1,
      `${label} escapes the workspace root`,
    );
  }
  return resolved;
}

const WORKSPACE_HOST_LINUX_ACCOUNT = /^[a-z_][a-z0-9_-]{0,30}$/;

function requireWorkspaceAccount(value: string, label: string): string {
  if (!WORKSPACE_HOST_LINUX_ACCOUNT.test(value) || value === "root") {
    throw new WorkspaceHostOperationError(
      label,
      1,
      `${label} must be a non-root Linux account name`,
    );
  }
  return value;
}

export class ProductionWorkspaceHostRemoteInitializerHost implements WorkspaceHostRemoteInitializerHost {
  private readonly system: WorkspaceHostSystem;
  private readonly workspaceRoot: string;
  private readonly workspaceCommand: string;
  private readonly gitCommand: string;
  private readonly agentProbeRunner: WorkspaceHostAgentProbeRunner;
  private readonly now: () => Date;
  private readonly gitCredentialBindings: WorkspaceHostGitCredentialBindingRegistry;
  private readonly workspaceHome: string;
  private readonly workspaceUser: string;
  private readonly workspaceGroup: string;
  private readonly agentHome: string;
  private readonly agentUser: string;
  private readonly agentGroup: string;
  private readonly agentProbePath: string;

  constructor(options: ProductionWorkspaceHostOptions = {}) {
    this.system = options.system ?? new NodeWorkspaceHostSystem();
    this.workspaceRoot =
      options.workspaceRoot ?? WORKSPACE_HOST_DEFAULT_WORKSPACE_ROOT;
    this.workspaceCommand =
      options.workspaceCommand ?? WORKSPACE_HOST_DEFAULT_WORKSPACE_COMMAND;
    this.gitCommand = options.gitCommand ?? "git";
    this.agentProbeRunner =
      options.agentProbeRunner ?? new NodeWorkspaceHostAgentProbeRunner();
    this.now = options.now ?? (() => new Date());
    this.workspaceHome = requireExplicitWorkspaceHostHome(
      options.workspaceHome ?? WORKSPACE_HOST_DEFAULT_WORKSPACE_HOME,
    );
    this.workspaceUser = requireWorkspaceAccount(
      options.workspaceUser ?? DEFAULT_WORKSPACE_HOST_WORKSPACE_USER,
      "workspaceUser",
    );
    this.workspaceGroup = requireWorkspaceAccount(
      options.workspaceGroup ?? this.workspaceUser,
      "workspaceGroup",
    );
    this.agentUser = requireWorkspaceAccount(
      options.agentUser ?? DEFAULT_WORKSPACE_HOST_AGENT_USER,
      "agentUser",
    );
    this.agentGroup = requireWorkspaceAccount(
      options.agentGroup ?? this.agentUser,
      "agentGroup",
    );
    this.agentHome = requireExplicitWorkspaceHostHome(
      options.agentHome ?? `/home/${this.agentUser}`,
    );
    // Refuse the collapse rather than silently accept it. A caller that passes the SSH account
    // here has recreated the exact shape D-248 removed — agent credentials in the customer's own
    // home, and a runtime the customer's login must read — and every downstream check would
    // still pass, because each one is individually satisfiable by that shape.
    if (this.agentUser === this.workspaceUser) {
      throw new WorkspaceHostOperationError(
        "agentUser",
        1,
        "agentUser must differ from workspaceUser: the agent identity exists so the SSH login is not the account that reads the runtime (D-043, D-248)",
      );
    }
    this.agentProbePath =
      options.agentProbePath ?? WORKSPACE_HOST_DEFAULT_AGENT_PROBE_PATH;
    if (
      !this.agentProbePath.startsWith("/") ||
      /[\r\n\0]/.test(this.agentProbePath)
    ) {
      throw new WorkspaceHostOperationError(
        "agentProbePath",
        1,
        "agentProbePath must be an absolute, newline-free search path",
      );
    }
    this.gitCredentialBindings =
      options.gitCredentialBindings ??
      new WorkspaceHostGitCredentialBindingRegistry(
        this.system,
        options.credentialMaterialRoot ??
          WORKSPACE_HOST_CREDENTIAL_MATERIAL_ROOT,
      );
  }

  private async require(
    operation: string,
    input: WorkspaceHostCommandInput,
  ): Promise<WorkspaceHostCommandResult> {
    const result = await this.system.run(input);
    if (result.exitCode !== 0) {
      throw new WorkspaceHostOperationError(
        operation,
        result.exitCode,
        diagnosticTail(result.stderr),
      );
    }
    return result;
  }

  async createWorkspace(
    input: WorkspaceHostCreateWorkspaceInput,
  ): Promise<WorkspaceHostRemoteStepEvidence> {
    const directory = resolveWithinRoot(
      this.workspaceRoot,
      input.workspaceId,
      "workspaceId",
    );
    await this.system.ensureDirectory(directory);
    await this.system.setOwnership?.(
      directory,
      this.workspaceUser,
      this.workspaceGroup,
    );
    // Verify rather than assume: `mkdir -p` succeeding is not the same fact as the directory
    // being there afterwards (a read-only mount and a racing teardown both produce that shape).
    if (!(await this.system.pathExists(directory))) {
      throw new WorkspaceHostOperationError(
        "createWorkspace",
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
    const destination = resolveWithinRoot(
      this.workspaceRoot,
      input.destination,
      "destination",
    );
    let env: Readonly<Record<string, string>> | undefined;
    if (input.visibility === "private") {
      if (input.credentialChannel !== "git") {
        throw new WorkspaceHostOperationError(
          "cloneRepository.credentials",
          1,
          "a private repository clone must consume the bound 'git' credential channel",
        );
      }
      const binding = await this.gitCredentialBindings.resolve(this.now());
      if (!(await this.system.pathExists(binding.materialPath))) {
        throw new WorkspaceHostOperationError(
          "cloneRepository.credentials",
          1,
          "the bound git credential material is absent from the host",
        );
      }
      // The material itself remains in the 0700 credential store. Git receives only the helper
      // path through its environment: never argv, evidence, errors, or logs.
      env = {
        GIT_TERMINAL_PROMPT: "0",
        GIT_CONFIG_COUNT: "2",
        GIT_CONFIG_KEY_0: "credential.helper",
        GIT_CONFIG_VALUE_0: `store --file=${binding.materialPath}`,
        GIT_CONFIG_KEY_1: "credential.useHttpPath",
        GIT_CONFIG_VALUE_1: "true",
      };
    }
    await this.require("cloneRepository", {
      command: this.gitCommand,
      args: ["clone", "--quiet", input.repositoryUrl, destination],
      ...(env ? { env } : {}),
    });
    if (input.revision) {
      await this.require("cloneRepository.checkout", {
        command: this.gitCommand,
        args: ["-C", destination, "checkout", "--quiet", input.revision],
      });
    }
    // The clone is only real if the git directory landed. `git clone` exiting 0 with no worktree
    // is the shape a partially-written filesystem takes, and it is the failure the verify step
    // exists to catch — catching it HERE names the step that actually failed.
    if (!(await this.system.pathExists(join(destination, ".git")))) {
      throw new WorkspaceHostOperationError(
        "cloneRepository",
        1,
        `no .git directory at ${destination} after clone`,
      );
    }
    // The privileged initializer creates the checkout, but the unprivileged SSH identity owns and
    // edits it afterwards. Do this only after the clone is complete so Git never observes a tree
    // whose ownership changes underneath it.
    await this.system.setOwnershipRecursively?.(
      destination,
      this.workspaceUser,
      this.workspaceGroup,
    );
    return {
      destination,
      visibility: input.visibility,
      cloned: true,
      ...(input.revision ? { revision: input.revision } : {}),
      // The CHANNEL is public routing metadata; the credential itself never appears here.
      ...(input.credentialChannel
        ? { credentialChannel: input.credentialChannel }
        : {}),
      observedAt: this.now().toISOString(),
    };
  }

  async pairWorkspace(
    input: WorkspaceHostPairWorkspaceInput,
  ): Promise<WorkspaceHostRemoteStepEvidence> {
    await this.require("pairWorkspace", {
      command: this.workspaceCommand,
      args: [
        "workspace",
        "pair",
        "--source",
        input.sourceWorkspaceId,
        "--pairing-ref",
        input.pairingReference.ref,
        ...input.include.flatMap((entry) => ["--include", entry]),
      ],
    });
    return {
      sourceWorkspaceId: input.sourceWorkspaceId,
      // A pairing ref is a reference, not material — but it is still an identifier the controller
      // supplied, so it is digested rather than echoed. The controller can match the digest.
      pairingReferenceDigest: workspaceHostCredentialReferenceDigest(
        input.pairingReference.ref,
      ),
      include: [...input.include],
      paired: true,
      observedAt: this.now().toISOString(),
    };
  }

  async importWorkspace(
    input: WorkspaceHostImportWorkspaceInput,
  ): Promise<WorkspaceHostRemoteStepEvidence> {
    await this.require("importWorkspace", {
      command: this.workspaceCommand,
      args: [
        "workspace",
        "import",
        "--source",
        input.sourceWorkspaceId,
        "--snapshot",
        input.sourceSnapshotRef,
        ...input.include.flatMap((entry) => ["--include", entry]),
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
  async probeAgentVerification(): Promise<WorkspaceHostAgentVerificationReport> {
    return await probeWorkspaceHostAgents({
      runner: this.agentProbeRunner,
      now: this.now,
      // The AGENT identity, not the SSH login (D-248). This line is the one that decides which
      // account has to be able to read `$RUNTIME_ROOT`: whoever the probes run as is the account
      // the bootstrap must grant runtime read to, and D-043 rules that it cannot be the workspace
      // user. HOME travels with it — the delivered Claude/Codex material lives under the agent's
      // 0700 home, so a probe with the SSH user's HOME would look for credentials that are not
      // there and fail identically to a genuine credential fault.
      env: {
        HOME: this.agentHome,
        USER: this.agentUser,
        LOGNAME: this.agentUser,
        PATH: this.agentProbePath,
      },
      runAsUser: this.agentUser,
    });
  }

  async describeClonedRepository(input?: {
    readonly destination: string;
    readonly visibility: "public" | "private";
  }): Promise<{
    readonly visibility: "public" | "private";
    readonly cloned: boolean;
  }> {
    if (!input) return { visibility: "public", cloned: false };
    // `verify-initialization` is a fresh process. The validated destination is carried on that
    // step, so this observation cannot depend on a clone remembered by an earlier JS object.
    const destination = resolveWithinRoot(
      this.workspaceRoot,
      input.destination,
      "destination",
    );
    const cloned = await this.system.pathExists(join(destination, ".git"));
    return { visibility: input.visibility, cloned };
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
export class ProductionWorkspaceHostCredentialMaterializer implements WorkspaceHostCredentialMaterializer {
  readonly family: WorkspaceHostCredentialFamily;
  private readonly system: WorkspaceHostSystem;
  private readonly locate: (
    binding: WorkspaceHostCredentialBindingDescriptor,
  ) => string | null;
  private readonly gitCredentialBindings?: WorkspaceHostGitCredentialBindingRegistry;
  private readonly agentHomeConsumer?: WorkspaceHostAgentHomeConsumer;
  private readonly recordRevocation?: (generation: number) => Promise<void>;
  private readonly lifecycleLockPath?: string;

  constructor(
    family: WorkspaceHostCredentialFamily,
    system: WorkspaceHostSystem,
    locate: (
      binding: WorkspaceHostCredentialBindingDescriptor,
    ) => string | null,
    gitCredentialBindings?: WorkspaceHostGitCredentialBindingRegistry,
    agentHomeConsumer?: WorkspaceHostAgentHomeConsumer,
    recordRevocation?: (generation: number) => Promise<void>,
    lifecycleLockPath?: string,
  ) {
    this.family = family;
    this.system = system;
    this.locate = locate;
    this.gitCredentialBindings = gitCredentialBindings;
    this.agentHomeConsumer = agentHomeConsumer;
    this.recordRevocation = recordRevocation;
    this.lifecycleLockPath = lifecycleLockPath;
  }

  private async withLifecycleLock<T>(task: () => Promise<T>): Promise<T> {
    if (!this.lifecycleLockPath) return await task();
    return await withWorkspaceHostCredentialFilesystemLock(
      this.system,
      this.lifecycleLockPath,
      task,
    );
  }

  private agentFamily(): WorkspaceHostAgentHomeFamily | null {
    return WORKSPACE_HOST_AGENT_HOME_FAMILIES.includes(
      this.family as WorkspaceHostAgentHomeFamily,
    )
      ? (this.family as WorkspaceHostAgentHomeFamily)
      : null;
  }

  private async requireMaterial(
    binding: WorkspaceHostCredentialBindingDescriptor,
    operation: string,
  ): Promise<{ readonly path: string; readonly bytes: Buffer } | null> {
    const path = this.locate(binding);
    if (path === null) return null;
    const bytes = await this.system.readFileIfPresent(path);
    if (bytes === null) {
      throw new WorkspaceHostOperationError(
        `credential.${binding.channel}.${operation}`,
        1,
        `delivered material for family '${this.family}' is not present on the host`,
      );
    }
    return { path, bytes };
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

  async bind(
    binding: WorkspaceHostCredentialBindingDescriptor,
  ): Promise<Readonly<Record<string, unknown>>> {
    return await this.withLifecycleLock(async () => {
      const material = await this.requireMaterial(binding, "bind");
      const agentFamily = this.agentFamily();
      if (agentFamily) {
        if (!this.agentHomeConsumer || !material) {
          throw new WorkspaceHostOperationError(
            `credential.${binding.channel}.bind`,
            1,
            `no agent-home consumer is configured for family '${this.family}'`,
          );
        }
        await this.agentHomeConsumer.install(
          agentFamily,
          binding.generation,
          material.bytes,
          { lockHeld: true },
        );
      } else if (binding.channel === "git" && material) {
        if (!this.gitCredentialBindings) {
          throw new WorkspaceHostOperationError(
            "credential.git.bind",
            1,
            "no durable Git binding registry is configured",
          );
        }
        await this.gitCredentialBindings.bind(binding, material.path, {
          lockHeld: true,
        });
      } else if (binding.channel !== "cloud" && !material) {
        throw new WorkspaceHostOperationError(
          `credential.${binding.channel}.bind`,
          1,
          `family '${this.family}' requires delivered material`,
        );
      }
      return this.describe(binding, true);
    });
  }

  async verifyBound(
    binding: WorkspaceHostCredentialBindingDescriptor,
  ): Promise<Readonly<Record<string, unknown>>> {
    return await this.withLifecycleLock(async () => {
      const material = await this.requireMaterial(binding, "verify-bound");
      const agentFamily = this.agentFamily();
      if (agentFamily) {
        if (!this.agentHomeConsumer || !material) {
          throw new WorkspaceHostOperationError(
            `credential.${binding.channel}.verify-bound`,
            1,
            `no agent-home consumer is configured for family '${this.family}'`,
          );
        }
        await this.agentHomeConsumer.verify(
          agentFamily,
          binding.generation,
          material.bytes,
          { lockHeld: true },
        );
      } else if (binding.channel === "git" && material) {
        await this.gitCredentialBindings?.verifyBound(binding, material.path, {
          lockHeld: true,
        });
      }
      return this.describe(binding, true);
    });
  }

  async revoke(
    binding: WorkspaceHostCredentialBindingDescriptor,
  ): Promise<Readonly<Record<string, unknown>>> {
    return await this.withLifecycleLock(async () => {
      const path = this.locate(binding);
      const agentFamily = this.agentFamily();
      if (agentFamily) {
        if (!this.agentHomeConsumer) {
          throw new WorkspaceHostOperationError(
            `credential.${binding.channel}.revoke`,
            1,
            `no agent-home consumer is configured for family '${this.family}'`,
          );
        }
        await this.agentHomeConsumer.revoke(agentFamily, binding.generation, {
          lockHeld: true,
        });
      }
      await this.gitCredentialBindings?.revoke(binding, { lockHeld: true });
      if (path !== null) await this.system.removePath(path);
      // The ledger is raised before success is reported, because it is the only durable trace that
      // this generation was destroyed. Keep the whole sequence under one family lock so a delivery
      // cannot slip between unlink and the high-water update.
      if (path !== null) await this.recordRevocation?.(binding.generation);
      return this.describe(binding, false);
    });
  }

  async verifyRevoked(
    binding: WorkspaceHostCredentialBindingDescriptor,
  ): Promise<Readonly<Record<string, unknown>>> {
    return await this.withLifecycleLock(async () => {
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
      const agentFamily = this.agentFamily();
      if (agentFamily) {
        if (!this.agentHomeConsumer) {
          throw new WorkspaceHostOperationError(
            `credential.${binding.channel}.verify-revoked`,
            1,
            `no agent-home consumer is configured for family '${this.family}'`,
          );
        }
        await this.agentHomeConsumer.verifyRevoked(
          agentFamily,
          binding.generation,
          { lockHeld: true },
        );
      }
      await this.gitCredentialBindings?.verifyRevoked(binding, {
        lockHeld: true,
      });
      return this.describe(binding, false);
    });
  }
}

/** Where each family's delivered material lives on the host, or null when it is ambient. */
export const WORKSPACE_HOST_CREDENTIAL_MATERIAL_ROOT =
  "/var/lib/papercusp/credentials";

function materialPathFor(
  root: string,
  family: WorkspaceHostCredentialFamily,
): (binding: WorkspaceHostCredentialBindingDescriptor) => string | null {
  return (binding) => {
    // Derived from the family spec, never from a hard-coded family name (D-215): a family that is
    // answered ambiently by the environment has no file to check, and inventing one would make
    // bind() pass against a path we created ourselves. Keying on the spec means a fifth family
    // has to declare which it is instead of silently inheriting the wrong branch.
    if (
      !WORKSPACE_HOST_CREDENTIAL_FAMILY_SPECS[family].requiresDeliveredMaterial
    )
      return null;
    // The layout is owned by the delivery module — the writer and this reader must agree on the
    // path, and two `join` calls that happen to match today are how they stop matching later.
    return workspaceHostCredentialMaterialPath(
      root,
      family,
      binding.generation,
    );
  };
}

export function createProductionWorkspaceHostCredentialMaterializers(
  system: WorkspaceHostSystem,
  materialRoot: string = WORKSPACE_HOST_CREDENTIAL_MATERIAL_ROOT,
  gitCredentialBindings?: WorkspaceHostGitCredentialBindingRegistry,
  agentHomeConsumer?: WorkspaceHostAgentHomeConsumer,
): readonly WorkspaceHostCredentialMaterializer[] {
  const durableGitBindings =
    gitCredentialBindings ??
    new WorkspaceHostGitCredentialBindingRegistry(system, materialRoot);
  const durableAgentHome =
    agentHomeConsumer ??
    new WorkspaceHostAgentHomeConsumer({
      filesystem: system,
      materialRoot,
      agentHome: WORKSPACE_HOST_DEFAULT_AGENT_HOME,
      agentUser: DEFAULT_WORKSPACE_HOST_AGENT_USER,
      agentGroup: DEFAULT_WORKSPACE_HOST_AGENT_USER,
    });
  // Enumerated explicitly rather than mapped over WORKSPACE_HOST_CREDENTIAL_FAMILIES: adding a
  // family should be a decision that lands here deliberately, not one that silently acquires a
  // default binding policy from a loop.
  const families: readonly WorkspaceHostCredentialFamily[] = [
    "cloud-workload-identity",
    "git-short-lived-delegation",
    "agent-forwarded-reference",
    "agent-encrypted-reference",
  ];
  return families.map(
    (family) =>
      new ProductionWorkspaceHostCredentialMaterializer(
        family,
        system,
        materialPathFor(materialRoot, family),
        durableGitBindings,
        durableAgentHome,
        // Only families with an on-host artifact have anything to revoke, so only they carry a
        // ledger. Passing one for an ambient family would create a revocation record for material
        // that never existed.
        WORKSPACE_HOST_CREDENTIAL_FAMILY_SPECS[family].requiresDeliveredMaterial
          ? async (generation: number) =>
              // Through the SAME `system` seam every other host operation uses. A second
              // filesystem here — even one defaulting to the real node implementation — means a
              // caller that faked the host still writes to the machine running it.
              await recordWorkspaceHostCredentialRevocation(
                system,
                materialRoot,
                family,
                generation,
                { lockHeld: true },
              )
          : undefined,
        WORKSPACE_HOST_CREDENTIAL_FAMILY_SPECS[family].requiresDeliveredMaterial
          ? workspaceHostCredentialFamilyLockPath(materialRoot, family)
          : undefined,
      ),
  );
}

export interface ProductionWorkspaceHostRemoteInitializerOptions extends ProductionWorkspaceHostOptions {}

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
  const materialRoot =
    options.credentialMaterialRoot ?? WORKSPACE_HOST_CREDENTIAL_MATERIAL_ROOT;
  const workspaceUser =
    options.workspaceUser ?? DEFAULT_WORKSPACE_HOST_WORKSPACE_USER;
  const workspaceGroup = options.workspaceGroup ?? workspaceUser;
  const workspaceHome = options.workspaceHome ?? `/home/${workspaceUser}`;
  const agentUser = options.agentUser ?? DEFAULT_WORKSPACE_HOST_AGENT_USER;
  const agentGroup = options.agentGroup ?? agentUser;
  const agentHome = options.agentHome ?? `/home/${agentUser}`;
  const gitCredentialBindings =
    options.gitCredentialBindings ??
    new WorkspaceHostGitCredentialBindingRegistry(system, materialRoot);
  // The delivered Claude/Codex/OMP material lands in the AGENT identity's 0700 home, not the SSH
  // login's. This wiring is the whole of the credential half of D-248: everything downstream
  // (ownership, the probe's HOME, what the customer can read over SSH) follows from these three.
  const agentHomeConsumer = new WorkspaceHostAgentHomeConsumer({
    filesystem: system,
    materialRoot,
    agentHome,
    agentUser,
    agentGroup,
  });
  return {
    host: new ProductionWorkspaceHostRemoteInitializerHost({
      ...options,
      system,
      credentialMaterialRoot: materialRoot,
      workspaceHome,
      workspaceUser,
      workspaceGroup,
      agentHome,
      agentUser,
      agentGroup,
      gitCredentialBindings,
    }),
    credentials: new WorkspaceHostCredentialResolver(
      createProductionWorkspaceHostCredentialMaterializers(
        system,
        materialRoot,
        gitCredentialBindings,
        agentHomeConsumer,
      ),
    ),
    ...(options.now ? { now: options.now } : {}),
  };
}
