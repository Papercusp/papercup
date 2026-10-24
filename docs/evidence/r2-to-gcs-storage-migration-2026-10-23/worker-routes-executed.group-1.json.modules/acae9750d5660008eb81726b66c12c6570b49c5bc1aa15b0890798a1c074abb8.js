__vite_ssr_exportName__("WORKSPACE_HOST_DEFAULT_WORKSPACE_ROOT", () => { try { return WORKSPACE_HOST_DEFAULT_WORKSPACE_ROOT } catch {} });
__vite_ssr_exportName__("WORKSPACE_HOST_DEFAULT_WORKSPACE_HOME", () => { try { return WORKSPACE_HOST_DEFAULT_WORKSPACE_HOME } catch {} });
__vite_ssr_exportName__("WORKSPACE_HOST_DEFAULT_AGENT_HOME", () => { try { return WORKSPACE_HOST_DEFAULT_AGENT_HOME } catch {} });
__vite_ssr_exportName__("WORKSPACE_HOST_RELEASE_BIN_DIR", () => { try { return WORKSPACE_HOST_RELEASE_BIN_DIR } catch {} });
__vite_ssr_exportName__("WORKSPACE_HOST_BOOTSTRAP_ATTESTATION_FILE", () => { try { return WORKSPACE_HOST_BOOTSTRAP_ATTESTATION_FILE } catch {} });
__vite_ssr_exportName__("WORKSPACE_HOST_DEFAULT_AGENT_PROBE_PATH", () => { try { return WORKSPACE_HOST_DEFAULT_AGENT_PROBE_PATH } catch {} });
__vite_ssr_exportName__("WORKSPACE_HOST_DEFAULT_WORKSPACE_COMMAND", () => { try { return WORKSPACE_HOST_DEFAULT_WORKSPACE_COMMAND } catch {} });
__vite_ssr_exportName__("WORKSPACE_HOST_DEFAULT_COMMAND_TIMEOUT_MS", () => { try { return WORKSPACE_HOST_DEFAULT_COMMAND_TIMEOUT_MS } catch {} });
__vite_ssr_exportName__("workspaceHostGetOnlyGitCredentialEnvironment", () => { try { return workspaceHostGetOnlyGitCredentialEnvironment } catch {} });
__vite_ssr_exportName__("WorkspaceHostOperationError", () => { try { return WorkspaceHostOperationError } catch {} });
__vite_ssr_exportName__("NodeWorkspaceHostSystem", () => { try { return NodeWorkspaceHostSystem } catch {} });
__vite_ssr_exportName__("WorkspaceHostGitCredentialBindingRegistry", () => { try { return WorkspaceHostGitCredentialBindingRegistry } catch {} });
__vite_ssr_exportName__("ProductionWorkspaceHostRemoteInitializerHost", () => { try { return ProductionWorkspaceHostRemoteInitializerHost } catch {} });
__vite_ssr_exportName__("ProductionWorkspaceHostCredentialMaterializer", () => { try { return ProductionWorkspaceHostCredentialMaterializer } catch {} });
__vite_ssr_exportName__("WORKSPACE_HOST_CREDENTIAL_MATERIAL_ROOT", () => { try { return WORKSPACE_HOST_CREDENTIAL_MATERIAL_ROOT } catch {} });
__vite_ssr_exportName__("createProductionWorkspaceHostCredentialMaterializers", () => { try { return createProductionWorkspaceHostCredentialMaterializers } catch {} });
__vite_ssr_exportName__("createProductionWorkspaceHostRemoteInitializerDeps", () => { try { return createProductionWorkspaceHostRemoteInitializerDeps } catch {} });
const __vite_ssr_import_0__ = await __vite_ssr_import__("node:child_process", {"importedNames":["execFile"]});
const __vite_ssr_import_1__ = await __vite_ssr_import__("node:fs/promises", {"importedNames":["lstat","rm","stat"]});
const __vite_ssr_import_2__ = await __vite_ssr_import__("node:path", {"importedNames":["isAbsolute","join"]});
const __vite_ssr_import_3__ = await __vite_ssr_import__("/@fs/home/marsh-office/papercupai-workspace/papercusp/libs/generic/deployment-driver/src/workspace-host-desktop-pack.ts", {"importedNames":["buildWorkspaceHostDesktopPackScript","parseWorkspaceHostDesktopPackAttestation","PINNED_KASMVNC_ARTIFACT","WORKSPACE_HOST_DESKTOP_PACK_CONTRACT_VERSION"]});
const __vite_ssr_import_4__ = await __vite_ssr_import__("/@fs/home/marsh-office/papercupai-workspace/papercusp/libs/generic/deployment-driver/src/workspace-host-agent-authentication.ts", {"importedNames":["NodeWorkspaceHostAgentProbeRunner","probeWorkspaceHostAgents","WORKSPACE_HOST_CANARY_AGENTS"]});
const __vite_ssr_import_5__ = await __vite_ssr_import__("/@fs/home/marsh-office/papercupai-workspace/papercusp/libs/generic/deployment-driver/src/workspace-host-credential-namespace.ts", {"importedNames":["WORKSPACE_HOST_CREDENTIAL_FAMILY_SPECS","WorkspaceHostCredentialResolver","workspaceHostCredentialReferenceDigest"]});
const __vite_ssr_import_6__ = await __vite_ssr_import__("/@fs/home/marsh-office/papercupai-workspace/papercusp/libs/generic/deployment-driver/src/workspace-host-credential-delivery.ts", {"importedNames":["NodeWorkspaceHostCredentialDeliveryFilesystem","ensureSharedWorkspaceDirectory","recordWorkspaceHostCredentialRevocation","withWorkspaceHostCredentialFilesystemLock","workspaceHostCredentialFamilyLockPath","workspaceHostCredentialMaterialPath"]});
const __vite_ssr_import_7__ = await __vite_ssr_import__("/@fs/home/marsh-office/papercupai-workspace/papercusp/libs/generic/deployment-driver/src/workspace-host-agent-home.ts", {"importedNames":["WorkspaceHostAgentHomeConsumer","WORKSPACE_HOST_AGENT_HOME_FAMILIES","requireExplicitWorkspaceHostHome"]});
const __vite_ssr_import_8__ = await __vite_ssr_import__("/@fs/home/marsh-office/papercupai-workspace/papercusp/libs/generic/deployment-driver/src/workspace-host-bootstrap.ts", {"importedNames":["DEFAULT_WORKSPACE_HOST_AGENT_USER","DEFAULT_WORKSPACE_HOST_WORKSPACE_USER","WORKSPACE_HOST_CUSTOMER_AGENT_TOOLCHAIN_BIN","WORKSPACE_HOST_DATA_ROOT","WORKSPACE_HOST_RUNTIME_ROOT","WORKSPACE_HOST_STATE_ROOT"]});









const WORKSPACE_HOST_DEFAULT_WORKSPACE_ROOT = __vite_ssr_import_8__.WORKSPACE_HOST_DATA_ROOT;
const WORKSPACE_HOST_DEFAULT_WORKSPACE_HOME = `/home/${__vite_ssr_import_8__.DEFAULT_WORKSPACE_HOST_WORKSPACE_USER}`;
const WORKSPACE_HOST_DEFAULT_AGENT_HOME = `/home/${__vite_ssr_import_8__.DEFAULT_WORKSPACE_HOST_AGENT_USER}`;
const WORKSPACE_HOST_RELEASE_BIN_DIR = `${__vite_ssr_import_8__.WORKSPACE_HOST_RUNTIME_ROOT}/current/bin`;
const WORKSPACE_HOST_BOOTSTRAP_ATTESTATION_FILE = `${__vite_ssr_import_8__.WORKSPACE_HOST_STATE_ROOT}/bootstrap-attestation.json`;
const WORKSPACE_HOST_DEFAULT_AGENT_PROBE_PATH = `${__vite_ssr_import_8__.WORKSPACE_HOST_CUSTOMER_AGENT_TOOLCHAIN_BIN}:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`;
const WORKSPACE_HOST_DEFAULT_WORKSPACE_COMMAND = "papercup";
const WORKSPACE_HOST_DEFAULT_COMMAND_TIMEOUT_MS = 3e5;
function workspaceHostGetOnlyGitCredentialEnvironment(materialPath) {
  if (!(0,__vite_ssr_import_2__.isAbsolute)(materialPath) || /[\0\r\n]/.test(materialPath)) {
    throw new Error(
      "Git credential material path must be an absolute single-line path"
    );
  };
  const quotedMaterialPath = `'${materialPath.replaceAll("'", "'\\''")}'`;
  return Object.freeze({
    GIT_TERMINAL_PROMPT: "0",
    GIT_ASKPASS: "/bin/false",
    SSH_ASKPASS: "/bin/false",
    GCM_INTERACTIVE: "never",
    GIT_CONFIG_COUNT: "3",
    GIT_CONFIG_KEY_0: "credential.helper",
    GIT_CONFIG_VALUE_0: "",
    GIT_CONFIG_KEY_1: "credential.helper",
    GIT_CONFIG_VALUE_1: `!f() { if [ "$1" = get ]; then git credential-store --file=${quotedMaterialPath} get; fi; }; f`,
    GIT_CONFIG_KEY_2: "credential.useHttpPath",
    GIT_CONFIG_VALUE_2: "true"
  });
};
class WorkspaceHostOperationError extends Error {
  operation;
  exitCode;
  constructor(operation, exitCode, detail) {
    super(
      `workspace host operation '${operation}' failed with exit ${exitCode}: ${detail}`
    );
    this.name = "WorkspaceHostOperationError";
    this.operation = operation;
    this.exitCode = exitCode;
  }
};
function diagnosticTail(text, maxChars = 2e3) {
  const trimmed = text.trim();
  if (trimmed.length <= maxChars) return trimmed || "(no diagnostic output)";
  return `…${trimmed.slice(-maxChars)}`;
}
class NodeWorkspaceHostSystem {
  async run(input) {
    return await new Promise((resolve) => {
      (0,__vite_ssr_import_0__.execFile)(
        input.command,
        [...input.args],
        {
          cwd: input.cwd,
          ...input.env ? { env: { ...process.env, ...input.env } } : {},
          timeout: input.timeoutMs ?? WORKSPACE_HOST_DEFAULT_COMMAND_TIMEOUT_MS,
          maxBuffer: 16 * 1024 * 1024,
          // The child must never inherit an interactive terminal: every command here runs
          // unattended, and a CLI that decides to prompt would hang the step until the timeout.
          windowsHide: true
        },
        (error, stdout, stderr) => {
          const code = error && typeof error.code === "number" ? error.code : error ? 1 : 0;
          resolve({
            exitCode: code,
            stdout: String(stdout ?? ""),
            stderr: String(stderr ?? "")
          });
        }
      );
    });
  }
  async ensureDirectory(path) {
    await this.deliveryFilesystem.ensureDirectory(path);
  }
  async ensureWorkspaceDirectory(path) {
    await (0,__vite_ssr_import_6__.ensureSharedWorkspaceDirectory)(path);
  }
  async pathExists(path) {
    try {
      await (0,__vite_ssr_import_1__.stat)(path);
      return true;
    } catch {
      return false;
    }
  }
  async pathKind(path) {
    try {
      const info = await (0,__vite_ssr_import_1__.lstat)(path);
      if (info.isSymbolicLink()) return "symlink";
      if (info.isDirectory()) return "directory";
      if (info.isFile()) return "file";
      return "other";
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT")
        return "missing";
      throw error;
    }
  }
  async withExclusiveLock(path, task) {
    return await this.deliveryFilesystem.withExclusiveLock(path, task);
  }
  async removePath(path) {
    await (0,__vite_ssr_import_1__.rm)(path, { recursive: true, force: true });
  }
  async changeOwnership(path, owner, group, recursive) {
    await new Promise((resolve, reject) => {
      (0,__vite_ssr_import_0__.execFile)(
        "chown",
        [...recursive ? ["-R"] : ["-h"], `${owner}:${group}`, path],
        (error) => error ? reject(error) : resolve()
      );
    });
  }
  async setOwnership(path, owner, group) {
    await this.changeOwnership(path, owner, group, false);
  }
  async setOwnershipRecursively(path, owner, group) {
    await this.changeOwnership(path, owner, group, true);
  }
  // The two credential-delivery operations. Delegated to the delivery module's implementation
  // rather than re-derived here, so the 0600/atomic-rename behaviour has one definition and the
  // packaged delivery entrypoint and this host adapter cannot drift on how material is written.
  async writePrivateFile(path, bytes) {
    await this.deliveryFilesystem.writePrivateFile(path, bytes);
  }
  async readFileIfPresent(path) {
    return await this.deliveryFilesystem.readFileIfPresent(path);
  }
  deliveryFilesystem = new __vite_ssr_import_6__.NodeWorkspaceHostCredentialDeliveryFilesystem();
};
class WorkspaceHostGitCredentialBindingRegistry {
  filesystem;
  materialRoot;
  constructor(filesystem = new NodeWorkspaceHostSystem(), materialRoot = WORKSPACE_HOST_CREDENTIAL_MATERIAL_ROOT) {
    this.filesystem = filesystem;
    this.materialRoot = materialRoot;
  }
  static statePath(materialRoot) {
    return (0,__vite_ssr_import_2__.join)(materialRoot, "active", "git-binding.json");
  }
  async readState() {
    const raw = await this.filesystem.readFileIfPresent(
      WorkspaceHostGitCredentialBindingRegistry.statePath(this.materialRoot)
    );
    if (raw === null) return null;
    let parsed;
    try {
      parsed = JSON.parse(raw.toString("utf8"));
    } catch {
      throw new WorkspaceHostOperationError(
        "credential.git.state",
        1,
        "active Git binding state is malformed"
      );
    };
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new WorkspaceHostOperationError(
        "credential.git.state",
        1,
        "active Git binding state is malformed"
      );
    };
    const body = parsed;
    if (body.contractVersion !== WORKSPACE_HOST_GIT_BINDING_STATE_VERSION || body.channel !== "git" || body.family !== "git-short-lived-delegation" || !Number.isSafeInteger(body.generation) || body.generation < 1 || typeof body.materialPath !== "string" || body.expiresAt !== void 0 && (typeof body.expiresAt !== "string" || !Number.isFinite(Date.parse(body.expiresAt)))) {
      throw new WorkspaceHostOperationError(
        "credential.git.state",
        1,
        "active Git binding state is malformed"
      );
    };
    const expectedPath = (0,__vite_ssr_import_6__.workspaceHostCredentialMaterialPath)(
      this.materialRoot,
      "git-short-lived-delegation",
      body.generation
    );
    if (body.materialPath !== expectedPath) {
      throw new WorkspaceHostOperationError(
        "credential.git.state",
        1,
        "active Git binding state points outside the canonical material path"
      );
    };
    return {
      generation: body.generation,
      materialPath: body.materialPath,
      ...body.expiresAt ? { expiresAt: body.expiresAt } : {}
    };
  }
  async bindUnlocked(binding, materialPath) {
    if (binding.channel !== "git") return;
    const expectedPath = (0,__vite_ssr_import_6__.workspaceHostCredentialMaterialPath)(
      this.materialRoot,
      "git-short-lived-delegation",
      binding.generation
    );
    if (materialPath !== expectedPath) {
      throw new WorkspaceHostOperationError(
        "credential.git.bind",
        1,
        "Git binding material path is not the canonical generation path"
      );
    };
    const current = await this.readState();
    if (current && current.generation > binding.generation) {
      throw new WorkspaceHostOperationError(
        "credential.git.bind",
        1,
        `cannot activate generation ${binding.generation} below active generation ${current.generation}`
      );
    };
    if (current && current.generation === binding.generation && (current.materialPath !== materialPath || current.expiresAt !== binding.expiresAt)) {
      throw new WorkspaceHostOperationError(
        "credential.git.bind",
        1,
        `generation ${binding.generation} is already active with different binding state`
      );
    };
    await this.filesystem.ensureDirectory((0,__vite_ssr_import_2__.join)(this.materialRoot, "active"));
    await this.filesystem.writePrivateFile(
      WorkspaceHostGitCredentialBindingRegistry.statePath(this.materialRoot),
      Buffer.from(
        JSON.stringify({
          contractVersion: WORKSPACE_HOST_GIT_BINDING_STATE_VERSION,
          channel: "git",
          family: "git-short-lived-delegation",
          generation: binding.generation,
          materialPath,
          ...binding.expiresAt ? { expiresAt: binding.expiresAt } : {}
        }),
        "utf8"
      )
    );
  }
  async bind(binding, materialPath, options = {}) {
    const task = () => this.bindUnlocked(binding, materialPath);
    if (options.lockHeld) return await task();
    return await (0,__vite_ssr_import_6__.withWorkspaceHostCredentialFilesystemLock)(
      this.filesystem,
      (0,__vite_ssr_import_6__.workspaceHostCredentialFamilyLockPath)(
        this.materialRoot,
        "git-short-lived-delegation"
      ),
      task
    );
  }
  async revokeUnlocked(binding) {
    if (binding.channel !== "git") return;
    const current = await this.readState();
    if (!current || current.generation !== binding.generation) return;
    await this.filesystem.removePath(
      WorkspaceHostGitCredentialBindingRegistry.statePath(this.materialRoot)
    );
  }
  async revoke(binding, options = {}) {
    const task = () => this.revokeUnlocked(binding);
    if (options.lockHeld) return await task();
    return await (0,__vite_ssr_import_6__.withWorkspaceHostCredentialFilesystemLock)(
      this.filesystem,
      (0,__vite_ssr_import_6__.workspaceHostCredentialFamilyLockPath)(
        this.materialRoot,
        "git-short-lived-delegation"
      ),
      task
    );
  }
  async verifyBoundUnlocked(binding, materialPath) {
    if (binding.channel !== "git") return;
    const current = await this.readState();
    if (!current || current.generation !== binding.generation || current.materialPath !== materialPath || current.expiresAt !== binding.expiresAt) {
      throw new WorkspaceHostOperationError(
        "credential.git.verify-bound",
        1,
        `generation ${binding.generation} is not the active Git binding`
      );
    }
  }
  async verifyBound(binding, materialPath, options = {}) {
    const task = () => this.verifyBoundUnlocked(binding, materialPath);
    if (options.lockHeld) return await task();
    return await (0,__vite_ssr_import_6__.withWorkspaceHostCredentialFilesystemLock)(
      this.filesystem,
      (0,__vite_ssr_import_6__.workspaceHostCredentialFamilyLockPath)(
        this.materialRoot,
        "git-short-lived-delegation"
      ),
      task
    );
  }
  async verifyRevokedUnlocked(binding) {
    if (binding.channel !== "git") return;
    const current = await this.readState();
    if (current?.generation === binding.generation) {
      throw new WorkspaceHostOperationError(
        "credential.git.verify-revoked",
        1,
        `generation ${binding.generation} is still the active Git binding`
      );
    }
  }
  async verifyRevoked(binding, options = {}) {
    const task = () => this.verifyRevokedUnlocked(binding);
    if (options.lockHeld) return await task();
    return await (0,__vite_ssr_import_6__.withWorkspaceHostCredentialFilesystemLock)(
      this.filesystem,
      (0,__vite_ssr_import_6__.workspaceHostCredentialFamilyLockPath)(
        this.materialRoot,
        "git-short-lived-delegation"
      ),
      task
    );
  }
  async resolve(now) {
    const active = await this.readState();
    if (!active) {
      throw new WorkspaceHostOperationError(
        "cloneRepository.credentials",
        1,
        "no bound git credential material is available for a private clone"
      );
    };
    if (active.expiresAt && Date.parse(active.expiresAt) <= now.getTime()) {
      throw new WorkspaceHostOperationError(
        "cloneRepository.credentials",
        1,
        "the bound git credential material has expired"
      );
    };
    return active;
  }
};
const WORKSPACE_HOST_GIT_BINDING_STATE_VERSION = "papercusp-workspace-host-git-binding-state-v1";
function resolveWithinRoot(root, candidate, label) {
  if ((0,__vite_ssr_import_2__.isAbsolute)(candidate)) {
    throw new WorkspaceHostOperationError(
      label,
      1,
      `${label} must be workspace-relative`
    );
  };
  const resolved = (0,__vite_ssr_import_2__.join)(root, candidate);
  if (resolved !== root && !resolved.startsWith(`${root}/`)) {
    throw new WorkspaceHostOperationError(
      label,
      1,
      `${label} escapes the workspace root`
    );
  };
  return resolved;
}
const WORKSPACE_HOST_LINUX_ACCOUNT = /^[a-z_][a-z0-9_-]{0,30}$/;
function requireWorkspaceAccount(value, label) {
  if (!WORKSPACE_HOST_LINUX_ACCOUNT.test(value) || value === "root") {
    throw new WorkspaceHostOperationError(
      label,
      1,
      `${label} must be a non-root Linux account name`
    );
  };
  return value;
}
class ProductionWorkspaceHostRemoteInitializerHost {
  system;
  workspaceRoot;
  workspaceCommand;
  gitCommand;
  agentProbeRunner;
  now;
  gitCredentialBindings;
  workspaceHome;
  workspaceUser;
  workspaceGroup;
  agentHome;
  agentUser;
  agentGroup;
  agentProbePath;
  agentRuntimeAttestationPath;
  customerAgentToolchainBin;
  constructor(options = {}) {
    this.system = options.system ?? new NodeWorkspaceHostSystem();
    this.workspaceRoot = options.workspaceRoot ?? WORKSPACE_HOST_DEFAULT_WORKSPACE_ROOT;
    this.workspaceCommand = options.workspaceCommand ?? WORKSPACE_HOST_DEFAULT_WORKSPACE_COMMAND;
    this.gitCommand = options.gitCommand ?? "git";
    this.agentProbeRunner = options.agentProbeRunner ?? new __vite_ssr_import_4__.NodeWorkspaceHostAgentProbeRunner();
    this.now = options.now ?? (() => /* @__PURE__ */ new Date());
    this.workspaceHome = (0,__vite_ssr_import_7__.requireExplicitWorkspaceHostHome)(
      options.workspaceHome ?? WORKSPACE_HOST_DEFAULT_WORKSPACE_HOME
    );
    this.workspaceUser = requireWorkspaceAccount(
      options.workspaceUser ?? __vite_ssr_import_8__.DEFAULT_WORKSPACE_HOST_WORKSPACE_USER,
      "workspaceUser"
    );
    this.workspaceGroup = requireWorkspaceAccount(
      options.workspaceGroup ?? this.workspaceUser,
      "workspaceGroup"
    );
    this.agentUser = requireWorkspaceAccount(
      options.agentUser ?? __vite_ssr_import_8__.DEFAULT_WORKSPACE_HOST_AGENT_USER,
      "agentUser"
    );
    this.agentGroup = requireWorkspaceAccount(
      options.agentGroup ?? this.agentUser,
      "agentGroup"
    );
    this.agentHome = (0,__vite_ssr_import_7__.requireExplicitWorkspaceHostHome)(
      options.agentHome ?? `/home/${this.agentUser}`
    );
    if (this.agentUser === this.workspaceUser) {
      throw new WorkspaceHostOperationError(
        "agentUser",
        1,
        "agentUser must differ from workspaceUser: the agent identity exists so the SSH login is not the account that reads the runtime (D-043, D-248)"
      );
    };
    this.agentProbePath = options.agentProbePath ?? WORKSPACE_HOST_DEFAULT_AGENT_PROBE_PATH;
    if (!this.agentProbePath.startsWith("/") || /[\r\n\0]/.test(this.agentProbePath)) {
      throw new WorkspaceHostOperationError(
        "agentProbePath",
        1,
        "agentProbePath must be an absolute, newline-free search path"
      );
    };
    this.agentRuntimeAttestationPath = options.agentRuntimeAttestationPath ?? WORKSPACE_HOST_BOOTSTRAP_ATTESTATION_FILE;
    this.customerAgentToolchainBin = (0,__vite_ssr_import_7__.requireExplicitWorkspaceHostHome)(
      options.customerAgentToolchainBin ?? __vite_ssr_import_8__.WORKSPACE_HOST_CUSTOMER_AGENT_TOOLCHAIN_BIN
    );
    this.gitCredentialBindings = options.gitCredentialBindings ?? new WorkspaceHostGitCredentialBindingRegistry(
      this.system,
      options.credentialMaterialRoot ?? WORKSPACE_HOST_CREDENTIAL_MATERIAL_ROOT
    );
  }
  async require(operation, input) {
    const result = await this.system.run(input);
    if (result.exitCode !== 0) {
      throw new WorkspaceHostOperationError(
        operation,
        result.exitCode,
        diagnosticTail(result.stderr)
      );
    };
    return result;
  }
  async installDesktopPack(input) {
    if (!/^[a-z0-9][a-z0-9._-]{0,127}$/i.test(input.hostId)) {
      throw new WorkspaceHostOperationError("installDesktopPack", 1, "invalid desktop-pack hostId");
    };
    const { script } = (0,__vite_ssr_import_3__.buildWorkspaceHostDesktopPackScript)({
      contractVersion: __vite_ssr_import_3__.WORKSPACE_HOST_DESKTOP_PACK_CONTRACT_VERSION,
      action: "install",
      hostId: input.hostId
    });
    const result = await this.require("installDesktopPack", {
      command: "/bin/bash",
      args: ["-c", script]
    });
    const attestation = (0,__vite_ssr_import_3__.parseWorkspaceHostDesktopPackAttestation)(result.stdout);
    if (attestation.hostId !== input.hostId || attestation.action !== "install" || attestation.kasmvnc?.version !== __vite_ssr_import_3__.PINNED_KASMVNC_ARTIFACT.version || attestation.kasmvnc?.sha256 !== __vite_ssr_import_3__.PINNED_KASMVNC_ARTIFACT.debSha256) {
      throw new WorkspaceHostOperationError("installDesktopPack", 1, "desktop pack attestation identity mismatch");
    };
    return { ...attestation };
  }
  async verifyRetainedWorkspace(input) {
    if (!/^[a-f0-9]{64}$/.test(input.tenantIdentity)) {
      throw new WorkspaceHostOperationError("verifyRetainedWorkspace", 1, "invalid retained tenant identity");
    };
    const directory = resolveWithinRoot(this.workspaceRoot, input.workspaceId, "workspaceId");
    await this.require("verifyRetainedWorkspace", {
      command: "/bin/bash",
      args: ["-c", [
        "set -euo pipefail",
        "tenant=$1; workspace_root=$2; directory=$3; native_home=$4; workspace_user=$5",
        "data_mount=/var/lib/papercusp",
        'read -r data_uuid data_fs data_root extra < <(findmnt -n --mountpoint "$data_mount" -o UUID,FSTYPE,FSROOT)',
        '[[ -n "$data_uuid" && "$data_fs" == ext4 && "$data_root" == / && -z "${extra:-}" ]]',
        'marker="$data_mount/.papercusp-tenant"',
        '[[ -f "$marker" && ! -L "$marker" && "$(stat -c %u:%a "$marker")" == 0:600 ]]',
        '[[ "$(cat "$marker")" == "papercusp-tenant-v1:$tenant:$data_uuid" ]]',
        '[[ -d "$directory" && ! -L "$directory" && -d "$native_home" && ! -L "$native_home" ]]',
        '[[ "$(stat -Lc %d:%i "$workspace_root")" == "$(stat -Lc %d:%i "$data_mount/workspaces")" ]]',
        '[[ "$(stat -Lc %d:%i "$native_home")" == "$(stat -Lc %d:%i "$data_mount/home/$workspace_user")" ]]',
        'sync -f "$native_home"'
      ].join("\n"), "--", input.tenantIdentity, this.workspaceRoot, directory, this.workspaceHome, this.workspaceUser]
    });
    return {
      workspaceId: input.workspaceId,
      hostId: input.hostId,
      directory,
      retained: true,
      nativeSessionHomeRetained: true,
      observedAt: this.now().toISOString()
    };
  }
  async createWorkspace(input) {
    const directory = resolveWithinRoot(
      this.workspaceRoot,
      input.workspaceId,
      "workspaceId"
    );
    await this.system.ensureWorkspaceDirectory(directory);
    await this.system.setOwnership?.(
      directory,
      this.workspaceUser,
      this.workspaceGroup
    );
    if (!await this.system.pathExists(directory)) {
      throw new WorkspaceHostOperationError(
        "createWorkspace",
        1,
        `workspace directory ${directory} does not exist after creation`
      );
    };
    return {
      workspaceId: input.workspaceId,
      hostId: input.hostId,
      directory,
      created: true,
      observedAt: this.now().toISOString()
    };
  }
  async cloneRepository(input) {
    const destination = resolveWithinRoot(
      this.workspaceRoot,
      input.destination,
      "destination"
    );
    let env;
    if (input.visibility === "private") {
      if (input.credentialChannel !== "git") {
        throw new WorkspaceHostOperationError(
          "cloneRepository.credentials",
          1,
          "a private repository clone must consume the bound 'git' credential channel"
        );
      };
      const binding = await this.gitCredentialBindings.resolve(this.now());
      if (!await this.system.pathExists(binding.materialPath)) {
        throw new WorkspaceHostOperationError(
          "cloneRepository.credentials",
          1,
          "the bound git credential material is absent from the host"
        );
      };
      env = workspaceHostGetOnlyGitCredentialEnvironment(binding.materialPath);
    };
    if (await this.system.pathExists(destination)) {
      const gitDirectory = (0,__vite_ssr_import_2__.join)(destination, ".git");
      if (!await this.system.pathExists(gitDirectory)) {
        throw new WorkspaceHostOperationError(
          "cloneRepository.resume",
          1,
          `existing destination ${destination} is not a Git worktree`
        );
      };
      const worktree = await this.require("cloneRepository.resume.worktree", {
        command: this.gitCommand,
        args: ["-C", destination, "rev-parse", "--is-inside-work-tree"]
      });
      if (worktree.stdout.trim() !== "true") {
        throw new WorkspaceHostOperationError(
          "cloneRepository.resume",
          1,
          `existing destination ${destination} is not a Git worktree`
        );
      };
      const remote = await this.require("cloneRepository.resume.origin", {
        command: this.gitCommand,
        args: ["-C", destination, "remote", "get-url", "origin"]
      });
      if (remote.stdout.trim().replace(/\/+$/, "") !== input.repositoryUrl.trim().replace(/\/+$/, "")) {
        throw new WorkspaceHostOperationError(
          "cloneRepository.resume",
          1,
          `existing destination ${destination} has a different origin`
        );
      };
      const status = await this.require("cloneRepository.resume.status", {
        command: this.gitCommand,
        args: [
          "-C",
          destination,
          "status",
          "--porcelain=v1",
          "--untracked-files=all"
        ]
      });
      if (status.stdout.trim() !== "") {
        throw new WorkspaceHostOperationError(
          "cloneRepository.resume",
          1,
          `existing destination ${destination} has uncommitted changes`
        );
      };
      if (input.revision) {
        const requested = await this.require(
          "cloneRepository.resume.revision",
          {
            command: this.gitCommand,
            args: [
              "-C",
              destination,
              "rev-parse",
              "--verify",
              `${input.revision}^{commit}`
            ]
          }
        );
        const head = await this.require("cloneRepository.resume.head", {
          command: this.gitCommand,
          args: ["-C", destination, "rev-parse", "HEAD"]
        });
        if (requested.stdout.trim() !== head.stdout.trim()) {
          throw new WorkspaceHostOperationError(
            "cloneRepository.resume",
            1,
            `existing destination ${destination} is not at requested revision ${input.revision}`
          );
        }
      };
      await this.system.setOwnershipRecursively?.(
        destination,
        this.workspaceUser,
        this.workspaceGroup
      );
      return {
        destination,
        visibility: input.visibility,
        cloned: false,
        reused: true,
        ...input.revision ? { revision: input.revision } : {},
        ...input.credentialChannel ? { credentialChannel: input.credentialChannel } : {},
        observedAt: this.now().toISOString()
      };
    };
    await this.require("cloneRepository", {
      command: this.gitCommand,
      args: ["clone", "--quiet", input.repositoryUrl, destination],
      ...env ? { env } : {}
    });
    if (input.revision) {
      await this.require("cloneRepository.checkout", {
        command: this.gitCommand,
        args: ["-C", destination, "checkout", "--quiet", input.revision]
      });
    };
    if (!await this.system.pathExists((0,__vite_ssr_import_2__.join)(destination, ".git"))) {
      throw new WorkspaceHostOperationError(
        "cloneRepository",
        1,
        `no .git directory at ${destination} after clone`
      );
    };
    await this.system.setOwnershipRecursively?.(
      destination,
      this.workspaceUser,
      this.workspaceGroup
    );
    return {
      destination,
      visibility: input.visibility,
      cloned: true,
      ...input.revision ? { revision: input.revision } : {},
      // The CHANNEL is public routing metadata; the credential itself never appears here.
      ...input.credentialChannel ? { credentialChannel: input.credentialChannel } : {},
      observedAt: this.now().toISOString()
    };
  }
  async pairWorkspace(input) {
    await this.require("pairWorkspace", {
      command: this.workspaceCommand,
      args: [
        "workspace",
        "pair",
        "--source",
        input.sourceWorkspaceId,
        "--pairing-ref",
        input.pairingReference.ref,
        ...input.include.flatMap((entry) => ["--include", entry])
      ]
    });
    return {
      sourceWorkspaceId: input.sourceWorkspaceId,
      // A pairing ref is a reference, not material — but it is still an identifier the controller
      // supplied, so it is digested rather than echoed. The controller can match the digest.
      pairingReferenceDigest: (0,__vite_ssr_import_5__.workspaceHostCredentialReferenceDigest)(
        input.pairingReference.ref
      ),
      include: [...input.include],
      paired: true,
      observedAt: this.now().toISOString()
    };
  }
  async importWorkspace(input) {
    await this.require("importWorkspace", {
      command: this.workspaceCommand,
      args: [
        "workspace",
        "import",
        "--source",
        input.sourceWorkspaceId,
        "--snapshot",
        input.sourceSnapshotRef,
        ...input.include.flatMap((entry) => ["--include", entry])
      ]
    });
    return {
      sourceWorkspaceId: input.sourceWorkspaceId,
      sourceSnapshotRef: input.sourceSnapshotRef,
      include: [...input.include],
      imported: true,
      observedAt: this.now().toISOString()
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
  async probeAgentVerification(requestedAgents) {
    return await (0,__vite_ssr_import_4__.probeWorkspaceHostAgents)({
      runner: this.agentProbeRunner,
      requestedAgents,
      now: this.now,
      // D-259 Defect 2: exec an explicit path, never a bare name a wrapper could answer. The
      // attestation says WHICH vendor CLIs bootstrap installed; the path executed is that CLI's
      // copy in the customer agent toolchain (D-423), because the attested install lives in the
      // platform agent home, which the account running these probes cannot read.
      runtimePaths: this.customerToolchainRuntimePaths(
        await this.readAttestedAgentRuntimePaths()
      ),
      // The CUSTOMER workspace account (D-421), the identity every customer-driven agent runs
      // as — so a passing probe proves the product path, not a platform-only one. HOME travels
      // with it: the delivered Claude/Codex material lives in that account's 0700 home, and a
      // probe with any other HOME would look for credentials that are not there and fail
      // identically to a genuine credential fault. D-043 is intact because this account reaches
      // only the toolchain, never `$RUNTIME_ROOT`.
      env: {
        HOME: this.workspaceHome,
        USER: this.workspaceUser,
        LOGNAME: this.workspaceUser,
        PATH: this.agentProbePath
      },
      runAsUser: this.workspaceUser
    });
  }
  /** Map each attested vendor CLI onto its customer-toolchain copy (D-423). */
  customerToolchainRuntimePaths(attested) {
    const paths = {};
    for (const agent of Object.keys(attested)) {
      paths[agent] = (0,__vite_ssr_import_2__.join)(this.customerAgentToolchainBin, agent);
    };
    return paths;
  }
  /**
   * Read the vendor runtime paths bootstrap recorded in its attestation (D-259 Defect 2).
   *
   * ABSENCE IS NOT AN ERROR, in three distinct shapes, and each one is a real host: no attestation
   * file (this adapter running somewhere that never bootstrapped), no `agentRuntimes` key (a host
   * provisioned before the vendor installs existed), or a key missing one agent (a partial
   * install). All three fall back to the probe's own command and therefore FAIL the probe, which
   * is the honest verdict — those hosts genuinely cannot authenticate that agent.
   *
   * MALFORMED IS an error, and the difference matters. Unreadable JSON, a non-object
   * `agentRuntimes`, or a non-absolute path means the attestation says something we cannot act on;
   * treating that as "no path recorded" would silently downgrade it to the fallback above and
   * report a probe failure whose real cause was a corrupt attestation nobody looked at.
   */
  async readAttestedAgentRuntimePaths() {
    const bytes = await this.system.readFileIfPresent(
      this.agentRuntimeAttestationPath
    );
    if (!bytes) return {};
    let parsed;
    try {
      parsed = JSON.parse(bytes.toString("utf8"));
    } catch {
      throw new WorkspaceHostOperationError(
        "readAttestedAgentRuntimePaths",
        1,
        `bootstrap attestation at ${this.agentRuntimeAttestationPath} is not valid JSON`
      );
    };
    const runtime = parsed?.runtime;
    const attested = runtime && typeof runtime === "object" ? runtime.agentRuntimes : void 0;
    if (attested === void 0) return {};
    if (typeof attested !== "object" || attested === null || Array.isArray(attested)) {
      throw new WorkspaceHostOperationError(
        "readAttestedAgentRuntimePaths",
        1,
        "bootstrap attestation runtime.agentRuntimes is not an object"
      );
    };
    const record = attested;
    const paths = {};
    for (const agent of __vite_ssr_import_4__.WORKSPACE_HOST_CANARY_AGENTS) {
      const value = record[agent];
      if (value === void 0) continue;
      if (typeof value !== "string" || !(0,__vite_ssr_import_2__.isAbsolute)(value)) {
        throw new WorkspaceHostOperationError(
          "readAttestedAgentRuntimePaths",
          1,
          `attested runtime path for '${agent}' is not an absolute path`
        );
      };
      if (value === WORKSPACE_HOST_RELEASE_BIN_DIR || value.startsWith(`${WORKSPACE_HOST_RELEASE_BIN_DIR}/`)) {
        throw new WorkspaceHostOperationError(
          "readAttestedAgentRuntimePaths",
          1,
          `attested runtime path for '${agent}' is inside ${WORKSPACE_HOST_RELEASE_BIN_DIR}, which holds launcher wrappers rather than vendor CLIs (D-259)`
        );
      };
      paths[agent] = value;
    };
    return paths;
  }
  async describeClonedRepository(input) {
    if (!input) return { visibility: "public", cloned: false };
    const destination = resolveWithinRoot(
      this.workspaceRoot,
      input.destination,
      "destination"
    );
    const cloned = await this.system.pathExists((0,__vite_ssr_import_2__.join)(destination, ".git"));
    return { visibility: input.visibility, cloned };
  }
};
class ProductionWorkspaceHostCredentialMaterializer {
  family;
  system;
  locate;
  gitCredentialBindings;
  agentHomeConsumer;
  recordRevocation;
  lifecycleLockPath;
  constructor(family, system, locate, gitCredentialBindings, agentHomeConsumer, recordRevocation, lifecycleLockPath) {
    this.family = family;
    this.system = system;
    this.locate = locate;
    this.gitCredentialBindings = gitCredentialBindings;
    this.agentHomeConsumer = agentHomeConsumer;
    this.recordRevocation = recordRevocation;
    this.lifecycleLockPath = lifecycleLockPath;
  }
  async withLifecycleLock(task) {
    if (!this.lifecycleLockPath) return await task();
    return await (0,__vite_ssr_import_6__.withWorkspaceHostCredentialFilesystemLock)(
      this.system,
      this.lifecycleLockPath,
      task
    );
  }
  agentFamily() {
    return __vite_ssr_import_7__.WORKSPACE_HOST_AGENT_HOME_FAMILIES.includes(
      this.family
    ) ? this.family : null;
  }
  async requireMaterial(binding, operation) {
    const path = this.locate(binding);
    if (path === null) return null;
    const bytes = await this.system.readFileIfPresent(path);
    if (bytes === null) {
      throw new WorkspaceHostOperationError(
        `credential.${binding.channel}.${operation}`,
        1,
        `delivered material for family '${this.family}' is not present on the host`
      );
    };
    return { path, bytes };
  }
  describe(binding, present) {
    return {
      family: this.family,
      channel: binding.channel,
      deliveryKind: binding.deliveryKind,
      generation: binding.generation,
      present
    };
  }
  async bind(binding) {
    return await this.withLifecycleLock(async () => {
      const material = await this.requireMaterial(binding, "bind");
      const agentFamily = this.agentFamily();
      if (agentFamily) {
        if (!this.agentHomeConsumer || !material) {
          throw new WorkspaceHostOperationError(
            `credential.${binding.channel}.bind`,
            1,
            `no agent-home consumer is configured for family '${this.family}'`
          );
        };
        await this.agentHomeConsumer.install(
          agentFamily,
          binding.generation,
          material.bytes,
          { lockHeld: true }
        );
      } else if (binding.channel === "git" && material) {
        if (!this.gitCredentialBindings) {
          throw new WorkspaceHostOperationError(
            "credential.git.bind",
            1,
            "no durable Git binding registry is configured"
          );
        };
        await this.gitCredentialBindings.bind(binding, material.path, {
          lockHeld: true
        });
      } else if (binding.channel !== "cloud" && !material) {
        throw new WorkspaceHostOperationError(
          `credential.${binding.channel}.bind`,
          1,
          `family '${this.family}' requires delivered material`
        );
      };
      return this.describe(binding, true);
    });
  }
  async verifyBound(binding) {
    return await this.withLifecycleLock(async () => {
      const material = await this.requireMaterial(binding, "verify-bound");
      const agentFamily = this.agentFamily();
      if (agentFamily) {
        if (!this.agentHomeConsumer || !material) {
          throw new WorkspaceHostOperationError(
            `credential.${binding.channel}.verify-bound`,
            1,
            `no agent-home consumer is configured for family '${this.family}'`
          );
        };
        await this.agentHomeConsumer.verify(
          agentFamily,
          binding.generation,
          material.bytes,
          { lockHeld: true }
        );
      } else if (binding.channel === "git" && material) {
        await this.gitCredentialBindings?.verifyBound(binding, material.path, {
          lockHeld: true
        });
      };
      return this.describe(binding, true);
    });
  }
  async revoke(binding) {
    return await this.withLifecycleLock(async () => {
      const path = this.locate(binding);
      const agentFamily = this.agentFamily();
      if (agentFamily) {
        if (!this.agentHomeConsumer) {
          throw new WorkspaceHostOperationError(
            `credential.${binding.channel}.revoke`,
            1,
            `no agent-home consumer is configured for family '${this.family}'`
          );
        };
        await this.agentHomeConsumer.revoke(agentFamily, binding.generation, {
          lockHeld: true
        });
      };
      await this.gitCredentialBindings?.revoke(binding, { lockHeld: true });
      if (path !== null) await this.system.removePath(path);
      if (path !== null) await this.recordRevocation?.(binding.generation);
      return this.describe(binding, false);
    });
  }
  async verifyRevoked(binding) {
    return await this.withLifecycleLock(async () => {
      const path = this.locate(binding);
      if (path === null) return this.describe(binding, false);
      if (await this.system.pathExists(path)) {
        throw new WorkspaceHostOperationError(
          `credential.${binding.channel}.verify-revoked`,
          1,
          `material for family '${this.family}' is still present after revocation`
        );
      };
      const agentFamily = this.agentFamily();
      if (agentFamily) {
        if (!this.agentHomeConsumer) {
          throw new WorkspaceHostOperationError(
            `credential.${binding.channel}.verify-revoked`,
            1,
            `no agent-home consumer is configured for family '${this.family}'`
          );
        };
        await this.agentHomeConsumer.verifyRevoked(
          agentFamily,
          binding.generation,
          { lockHeld: true }
        );
      };
      await this.gitCredentialBindings?.verifyRevoked(binding, {
        lockHeld: true
      });
      return this.describe(binding, false);
    });
  }
};
const WORKSPACE_HOST_CREDENTIAL_MATERIAL_ROOT = "/var/lib/papercusp/credentials";
function materialPathFor(root, family) {
  return (binding) => {
    if (!__vite_ssr_import_5__.WORKSPACE_HOST_CREDENTIAL_FAMILY_SPECS[family].requiresDeliveredMaterial)
      return null;
    return (0,__vite_ssr_import_6__.workspaceHostCredentialMaterialPath)(
      root,
      family,
      binding.generation
    );
  };
}
function createProductionWorkspaceHostCredentialMaterializers(system, materialRoot = WORKSPACE_HOST_CREDENTIAL_MATERIAL_ROOT, gitCredentialBindings, agentHomeConsumer) {
  const durableGitBindings = gitCredentialBindings ?? new WorkspaceHostGitCredentialBindingRegistry(system, materialRoot);
  const durableAgentHome = agentHomeConsumer ?? new __vite_ssr_import_7__.WorkspaceHostAgentHomeConsumer({
    filesystem: system,
    materialRoot,
    // D-421: the customer workspace account runs every customer-driven agent.
    agentHome: WORKSPACE_HOST_DEFAULT_WORKSPACE_HOME,
    agentUser: __vite_ssr_import_8__.DEFAULT_WORKSPACE_HOST_WORKSPACE_USER,
    agentGroup: __vite_ssr_import_8__.DEFAULT_WORKSPACE_HOST_WORKSPACE_USER,
    legacyHomes: [{ home: WORKSPACE_HOST_DEFAULT_AGENT_HOME }]
  });
  const families = [
    "cloud-workload-identity",
    "git-short-lived-delegation",
    "agent-forwarded-reference",
    "agent-encrypted-reference"
  ];
  return families.map(
    (family) => new ProductionWorkspaceHostCredentialMaterializer(
      family,
      system,
      materialPathFor(materialRoot, family),
      durableGitBindings,
      durableAgentHome,
      // Only families with an on-host artifact have anything to revoke, so only they carry a
      // ledger. Passing one for an ambient family would create a revocation record for material
      // that never existed.
      __vite_ssr_import_5__.WORKSPACE_HOST_CREDENTIAL_FAMILY_SPECS[family].requiresDeliveredMaterial ? async (generation) => (
        // Through the SAME `system` seam every other host operation uses. A second
        // filesystem here — even one defaulting to the real node implementation — means a
        // caller that faked the host still writes to the machine running it.
        await (0,__vite_ssr_import_6__.recordWorkspaceHostCredentialRevocation)(
          system,
          materialRoot,
          family,
          generation,
          { lockHeld: true }
        )
      ) : void 0,
      __vite_ssr_import_5__.WORKSPACE_HOST_CREDENTIAL_FAMILY_SPECS[family].requiresDeliveredMaterial ? (0,__vite_ssr_import_6__.workspaceHostCredentialFamilyLockPath)(materialRoot, family) : void 0
    )
  );
};
function createProductionWorkspaceHostRemoteInitializerDeps(options = {}) {
  const system = options.system ?? new NodeWorkspaceHostSystem();
  const materialRoot = options.credentialMaterialRoot ?? WORKSPACE_HOST_CREDENTIAL_MATERIAL_ROOT;
  const workspaceUser = options.workspaceUser ?? __vite_ssr_import_8__.DEFAULT_WORKSPACE_HOST_WORKSPACE_USER;
  const workspaceGroup = options.workspaceGroup ?? workspaceUser;
  const workspaceHome = options.workspaceHome ?? `/home/${workspaceUser}`;
  const agentUser = options.agentUser ?? __vite_ssr_import_8__.DEFAULT_WORKSPACE_HOST_AGENT_USER;
  const agentGroup = options.agentGroup ?? agentUser;
  const agentHome = options.agentHome ?? `/home/${agentUser}`;
  const gitCredentialBindings = options.gitCredentialBindings ?? new WorkspaceHostGitCredentialBindingRegistry(system, materialRoot);
  const host = new ProductionWorkspaceHostRemoteInitializerHost({
    ...options,
    system,
    credentialMaterialRoot: materialRoot,
    workspaceHome,
    workspaceUser,
    workspaceGroup,
    agentHome,
    agentUser,
    agentGroup,
    gitCredentialBindings
  });
  const agentHomeConsumer = new __vite_ssr_import_7__.WorkspaceHostAgentHomeConsumer({
    filesystem: system,
    materialRoot,
    agentHome: workspaceHome,
    agentUser: workspaceUser,
    agentGroup: workspaceGroup,
    legacyHomes: [{ home: agentHome }]
  });
  return {
    host,
    credentials: new __vite_ssr_import_5__.WorkspaceHostCredentialResolver(
      createProductionWorkspaceHostCredentialMaterializers(
        system,
        materialRoot,
        gitCredentialBindings,
        agentHomeConsumer
      )
    ),
    ...options.now ? { now: options.now } : {}
  };
}
//# sourceMappingSource=vite-generated
//# sourceMappingURL=data:application/json;base64,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eUJBQ1IsSUFBSSwwQ0FBMEMsUUFBUSxZQUFZO0FBUXBFLFFBQU0sT0FBTyxJQUFJLDZDQUE2QztBQUFBLElBQzVELEdBQUc7QUFBQSxJQUNIO0FBQUEsSUFDQSx3QkFBd0I7QUFBQSxJQUN4QjtBQUFBLElBQ0E7QUFBQSxJQUNBO0FBQUEsSUFDQTtBQUFBLElBQ0E7QUFBQSxJQUNBO0FBQUEsSUFDQTtBQUFBLEVBQ0YsQ0FBQztBQUNELFFBQU0sb0JBQW9CLElBQUkscURBQStCO0FBQUEsSUFDM0QsWUFBWTtBQUFBLElBQ1o7QUFBQSxJQUNBLFdBQVc7QUFBQSxJQUNYLFdBQVc7QUFBQSxJQUNYLFlBQVk7QUFBQSxJQUNaLGFBQWEsQ0FBQyxFQUFFLE1BQU0sVUFBVSxDQUFDO0FBQUEsRUFDbkMsQ0FBQztBQUNELFNBQU87QUFBQSxJQUNMO0FBQUEsSUFDQSxhQUFhLElBQUk7QUFBQSxNQUNmO0FBQUEsUUFDRTtBQUFBLFFBQ0E7QUFBQSxRQUNBO0FBQUEsUUFDQTtBQUFBLE1BQ0Y7QUFBQSxJQUNGO0FBQUEsSUFDQSxHQUFJLFFBQVEsTUFBTSxFQUFFLEtBQUssUUFBUSxJQUFJLElBQUksQ0FBQztBQUFBLEVBQzVDO0FBQ0YiLCJuYW1lcyI6W10sImlnbm9yZUxpc3QiOltdLCJzb3VyY2VzIjpbIndvcmtzcGFjZS1ob3N0LXJlbW90ZS1pbml0aWFsaXplci1ob3N0LnRzIl0sInNvdXJjZXNDb250ZW50IjpbIi8qKlxuICogVGhlIFBST0RVQ1RJT04gaG9zdCBhZGFwdGVyIGJlaGluZCB0aGUgcmVtb3RlIGluaXRpYWxpemVyJ3MgcHJvdG9jb2wgZW5naW5lIChELTExMCkuXG4gKlxuICogYHdvcmtzcGFjZS1ob3N0LXJlbW90ZS1pbml0aWFsaXplci50c2AgZGVmaW5lcyBgV29ya3NwYWNlSG9zdFJlbW90ZUluaXRpYWxpemVySG9zdGAgYXMgYSBzZWFtIHNvXG4gKiB0aGUgcHJvdG9jb2wgZW5naW5lIGNhbiBiZSB0ZXN0ZWQgd2l0aG91dCBhIFZNLiBVbnRpbCB0aGlzIGZpbGUgZXhpc3RlZCB0aGUgT05MWSBpbXBsZW1lbnRhdGlvbnNcbiAqIG9mIHRoYXQgc2VhbSB3ZXJlIGBSZWNvcmRpbmdIb3N0YCBpbiB0aGUgdGVzdCBmaWxlIGFuZCBgUmVjb3JkaW5nTWF0ZXJpYWxpemVyYCBpbiB0d28gb3RoZXJzIOKAlFxuICogc28gZXZlcnkgaW5pdGlhbGl6YXRpb24gc3RlcCBoYWQgYSBjb250cmFjdCwgYW4gZW52ZWxvcGUsIGFuZCBhIHBhc3NpbmcgdGVzdCBzdWl0ZSwgYW5kIG5vIGNvZGVcbiAqIHRoYXQgY291bGQgYWN0dWFsbHkgY3JlYXRlIGEgd29ya3NwYWNlIG9uIGEgaG9zdC4gRC0xMTAgbmFtZWQgdGhhdCBnYXA7IHRoaXMgZmlsZSBjbG9zZXMgaXQuXG4gKlxuICogV0hZIEEgU1lTVEVNIFNFQU0gUkFUSEVSIFRIQU4gRElSRUNUIGBub2RlOmNoaWxkX3Byb2Nlc3NgIENBTExTLiBFdmVyeSBvcGVyYXRpb24gaGVyZSBpcyBhXG4gKiBwcm9jZXNzIHNwYXduIG9yIGEgZmlsZXN5c3RlbSBtdXRhdGlvbiBvbiBhIHJlYWwgVk0sIHdoaWNoIGlzIGV4YWN0bHkgdGhlIGNvZGUgYSB1bml0IHRlc3RcbiAqIGNhbm5vdCBleGVyY2lzZS4gUm91dGluZyBhbGwgb2YgaXQgdGhyb3VnaCBvbmUgc21hbGwgYFdvcmtzcGFjZUhvc3RTeXN0ZW1gIGludGVyZmFjZSDigJQgd2hvc2VcbiAqIGRlZmF1bHQgaXMgdGhlIHJlYWwgbm9kZSBpbXBsZW1lbnRhdGlvbiBiZWxvdyDigJQgbWVhbnMgdGhlIGFkYXB0ZXIncyBERUNJU0lPTlMgKHdoaWNoIGNvbW1hbmQsXG4gKiB3aGljaCBhcmd1bWVudHMsIHdoYXQgY291bnRzIGFzIGZhaWx1cmUsIHdoYXQgYmVjb21lcyBldmlkZW5jZSkgYXJlIHRlc3RhYmxlLCB3aGlsZSB0aGVcbiAqIGlycmVkdWNpYmxlIEkvTyBzdGF5cyBpbiBvbmUgcGxhY2UgdGhhdCBpcyBvYnZpb3VzbHkgY29ycmVjdC4gVGhhdCBpcyB0aGUgc2FtZSBzcGxpdCB0aGVcbiAqIHByb3RvY29sIGVuZ2luZSBhbHJlYWR5IHVzZXMsIG9uZSBsYXllciBkb3duLlxuICpcbiAqIEVWSURFTkNFIE5FVkVSIENBUlJJRVMgQVVUSE9SSVpBVElPTiBNQVRFUklBTC4gVGhlIHByb3RvY29sIGVuZ2luZSBydW5zXG4gKiBgYXNzZXJ0V29ya3NwYWNlSG9zdFNlY3JldElzb2xhdGlvbmAgb3ZlciBldmVyeSByZXNwb25zZSwgYW5kIHRoZSBjcmVkZW50aWFsIHJlc29sdmVyIHJ1bnMgaXRcbiAqIG92ZXIgZXZlcnkgbWF0ZXJpYWxpemVyIGRldGFpbC4gQm90aCByZWplY3QgYSBrZXkgbWF0Y2hpbmdcbiAqIGAoYXBpW18tXT9rZXl8YWNjZXNzW18tXT9rZXl8c2VjcmV0fHRva2VufHBhc3N3b3JkfHBhc3NwaHJhc2V8cHJpdmF0ZVtfLV0/a2V5KWAgYW5kIGFueSB2YWx1ZVxuICogY29udGFpbmluZyBhIFBFTSBwcml2YXRlLWtleSBoZWFkZXIuIEV2aWRlbmNlIGJlbG93IGlzIHRoZXJlZm9yZSByZXN0cmljdGVkIHRvIHBhdGhzLCBib29sZWFucyxcbiAqIGV4aXQgY29kZXMsIGNvdW50cyBhbmQgYWxyZWFkeS1kaWdlc3RlZCByZWZlcmVuY2VzIOKAlCBuZXZlciBhIGNyZWRlbnRpYWwsIGFuZCBuZXZlciBhIGNvbW1hbmRcbiAqIGxpbmUgdGhhdCBjb3VsZCBoYXZlIG9uZSBpbnRlcnBvbGF0ZWQgaW50byBpdC5cbiAqXG4gKiBGQUlMVVJFIElTIExPVUQuIEEgbm9uLXplcm8gZXhpdCB0aHJvd3MgYFdvcmtzcGFjZUhvc3RPcGVyYXRpb25FcnJvcmAsIHdoaWNoIHRoZSBDTEkgd3JhcHBlclxuICogdHVybnMgaW50byBleGl0IDEgcGx1cyBhIHN0ZGVyciBkaWFnbm9zdGljLiBJdCBpcyBkZWxpYmVyYXRlIHRoYXQgbm8gb3BlcmF0aW9uIGhlcmUgY2FuIHJlcG9ydFxuICogcGFydGlhbCBvciBvcHRpbWlzdGljIHN1Y2Nlc3M6IHRoZSBjb250cm9sbGVyIHRyZWF0cyBhIGZhaWxlZCBzdGVwIGFzIGZhaWxlZCBhbmQgc3RvcHMsIHdoZXJlYXNcbiAqIGEgc3RlcCB0aGF0IHJlcG9ydGVkIHN1Y2Nlc3MgaXQgaGFkIG5vdCBhY2hpZXZlZCB3b3VsZCBsZWF2ZSBhIGhhbGYtaW5pdGlhbGl6ZWQgaG9zdCB0aGF0IGV2ZXJ5XG4gKiBsYXRlciBzdGVwIHRoZW4gYnVpbGRzIG9uLlxuICovXG5pbXBvcnQgeyBleGVjRmlsZSB9IGZyb20gXCJub2RlOmNoaWxkX3Byb2Nlc3NcIjtcbmltcG9ydCB7IGNobW9kLCBsc3RhdCwgbWtkaXIsIHJtLCBzdGF0IH0gZnJvbSBcIm5vZGU6ZnMvcHJvbWlzZXNcIjtcbmltcG9ydCB7IGlzQWJzb2x1dGUsIGpvaW4gfSBmcm9tIFwibm9kZTpwYXRoXCI7XG5pbXBvcnQge1xuICBidWlsZFdvcmtzcGFjZUhvc3REZXNrdG9wUGFja1NjcmlwdCxcbiAgcGFyc2VXb3Jrc3BhY2VIb3N0RGVza3RvcFBhY2tBdHRlc3RhdGlvbixcbiAgUElOTkVEX0tBU01WTkNfQVJUSUZBQ1QsXG4gIFdPUktTUEFDRV9IT1NUX0RFU0tUT1BfUEFDS19DT05UUkFDVF9WRVJTSU9OLFxufSBmcm9tIFwiLi93b3Jrc3BhY2UtaG9zdC1kZXNrdG9wLXBhY2tcIjtcblxuaW1wb3J0IHtcbiAgTm9kZVdvcmtzcGFjZUhvc3RBZ2VudFByb2JlUnVubmVyLFxuICBwcm9iZVdvcmtzcGFjZUhvc3RBZ2VudHMsXG4gIFdPUktTUEFDRV9IT1NUX0NBTkFSWV9BR0VOVFMsXG4gIHR5cGUgV29ya3NwYWNlSG9zdEFnZW50VmVyaWZpY2F0aW9uUmVwb3J0LFxuICB0eXBlIFdvcmtzcGFjZUhvc3RBZ2VudFByb2JlUnVubmVyLFxuICB0eXBlIFdvcmtzcGFjZUhvc3RDYW5hcnlBZ2VudCxcbn0gZnJvbSBcIi4vd29ya3NwYWNlLWhvc3QtYWdlbnQtYXV0aGVudGljYXRpb25cIjtcbmltcG9ydCB7XG4gIFdPUktTUEFDRV9IT1NUX0NSRURFTlRJQUxfRkFNSUxZX1NQRUNTLFxuICBXb3Jrc3BhY2VIb3N0Q3JlZGVudGlhbFJlc29sdmVyLFxuICB3b3Jrc3BhY2VIb3N0Q3JlZGVudGlhbFJlZmVyZW5jZURpZ2VzdCxcbiAgdHlwZSBXb3Jrc3BhY2VIb3N0Q3JlZGVudGlhbEJpbmRpbmdEZXNjcmlwdG9yLFxuICB0eXBlIFdvcmtzcGFjZUhvc3RDcmVkZW50aWFsRmFtaWx5LFxuICB0eXBlIFdvcmtzcGFjZUhvc3RDcmVkZW50aWFsTWF0ZXJpYWxpemVyLFxufSBmcm9tIFwiLi93b3Jrc3BhY2UtaG9zdC1jcmVkZW50aWFsLW5hbWVzcGFjZVwiO1xuaW1wb3J0IHtcbiAgTm9kZVdvcmtzcGFjZUhvc3RDcmVkZW50aWFsRGVsaXZlcnlGaWxlc3lzdGVtLFxuICBlbnN1cmVTaGFyZWRXb3Jrc3BhY2VEaXJlY3RvcnksXG4gIHJlY29yZFdvcmtzcGFjZUhvc3RDcmVkZW50aWFsUmV2b2NhdGlvbixcbiAgd2l0aFdvcmtzcGFjZUhvc3RDcmVkZW50aWFsRmlsZXN5c3RlbUxvY2ssXG4gIHdvcmtzcGFjZUhvc3RDcmVkZW50aWFsRmFtaWx5TG9ja1BhdGgsXG4gIHdvcmtzcGFjZUhvc3RDcmVkZW50aWFsTWF0ZXJpYWxQYXRoLFxuICB0eXBlIFdvcmtzcGFjZUhvc3RDcmVkZW50aWFsRGVsaXZlcnlGaWxlc3lzdGVtLFxufSBmcm9tIFwiLi93b3Jrc3BhY2UtaG9zdC1jcmVkZW50aWFsLWRlbGl2ZXJ5XCI7XG5pbXBvcnQge1xuICBXb3Jrc3BhY2VIb3N0QWdlbnRIb21lQ29uc3VtZXIsXG4gIFdPUktTUEFDRV9IT1NUX0FHRU5UX0hPTUVfRkFNSUxJRVMsXG4gIHJlcXVpcmVFeHBsaWNpdFdvcmtzcGFjZUhvc3RIb21lLFxuICB0eXBlIFdvcmtzcGFjZUhvc3RBZ2VudEhvbWVGYW1pbHksXG4gIHR5cGUgV29ya3NwYWNlSG9zdEFnZW50SG9tZUZpbGVzeXN0ZW0sXG59IGZyb20gXCIuL3dvcmtzcGFjZS1ob3N0LWFnZW50LWhvbWVcIjtcbmltcG9ydCB7XG4gIERFRkFVTFRfV09SS1NQQUNFX0hPU1RfQUdFTlRfVVNFUixcbiAgREVGQVVMVF9XT1JLU1BBQ0VfSE9TVF9XT1JLU1BBQ0VfVVNFUixcbiAgV09SS1NQQUNFX0hPU1RfQ1VTVE9NRVJfQUdFTlRfVE9PTENIQUlOX0JJTixcbiAgV09SS1NQQUNFX0hPU1RfREFUQV9ST09ULFxuICBXT1JLU1BBQ0VfSE9TVF9SVU5USU1FX1JPT1QsXG4gIFdPUktTUEFDRV9IT1NUX1NUQVRFX1JPT1QsXG59IGZyb20gXCIuL3dvcmtzcGFjZS1ob3N0LWJvb3RzdHJhcFwiO1xuaW1wb3J0IHR5cGUge1xuICBXb3Jrc3BhY2VIb3N0Q2xvbmVSZXBvc2l0b3J5SW5wdXQsXG4gIFdvcmtzcGFjZUhvc3RDcmVhdGVXb3Jrc3BhY2VJbnB1dCxcbiAgV29ya3NwYWNlSG9zdEltcG9ydFdvcmtzcGFjZUlucHV0LFxuICBXb3Jrc3BhY2VIb3N0UGFpcldvcmtzcGFjZUlucHV0LFxuICBXb3Jrc3BhY2VIb3N0UmVtb3RlSW5pdGlhbGl6ZXJEZXBzLFxuICBXb3Jrc3BhY2VIb3N0UmVtb3RlSW5pdGlhbGl6ZXJIb3N0LFxuICBXb3Jrc3BhY2VIb3N0UmVtb3RlU3RlcEV2aWRlbmNlLFxufSBmcm9tIFwiLi93b3Jrc3BhY2UtaG9zdC1yZW1vdGUtaW5pdGlhbGl6ZXJcIjtcblxuLyoqIERlZmF1bHQgcm9vdCB1bmRlciB3aGljaCBwZXItd29ya3NwYWNlIGRpcmVjdG9yaWVzIGFyZSBjcmVhdGVkIG9uIHRoZSBob3N0LiAqL1xuZXhwb3J0IGNvbnN0IFdPUktTUEFDRV9IT1NUX0RFRkFVTFRfV09SS1NQQUNFX1JPT1QgPSBXT1JLU1BBQ0VfSE9TVF9EQVRBX1JPT1Q7XG5cbi8qKiBEZWZhdWx0IG5hdGl2ZSBob21lIHVzZWQgYnkgdGhlIGRlZGljYXRlZCB3b3Jrc3BhY2UgU1NIIGlkZW50aXR5LiAqL1xuZXhwb3J0IGNvbnN0IFdPUktTUEFDRV9IT1NUX0RFRkFVTFRfV09SS1NQQUNFX0hPTUUgPSBgL2hvbWUvJHtERUZBVUxUX1dPUktTUEFDRV9IT1NUX1dPUktTUEFDRV9VU0VSfWA7XG5cbi8qKlxuICogRGVmYXVsdCBuYXRpdmUgaG9tZSBvZiB0aGUgcGxhdGZvcm0gQUdFTlQgaWRlbnRpdHkgKEQtMjQ4KS5cbiAqXG4gKiBCZXR3ZWVuIEQtMjQ4IGFuZCBELTQyMSBkZWxpdmVyZWQgQ2xhdWRlL0NvZGV4L09NUCBtYXRlcmlhbCBsaXZlZCBoZXJlLiBTaW5jZSBELTQyMSBldmVyeVxuICogY3VzdG9tZXItZHJpdmVuIGFnZW50IHJ1bnMgYXMgdGhlIGN1c3RvbWVyIHdvcmtzcGFjZSBhY2NvdW50LCBzbyBkZWxpdmVyZWQgbWF0ZXJpYWwgZ29lcyB0b1xuICoge0BsaW5rIFdPUktTUEFDRV9IT1NUX0RFRkFVTFRfV09SS1NQQUNFX0hPTUV9IGFuZCB0aGlzIGhvbWUgaXMgb25seSBhIExFR0FDWSBpbnN0YWxsIGxvY2F0aW9uXG4gKiB0aGUgY3JlZGVudGlhbCBjb25zdW1lciBtaWdyYXRlcyBhd2F5IGZyb20uIFRoZSBpZGVudGl0eSBpdHNlbGYgcmVtYWluczogYm9vdHN0cmFwIHN0aWxsXG4gKiBpbnN0YWxscyB0aGUgdmVuZG9yIENMSXMgYXMgaXQsIGFuZCB0aGUgY3VzdG9tZXIgdG9vbGNoYWluIGlzIGNvcGllZCBmcm9tIHRoZXJlIChELTQyMykuXG4gKi9cbmV4cG9ydCBjb25zdCBXT1JLU1BBQ0VfSE9TVF9ERUZBVUxUX0FHRU5UX0hPTUUgPSBgL2hvbWUvJHtERUZBVUxUX1dPUktTUEFDRV9IT1NUX0FHRU5UX1VTRVJ9YDtcblxuLyoqXG4gKiBUaGUgcmVsZWFzZSBidW5kbGUncyBvd24gYGJpbi9gIOKAlCB0aGUgZGlyZWN0b3J5IGhvbGRpbmcgdGhlIHBzdSBMQVVOQ0hFUiBXUkFQUEVSUyBuYW1lZFxuICogYGNsYXVkZWAsIGBjb2RleGAgYW5kIGBvbXBgLlxuICpcbiAqIE5hbWVkIHJhdGhlciB0aGFuIHNwZWxsZWQgaW5saW5lIGJlY2F1c2UgdHdvIGRpZmZlcmVudCBydWxlcyBwb2ludCBhdCBpdCBhbmQgdGhleSBtdXN0IG5vdFxuICogZHJpZnQgYXBhcnQ6IGl0IGxlYWRzIHRoZSBwcm9iZSBzZWFyY2ggcGF0aCBiZWxvdyAodGhlIHdyYXBwZXJzIGFyZSB3aGF0IGEgYmFyZSBuYW1lIGZpbmRzKSwgYW5kXG4gKiBhbiBhdHRlc3RlZCB2ZW5kb3IgcnVudGltZSBwYXRoIGluc2lkZSBpdCBpcyByZWZ1c2VkIG91dHJpZ2h0IChELTI1OSBEZWZlY3QgMikg4oCUIGEgcmVzb2x2ZSB0aGF0XG4gKiBsYW5kZWQgaGVyZSBmb3VuZCBhIHdyYXBwZXIsIHdoaWNoIGlzIHRoZSBELTI0NyBjb25mdXNpb24gYXJyaXZpbmcgdGhyb3VnaCBhIGRpZmZlcmVudCBkb29yLlxuICovXG5leHBvcnQgY29uc3QgV09SS1NQQUNFX0hPU1RfUkVMRUFTRV9CSU5fRElSID0gYCR7V09SS1NQQUNFX0hPU1RfUlVOVElNRV9ST09UfS9jdXJyZW50L2JpbmA7XG5cbi8qKiBXaGVyZSBib290c3RyYXAgd3JpdGVzIHRoZSBhdHRlc3RhdGlvbiB0aGlzIGFkYXB0ZXIgcmVhZHMgaXRzIHZlbmRvciBydW50aW1lIHBhdGhzIGZyb20uICovXG5leHBvcnQgY29uc3QgV09SS1NQQUNFX0hPU1RfQk9PVFNUUkFQX0FUVEVTVEFUSU9OX0ZJTEUgPSBgJHtXT1JLU1BBQ0VfSE9TVF9TVEFURV9ST09UfS9ib290c3RyYXAtYXR0ZXN0YXRpb24uanNvbmA7XG5cbi8qKlxuICogRXhhY3QgUEFUSCBwYXNzZWQgdG8gYWdlbnQgcHJvYmVzOyBubyBjb250cm9sbGVyIHByb2Nlc3MgZW52aXJvbm1lbnQgaXMgaW5oZXJpdGVkLlxuICpcbiAqIExlZCBieSB0aGUgY3VzdG9tZXIgYWdlbnQgdG9vbGNoYWluLCBub3QgdGhlIHJlbGVhc2UgYmluOiB0aGUgcHJvYmVzIHJ1biBhcyB0aGUgY3VzdG9tZXJcbiAqIHdvcmtzcGFjZSBhY2NvdW50IChELTQyMSksIHdoaWNoIEQtMDQzIGJhcnMgZnJvbSB0aGUgcmVsZWFzZSB0cmVlLCBzbyBhIHJlbGVhc2UtYmluIGVudHJ5IHdvdWxkXG4gKiBvbmx5IGV2ZXIgcHJvZHVjZSBFQUNDRVMgKEQtNDIzKS5cbiAqL1xuZXhwb3J0IGNvbnN0IFdPUktTUEFDRV9IT1NUX0RFRkFVTFRfQUdFTlRfUFJPQkVfUEFUSCA9IGAke1dPUktTUEFDRV9IT1NUX0NVU1RPTUVSX0FHRU5UX1RPT0xDSEFJTl9CSU59Oi91c3IvbG9jYWwvc2JpbjovdXNyL2xvY2FsL2JpbjovdXNyL3NiaW46L3Vzci9iaW46L3NiaW46L2JpbmA7XG5cbi8qKiBEZWZhdWx0IGJ1bmRsZWQgQ0xJIHVzZWQgZm9yIHBhaXIvaW1wb3J0LiBgc2lkZWNhci9iaW5gIGlzIG9uIHRoZSBydW50aW1lIFBBVEguICovXG5leHBvcnQgY29uc3QgV09SS1NQQUNFX0hPU1RfREVGQVVMVF9XT1JLU1BBQ0VfQ09NTUFORCA9IFwicGFwZXJjdXBcIjtcblxuLyoqIERlZmF1bHQgYm91bmQgb24gYW55IHNpbmdsZSBob3N0IGNvbW1hbmQsIHNvIGEgaHVuZyBjaGlsZCBjYW5ub3Qgc3RhbGwgYSBzdGVwIGZvcmV2ZXIuICovXG5leHBvcnQgY29uc3QgV09SS1NQQUNFX0hPU1RfREVGQVVMVF9DT01NQU5EX1RJTUVPVVRfTVMgPSAzMDBfMDAwO1xuXG4vKipcbiAqIEJ1aWxkIHRoZSBvbmx5IEdpdCBjcmVkZW50aWFsIGVudmlyb25tZW50IGFsbG93ZWQgdG8gY29uc3VtZSBhIGRlbGl2ZXJlZCBnZW5lcmF0aW9uLlxuICpcbiAqIEdpdCBub3JtYWxseSBmb3J3YXJkcyBgYXBwcm92ZWAgYW5kIGByZWplY3RgIHRvIGV2ZXJ5IGNvbmZpZ3VyZWQgaGVscGVyLiBUaGUgZGVsaXZlcmVkIGZpbGUgaXNcbiAqIGltbXV0YWJsZSBldmlkZW5jZSwgc28gaXRzIGhlbHBlciBleHBvc2VzIG9ubHkgYGdldGA7IHRoZSBsZWFkaW5nIGVtcHR5IGhlbHBlciBhbHNvIHJlc2V0cyBldmVyeVxuICogYW1iaWVudCBoZWxwZXIgaW5oZXJpdGVkIGZyb20gc3lzdGVtL2dsb2JhbCBjb25maWd1cmF0aW9uLiBUaGUgcGF0aCBpcyBzaGVsbC1xdW90ZWQgYmVjYXVzZSBHaXRcbiAqIGludm9rZXMgYCFgIGhlbHBlcnMgdGhyb3VnaCBhIHNoZWxsLCBidXQgaXQgaXMgbmV2ZXIgaW50ZXJwb2xhdGVkIGludG8gYXJndiBvciBwdWJsaWMgZXZpZGVuY2UuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiB3b3Jrc3BhY2VIb3N0R2V0T25seUdpdENyZWRlbnRpYWxFbnZpcm9ubWVudChcbiAgbWF0ZXJpYWxQYXRoOiBzdHJpbmcsXG4pOiBSZWFkb25seTxSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+PiB7XG4gIGlmICghaXNBYnNvbHV0ZShtYXRlcmlhbFBhdGgpIHx8IC9bXFwwXFxyXFxuXS8udGVzdChtYXRlcmlhbFBhdGgpKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgXCJHaXQgY3JlZGVudGlhbCBtYXRlcmlhbCBwYXRoIG11c3QgYmUgYW4gYWJzb2x1dGUgc2luZ2xlLWxpbmUgcGF0aFwiLFxuICAgICk7XG4gIH1cbiAgY29uc3QgcXVvdGVkTWF0ZXJpYWxQYXRoID0gYCcke21hdGVyaWFsUGF0aC5yZXBsYWNlQWxsKFwiJ1wiLCBcIidcXFxcJydcIil9J2A7XG4gIHJldHVybiBPYmplY3QuZnJlZXplKHtcbiAgICBHSVRfVEVSTUlOQUxfUFJPTVBUOiBcIjBcIixcbiAgICBHSVRfQVNLUEFTUzogXCIvYmluL2ZhbHNlXCIsXG4gICAgU1NIX0FTS1BBU1M6IFwiL2Jpbi9mYWxzZVwiLFxuICAgIEdDTV9JTlRFUkFDVElWRTogXCJuZXZlclwiLFxuICAgIEdJVF9DT05GSUdfQ09VTlQ6IFwiM1wiLFxuICAgIEdJVF9DT05GSUdfS0VZXzA6IFwiY3JlZGVudGlhbC5oZWxwZXJcIixcbiAgICBHSVRfQ09ORklHX1ZBTFVFXzA6IFwiXCIsXG4gICAgR0lUX0NPTkZJR19LRVlfMTogXCJjcmVkZW50aWFsLmhlbHBlclwiLFxuICAgIEdJVF9DT05GSUdfVkFMVUVfMTogYCFmKCkgeyBpZiBbIFwiJDFcIiA9IGdldCBdOyB0aGVuIGdpdCBjcmVkZW50aWFsLXN0b3JlIC0tZmlsZT0ke3F1b3RlZE1hdGVyaWFsUGF0aH0gZ2V0OyBmaTsgfTsgZmAsXG4gICAgR0lUX0NPTkZJR19LRVlfMjogXCJjcmVkZW50aWFsLnVzZUh0dHBQYXRoXCIsXG4gICAgR0lUX0NPTkZJR19WQUxVRV8yOiBcInRydWVcIixcbiAgfSk7XG59XG5cbmV4cG9ydCBpbnRlcmZhY2UgV29ya3NwYWNlSG9zdENvbW1hbmRSZXN1bHQge1xuICByZWFkb25seSBleGl0Q29kZTogbnVtYmVyO1xuICByZWFkb25seSBzdGRvdXQ6IHN0cmluZztcbiAgcmVhZG9ubHkgc3RkZXJyOiBzdHJpbmc7XG59XG5cbmV4cG9ydCBpbnRlcmZhY2UgV29ya3NwYWNlSG9zdENvbW1hbmRJbnB1dCB7XG4gIHJlYWRvbmx5IGNvbW1hbmQ6IHN0cmluZztcbiAgcmVhZG9ubHkgYXJnczogcmVhZG9ubHkgc3RyaW5nW107XG4gIHJlYWRvbmx5IGN3ZD86IHN0cmluZztcbiAgcmVhZG9ubHkgdGltZW91dE1zPzogbnVtYmVyO1xuICAvKiogUHJvY2Vzcy1vbmx5IGNvbmZpZ3VyYXRpb24uIENhbGxlcnMgbXVzdCBuZXZlciBjb3B5IHRoaXMgaW50byBldmlkZW5jZSBvciBkaWFnbm9zdGljcy4gKi9cbiAgcmVhZG9ubHkgZW52PzogUmVhZG9ubHk8UmVjb3JkPHN0cmluZywgc3RyaW5nPj47XG59XG5cbi8qKlxuICogVGhlIGlycmVkdWNpYmxlIGhvc3QgSS9PLiBTbWFsbCBvbiBwdXJwb3NlOiBldmVyeXRoaW5nIGFib3ZlIGl0IGlzIGRlY2lzaW9uIGxvZ2ljIHRoYXQgYSB0ZXN0XG4gKiBjYW4gZHJpdmUsIGFuZCBldmVyeXRoaW5nIGluIGl0IGlzIGEgZGlyZWN0IGNhbGwgdG8gbm9kZSB3aXRoIG5vIGJyYW5jaGluZyB3b3J0aCB0ZXN0aW5nLlxuICovXG5leHBvcnQgaW50ZXJmYWNlIFdvcmtzcGFjZUhvc3RTeXN0ZW1cbiAgZXh0ZW5kc1xuICAgIFdvcmtzcGFjZUhvc3RDcmVkZW50aWFsRGVsaXZlcnlGaWxlc3lzdGVtLFxuICAgIFdvcmtzcGFjZUhvc3RBZ2VudEhvbWVGaWxlc3lzdGVtIHtcbiAgcnVuKGlucHV0OiBXb3Jrc3BhY2VIb3N0Q29tbWFuZElucHV0KTogUHJvbWlzZTxXb3Jrc3BhY2VIb3N0Q29tbWFuZFJlc3VsdD47XG4gIC8qKlxuICAgKiBDcmVhdGUgYSBkaXJlY3RvcnkgdW5kZXIgdGhlIEFDTCdkIHdvcmtzcGFjZSByb290LCBtb2RlIGAwNzcwYCwgbmV2ZXIgZm9sbG93aW5nIGEgc3ltbGluay5cbiAgICogRGlzdGluY3QgZnJvbSBgZW5zdXJlRGlyZWN0b3J5YCAodGhlIFBSSVZBVEUgYDA3MDBgIGNyZWRlbnRpYWwvaG9tZSBmb3JtKSBvbiBwdXJwb3NlOiB1bmRlclxuICAgKiB0aGUgcm9vdCdzIGRlZmF1bHQgQUNMIGEgYDA3MDBgIG1vZGUgc2V0cyBgbWFzazo6LS0tYCBhbmQgbG9ja3MgdGhlIHNlcnZpY2UgYW5kIGFnZW50XG4gICAqIGFjY291bnRzIG91dCBvZiB0aGUgY3VzdG9tZXIncyB3b3Jrc3BhY2UgKFdJLTEwMDA0NTk0KS5cbiAgICovXG4gIGVuc3VyZVdvcmtzcGFjZURpcmVjdG9yeShwYXRoOiBzdHJpbmcpOiBQcm9taXNlPHZvaWQ+O1xuICBwYXRoRXhpc3RzKHBhdGg6IHN0cmluZyk6IFByb21pc2U8Ym9vbGVhbj47XG4gIHJlbW92ZVBhdGgocGF0aDogc3RyaW5nKTogUHJvbWlzZTx2b2lkPjtcbiAgLyoqIE9wdGlvbmFsIG9ubHkgc28gaGVybWV0aWMgc3lzdGVtcyBuZWVkIG5vdCBtb2RlbCBVbml4IG93bmVyc2hpcC4gUHJvZHVjdGlvbiBhbHdheXMgcHJvdmlkZXMgaXQuICovXG4gIHNldE93bmVyc2hpcD8ocGF0aDogc3RyaW5nLCBvd25lcjogc3RyaW5nLCBncm91cDogc3RyaW5nKTogUHJvbWlzZTx2b2lkPjtcbiAgc2V0T3duZXJzaGlwUmVjdXJzaXZlbHk/KFxuICAgIHBhdGg6IHN0cmluZyxcbiAgICBvd25lcjogc3RyaW5nLFxuICAgIGdyb3VwOiBzdHJpbmcsXG4gICk6IFByb21pc2U8dm9pZD47XG59XG5cbi8qKiBBIGhvc3Qgb3BlcmF0aW9uIHRoYXQgZGlkIG5vdCBhY2hpZXZlIHdoYXQgaXQgY2xhaW1lZC4gTmV2ZXIgY2FycmllcyB0aGUgY2hpbGQncyBhcmd2LiAqL1xuZXhwb3J0IGNsYXNzIFdvcmtzcGFjZUhvc3RPcGVyYXRpb25FcnJvciBleHRlbmRzIEVycm9yIHtcbiAgcmVhZG9ubHkgb3BlcmF0aW9uOiBzdHJpbmc7XG4gIHJlYWRvbmx5IGV4aXRDb2RlOiBudW1iZXI7XG5cbiAgY29uc3RydWN0b3Iob3BlcmF0aW9uOiBzdHJpbmcsIGV4aXRDb2RlOiBudW1iZXIsIGRldGFpbDogc3RyaW5nKSB7XG4gICAgc3VwZXIoXG4gICAgICBgd29ya3NwYWNlIGhvc3Qgb3BlcmF0aW9uICcke29wZXJhdGlvbn0nIGZhaWxlZCB3aXRoIGV4aXQgJHtleGl0Q29kZX06ICR7ZGV0YWlsfWAsXG4gICAgKTtcbiAgICB0aGlzLm5hbWUgPSBcIldvcmtzcGFjZUhvc3RPcGVyYXRpb25FcnJvclwiO1xuICAgIHRoaXMub3BlcmF0aW9uID0gb3BlcmF0aW9uO1xuICAgIHRoaXMuZXhpdENvZGUgPSBleGl0Q29kZTtcbiAgfVxufVxuXG4vKipcbiAqIFRyaW0gYSBjaGlsZCdzIHN0ZGVyciBmb3IgYSBkaWFnbm9zdGljLlxuICpcbiAqIEJvdW5kZWQgYmVjYXVzZSBhIGZhaWxpbmcgY29tbWFuZCBjYW4gZW1pdCBtZWdhYnl0ZXMsIGFuZCB0aGUgd2hvbGUgZGlhZ25vc3RpYyBlbmRzIHVwIGluIGFcbiAqIHByb3RvY29sIGVycm9yIHRoZSBjb250cm9sbGVyIHJlYWRzLiBUaGUgdGFpbCBpcyBrZXB0IHJhdGhlciB0aGFuIHRoZSBoZWFkOiB0aGUgYWN0dWFsIGVycm9yXG4gKiBmcm9tIGEgQ0xJIGlzIGFsbW9zdCBhbHdheXMgaXRzIGxhc3QgbGluZXMsIHdoaWxlIHRoZSBoZWFkIGlzIHVzdWFsbHkgYmFubmVyIGFuZCBwcm9ncmVzcy5cbiAqL1xuZnVuY3Rpb24gZGlhZ25vc3RpY1RhaWwodGV4dDogc3RyaW5nLCBtYXhDaGFycyA9IDJfMDAwKTogc3RyaW5nIHtcbiAgY29uc3QgdHJpbW1lZCA9IHRleHQudHJpbSgpO1xuICBpZiAodHJpbW1lZC5sZW5ndGggPD0gbWF4Q2hhcnMpIHJldHVybiB0cmltbWVkIHx8IFwiKG5vIGRpYWdub3N0aWMgb3V0cHV0KVwiO1xuICByZXR1cm4gYOKApiR7dHJpbW1lZC5zbGljZSgtbWF4Q2hhcnMpfWA7XG59XG5cbi8qKiBUaGUgcmVhbCBpbXBsZW1lbnRhdGlvbi4gVXNlZCBieSB0aGUgcGFja2FnZWQgYGJpbi9wYXBlcmN1c3AtcmVtb3RlLWluaXRpYWxpemVyYC4gKi9cbmV4cG9ydCBjbGFzcyBOb2RlV29ya3NwYWNlSG9zdFN5c3RlbSBpbXBsZW1lbnRzIFdvcmtzcGFjZUhvc3RTeXN0ZW0ge1xuICBhc3luYyBydW4oXG4gICAgaW5wdXQ6IFdvcmtzcGFjZUhvc3RDb21tYW5kSW5wdXQsXG4gICk6IFByb21pc2U8V29ya3NwYWNlSG9zdENvbW1hbmRSZXN1bHQ+IHtcbiAgICByZXR1cm4gYXdhaXQgbmV3IFByb21pc2U8V29ya3NwYWNlSG9zdENvbW1hbmRSZXN1bHQ+KChyZXNvbHZlKSA9PiB7XG4gICAgICBleGVjRmlsZShcbiAgICAgICAgaW5wdXQuY29tbWFuZCxcbiAgICAgICAgWy4uLmlucHV0LmFyZ3NdLFxuICAgICAgICB7XG4gICAgICAgICAgY3dkOiBpbnB1dC5jd2QsXG4gICAgICAgICAgLi4uKGlucHV0LmVudiA/IHsgZW52OiB7IC4uLnByb2Nlc3MuZW52LCAuLi5pbnB1dC5lbnYgfSB9IDoge30pLFxuICAgICAgICAgIHRpbWVvdXQ6IGlucHV0LnRpbWVvdXRNcyA/PyBXT1JLU1BBQ0VfSE9TVF9ERUZBVUxUX0NPTU1BTkRfVElNRU9VVF9NUyxcbiAgICAgICAgICBtYXhCdWZmZXI6IDE2ICogMTAyNCAqIDEwMjQsXG4gICAgICAgICAgLy8gVGhlIGNoaWxkIG11c3QgbmV2ZXIgaW5oZXJpdCBhbiBpbnRlcmFjdGl2ZSB0ZXJtaW5hbDogZXZlcnkgY29tbWFuZCBoZXJlIHJ1bnNcbiAgICAgICAgICAvLyB1bmF0dGVuZGVkLCBhbmQgYSBDTEkgdGhhdCBkZWNpZGVzIHRvIHByb21wdCB3b3VsZCBoYW5nIHRoZSBzdGVwIHVudGlsIHRoZSB0aW1lb3V0LlxuICAgICAgICAgIHdpbmRvd3NIaWRlOiB0cnVlLFxuICAgICAgICB9LFxuICAgICAgICAoZXJyb3IsIHN0ZG91dCwgc3RkZXJyKSA9PiB7XG4gICAgICAgICAgY29uc3QgY29kZSA9XG4gICAgICAgICAgICBlcnJvciAmJiB0eXBlb2YgKGVycm9yIGFzIHsgY29kZT86IHVua25vd24gfSkuY29kZSA9PT0gXCJudW1iZXJcIlxuICAgICAgICAgICAgICA/ICgoZXJyb3IgYXMgeyBjb2RlOiBudW1iZXIgfSkuY29kZSBhcyBudW1iZXIpXG4gICAgICAgICAgICAgIDogZXJyb3JcbiAgICAgICAgICAgICAgICA/IDFcbiAgICAgICAgICAgICAgICA6IDA7XG4gICAgICAgICAgcmVzb2x2ZSh7XG4gICAgICAgICAgICBleGl0Q29kZTogY29kZSxcbiAgICAgICAgICAgIHN0ZG91dDogU3RyaW5nKHN0ZG91dCA/PyBcIlwiKSxcbiAgICAgICAgICAgIHN0ZGVycjogU3RyaW5nKHN0ZGVyciA/PyBcIlwiKSxcbiAgICAgICAgICB9KTtcbiAgICAgICAgfSxcbiAgICAgICk7XG4gICAgfSk7XG4gIH1cblxuICBhc3luYyBlbnN1cmVEaXJlY3RvcnkocGF0aDogc3RyaW5nKTogUHJvbWlzZTx2b2lkPiB7XG4gICAgYXdhaXQgdGhpcy5kZWxpdmVyeUZpbGVzeXN0ZW0uZW5zdXJlRGlyZWN0b3J5KHBhdGgpO1xuICB9XG5cbiAgYXN5bmMgZW5zdXJlV29ya3NwYWNlRGlyZWN0b3J5KHBhdGg6IHN0cmluZyk6IFByb21pc2U8dm9pZD4ge1xuICAgIGF3YWl0IGVuc3VyZVNoYXJlZFdvcmtzcGFjZURpcmVjdG9yeShwYXRoKTtcbiAgfVxuXG4gIGFzeW5jIHBhdGhFeGlzdHMocGF0aDogc3RyaW5nKTogUHJvbWlzZTxib29sZWFuPiB7XG4gICAgdHJ5IHtcbiAgICAgIGF3YWl0IHN0YXQocGF0aCk7XG4gICAgICByZXR1cm4gdHJ1ZTtcbiAgICB9IGNhdGNoIHtcbiAgICAgIHJldHVybiBmYWxzZTtcbiAgICB9XG4gIH1cblxuICBhc3luYyBwYXRoS2luZChcbiAgICBwYXRoOiBzdHJpbmcsXG4gICk6IFByb21pc2U8XCJtaXNzaW5nXCIgfCBcImRpcmVjdG9yeVwiIHwgXCJmaWxlXCIgfCBcInN5bWxpbmtcIiB8IFwib3RoZXJcIj4ge1xuICAgIHRyeSB7XG4gICAgICBjb25zdCBpbmZvID0gYXdhaXQgbHN0YXQocGF0aCk7XG4gICAgICBpZiAoaW5mby5pc1N5bWJvbGljTGluaygpKSByZXR1cm4gXCJzeW1saW5rXCI7XG4gICAgICBpZiAoaW5mby5pc0RpcmVjdG9yeSgpKSByZXR1cm4gXCJkaXJlY3RvcnlcIjtcbiAgICAgIGlmIChpbmZvLmlzRmlsZSgpKSByZXR1cm4gXCJmaWxlXCI7XG4gICAgICByZXR1cm4gXCJvdGhlclwiO1xuICAgIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgICBpZiAoXG4gICAgICAgIGVycm9yICYmXG4gICAgICAgIHR5cGVvZiBlcnJvciA9PT0gXCJvYmplY3RcIiAmJlxuICAgICAgICBcImNvZGVcIiBpbiBlcnJvciAmJlxuICAgICAgICAoZXJyb3IgYXMgeyBjb2RlPzogdW5rbm93biB9KS5jb2RlID09PSBcIkVOT0VOVFwiXG4gICAgICApXG4gICAgICAgIHJldHVybiBcIm1pc3NpbmdcIjtcbiAgICAgIHRocm93IGVycm9yO1xuICAgIH1cbiAgfVxuXG4gIGFzeW5jIHdpdGhFeGNsdXNpdmVMb2NrPFQ+KHBhdGg6IHN0cmluZywgdGFzazogKCkgPT4gUHJvbWlzZTxUPik6IFByb21pc2U8VD4ge1xuICAgIHJldHVybiBhd2FpdCB0aGlzLmRlbGl2ZXJ5RmlsZXN5c3RlbS53aXRoRXhjbHVzaXZlTG9jayEocGF0aCwgdGFzayk7XG4gIH1cblxuICBhc3luYyByZW1vdmVQYXRoKHBhdGg6IHN0cmluZyk6IFByb21pc2U8dm9pZD4ge1xuICAgIGF3YWl0IHJtKHBhdGgsIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KTtcbiAgfVxuXG4gIHByaXZhdGUgYXN5bmMgY2hhbmdlT3duZXJzaGlwKFxuICAgIHBhdGg6IHN0cmluZyxcbiAgICBvd25lcjogc3RyaW5nLFxuICAgIGdyb3VwOiBzdHJpbmcsXG4gICAgcmVjdXJzaXZlOiBib29sZWFuLFxuICApOiBQcm9taXNlPHZvaWQ+IHtcbiAgICAvLyBSZXNvbHZlIG5hbWVzIHRocm91Z2ggdGhlIHBsYXRmb3JtIGNvbW1hbmQgcmF0aGVyIHRoYW4gY2FycnlpbmcgdWlkL2dpZCBhc3N1bXB0aW9ucyBhY3Jvc3NcbiAgICAvLyBwcm92aWRlciBpbWFnZXMuIEFjY291bnQgbmFtZXMgYXJlIHZhbGlkYXRlZCBieSB0aGUgYWRhcHRlciBiZWZvcmUgcmVhY2hpbmcgdGhpcyBzZWFtLlxuICAgIC8vIFdJLTEwMDA0NjA3OiB3b3Jrc3BhY2UgZGlyZWN0b3JpZXMgbGl2ZSB1bmRlciBhIGN1c3RvbWVyLXdyaXRhYmxlIHJvb3QuIFRoZSBmaW5hbCBwYXRoIGNhblxuICAgIC8vIGJlIHJlcGxhY2VkIHdpdGggYSBzeW1saW5rIGFmdGVyIGl0cyBjb21wb25lbnQgd2Fsaywgc28gbm9uLXJlY3Vyc2l2ZSBjaG93biBtdXN0IGNoYW5nZSB0aGVcbiAgICAvLyBsaW5rIGl0c2VsZiBpbnN0ZWFkIG9mIGZvbGxvd2luZyBpdCB0byBhIHJvb3Qtb3duZWQgdGFyZ2V0LlxuICAgIGF3YWl0IG5ldyBQcm9taXNlPHZvaWQ+KChyZXNvbHZlLCByZWplY3QpID0+IHtcbiAgICAgIGV4ZWNGaWxlKFxuICAgICAgICBcImNob3duXCIsXG4gICAgICAgIFsuLi4ocmVjdXJzaXZlID8gW1wiLVJcIl0gOiBbXCItaFwiXSksIGAke293bmVyfToke2dyb3VwfWAsIHBhdGhdLFxuICAgICAgICAoZXJyb3IpID0+IChlcnJvciA/IHJlamVjdChlcnJvcikgOiByZXNvbHZlKCkpLFxuICAgICAgKTtcbiAgICB9KTtcbiAgfVxuXG4gIGFzeW5jIHNldE93bmVyc2hpcChcbiAgICBwYXRoOiBzdHJpbmcsXG4gICAgb3duZXI6IHN0cmluZyxcbiAgICBncm91cDogc3RyaW5nLFxuICApOiBQcm9taXNlPHZvaWQ+IHtcbiAgICBhd2FpdCB0aGlzLmNoYW5nZU93bmVyc2hpcChwYXRoLCBvd25lciwgZ3JvdXAsIGZhbHNlKTtcbiAgfVxuXG4gIGFzeW5jIHNldE93bmVyc2hpcFJlY3Vyc2l2ZWx5KFxuICAgIHBhdGg6IHN0cmluZyxcbiAgICBvd25lcjogc3RyaW5nLFxuICAgIGdyb3VwOiBzdHJpbmcsXG4gICk6IFByb21pc2U8dm9pZD4ge1xuICAgIGF3YWl0IHRoaXMuY2hhbmdlT3duZXJzaGlwKHBhdGgsIG93bmVyLCBncm91cCwgdHJ1ZSk7XG4gIH1cblxuICAvLyBUaGUgdHdvIGNyZWRlbnRpYWwtZGVsaXZlcnkgb3BlcmF0aW9ucy4gRGVsZWdhdGVkIHRvIHRoZSBkZWxpdmVyeSBtb2R1bGUncyBpbXBsZW1lbnRhdGlvblxuICAvLyByYXRoZXIgdGhhbiByZS1kZXJpdmVkIGhlcmUsIHNvIHRoZSAwNjAwL2F0b21pYy1yZW5hbWUgYmVoYXZpb3VyIGhhcyBvbmUgZGVmaW5pdGlvbiBhbmQgdGhlXG4gIC8vIHBhY2thZ2VkIGRlbGl2ZXJ5IGVudHJ5cG9pbnQgYW5kIHRoaXMgaG9zdCBhZGFwdGVyIGNhbm5vdCBkcmlmdCBvbiBob3cgbWF0ZXJpYWwgaXMgd3JpdHRlbi5cbiAgYXN5bmMgd3JpdGVQcml2YXRlRmlsZShwYXRoOiBzdHJpbmcsIGJ5dGVzOiBCdWZmZXIpOiBQcm9taXNlPHZvaWQ+IHtcbiAgICBhd2FpdCB0aGlzLmRlbGl2ZXJ5RmlsZXN5c3RlbS53cml0ZVByaXZhdGVGaWxlKHBhdGgsIGJ5dGVzKTtcbiAgfVxuXG4gIGFzeW5jIHJlYWRGaWxlSWZQcmVzZW50KHBhdGg6IHN0cmluZyk6IFByb21pc2U8QnVmZmVyIHwgbnVsbD4ge1xuICAgIHJldHVybiBhd2FpdCB0aGlzLmRlbGl2ZXJ5RmlsZXN5c3RlbS5yZWFkRmlsZUlmUHJlc2VudChwYXRoKTtcbiAgfVxuXG4gIHByaXZhdGUgcmVhZG9ubHkgZGVsaXZlcnlGaWxlc3lzdGVtID1cbiAgICBuZXcgTm9kZVdvcmtzcGFjZUhvc3RDcmVkZW50aWFsRGVsaXZlcnlGaWxlc3lzdGVtKCk7XG59XG5cbmV4cG9ydCBpbnRlcmZhY2UgUHJvZHVjdGlvbldvcmtzcGFjZUhvc3RPcHRpb25zIHtcbiAgcmVhZG9ubHkgc3lzdGVtPzogV29ya3NwYWNlSG9zdFN5c3RlbTtcbiAgcmVhZG9ubHkgd29ya3NwYWNlUm9vdD86IHN0cmluZztcbiAgcmVhZG9ubHkgd29ya3NwYWNlQ29tbWFuZD86IHN0cmluZztcbiAgcmVhZG9ubHkgZ2l0Q29tbWFuZD86IHN0cmluZztcbiAgcmVhZG9ubHkgYWdlbnRQcm9iZVJ1bm5lcj86IFdvcmtzcGFjZUhvc3RBZ2VudFByb2JlUnVubmVyO1xuICByZWFkb25seSBub3c/OiAoKSA9PiBEYXRlO1xuICByZWFkb25seSBnaXRDcmVkZW50aWFsQmluZGluZ3M/OiBXb3Jrc3BhY2VIb3N0R2l0Q3JlZGVudGlhbEJpbmRpbmdSZWdpc3RyeTtcbiAgcmVhZG9ubHkgY3JlZGVudGlhbE1hdGVyaWFsUm9vdD86IHN0cmluZztcbiAgLyoqIEV4cGxpY2l0IG5hdGl2ZSBob21lIGZvciB0aGUgd29ya3NwYWNlIGlkZW50aXR5OyBuZXZlciBpbmZlcnJlZCBmcm9tIGFtYmllbnQgSE9NRS4gKi9cbiAgcmVhZG9ubHkgd29ya3NwYWNlSG9tZT86IHN0cmluZztcbiAgcmVhZG9ubHkgd29ya3NwYWNlVXNlcj86IHN0cmluZztcbiAgcmVhZG9ubHkgd29ya3NwYWNlR3JvdXA/OiBzdHJpbmc7XG4gIC8qKlxuICAgKiBUaGUgVEhJUkQgaWRlbnRpdHkgKEQtMjQ4KSDigJQgdGhlIGFjY291bnQgdGhlIGJ1bmRsZWQgYWdlbnQgQ0xJcyBleGVjdXRlIGFzLCBhbmQgdGhlIG93bmVyIG9mXG4gICAqIHRoZSBkZWxpdmVyZWQgYWdlbnQgY3JlZGVudGlhbCBob21lLiBEZWxpYmVyYXRlbHkgTk9UIGB3b3Jrc3BhY2VVc2VyYDogdGhhdCBhY2NvdW50IGlzIHRoZVxuICAgKiBjdXN0b21lcidzIFNTSCBsb2dpbiBvbiBhIEJZT0MgaG9zdCwgYW5kIEQtMDQzIGZvcmJpZHMgaXQgcmVhZGluZyB0aGUgcnVudGltZSBhdCBhbGwuXG4gICAqL1xuICByZWFkb25seSBhZ2VudEhvbWU/OiBzdHJpbmc7XG4gIHJlYWRvbmx5IGFnZW50VXNlcj86IHN0cmluZztcbiAgcmVhZG9ubHkgYWdlbnRHcm91cD86IHN0cmluZztcbiAgcmVhZG9ubHkgYWdlbnRQcm9iZVBhdGg/OiBzdHJpbmc7XG4gIC8qKlxuICAgKiBBdHRlc3RhdGlvbiB0aGlzIGFkYXB0ZXIgcmVhZHMgdGhlIHZlbmRvciBydW50aW1lIHBhdGhzIG91dCBvZiAoRC0yNTkgRGVmZWN0IDIpLlxuICAgKlxuICAgKiBPdmVycmlkYWJsZSBzbyBhIHRlc3QgY2FuIHBvaW50IGF0IGEgZml4dHVyZTsgcHJvZHVjdGlvbiBhbHdheXMgdXNlcyB0aGUgcmVhbCBob3N0IHBhdGguXG4gICAqL1xuICByZWFkb25seSBhZ2VudFJ1bnRpbWVBdHRlc3RhdGlvblBhdGg/OiBzdHJpbmc7XG4gIC8qKiBDdXN0b21lciBhZ2VudCB0b29sY2hhaW4gYmluIHRoZSBwcm9iZXMgZXhlY3V0ZSBmcm9tIChELTQyMyk7IG92ZXJyaWRhYmxlIGZvciB0ZXN0cy4gKi9cbiAgcmVhZG9ubHkgY3VzdG9tZXJBZ2VudFRvb2xjaGFpbkJpbj86IHN0cmluZztcbn1cblxuaW50ZXJmYWNlIFdvcmtzcGFjZUhvc3RHaXRDcmVkZW50aWFsQmluZGluZyB7XG4gIHJlYWRvbmx5IGdlbmVyYXRpb246IG51bWJlcjtcbiAgcmVhZG9ubHkgbWF0ZXJpYWxQYXRoOiBzdHJpbmc7XG4gIHJlYWRvbmx5IGV4cGlyZXNBdD86IHN0cmluZztcbn1cblxuLyoqXG4gKiBGaWxlc3lzdGVtLWJhY2tlZCBzdGF0ZSBqb2luaW5nIGxpZmVjeWNsZSBiaW5kL3Jldm9rZSB0byBhIGxhdGVyIHByaXZhdGUgY2xvbmUuXG4gKlxuICogVGhlIG9sZCBpbXBsZW1lbnRhdGlvbiBrZXB0IGBhY3RpdmVgIG9ubHkgaW4gdGhpcyBvYmplY3QuIFRoZSBwYWNrYWdlZCBpbml0aWFsaXplciBjb25zdHJ1Y3RzIGFcbiAqIG5ldyBvYmplY3QgZm9yIGV2ZXJ5IFNTSCBzdGVwLCBzbyBhIHN1Y2Nlc3NmdWwgYmluZCB3YXMgaW52aXNpYmxlIHRvIHRoZSBuZXh0IGNsb25lIHByb2Nlc3MuXG4gKiBFdmVyeSBvcGVyYXRpb24gYmVsb3cgcmVhZHMgdGhlIHN0YXRlIGZpbGUgYWZyZXNoOyBpbmRlcGVuZGVudCBwcm9jZXNzZXMgdGhlcmVmb3JlIHNoYXJlIHRoZVxuICogc2FtZSBnZW5lcmF0aW9uIHdpdGhvdXQgYSBjb250cm9sbGVyLXNpZGUgc2luZ2xldG9uLlxuICovXG5leHBvcnQgY2xhc3MgV29ya3NwYWNlSG9zdEdpdENyZWRlbnRpYWxCaW5kaW5nUmVnaXN0cnkge1xuICBwcml2YXRlIHJlYWRvbmx5IGZpbGVzeXN0ZW06IFdvcmtzcGFjZUhvc3RTeXN0ZW07XG4gIHByaXZhdGUgcmVhZG9ubHkgbWF0ZXJpYWxSb290OiBzdHJpbmc7XG5cbiAgY29uc3RydWN0b3IoXG4gICAgZmlsZXN5c3RlbTogV29ya3NwYWNlSG9zdFN5c3RlbSA9IG5ldyBOb2RlV29ya3NwYWNlSG9zdFN5c3RlbSgpLFxuICAgIG1hdGVyaWFsUm9vdDogc3RyaW5nID0gV09SS1NQQUNFX0hPU1RfQ1JFREVOVElBTF9NQVRFUklBTF9ST09ULFxuICApIHtcbiAgICB0aGlzLmZpbGVzeXN0ZW0gPSBmaWxlc3lzdGVtO1xuICAgIHRoaXMubWF0ZXJpYWxSb290ID0gbWF0ZXJpYWxSb290O1xuICB9XG5cbiAgc3RhdGljIHN0YXRlUGF0aChtYXRlcmlhbFJvb3Q6IHN0cmluZyk6IHN0cmluZyB7XG4gICAgcmV0dXJuIGpvaW4obWF0ZXJpYWxSb290LCBcImFjdGl2ZVwiLCBcImdpdC1iaW5kaW5nLmpzb25cIik7XG4gIH1cblxuICBwcml2YXRlIGFzeW5jIHJlYWRTdGF0ZSgpOiBQcm9taXNlPFdvcmtzcGFjZUhvc3RHaXRDcmVkZW50aWFsQmluZGluZyB8IG51bGw+IHtcbiAgICBjb25zdCByYXcgPSBhd2FpdCB0aGlzLmZpbGVzeXN0ZW0ucmVhZEZpbGVJZlByZXNlbnQoXG4gICAgICBXb3Jrc3BhY2VIb3N0R2l0Q3JlZGVudGlhbEJpbmRpbmdSZWdpc3RyeS5zdGF0ZVBhdGgodGhpcy5tYXRlcmlhbFJvb3QpLFxuICAgICk7XG4gICAgaWYgKHJhdyA9PT0gbnVsbCkgcmV0dXJuIG51bGw7XG4gICAgbGV0IHBhcnNlZDogdW5rbm93bjtcbiAgICB0cnkge1xuICAgICAgcGFyc2VkID0gSlNPTi5wYXJzZShyYXcudG9TdHJpbmcoXCJ1dGY4XCIpKTtcbiAgICB9IGNhdGNoIHtcbiAgICAgIHRocm93IG5ldyBXb3Jrc3BhY2VIb3N0T3BlcmF0aW9uRXJyb3IoXG4gICAgICAgIFwiY3JlZGVudGlhbC5naXQuc3RhdGVcIixcbiAgICAgICAgMSxcbiAgICAgICAgXCJhY3RpdmUgR2l0IGJpbmRpbmcgc3RhdGUgaXMgbWFsZm9ybWVkXCIsXG4gICAgICApO1xuICAgIH1cbiAgICBpZiAoIXBhcnNlZCB8fCB0eXBlb2YgcGFyc2VkICE9PSBcIm9iamVjdFwiIHx8IEFycmF5LmlzQXJyYXkocGFyc2VkKSkge1xuICAgICAgdGhyb3cgbmV3IFdvcmtzcGFjZUhvc3RPcGVyYXRpb25FcnJvcihcbiAgICAgICAgXCJjcmVkZW50aWFsLmdpdC5zdGF0ZVwiLFxuICAgICAgICAxLFxuICAgICAgICBcImFjdGl2ZSBHaXQgYmluZGluZyBzdGF0ZSBpcyBtYWxmb3JtZWRcIixcbiAgICAgICk7XG4gICAgfVxuICAgIGNvbnN0IGJvZHkgPSBwYXJzZWQgYXMgUmVjb3JkPHN0cmluZywgdW5rbm93bj47XG4gICAgaWYgKFxuICAgICAgYm9keS5jb250cmFjdFZlcnNpb24gIT09IFdPUktTUEFDRV9IT1NUX0dJVF9CSU5ESU5HX1NUQVRFX1ZFUlNJT04gfHxcbiAgICAgIGJvZHkuY2hhbm5lbCAhPT0gXCJnaXRcIiB8fFxuICAgICAgYm9keS5mYW1pbHkgIT09IFwiZ2l0LXNob3J0LWxpdmVkLWRlbGVnYXRpb25cIiB8fFxuICAgICAgIU51bWJlci5pc1NhZmVJbnRlZ2VyKGJvZHkuZ2VuZXJhdGlvbikgfHxcbiAgICAgIChib2R5LmdlbmVyYXRpb24gYXMgbnVtYmVyKSA8IDEgfHxcbiAgICAgIHR5cGVvZiBib2R5Lm1hdGVyaWFsUGF0aCAhPT0gXCJzdHJpbmdcIiB8fFxuICAgICAgKGJvZHkuZXhwaXJlc0F0ICE9PSB1bmRlZmluZWQgJiZcbiAgICAgICAgKHR5cGVvZiBib2R5LmV4cGlyZXNBdCAhPT0gXCJzdHJpbmdcIiB8fFxuICAgICAgICAgICFOdW1iZXIuaXNGaW5pdGUoRGF0ZS5wYXJzZShib2R5LmV4cGlyZXNBdCkpKSlcbiAgICApIHtcbiAgICAgIHRocm93IG5ldyBXb3Jrc3BhY2VIb3N0T3BlcmF0aW9uRXJyb3IoXG4gICAgICAgIFwiY3JlZGVudGlhbC5naXQuc3RhdGVcIixcbiAgICAgICAgMSxcbiAgICAgICAgXCJhY3RpdmUgR2l0IGJpbmRpbmcgc3RhdGUgaXMgbWFsZm9ybWVkXCIsXG4gICAgICApO1xuICAgIH1cbiAgICBjb25zdCBleHBlY3RlZFBhdGggPSB3b3Jrc3BhY2VIb3N0Q3JlZGVudGlhbE1hdGVyaWFsUGF0aChcbiAgICAgIHRoaXMubWF0ZXJpYWxSb290LFxuICAgICAgXCJnaXQtc2hvcnQtbGl2ZWQtZGVsZWdhdGlvblwiLFxuICAgICAgYm9keS5nZW5lcmF0aW9uIGFzIG51bWJlcixcbiAgICApO1xuICAgIGlmIChib2R5Lm1hdGVyaWFsUGF0aCAhPT0gZXhwZWN0ZWRQYXRoKSB7XG4gICAgICB0aHJvdyBuZXcgV29ya3NwYWNlSG9zdE9wZXJhdGlvbkVycm9yKFxuICAgICAgICBcImNyZWRlbnRpYWwuZ2l0LnN0YXRlXCIsXG4gICAgICAgIDEsXG4gICAgICAgIFwiYWN0aXZlIEdpdCBiaW5kaW5nIHN0YXRlIHBvaW50cyBvdXRzaWRlIHRoZSBjYW5vbmljYWwgbWF0ZXJpYWwgcGF0aFwiLFxuICAgICAgKTtcbiAgICB9XG4gICAgcmV0dXJuIHtcbiAgICAgIGdlbmVyYXRpb246IGJvZHkuZ2VuZXJhdGlvbiBhcyBudW1iZXIsXG4gICAgICBtYXRlcmlhbFBhdGg6IGJvZHkubWF0ZXJpYWxQYXRoLFxuICAgICAgLi4uKGJvZHkuZXhwaXJlc0F0ID8geyBleHBpcmVzQXQ6IGJvZHkuZXhwaXJlc0F0IH0gOiB7fSksXG4gICAgfTtcbiAgfVxuXG4gIHByaXZhdGUgYXN5bmMgYmluZFVubG9ja2VkKFxuICAgIGJpbmRpbmc6IFdvcmtzcGFjZUhvc3RDcmVkZW50aWFsQmluZGluZ0Rlc2NyaXB0b3IsXG4gICAgbWF0ZXJpYWxQYXRoOiBzdHJpbmcsXG4gICk6IFByb21pc2U8dm9pZD4ge1xuICAgIGlmIChiaW5kaW5nLmNoYW5uZWwgIT09IFwiZ2l0XCIpIHJldHVybjtcbiAgICBjb25zdCBleHBlY3RlZFBhdGggPSB3b3Jrc3BhY2VIb3N0Q3JlZGVudGlhbE1hdGVyaWFsUGF0aChcbiAgICAgIHRoaXMubWF0ZXJpYWxSb290LFxuICAgICAgXCJnaXQtc2hvcnQtbGl2ZWQtZGVsZWdhdGlvblwiLFxuICAgICAgYmluZGluZy5nZW5lcmF0aW9uLFxuICAgICk7XG4gICAgaWYgKG1hdGVyaWFsUGF0aCAhPT0gZXhwZWN0ZWRQYXRoKSB7XG4gICAgICB0aHJvdyBuZXcgV29ya3NwYWNlSG9zdE9wZXJhdGlvbkVycm9yKFxuICAgICAgICBcImNyZWRlbnRpYWwuZ2l0LmJpbmRcIixcbiAgICAgICAgMSxcbiAgICAgICAgXCJHaXQgYmluZGluZyBtYXRlcmlhbCBwYXRoIGlzIG5vdCB0aGUgY2Fub25pY2FsIGdlbmVyYXRpb24gcGF0aFwiLFxuICAgICAgKTtcbiAgICB9XG4gICAgY29uc3QgY3VycmVudCA9IGF3YWl0IHRoaXMucmVhZFN0YXRlKCk7XG4gICAgaWYgKGN1cnJlbnQgJiYgY3VycmVudC5nZW5lcmF0aW9uID4gYmluZGluZy5nZW5lcmF0aW9uKSB7XG4gICAgICB0aHJvdyBuZXcgV29ya3NwYWNlSG9zdE9wZXJhdGlvbkVycm9yKFxuICAgICAgICBcImNyZWRlbnRpYWwuZ2l0LmJpbmRcIixcbiAgICAgICAgMSxcbiAgICAgICAgYGNhbm5vdCBhY3RpdmF0ZSBnZW5lcmF0aW9uICR7YmluZGluZy5nZW5lcmF0aW9ufSBiZWxvdyBhY3RpdmUgZ2VuZXJhdGlvbiAke2N1cnJlbnQuZ2VuZXJhdGlvbn1gLFxuICAgICAgKTtcbiAgICB9XG4gICAgaWYgKFxuICAgICAgY3VycmVudCAmJlxuICAgICAgY3VycmVudC5nZW5lcmF0aW9uID09PSBiaW5kaW5nLmdlbmVyYXRpb24gJiZcbiAgICAgIChjdXJyZW50Lm1hdGVyaWFsUGF0aCAhPT0gbWF0ZXJpYWxQYXRoIHx8XG4gICAgICAgIGN1cnJlbnQuZXhwaXJlc0F0ICE9PSBiaW5kaW5nLmV4cGlyZXNBdClcbiAgICApIHtcbiAgICAgIHRocm93IG5ldyBXb3Jrc3BhY2VIb3N0T3BlcmF0aW9uRXJyb3IoXG4gICAgICAgIFwiY3JlZGVudGlhbC5naXQuYmluZFwiLFxuICAgICAgICAxLFxuICAgICAgICBgZ2VuZXJhdGlvbiAke2JpbmRpbmcuZ2VuZXJhdGlvbn0gaXMgYWxyZWFkeSBhY3RpdmUgd2l0aCBkaWZmZXJlbnQgYmluZGluZyBzdGF0ZWAsXG4gICAgICApO1xuICAgIH1cbiAgICBhd2FpdCB0aGlzLmZpbGVzeXN0ZW0uZW5zdXJlRGlyZWN0b3J5KGpvaW4odGhpcy5tYXRlcmlhbFJvb3QsIFwiYWN0aXZlXCIpKTtcbiAgICBhd2FpdCB0aGlzLmZpbGVzeXN0ZW0ud3JpdGVQcml2YXRlRmlsZShcbiAgICAgIFdvcmtzcGFjZUhvc3RHaXRDcmVkZW50aWFsQmluZGluZ1JlZ2lzdHJ5LnN0YXRlUGF0aCh0aGlzLm1hdGVyaWFsUm9vdCksXG4gICAgICBCdWZmZXIuZnJvbShcbiAgICAgICAgSlNPTi5zdHJpbmdpZnkoe1xuICAgICAgICAgIGNvbnRyYWN0VmVyc2lvbjogV09SS1NQQUNFX0hPU1RfR0lUX0JJTkRJTkdfU1RBVEVfVkVSU0lPTixcbiAgICAgICAgICBjaGFubmVsOiBcImdpdFwiLFxuICAgICAgICAgIGZhbWlseTogXCJnaXQtc2hvcnQtbGl2ZWQtZGVsZWdhdGlvblwiLFxuICAgICAgICAgIGdlbmVyYXRpb246IGJpbmRpbmcuZ2VuZXJhdGlvbixcbiAgICAgICAgICBtYXRlcmlhbFBhdGgsXG4gICAgICAgICAgLi4uKGJpbmRpbmcuZXhwaXJlc0F0ID8geyBleHBpcmVzQXQ6IGJpbmRpbmcuZXhwaXJlc0F0IH0gOiB7fSksXG4gICAgICAgIH0pLFxuICAgICAgICBcInV0ZjhcIixcbiAgICAgICksXG4gICAgKTtcbiAgfVxuXG4gIGFzeW5jIGJpbmQoXG4gICAgYmluZGluZzogV29ya3NwYWNlSG9zdENyZWRlbnRpYWxCaW5kaW5nRGVzY3JpcHRvcixcbiAgICBtYXRlcmlhbFBhdGg6IHN0cmluZyxcbiAgICBvcHRpb25zOiB7IHJlYWRvbmx5IGxvY2tIZWxkPzogYm9vbGVhbiB9ID0ge30sXG4gICk6IFByb21pc2U8dm9pZD4ge1xuICAgIGNvbnN0IHRhc2sgPSAoKSA9PiB0aGlzLmJpbmRVbmxvY2tlZChiaW5kaW5nLCBtYXRlcmlhbFBhdGgpO1xuICAgIGlmIChvcHRpb25zLmxvY2tIZWxkKSByZXR1cm4gYXdhaXQgdGFzaygpO1xuICAgIHJldHVybiBhd2FpdCB3aXRoV29ya3NwYWNlSG9zdENyZWRlbnRpYWxGaWxlc3lzdGVtTG9jayhcbiAgICAgIHRoaXMuZmlsZXN5c3RlbSxcbiAgICAgIHdvcmtzcGFjZUhvc3RDcmVkZW50aWFsRmFtaWx5TG9ja1BhdGgoXG4gICAgICAgIHRoaXMubWF0ZXJpYWxSb290LFxuICAgICAgICBcImdpdC1zaG9ydC1saXZlZC1kZWxlZ2F0aW9uXCIsXG4gICAgICApLFxuICAgICAgdGFzayxcbiAgICApO1xuICB9XG5cbiAgcHJpdmF0ZSBhc3luYyByZXZva2VVbmxvY2tlZChcbiAgICBiaW5kaW5nOiBXb3Jrc3BhY2VIb3N0Q3JlZGVudGlhbEJpbmRpbmdEZXNjcmlwdG9yLFxuICApOiBQcm9taXNlPHZvaWQ+IHtcbiAgICBpZiAoYmluZGluZy5jaGFubmVsICE9PSBcImdpdFwiKSByZXR1cm47XG4gICAgY29uc3QgY3VycmVudCA9IGF3YWl0IHRoaXMucmVhZFN0YXRlKCk7XG4gICAgLy8gTmV2ZXIgbGV0IGFuIG9sZCBwcm9jZXNzIHJldm9rZSBhIG5ld2VyIGFjdGl2ZSBiaW5kaW5nLlxuICAgIGlmICghY3VycmVudCB8fCBjdXJyZW50LmdlbmVyYXRpb24gIT09IGJpbmRpbmcuZ2VuZXJhdGlvbikgcmV0dXJuO1xuICAgIGF3YWl0IHRoaXMuZmlsZXN5c3RlbS5yZW1vdmVQYXRoKFxuICAgICAgV29ya3NwYWNlSG9zdEdpdENyZWRlbnRpYWxCaW5kaW5nUmVnaXN0cnkuc3RhdGVQYXRoKHRoaXMubWF0ZXJpYWxSb290KSxcbiAgICApO1xuICB9XG5cbiAgYXN5bmMgcmV2b2tlKFxuICAgIGJpbmRpbmc6IFdvcmtzcGFjZUhvc3RDcmVkZW50aWFsQmluZGluZ0Rlc2NyaXB0b3IsXG4gICAgb3B0aW9uczogeyByZWFkb25seSBsb2NrSGVsZD86IGJvb2xlYW4gfSA9IHt9LFxuICApOiBQcm9taXNlPHZvaWQ+IHtcbiAgICBjb25zdCB0YXNrID0gKCkgPT4gdGhpcy5yZXZva2VVbmxvY2tlZChiaW5kaW5nKTtcbiAgICBpZiAob3B0aW9ucy5sb2NrSGVsZCkgcmV0dXJuIGF3YWl0IHRhc2soKTtcbiAgICByZXR1cm4gYXdhaXQgd2l0aFdvcmtzcGFjZUhvc3RDcmVkZW50aWFsRmlsZXN5c3RlbUxvY2soXG4gICAgICB0aGlzLmZpbGVzeXN0ZW0sXG4gICAgICB3b3Jrc3BhY2VIb3N0Q3JlZGVudGlhbEZhbWlseUxvY2tQYXRoKFxuICAgICAgICB0aGlzLm1hdGVyaWFsUm9vdCxcbiAgICAgICAgXCJnaXQtc2hvcnQtbGl2ZWQtZGVsZWdhdGlvblwiLFxuICAgICAgKSxcbiAgICAgIHRhc2ssXG4gICAgKTtcbiAgfVxuXG4gIHByaXZhdGUgYXN5bmMgdmVyaWZ5Qm91bmRVbmxvY2tlZChcbiAgICBiaW5kaW5nOiBXb3Jrc3BhY2VIb3N0Q3JlZGVudGlhbEJpbmRpbmdEZXNjcmlwdG9yLFxuICAgIG1hdGVyaWFsUGF0aDogc3RyaW5nLFxuICApOiBQcm9taXNlPHZvaWQ+IHtcbiAgICBpZiAoYmluZGluZy5jaGFubmVsICE9PSBcImdpdFwiKSByZXR1cm47XG4gICAgY29uc3QgY3VycmVudCA9IGF3YWl0IHRoaXMucmVhZFN0YXRlKCk7XG4gICAgaWYgKFxuICAgICAgIWN1cnJlbnQgfHxcbiAgICAgIGN1cnJlbnQuZ2VuZXJhdGlvbiAhPT0gYmluZGluZy5nZW5lcmF0aW9uIHx8XG4gICAgICBjdXJyZW50Lm1hdGVyaWFsUGF0aCAhPT0gbWF0ZXJpYWxQYXRoIHx8XG4gICAgICBjdXJyZW50LmV4cGlyZXNBdCAhPT0gYmluZGluZy5leHBpcmVzQXRcbiAgICApIHtcbiAgICAgIHRocm93IG5ldyBXb3Jrc3BhY2VIb3N0T3BlcmF0aW9uRXJyb3IoXG4gICAgICAgIFwiY3JlZGVudGlhbC5naXQudmVyaWZ5LWJvdW5kXCIsXG4gICAgICAgIDEsXG4gICAgICAgIGBnZW5lcmF0aW9uICR7YmluZGluZy5nZW5lcmF0aW9ufSBpcyBub3QgdGhlIGFjdGl2ZSBHaXQgYmluZGluZ2AsXG4gICAgICApO1xuICAgIH1cbiAgfVxuXG4gIGFzeW5jIHZlcmlmeUJvdW5kKFxuICAgIGJpbmRpbmc6IFdvcmtzcGFjZUhvc3RDcmVkZW50aWFsQmluZGluZ0Rlc2NyaXB0b3IsXG4gICAgbWF0ZXJpYWxQYXRoOiBzdHJpbmcsXG4gICAgb3B0aW9uczogeyByZWFkb25seSBsb2NrSGVsZD86IGJvb2xlYW4gfSA9IHt9LFxuICApOiBQcm9taXNlPHZvaWQ+IHtcbiAgICBjb25zdCB0YXNrID0gKCkgPT4gdGhpcy52ZXJpZnlCb3VuZFVubG9ja2VkKGJpbmRpbmcsIG1hdGVyaWFsUGF0aCk7XG4gICAgaWYgKG9wdGlvbnMubG9ja0hlbGQpIHJldHVybiBhd2FpdCB0YXNrKCk7XG4gICAgcmV0dXJuIGF3YWl0IHdpdGhXb3Jrc3BhY2VIb3N0Q3JlZGVudGlhbEZpbGVzeXN0ZW1Mb2NrKFxuICAgICAgdGhpcy5maWxlc3lzdGVtLFxuICAgICAgd29ya3NwYWNlSG9zdENyZWRlbnRpYWxGYW1pbHlMb2NrUGF0aChcbiAgICAgICAgdGhpcy5tYXRlcmlhbFJvb3QsXG4gICAgICAgIFwiZ2l0LXNob3J0LWxpdmVkLWRlbGVnYXRpb25cIixcbiAgICAgICksXG4gICAgICB0YXNrLFxuICAgICk7XG4gIH1cblxuICBwcml2YXRlIGFzeW5jIHZlcmlmeVJldm9rZWRVbmxvY2tlZChcbiAgICBiaW5kaW5nOiBXb3Jrc3BhY2VIb3N0Q3JlZGVudGlhbEJpbmRpbmdEZXNjcmlwdG9yLFxuICApOiBQcm9taXNlPHZvaWQ+IHtcbiAgICBpZiAoYmluZGluZy5jaGFubmVsICE9PSBcImdpdFwiKSByZXR1cm47XG4gICAgY29uc3QgY3VycmVudCA9IGF3YWl0IHRoaXMucmVhZFN0YXRlKCk7XG4gICAgaWYgKGN1cnJlbnQ/LmdlbmVyYXRpb24gPT09IGJpbmRpbmcuZ2VuZXJhdGlvbikge1xuICAgICAgdGhyb3cgbmV3IFdvcmtzcGFjZUhvc3RPcGVyYXRpb25FcnJvcihcbiAgICAgICAgXCJjcmVkZW50aWFsLmdpdC52ZXJpZnktcmV2b2tlZFwiLFxuICAgICAgICAxLFxuICAgICAgICBgZ2VuZXJhdGlvbiAke2JpbmRpbmcuZ2VuZXJhdGlvbn0gaXMgc3RpbGwgdGhlIGFjdGl2ZSBHaXQgYmluZGluZ2AsXG4gICAgICApO1xuICAgIH1cbiAgfVxuXG4gIGFzeW5jIHZlcmlmeVJldm9rZWQoXG4gICAgYmluZGluZzogV29ya3NwYWNlSG9zdENyZWRlbnRpYWxCaW5kaW5nRGVzY3JpcHRvcixcbiAgICBvcHRpb25zOiB7IHJlYWRvbmx5IGxvY2tIZWxkPzogYm9vbGVhbiB9ID0ge30sXG4gICk6IFByb21pc2U8dm9pZD4ge1xuICAgIGNvbnN0IHRhc2sgPSAoKSA9PiB0aGlzLnZlcmlmeVJldm9rZWRVbmxvY2tlZChiaW5kaW5nKTtcbiAgICBpZiAob3B0aW9ucy5sb2NrSGVsZCkgcmV0dXJuIGF3YWl0IHRhc2soKTtcbiAgICByZXR1cm4gYXdhaXQgd2l0aFdvcmtzcGFjZUhvc3RDcmVkZW50aWFsRmlsZXN5c3RlbUxvY2soXG4gICAgICB0aGlzLmZpbGVzeXN0ZW0sXG4gICAgICB3b3Jrc3BhY2VIb3N0Q3JlZGVudGlhbEZhbWlseUxvY2tQYXRoKFxuICAgICAgICB0aGlzLm1hdGVyaWFsUm9vdCxcbiAgICAgICAgXCJnaXQtc2hvcnQtbGl2ZWQtZGVsZWdhdGlvblwiLFxuICAgICAgKSxcbiAgICAgIHRhc2ssXG4gICAgKTtcbiAgfVxuXG4gIGFzeW5jIHJlc29sdmUobm93OiBEYXRlKTogUHJvbWlzZTxXb3Jrc3BhY2VIb3N0R2l0Q3JlZGVudGlhbEJpbmRpbmc+IHtcbiAgICBjb25zdCBhY3RpdmUgPSBhd2FpdCB0aGlzLnJlYWRTdGF0ZSgpO1xuICAgIGlmICghYWN0aXZlKSB7XG4gICAgICB0aHJvdyBuZXcgV29ya3NwYWNlSG9zdE9wZXJhdGlvbkVycm9yKFxuICAgICAgICBcImNsb25lUmVwb3NpdG9yeS5jcmVkZW50aWFsc1wiLFxuICAgICAgICAxLFxuICAgICAgICBcIm5vIGJvdW5kIGdpdCBjcmVkZW50aWFsIG1hdGVyaWFsIGlzIGF2YWlsYWJsZSBmb3IgYSBwcml2YXRlIGNsb25lXCIsXG4gICAgICApO1xuICAgIH1cbiAgICBpZiAoYWN0aXZlLmV4cGlyZXNBdCAmJiBEYXRlLnBhcnNlKGFjdGl2ZS5leHBpcmVzQXQpIDw9IG5vdy5nZXRUaW1lKCkpIHtcbiAgICAgIHRocm93IG5ldyBXb3Jrc3BhY2VIb3N0T3BlcmF0aW9uRXJyb3IoXG4gICAgICAgIFwiY2xvbmVSZXBvc2l0b3J5LmNyZWRlbnRpYWxzXCIsXG4gICAgICAgIDEsXG4gICAgICAgIFwidGhlIGJvdW5kIGdpdCBjcmVkZW50aWFsIG1hdGVyaWFsIGhhcyBleHBpcmVkXCIsXG4gICAgICApO1xuICAgIH1cbiAgICByZXR1cm4gYWN0aXZlO1xuICB9XG59XG5cbmNvbnN0IFdPUktTUEFDRV9IT1NUX0dJVF9CSU5ESU5HX1NUQVRFX1ZFUlNJT04gPVxuICBcInBhcGVyY3VzcC13b3Jrc3BhY2UtaG9zdC1naXQtYmluZGluZy1zdGF0ZS12MVwiO1xuXG4vKipcbiAqIFJlamVjdCBhIHBhdGggdGhhdCB3b3VsZCBlc2NhcGUgdGhlIHdvcmtzcGFjZSByb290LlxuICpcbiAqIFRoZSBjb250cm9sbGVyIHN1cHBsaWVzIGBkZXN0aW5hdGlvbmAgYW5kIHRoZSBpbmNsdWRlIGxpc3RzLCBhbmQgdGhvc2UgYXJyaXZlIG92ZXIgYSBuZXR3b3JrXG4gKiBib3VuZGFyeS4gQSByZWxhdGl2ZSBwYXRoIGNvbnRhaW5pbmcgYC4uYCwgb3IgYW4gYWJzb2x1dGUgcGF0aCBwb2ludGluZyBhbnl3aGVyZSwgd291bGQgbGV0IGFcbiAqIG1hbGZvcm1lZCAob3IgaG9zdGlsZSkgcmVxdWVzdCB3cml0ZSBvdXRzaWRlIHRoZSB3b3Jrc3BhY2UgaXQgY2xhaW1zIHRvIGJlIGluaXRpYWxpemluZy5cbiAqL1xuZnVuY3Rpb24gcmVzb2x2ZVdpdGhpblJvb3QoXG4gIHJvb3Q6IHN0cmluZyxcbiAgY2FuZGlkYXRlOiBzdHJpbmcsXG4gIGxhYmVsOiBzdHJpbmcsXG4pOiBzdHJpbmcge1xuICBpZiAoaXNBYnNvbHV0ZShjYW5kaWRhdGUpKSB7XG4gICAgdGhyb3cgbmV3IFdvcmtzcGFjZUhvc3RPcGVyYXRpb25FcnJvcihcbiAgICAgIGxhYmVsLFxuICAgICAgMSxcbiAgICAgIGAke2xhYmVsfSBtdXN0IGJlIHdvcmtzcGFjZS1yZWxhdGl2ZWAsXG4gICAgKTtcbiAgfVxuICBjb25zdCByZXNvbHZlZCA9IGpvaW4ocm9vdCwgY2FuZGlkYXRlKTtcbiAgaWYgKHJlc29sdmVkICE9PSByb290ICYmICFyZXNvbHZlZC5zdGFydHNXaXRoKGAke3Jvb3R9L2ApKSB7XG4gICAgdGhyb3cgbmV3IFdvcmtzcGFjZUhvc3RPcGVyYXRpb25FcnJvcihcbiAgICAgIGxhYmVsLFxuICAgICAgMSxcbiAgICAgIGAke2xhYmVsfSBlc2NhcGVzIHRoZSB3b3Jrc3BhY2Ugcm9vdGAsXG4gICAgKTtcbiAgfVxuICByZXR1cm4gcmVzb2x2ZWQ7XG59XG5cbmNvbnN0IFdPUktTUEFDRV9IT1NUX0xJTlVYX0FDQ09VTlQgPSAvXlthLXpfXVthLXowLTlfLV17MCwzMH0kLztcblxuZnVuY3Rpb24gcmVxdWlyZVdvcmtzcGFjZUFjY291bnQodmFsdWU6IHN0cmluZywgbGFiZWw6IHN0cmluZyk6IHN0cmluZyB7XG4gIGlmICghV09SS1NQQUNFX0hPU1RfTElOVVhfQUNDT1VOVC50ZXN0KHZhbHVlKSB8fCB2YWx1ZSA9PT0gXCJyb290XCIpIHtcbiAgICB0aHJvdyBuZXcgV29ya3NwYWNlSG9zdE9wZXJhdGlvbkVycm9yKFxuICAgICAgbGFiZWwsXG4gICAgICAxLFxuICAgICAgYCR7bGFiZWx9IG11c3QgYmUgYSBub24tcm9vdCBMaW51eCBhY2NvdW50IG5hbWVgLFxuICAgICk7XG4gIH1cbiAgcmV0dXJuIHZhbHVlO1xufVxuXG5leHBvcnQgY2xhc3MgUHJvZHVjdGlvbldvcmtzcGFjZUhvc3RSZW1vdGVJbml0aWFsaXplckhvc3QgaW1wbGVtZW50cyBXb3Jrc3BhY2VIb3N0UmVtb3RlSW5pdGlhbGl6ZXJIb3N0IHtcbiAgcHJpdmF0ZSByZWFkb25seSBzeXN0ZW06IFdvcmtzcGFjZUhvc3RTeXN0ZW07XG4gIHByaXZhdGUgcmVhZG9ubHkgd29ya3NwYWNlUm9vdDogc3RyaW5nO1xuICBwcml2YXRlIHJlYWRvbmx5IHdvcmtzcGFjZUNvbW1hbmQ6IHN0cmluZztcbiAgcHJpdmF0ZSByZWFkb25seSBnaXRDb21tYW5kOiBzdHJpbmc7XG4gIHByaXZhdGUgcmVhZG9ubHkgYWdlbnRQcm9iZVJ1bm5lcjogV29ya3NwYWNlSG9zdEFnZW50UHJvYmVSdW5uZXI7XG4gIHByaXZhdGUgcmVhZG9ubHkgbm93OiAoKSA9PiBEYXRlO1xuICBwcml2YXRlIHJlYWRvbmx5IGdpdENyZWRlbnRpYWxCaW5kaW5nczogV29ya3NwYWNlSG9zdEdpdENyZWRlbnRpYWxCaW5kaW5nUmVnaXN0cnk7XG4gIHByaXZhdGUgcmVhZG9ubHkgd29ya3NwYWNlSG9tZTogc3RyaW5nO1xuICBwcml2YXRlIHJlYWRvbmx5IHdvcmtzcGFjZVVzZXI6IHN0cmluZztcbiAgcHJpdmF0ZSByZWFkb25seSB3b3Jrc3BhY2VHcm91cDogc3RyaW5nO1xuICBwcml2YXRlIHJlYWRvbmx5IGFnZW50SG9tZTogc3RyaW5nO1xuICBwcml2YXRlIHJlYWRvbmx5IGFnZW50VXNlcjogc3RyaW5nO1xuICBwcml2YXRlIHJlYWRvbmx5IGFnZW50R3JvdXA6IHN0cmluZztcbiAgcHJpdmF0ZSByZWFkb25seSBhZ2VudFByb2JlUGF0aDogc3RyaW5nO1xuICBwcml2YXRlIHJlYWRvbmx5IGFnZW50UnVudGltZUF0dGVzdGF0aW9uUGF0aDogc3RyaW5nO1xuICBwcml2YXRlIHJlYWRvbmx5IGN1c3RvbWVyQWdlbnRUb29sY2hhaW5CaW46IHN0cmluZztcblxuICBjb25zdHJ1Y3RvcihvcHRpb25zOiBQcm9kdWN0aW9uV29ya3NwYWNlSG9zdE9wdGlvbnMgPSB7fSkge1xuICAgIHRoaXMuc3lzdGVtID0gb3B0aW9ucy5zeXN0ZW0gPz8gbmV3IE5vZGVXb3Jrc3BhY2VIb3N0U3lzdGVtKCk7XG4gICAgdGhpcy53b3Jrc3BhY2VSb290ID1cbiAgICAgIG9wdGlvbnMud29ya3NwYWNlUm9vdCA/PyBXT1JLU1BBQ0VfSE9TVF9ERUZBVUxUX1dPUktTUEFDRV9ST09UO1xuICAgIHRoaXMud29ya3NwYWNlQ29tbWFuZCA9XG4gICAgICBvcHRpb25zLndvcmtzcGFjZUNvbW1hbmQgPz8gV09SS1NQQUNFX0hPU1RfREVGQVVMVF9XT1JLU1BBQ0VfQ09NTUFORDtcbiAgICB0aGlzLmdpdENvbW1hbmQgPSBvcHRpb25zLmdpdENvbW1hbmQgPz8gXCJnaXRcIjtcbiAgICB0aGlzLmFnZW50UHJvYmVSdW5uZXIgPVxuICAgICAgb3B0aW9ucy5hZ2VudFByb2JlUnVubmVyID8/IG5ldyBOb2RlV29ya3NwYWNlSG9zdEFnZW50UHJvYmVSdW5uZXIoKTtcbiAgICB0aGlzLm5vdyA9IG9wdGlvbnMubm93ID8/ICgoKSA9PiBuZXcgRGF0ZSgpKTtcbiAgICB0aGlzLndvcmtzcGFjZUhvbWUgPSByZXF1aXJlRXhwbGljaXRXb3Jrc3BhY2VIb3N0SG9tZShcbiAgICAgIG9wdGlvbnMud29ya3NwYWNlSG9tZSA/PyBXT1JLU1BBQ0VfSE9TVF9ERUZBVUxUX1dPUktTUEFDRV9IT01FLFxuICAgICk7XG4gICAgdGhpcy53b3Jrc3BhY2VVc2VyID0gcmVxdWlyZVdvcmtzcGFjZUFjY291bnQoXG4gICAgICBvcHRpb25zLndvcmtzcGFjZVVzZXIgPz8gREVGQVVMVF9XT1JLU1BBQ0VfSE9TVF9XT1JLU1BBQ0VfVVNFUixcbiAgICAgIFwid29ya3NwYWNlVXNlclwiLFxuICAgICk7XG4gICAgdGhpcy53b3Jrc3BhY2VHcm91cCA9IHJlcXVpcmVXb3Jrc3BhY2VBY2NvdW50KFxuICAgICAgb3B0aW9ucy53b3Jrc3BhY2VHcm91cCA/PyB0aGlzLndvcmtzcGFjZVVzZXIsXG4gICAgICBcIndvcmtzcGFjZUdyb3VwXCIsXG4gICAgKTtcbiAgICB0aGlzLmFnZW50VXNlciA9IHJlcXVpcmVXb3Jrc3BhY2VBY2NvdW50KFxuICAgICAgb3B0aW9ucy5hZ2VudFVzZXIgPz8gREVGQVVMVF9XT1JLU1BBQ0VfSE9TVF9BR0VOVF9VU0VSLFxuICAgICAgXCJhZ2VudFVzZXJcIixcbiAgICApO1xuICAgIHRoaXMuYWdlbnRHcm91cCA9IHJlcXVpcmVXb3Jrc3BhY2VBY2NvdW50KFxuICAgICAgb3B0aW9ucy5hZ2VudEdyb3VwID8/IHRoaXMuYWdlbnRVc2VyLFxuICAgICAgXCJhZ2VudEdyb3VwXCIsXG4gICAgKTtcbiAgICB0aGlzLmFnZW50SG9tZSA9IHJlcXVpcmVFeHBsaWNpdFdvcmtzcGFjZUhvc3RIb21lKFxuICAgICAgb3B0aW9ucy5hZ2VudEhvbWUgPz8gYC9ob21lLyR7dGhpcy5hZ2VudFVzZXJ9YCxcbiAgICApO1xuICAgIC8vIFJlZnVzZSB0aGUgY29sbGFwc2UgcmF0aGVyIHRoYW4gc2lsZW50bHkgYWNjZXB0IGl0LiBBIGNhbGxlciB0aGF0IHBhc3NlcyB0aGUgU1NIIGFjY291bnRcbiAgICAvLyBoZXJlIGhhcyByZWNyZWF0ZWQgdGhlIGV4YWN0IHNoYXBlIEQtMjQ4IHJlbW92ZWQg4oCUIGFnZW50IGNyZWRlbnRpYWxzIGluIHRoZSBjdXN0b21lcidzIG93blxuICAgIC8vIGhvbWUsIGFuZCBhIHJ1bnRpbWUgdGhlIGN1c3RvbWVyJ3MgbG9naW4gbXVzdCByZWFkIOKAlCBhbmQgZXZlcnkgZG93bnN0cmVhbSBjaGVjayB3b3VsZFxuICAgIC8vIHN0aWxsIHBhc3MsIGJlY2F1c2UgZWFjaCBvbmUgaXMgaW5kaXZpZHVhbGx5IHNhdGlzZmlhYmxlIGJ5IHRoYXQgc2hhcGUuXG4gICAgaWYgKHRoaXMuYWdlbnRVc2VyID09PSB0aGlzLndvcmtzcGFjZVVzZXIpIHtcbiAgICAgIHRocm93IG5ldyBXb3Jrc3BhY2VIb3N0T3BlcmF0aW9uRXJyb3IoXG4gICAgICAgIFwiYWdlbnRVc2VyXCIsXG4gICAgICAgIDEsXG4gICAgICAgIFwiYWdlbnRVc2VyIG11c3QgZGlmZmVyIGZyb20gd29ya3NwYWNlVXNlcjogdGhlIGFnZW50IGlkZW50aXR5IGV4aXN0cyBzbyB0aGUgU1NIIGxvZ2luIGlzIG5vdCB0aGUgYWNjb3VudCB0aGF0IHJlYWRzIHRoZSBydW50aW1lIChELTA0MywgRC0yNDgpXCIsXG4gICAgICApO1xuICAgIH1cbiAgICB0aGlzLmFnZW50UHJvYmVQYXRoID1cbiAgICAgIG9wdGlvbnMuYWdlbnRQcm9iZVBhdGggPz8gV09SS1NQQUNFX0hPU1RfREVGQVVMVF9BR0VOVF9QUk9CRV9QQVRIO1xuICAgIGlmIChcbiAgICAgICF0aGlzLmFnZW50UHJvYmVQYXRoLnN0YXJ0c1dpdGgoXCIvXCIpIHx8XG4gICAgICAvW1xcclxcblxcMF0vLnRlc3QodGhpcy5hZ2VudFByb2JlUGF0aClcbiAgICApIHtcbiAgICAgIHRocm93IG5ldyBXb3Jrc3BhY2VIb3N0T3BlcmF0aW9uRXJyb3IoXG4gICAgICAgIFwiYWdlbnRQcm9iZVBhdGhcIixcbiAgICAgICAgMSxcbiAgICAgICAgXCJhZ2VudFByb2JlUGF0aCBtdXN0IGJlIGFuIGFic29sdXRlLCBuZXdsaW5lLWZyZWUgc2VhcmNoIHBhdGhcIixcbiAgICAgICk7XG4gICAgfVxuICAgIHRoaXMuYWdlbnRSdW50aW1lQXR0ZXN0YXRpb25QYXRoID1cbiAgICAgIG9wdGlvbnMuYWdlbnRSdW50aW1lQXR0ZXN0YXRpb25QYXRoID8/XG4gICAgICBXT1JLU1BBQ0VfSE9TVF9CT09UU1RSQVBfQVRURVNUQVRJT05fRklMRTtcbiAgICB0aGlzLmN1c3RvbWVyQWdlbnRUb29sY2hhaW5CaW4gPSByZXF1aXJlRXhwbGljaXRXb3Jrc3BhY2VIb3N0SG9tZShcbiAgICAgIG9wdGlvbnMuY3VzdG9tZXJBZ2VudFRvb2xjaGFpbkJpbiA/PyBXT1JLU1BBQ0VfSE9TVF9DVVNUT01FUl9BR0VOVF9UT09MQ0hBSU5fQklOLFxuICAgICk7XG4gICAgdGhpcy5naXRDcmVkZW50aWFsQmluZGluZ3MgPVxuICAgICAgb3B0aW9ucy5naXRDcmVkZW50aWFsQmluZGluZ3MgPz9cbiAgICAgIG5ldyBXb3Jrc3BhY2VIb3N0R2l0Q3JlZGVudGlhbEJpbmRpbmdSZWdpc3RyeShcbiAgICAgICAgdGhpcy5zeXN0ZW0sXG4gICAgICAgIG9wdGlvbnMuY3JlZGVudGlhbE1hdGVyaWFsUm9vdCA/P1xuICAgICAgICAgIFdPUktTUEFDRV9IT1NUX0NSRURFTlRJQUxfTUFURVJJQUxfUk9PVCxcbiAgICAgICk7XG4gIH1cblxuICBwcml2YXRlIGFzeW5jIHJlcXVpcmUoXG4gICAgb3BlcmF0aW9uOiBzdHJpbmcsXG4gICAgaW5wdXQ6IFdvcmtzcGFjZUhvc3RDb21tYW5kSW5wdXQsXG4gICk6IFByb21pc2U8V29ya3NwYWNlSG9zdENvbW1hbmRSZXN1bHQ+IHtcbiAgICBjb25zdCByZXN1bHQgPSBhd2FpdCB0aGlzLnN5c3RlbS5ydW4oaW5wdXQpO1xuICAgIGlmIChyZXN1bHQuZXhpdENvZGUgIT09IDApIHtcbiAgICAgIHRocm93IG5ldyBXb3Jrc3BhY2VIb3N0T3BlcmF0aW9uRXJyb3IoXG4gICAgICAgIG9wZXJhdGlvbixcbiAgICAgICAgcmVzdWx0LmV4aXRDb2RlLFxuICAgICAgICBkaWFnbm9zdGljVGFpbChyZXN1bHQuc3RkZXJyKSxcbiAgICAgICk7XG4gICAgfVxuICAgIHJldHVybiByZXN1bHQ7XG4gIH1cblxuICBhc3luYyBpbnN0YWxsRGVza3RvcFBhY2soaW5wdXQ6IHsgaG9zdElkOiBzdHJpbmcgfSk6IFByb21pc2U8V29ya3NwYWNlSG9zdFJlbW90ZVN0ZXBFdmlkZW5jZT4ge1xuICAgIGlmICghL15bYS16MC05XVthLXowLTkuXy1dezAsMTI3fSQvaS50ZXN0KGlucHV0Lmhvc3RJZCkpIHtcbiAgICAgIHRocm93IG5ldyBXb3Jrc3BhY2VIb3N0T3BlcmF0aW9uRXJyb3IoXCJpbnN0YWxsRGVza3RvcFBhY2tcIiwgMSwgXCJpbnZhbGlkIGRlc2t0b3AtcGFjayBob3N0SWRcIik7XG4gICAgfVxuICAgIGNvbnN0IHsgc2NyaXB0IH0gPSBidWlsZFdvcmtzcGFjZUhvc3REZXNrdG9wUGFja1NjcmlwdCh7XG4gICAgICBjb250cmFjdFZlcnNpb246IFdPUktTUEFDRV9IT1NUX0RFU0tUT1BfUEFDS19DT05UUkFDVF9WRVJTSU9OLFxuICAgICAgYWN0aW9uOiBcImluc3RhbGxcIixcbiAgICAgIGhvc3RJZDogaW5wdXQuaG9zdElkLFxuICAgIH0pO1xuICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IHRoaXMucmVxdWlyZShcImluc3RhbGxEZXNrdG9wUGFja1wiLCB7XG4gICAgICBjb21tYW5kOiBcIi9iaW4vYmFzaFwiLFxuICAgICAgYXJnczogW1wiLWNcIiwgc2NyaXB0XSxcbiAgICB9KTtcbiAgICBjb25zdCBhdHRlc3RhdGlvbiA9IHBhcnNlV29ya3NwYWNlSG9zdERlc2t0b3BQYWNrQXR0ZXN0YXRpb24ocmVzdWx0LnN0ZG91dCk7XG4gICAgaWYgKFxuICAgICAgYXR0ZXN0YXRpb24uaG9zdElkICE9PSBpbnB1dC5ob3N0SWQgfHxcbiAgICAgIGF0dGVzdGF0aW9uLmFjdGlvbiAhPT0gXCJpbnN0YWxsXCIgfHxcbiAgICAgIGF0dGVzdGF0aW9uLmthc212bmM/LnZlcnNpb24gIT09IFBJTk5FRF9LQVNNVk5DX0FSVElGQUNULnZlcnNpb24gfHxcbiAgICAgIGF0dGVzdGF0aW9uLmthc212bmM/LnNoYTI1NiAhPT0gUElOTkVEX0tBU01WTkNfQVJUSUZBQ1QuZGViU2hhMjU2XG4gICAgKSB7XG4gICAgICB0aHJvdyBuZXcgV29ya3NwYWNlSG9zdE9wZXJhdGlvbkVycm9yKFwiaW5zdGFsbERlc2t0b3BQYWNrXCIsIDEsIFwiZGVza3RvcCBwYWNrIGF0dGVzdGF0aW9uIGlkZW50aXR5IG1pc21hdGNoXCIpO1xuICAgIH1cbiAgICByZXR1cm4geyAuLi5hdHRlc3RhdGlvbiB9O1xuICB9XG5cbiAgYXN5bmMgdmVyaWZ5UmV0YWluZWRXb3Jrc3BhY2UoXG4gICAgaW5wdXQ6IFdvcmtzcGFjZUhvc3RDcmVhdGVXb3Jrc3BhY2VJbnB1dCAmIHsgdGVuYW50SWRlbnRpdHk6IHN0cmluZyB9LFxuICApOiBQcm9taXNlPFdvcmtzcGFjZUhvc3RSZW1vdGVTdGVwRXZpZGVuY2U+IHtcbiAgICBpZiAoIS9eW2EtZjAtOV17NjR9JC8udGVzdChpbnB1dC50ZW5hbnRJZGVudGl0eSkpIHtcbiAgICAgIHRocm93IG5ldyBXb3Jrc3BhY2VIb3N0T3BlcmF0aW9uRXJyb3IoXCJ2ZXJpZnlSZXRhaW5lZFdvcmtzcGFjZVwiLCAxLCBcImludmFsaWQgcmV0YWluZWQgdGVuYW50IGlkZW50aXR5XCIpO1xuICAgIH1cbiAgICBjb25zdCBkaXJlY3RvcnkgPSByZXNvbHZlV2l0aGluUm9vdCh0aGlzLndvcmtzcGFjZVJvb3QsIGlucHV0LndvcmtzcGFjZUlkLCBcIndvcmtzcGFjZUlkXCIpO1xuICAgIC8vIFRoaXMgaXMgb2JzZXJ2YXRpb24gb25seS4gQSBtaXNzaW5nIG1vdW50L2hvbWUgbXVzdCBuZXZlciBiZSByZXBhaXJlZCB3aXRoIG1rZGlyIG9yIGFcbiAgICAvLyBmcmVzaCBuYXRpdmUgYWdlbnQgaG9tZTogdGhlIGV4aXN0aW5nIENMSSBjaGVja3BvaW50IGZpbGVzIGFyZSB0aGUgcmVzdW1lIGF1dGhvcml0eS5cbiAgICBhd2FpdCB0aGlzLnJlcXVpcmUoXCJ2ZXJpZnlSZXRhaW5lZFdvcmtzcGFjZVwiLCB7XG4gICAgICBjb21tYW5kOiBcIi9iaW4vYmFzaFwiLFxuICAgICAgYXJnczogW1wiLWNcIiwgW1xuICAgICAgICBcInNldCAtZXVvIHBpcGVmYWlsXCIsXG4gICAgICAgICd0ZW5hbnQ9JDE7IHdvcmtzcGFjZV9yb290PSQyOyBkaXJlY3Rvcnk9JDM7IG5hdGl2ZV9ob21lPSQ0OyB3b3Jrc3BhY2VfdXNlcj0kNScsXG4gICAgICAgICdkYXRhX21vdW50PS92YXIvbGliL3BhcGVyY3VzcCcsXG4gICAgICAgICdyZWFkIC1yIGRhdGFfdXVpZCBkYXRhX2ZzIGRhdGFfcm9vdCBleHRyYSA8IDwoZmluZG1udCAtbiAtLW1vdW50cG9pbnQgXCIkZGF0YV9tb3VudFwiIC1vIFVVSUQsRlNUWVBFLEZTUk9PVCknLFxuICAgICAgICAnW1sgLW4gXCIkZGF0YV91dWlkXCIgJiYgXCIkZGF0YV9mc1wiID09IGV4dDQgJiYgXCIkZGF0YV9yb290XCIgPT0gLyAmJiAteiBcIiR7ZXh0cmE6LX1cIiBdXScsXG4gICAgICAgICdtYXJrZXI9XCIkZGF0YV9tb3VudC8ucGFwZXJjdXNwLXRlbmFudFwiJyxcbiAgICAgICAgJ1tbIC1mIFwiJG1hcmtlclwiICYmICEgLUwgXCIkbWFya2VyXCIgJiYgXCIkKHN0YXQgLWMgJXU6JWEgXCIkbWFya2VyXCIpXCIgPT0gMDo2MDAgXV0nLFxuICAgICAgICAnW1sgXCIkKGNhdCBcIiRtYXJrZXJcIilcIiA9PSBcInBhcGVyY3VzcC10ZW5hbnQtdjE6JHRlbmFudDokZGF0YV91dWlkXCIgXV0nLFxuICAgICAgICAnW1sgLWQgXCIkZGlyZWN0b3J5XCIgJiYgISAtTCBcIiRkaXJlY3RvcnlcIiAmJiAtZCBcIiRuYXRpdmVfaG9tZVwiICYmICEgLUwgXCIkbmF0aXZlX2hvbWVcIiBdXScsXG4gICAgICAgICdbWyBcIiQoc3RhdCAtTGMgJWQ6JWkgXCIkd29ya3NwYWNlX3Jvb3RcIilcIiA9PSBcIiQoc3RhdCAtTGMgJWQ6JWkgXCIkZGF0YV9tb3VudC93b3Jrc3BhY2VzXCIpXCIgXV0nLFxuICAgICAgICAnW1sgXCIkKHN0YXQgLUxjICVkOiVpIFwiJG5hdGl2ZV9ob21lXCIpXCIgPT0gXCIkKHN0YXQgLUxjICVkOiVpIFwiJGRhdGFfbW91bnQvaG9tZS8kd29ya3NwYWNlX3VzZXJcIilcIiBdXScsXG4gICAgICAgICdzeW5jIC1mIFwiJG5hdGl2ZV9ob21lXCInLFxuICAgICAgXS5qb2luKFwiXFxuXCIpLCBcIi0tXCIsIGlucHV0LnRlbmFudElkZW50aXR5LCB0aGlzLndvcmtzcGFjZVJvb3QsIGRpcmVjdG9yeSwgdGhpcy53b3Jrc3BhY2VIb21lLCB0aGlzLndvcmtzcGFjZVVzZXJdLFxuICAgIH0pO1xuICAgIHJldHVybiB7XG4gICAgICB3b3Jrc3BhY2VJZDogaW5wdXQud29ya3NwYWNlSWQsIGhvc3RJZDogaW5wdXQuaG9zdElkLCBkaXJlY3RvcnksXG4gICAgICByZXRhaW5lZDogdHJ1ZSwgbmF0aXZlU2Vzc2lvbkhvbWVSZXRhaW5lZDogdHJ1ZSwgb2JzZXJ2ZWRBdDogdGhpcy5ub3coKS50b0lTT1N0cmluZygpLFxuICAgIH07XG4gIH1cblxuICBhc3luYyBjcmVhdGVXb3Jrc3BhY2UoXG4gICAgaW5wdXQ6IFdvcmtzcGFjZUhvc3RDcmVhdGVXb3Jrc3BhY2VJbnB1dCxcbiAgKTogUHJvbWlzZTxXb3Jrc3BhY2VIb3N0UmVtb3RlU3RlcEV2aWRlbmNlPiB7XG4gICAgY29uc3QgZGlyZWN0b3J5ID0gcmVzb2x2ZVdpdGhpblJvb3QoXG4gICAgICB0aGlzLndvcmtzcGFjZVJvb3QsXG4gICAgICBpbnB1dC53b3Jrc3BhY2VJZCxcbiAgICAgIFwid29ya3NwYWNlSWRcIixcbiAgICApO1xuICAgIC8vIFRoZSB3b3Jrc3BhY2UgZm9ybSwgbm90IHRoZSBwcml2YXRlIGBlbnN1cmVEaXJlY3RvcnlgOiB0aGlzIGRpcmVjdG9yeSBsaXZlcyB1bmRlciB0aGUgQUNMJ2RcbiAgICAvLyB3b3Jrc3BhY2Ugcm9vdCBhbmQgbXVzdCBzdGF5IHJlYWNoYWJsZSBieSB0aGUgc2VydmljZSBhbmQgYWdlbnQgYWNjb3VudHMgKFdJLTEwMDA0NTk0KS5cbiAgICBhd2FpdCB0aGlzLnN5c3RlbS5lbnN1cmVXb3Jrc3BhY2VEaXJlY3RvcnkoZGlyZWN0b3J5KTtcbiAgICBhd2FpdCB0aGlzLnN5c3RlbS5zZXRPd25lcnNoaXA/LihcbiAgICAgIGRpcmVjdG9yeSxcbiAgICAgIHRoaXMud29ya3NwYWNlVXNlcixcbiAgICAgIHRoaXMud29ya3NwYWNlR3JvdXAsXG4gICAgKTtcbiAgICAvLyBWZXJpZnkgcmF0aGVyIHRoYW4gYXNzdW1lOiBgbWtkaXIgLXBgIHN1Y2NlZWRpbmcgaXMgbm90IHRoZSBzYW1lIGZhY3QgYXMgdGhlIGRpcmVjdG9yeVxuICAgIC8vIGJlaW5nIHRoZXJlIGFmdGVyd2FyZHMgKGEgcmVhZC1vbmx5IG1vdW50IGFuZCBhIHJhY2luZyB0ZWFyZG93biBib3RoIHByb2R1Y2UgdGhhdCBzaGFwZSkuXG4gICAgaWYgKCEoYXdhaXQgdGhpcy5zeXN0ZW0ucGF0aEV4aXN0cyhkaXJlY3RvcnkpKSkge1xuICAgICAgdGhyb3cgbmV3IFdvcmtzcGFjZUhvc3RPcGVyYXRpb25FcnJvcihcbiAgICAgICAgXCJjcmVhdGVXb3Jrc3BhY2VcIixcbiAgICAgICAgMSxcbiAgICAgICAgYHdvcmtzcGFjZSBkaXJlY3RvcnkgJHtkaXJlY3Rvcnl9IGRvZXMgbm90IGV4aXN0IGFmdGVyIGNyZWF0aW9uYCxcbiAgICAgICk7XG4gICAgfVxuICAgIHJldHVybiB7XG4gICAgICB3b3Jrc3BhY2VJZDogaW5wdXQud29ya3NwYWNlSWQsXG4gICAgICBob3N0SWQ6IGlucHV0Lmhvc3RJZCxcbiAgICAgIGRpcmVjdG9yeSxcbiAgICAgIGNyZWF0ZWQ6IHRydWUsXG4gICAgICBvYnNlcnZlZEF0OiB0aGlzLm5vdygpLnRvSVNPU3RyaW5nKCksXG4gICAgfTtcbiAgfVxuXG4gIGFzeW5jIGNsb25lUmVwb3NpdG9yeShcbiAgICBpbnB1dDogV29ya3NwYWNlSG9zdENsb25lUmVwb3NpdG9yeUlucHV0LFxuICApOiBQcm9taXNlPFdvcmtzcGFjZUhvc3RSZW1vdGVTdGVwRXZpZGVuY2U+IHtcbiAgICBjb25zdCBkZXN0aW5hdGlvbiA9IHJlc29sdmVXaXRoaW5Sb290KFxuICAgICAgdGhpcy53b3Jrc3BhY2VSb290LFxuICAgICAgaW5wdXQuZGVzdGluYXRpb24sXG4gICAgICBcImRlc3RpbmF0aW9uXCIsXG4gICAgKTtcbiAgICBsZXQgZW52OiBSZWFkb25seTxSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+PiB8IHVuZGVmaW5lZDtcbiAgICBpZiAoaW5wdXQudmlzaWJpbGl0eSA9PT0gXCJwcml2YXRlXCIpIHtcbiAgICAgIGlmIChpbnB1dC5jcmVkZW50aWFsQ2hhbm5lbCAhPT0gXCJnaXRcIikge1xuICAgICAgICB0aHJvdyBuZXcgV29ya3NwYWNlSG9zdE9wZXJhdGlvbkVycm9yKFxuICAgICAgICAgIFwiY2xvbmVSZXBvc2l0b3J5LmNyZWRlbnRpYWxzXCIsXG4gICAgICAgICAgMSxcbiAgICAgICAgICBcImEgcHJpdmF0ZSByZXBvc2l0b3J5IGNsb25lIG11c3QgY29uc3VtZSB0aGUgYm91bmQgJ2dpdCcgY3JlZGVudGlhbCBjaGFubmVsXCIsXG4gICAgICAgICk7XG4gICAgICB9XG4gICAgICBjb25zdCBiaW5kaW5nID0gYXdhaXQgdGhpcy5naXRDcmVkZW50aWFsQmluZGluZ3MucmVzb2x2ZSh0aGlzLm5vdygpKTtcbiAgICAgIGlmICghKGF3YWl0IHRoaXMuc3lzdGVtLnBhdGhFeGlzdHMoYmluZGluZy5tYXRlcmlhbFBhdGgpKSkge1xuICAgICAgICB0aHJvdyBuZXcgV29ya3NwYWNlSG9zdE9wZXJhdGlvbkVycm9yKFxuICAgICAgICAgIFwiY2xvbmVSZXBvc2l0b3J5LmNyZWRlbnRpYWxzXCIsXG4gICAgICAgICAgMSxcbiAgICAgICAgICBcInRoZSBib3VuZCBnaXQgY3JlZGVudGlhbCBtYXRlcmlhbCBpcyBhYnNlbnQgZnJvbSB0aGUgaG9zdFwiLFxuICAgICAgICApO1xuICAgICAgfVxuICAgICAgZW52ID0gd29ya3NwYWNlSG9zdEdldE9ubHlHaXRDcmVkZW50aWFsRW52aXJvbm1lbnQoYmluZGluZy5tYXRlcmlhbFBhdGgpO1xuICAgIH1cblxuICAgIC8vIEEgcHJldmlvdXMgaW5pdGlhbGl6YXRpb24gY2FuIGhhdmUgY29tcGxldGVkIHRoZSBjbG9uZSBzdGVwIGJlZm9yZSB0aGUgY29udHJvbGxlciBsb3N0IGl0c1xuICAgIC8vIHJlc3BvbnNlLiBSZS1ydW5uaW5nIHdpdGggYSBmcmVzaCBvcGVyYXRpb24gbXVzdCByZXVzZSBvbmx5IGEgY2hlY2tvdXQgd2UgY2FuIHByb3ZlIGlzIHRoZVxuICAgIC8vIHNhbWUgcmVwb3NpdG9yeSwgY2xlYW4sIGFuZCBhbHJlYWR5IGF0IHRoZSByZXF1ZXN0ZWQgcmV2aXNpb24uIE5ldmVyIGRlbGV0ZSBvciBvdmVyd3JpdGUgYVxuICAgIC8vIG5vbi1lbXB0eSBkZXN0aW5hdGlvbjogaXQgbWF5IGNvbnRhaW4gY3VzdG9tZXIgd29yaywgb3IgaXQgbWF5IGJlIGV2aWRlbmNlIG9mIGEgZGlmZmVyZW50XG4gICAgLy8gc291cmNlIHRoYXQgdGhlIGNhbGxlciBtdXN0IGludmVzdGlnYXRlLlxuICAgIGlmIChhd2FpdCB0aGlzLnN5c3RlbS5wYXRoRXhpc3RzKGRlc3RpbmF0aW9uKSkge1xuICAgICAgY29uc3QgZ2l0RGlyZWN0b3J5ID0gam9pbihkZXN0aW5hdGlvbiwgXCIuZ2l0XCIpO1xuICAgICAgaWYgKCEoYXdhaXQgdGhpcy5zeXN0ZW0ucGF0aEV4aXN0cyhnaXREaXJlY3RvcnkpKSkge1xuICAgICAgICB0aHJvdyBuZXcgV29ya3NwYWNlSG9zdE9wZXJhdGlvbkVycm9yKFxuICAgICAgICAgIFwiY2xvbmVSZXBvc2l0b3J5LnJlc3VtZVwiLFxuICAgICAgICAgIDEsXG4gICAgICAgICAgYGV4aXN0aW5nIGRlc3RpbmF0aW9uICR7ZGVzdGluYXRpb259IGlzIG5vdCBhIEdpdCB3b3JrdHJlZWAsXG4gICAgICAgICk7XG4gICAgICB9XG4gICAgICBjb25zdCB3b3JrdHJlZSA9IGF3YWl0IHRoaXMucmVxdWlyZShcImNsb25lUmVwb3NpdG9yeS5yZXN1bWUud29ya3RyZWVcIiwge1xuICAgICAgICBjb21tYW5kOiB0aGlzLmdpdENvbW1hbmQsXG4gICAgICAgIGFyZ3M6IFtcIi1DXCIsIGRlc3RpbmF0aW9uLCBcInJldi1wYXJzZVwiLCBcIi0taXMtaW5zaWRlLXdvcmstdHJlZVwiXSxcbiAgICAgIH0pO1xuICAgICAgaWYgKHdvcmt0cmVlLnN0ZG91dC50cmltKCkgIT09IFwidHJ1ZVwiKSB7XG4gICAgICAgIHRocm93IG5ldyBXb3Jrc3BhY2VIb3N0T3BlcmF0aW9uRXJyb3IoXG4gICAgICAgICAgXCJjbG9uZVJlcG9zaXRvcnkucmVzdW1lXCIsXG4gICAgICAgICAgMSxcbiAgICAgICAgICBgZXhpc3RpbmcgZGVzdGluYXRpb24gJHtkZXN0aW5hdGlvbn0gaXMgbm90IGEgR2l0IHdvcmt0cmVlYCxcbiAgICAgICAgKTtcbiAgICAgIH1cbiAgICAgIGNvbnN0IHJlbW90ZSA9IGF3YWl0IHRoaXMucmVxdWlyZShcImNsb25lUmVwb3NpdG9yeS5yZXN1bWUub3JpZ2luXCIsIHtcbiAgICAgICAgY29tbWFuZDogdGhpcy5naXRDb21tYW5kLFxuICAgICAgICBhcmdzOiBbXCItQ1wiLCBkZXN0aW5hdGlvbiwgXCJyZW1vdGVcIiwgXCJnZXQtdXJsXCIsIFwib3JpZ2luXCJdLFxuICAgICAgfSk7XG4gICAgICBpZiAoXG4gICAgICAgIHJlbW90ZS5zdGRvdXQudHJpbSgpLnJlcGxhY2UoL1xcLyskLywgXCJcIikgIT09XG4gICAgICAgIGlucHV0LnJlcG9zaXRvcnlVcmwudHJpbSgpLnJlcGxhY2UoL1xcLyskLywgXCJcIilcbiAgICAgICkge1xuICAgICAgICB0aHJvdyBuZXcgV29ya3NwYWNlSG9zdE9wZXJhdGlvbkVycm9yKFxuICAgICAgICAgIFwiY2xvbmVSZXBvc2l0b3J5LnJlc3VtZVwiLFxuICAgICAgICAgIDEsXG4gICAgICAgICAgYGV4aXN0aW5nIGRlc3RpbmF0aW9uICR7ZGVzdGluYXRpb259IGhhcyBhIGRpZmZlcmVudCBvcmlnaW5gLFxuICAgICAgICApO1xuICAgICAgfVxuICAgICAgY29uc3Qgc3RhdHVzID0gYXdhaXQgdGhpcy5yZXF1aXJlKFwiY2xvbmVSZXBvc2l0b3J5LnJlc3VtZS5zdGF0dXNcIiwge1xuICAgICAgICBjb21tYW5kOiB0aGlzLmdpdENvbW1hbmQsXG4gICAgICAgIGFyZ3M6IFtcbiAgICAgICAgICBcIi1DXCIsXG4gICAgICAgICAgZGVzdGluYXRpb24sXG4gICAgICAgICAgXCJzdGF0dXNcIixcbiAgICAgICAgICBcIi0tcG9yY2VsYWluPXYxXCIsXG4gICAgICAgICAgXCItLXVudHJhY2tlZC1maWxlcz1hbGxcIixcbiAgICAgICAgXSxcbiAgICAgIH0pO1xuICAgICAgaWYgKHN0YXR1cy5zdGRvdXQudHJpbSgpICE9PSBcIlwiKSB7XG4gICAgICAgIHRocm93IG5ldyBXb3Jrc3BhY2VIb3N0T3BlcmF0aW9uRXJyb3IoXG4gICAgICAgICAgXCJjbG9uZVJlcG9zaXRvcnkucmVzdW1lXCIsXG4gICAgICAgICAgMSxcbiAgICAgICAgICBgZXhpc3RpbmcgZGVzdGluYXRpb24gJHtkZXN0aW5hdGlvbn0gaGFzIHVuY29tbWl0dGVkIGNoYW5nZXNgLFxuICAgICAgICApO1xuICAgICAgfVxuICAgICAgaWYgKGlucHV0LnJldmlzaW9uKSB7XG4gICAgICAgIGNvbnN0IHJlcXVlc3RlZCA9IGF3YWl0IHRoaXMucmVxdWlyZShcbiAgICAgICAgICBcImNsb25lUmVwb3NpdG9yeS5yZXN1bWUucmV2aXNpb25cIixcbiAgICAgICAgICB7XG4gICAgICAgICAgICBjb21tYW5kOiB0aGlzLmdpdENvbW1hbmQsXG4gICAgICAgICAgICBhcmdzOiBbXG4gICAgICAgICAgICAgIFwiLUNcIixcbiAgICAgICAgICAgICAgZGVzdGluYXRpb24sXG4gICAgICAgICAgICAgIFwicmV2LXBhcnNlXCIsXG4gICAgICAgICAgICAgIFwiLS12ZXJpZnlcIixcbiAgICAgICAgICAgICAgYCR7aW5wdXQucmV2aXNpb259Xntjb21taXR9YCxcbiAgICAgICAgICAgIF0sXG4gICAgICAgICAgfSxcbiAgICAgICAgKTtcbiAgICAgICAgY29uc3QgaGVhZCA9IGF3YWl0IHRoaXMucmVxdWlyZShcImNsb25lUmVwb3NpdG9yeS5yZXN1bWUuaGVhZFwiLCB7XG4gICAgICAgICAgY29tbWFuZDogdGhpcy5naXRDb21tYW5kLFxuICAgICAgICAgIGFyZ3M6IFtcIi1DXCIsIGRlc3RpbmF0aW9uLCBcInJldi1wYXJzZVwiLCBcIkhFQURcIl0sXG4gICAgICAgIH0pO1xuICAgICAgICBpZiAocmVxdWVzdGVkLnN0ZG91dC50cmltKCkgIT09IGhlYWQuc3Rkb3V0LnRyaW0oKSkge1xuICAgICAgICAgIHRocm93IG5ldyBXb3Jrc3BhY2VIb3N0T3BlcmF0aW9uRXJyb3IoXG4gICAgICAgICAgICBcImNsb25lUmVwb3NpdG9yeS5yZXN1bWVcIixcbiAgICAgICAgICAgIDEsXG4gICAgICAgICAgICBgZXhpc3RpbmcgZGVzdGluYXRpb24gJHtkZXN0aW5hdGlvbn0gaXMgbm90IGF0IHJlcXVlc3RlZCByZXZpc2lvbiAke2lucHV0LnJldmlzaW9ufWAsXG4gICAgICAgICAgKTtcbiAgICAgICAgfVxuICAgICAgfVxuICAgICAgYXdhaXQgdGhpcy5zeXN0ZW0uc2V0T3duZXJzaGlwUmVjdXJzaXZlbHk/LihcbiAgICAgICAgZGVzdGluYXRpb24sXG4gICAgICAgIHRoaXMud29ya3NwYWNlVXNlcixcbiAgICAgICAgdGhpcy53b3Jrc3BhY2VHcm91cCxcbiAgICAgICk7XG4gICAgICByZXR1cm4ge1xuICAgICAgICBkZXN0aW5hdGlvbixcbiAgICAgICAgdmlzaWJpbGl0eTogaW5wdXQudmlzaWJpbGl0eSxcbiAgICAgICAgY2xvbmVkOiBmYWxzZSxcbiAgICAgICAgcmV1c2VkOiB0cnVlLFxuICAgICAgICAuLi4oaW5wdXQucmV2aXNpb24gPyB7IHJldmlzaW9uOiBpbnB1dC5yZXZpc2lvbiB9IDoge30pLFxuICAgICAgICAuLi4oaW5wdXQuY3JlZGVudGlhbENoYW5uZWxcbiAgICAgICAgICA/IHsgY3JlZGVudGlhbENoYW5uZWw6IGlucHV0LmNyZWRlbnRpYWxDaGFubmVsIH1cbiAgICAgICAgICA6IHt9KSxcbiAgICAgICAgb2JzZXJ2ZWRBdDogdGhpcy5ub3coKS50b0lTT1N0cmluZygpLFxuICAgICAgfTtcbiAgICB9XG5cbiAgICBhd2FpdCB0aGlzLnJlcXVpcmUoXCJjbG9uZVJlcG9zaXRvcnlcIiwge1xuICAgICAgY29tbWFuZDogdGhpcy5naXRDb21tYW5kLFxuICAgICAgYXJnczogW1wiY2xvbmVcIiwgXCItLXF1aWV0XCIsIGlucHV0LnJlcG9zaXRvcnlVcmwsIGRlc3RpbmF0aW9uXSxcbiAgICAgIC4uLihlbnYgPyB7IGVudiB9IDoge30pLFxuICAgIH0pO1xuICAgIGlmIChpbnB1dC5yZXZpc2lvbikge1xuICAgICAgYXdhaXQgdGhpcy5yZXF1aXJlKFwiY2xvbmVSZXBvc2l0b3J5LmNoZWNrb3V0XCIsIHtcbiAgICAgICAgY29tbWFuZDogdGhpcy5naXRDb21tYW5kLFxuICAgICAgICBhcmdzOiBbXCItQ1wiLCBkZXN0aW5hdGlvbiwgXCJjaGVja291dFwiLCBcIi0tcXVpZXRcIiwgaW5wdXQucmV2aXNpb25dLFxuICAgICAgfSk7XG4gICAgfVxuICAgIC8vIFRoZSBjbG9uZSBpcyBvbmx5IHJlYWwgaWYgdGhlIGdpdCBkaXJlY3RvcnkgbGFuZGVkLiBgZ2l0IGNsb25lYCBleGl0aW5nIDAgd2l0aCBubyB3b3JrdHJlZVxuICAgIC8vIGlzIHRoZSBzaGFwZSBhIHBhcnRpYWxseS13cml0dGVuIGZpbGVzeXN0ZW0gdGFrZXMsIGFuZCBpdCBpcyB0aGUgZmFpbHVyZSB0aGUgdmVyaWZ5IHN0ZXBcbiAgICAvLyBleGlzdHMgdG8gY2F0Y2gg4oCUIGNhdGNoaW5nIGl0IEhFUkUgbmFtZXMgdGhlIHN0ZXAgdGhhdCBhY3R1YWxseSBmYWlsZWQuXG4gICAgaWYgKCEoYXdhaXQgdGhpcy5zeXN0ZW0ucGF0aEV4aXN0cyhqb2luKGRlc3RpbmF0aW9uLCBcIi5naXRcIikpKSkge1xuICAgICAgdGhyb3cgbmV3IFdvcmtzcGFjZUhvc3RPcGVyYXRpb25FcnJvcihcbiAgICAgICAgXCJjbG9uZVJlcG9zaXRvcnlcIixcbiAgICAgICAgMSxcbiAgICAgICAgYG5vIC5naXQgZGlyZWN0b3J5IGF0ICR7ZGVzdGluYXRpb259IGFmdGVyIGNsb25lYCxcbiAgICAgICk7XG4gICAgfVxuICAgIC8vIFRoZSBwcml2aWxlZ2VkIGluaXRpYWxpemVyIGNyZWF0ZXMgdGhlIGNoZWNrb3V0LCBidXQgdGhlIHVucHJpdmlsZWdlZCBTU0ggaWRlbnRpdHkgb3ducyBhbmRcbiAgICAvLyBlZGl0cyBpdCBhZnRlcndhcmRzLiBEbyB0aGlzIG9ubHkgYWZ0ZXIgdGhlIGNsb25lIGlzIGNvbXBsZXRlIHNvIEdpdCBuZXZlciBvYnNlcnZlcyBhIHRyZWVcbiAgICAvLyB3aG9zZSBvd25lcnNoaXAgY2hhbmdlcyB1bmRlcm5lYXRoIGl0LlxuICAgIGF3YWl0IHRoaXMuc3lzdGVtLnNldE93bmVyc2hpcFJlY3Vyc2l2ZWx5Py4oXG4gICAgICBkZXN0aW5hdGlvbixcbiAgICAgIHRoaXMud29ya3NwYWNlVXNlcixcbiAgICAgIHRoaXMud29ya3NwYWNlR3JvdXAsXG4gICAgKTtcbiAgICByZXR1cm4ge1xuICAgICAgZGVzdGluYXRpb24sXG4gICAgICB2aXNpYmlsaXR5OiBpbnB1dC52aXNpYmlsaXR5LFxuICAgICAgY2xvbmVkOiB0cnVlLFxuICAgICAgLi4uKGlucHV0LnJldmlzaW9uID8geyByZXZpc2lvbjogaW5wdXQucmV2aXNpb24gfSA6IHt9KSxcbiAgICAgIC8vIFRoZSBDSEFOTkVMIGlzIHB1YmxpYyByb3V0aW5nIG1ldGFkYXRhOyB0aGUgY3JlZGVudGlhbCBpdHNlbGYgbmV2ZXIgYXBwZWFycyBoZXJlLlxuICAgICAgLi4uKGlucHV0LmNyZWRlbnRpYWxDaGFubmVsXG4gICAgICAgID8geyBjcmVkZW50aWFsQ2hhbm5lbDogaW5wdXQuY3JlZGVudGlhbENoYW5uZWwgfVxuICAgICAgICA6IHt9KSxcbiAgICAgIG9ic2VydmVkQXQ6IHRoaXMubm93KCkudG9JU09TdHJpbmcoKSxcbiAgICB9O1xuICB9XG5cbiAgYXN5bmMgcGFpcldvcmtzcGFjZShcbiAgICBpbnB1dDogV29ya3NwYWNlSG9zdFBhaXJXb3Jrc3BhY2VJbnB1dCxcbiAgKTogUHJvbWlzZTxXb3Jrc3BhY2VIb3N0UmVtb3RlU3RlcEV2aWRlbmNlPiB7XG4gICAgYXdhaXQgdGhpcy5yZXF1aXJlKFwicGFpcldvcmtzcGFjZVwiLCB7XG4gICAgICBjb21tYW5kOiB0aGlzLndvcmtzcGFjZUNvbW1hbmQsXG4gICAgICBhcmdzOiBbXG4gICAgICAgIFwid29ya3NwYWNlXCIsXG4gICAgICAgIFwicGFpclwiLFxuICAgICAgICBcIi0tc291cmNlXCIsXG4gICAgICAgIGlucHV0LnNvdXJjZVdvcmtzcGFjZUlkLFxuICAgICAgICBcIi0tcGFpcmluZy1yZWZcIixcbiAgICAgICAgaW5wdXQucGFpcmluZ1JlZmVyZW5jZS5yZWYsXG4gICAgICAgIC4uLmlucHV0LmluY2x1ZGUuZmxhdE1hcCgoZW50cnkpID0+IFtcIi0taW5jbHVkZVwiLCBlbnRyeV0pLFxuICAgICAgXSxcbiAgICB9KTtcbiAgICByZXR1cm4ge1xuICAgICAgc291cmNlV29ya3NwYWNlSWQ6IGlucHV0LnNvdXJjZVdvcmtzcGFjZUlkLFxuICAgICAgLy8gQSBwYWlyaW5nIHJlZiBpcyBhIHJlZmVyZW5jZSwgbm90IG1hdGVyaWFsIOKAlCBidXQgaXQgaXMgc3RpbGwgYW4gaWRlbnRpZmllciB0aGUgY29udHJvbGxlclxuICAgICAgLy8gc3VwcGxpZWQsIHNvIGl0IGlzIGRpZ2VzdGVkIHJhdGhlciB0aGFuIGVjaG9lZC4gVGhlIGNvbnRyb2xsZXIgY2FuIG1hdGNoIHRoZSBkaWdlc3QuXG4gICAgICBwYWlyaW5nUmVmZXJlbmNlRGlnZXN0OiB3b3Jrc3BhY2VIb3N0Q3JlZGVudGlhbFJlZmVyZW5jZURpZ2VzdChcbiAgICAgICAgaW5wdXQucGFpcmluZ1JlZmVyZW5jZS5yZWYsXG4gICAgICApLFxuICAgICAgaW5jbHVkZTogWy4uLmlucHV0LmluY2x1ZGVdLFxuICAgICAgcGFpcmVkOiB0cnVlLFxuICAgICAgb2JzZXJ2ZWRBdDogdGhpcy5ub3coKS50b0lTT1N0cmluZygpLFxuICAgIH07XG4gIH1cblxuICBhc3luYyBpbXBvcnRXb3Jrc3BhY2UoXG4gICAgaW5wdXQ6IFdvcmtzcGFjZUhvc3RJbXBvcnRXb3Jrc3BhY2VJbnB1dCxcbiAgKTogUHJvbWlzZTxXb3Jrc3BhY2VIb3N0UmVtb3RlU3RlcEV2aWRlbmNlPiB7XG4gICAgYXdhaXQgdGhpcy5yZXF1aXJlKFwiaW1wb3J0V29ya3NwYWNlXCIsIHtcbiAgICAgIGNvbW1hbmQ6IHRoaXMud29ya3NwYWNlQ29tbWFuZCxcbiAgICAgIGFyZ3M6IFtcbiAgICAgICAgXCJ3b3Jrc3BhY2VcIixcbiAgICAgICAgXCJpbXBvcnRcIixcbiAgICAgICAgXCItLXNvdXJjZVwiLFxuICAgICAgICBpbnB1dC5zb3VyY2VXb3Jrc3BhY2VJZCxcbiAgICAgICAgXCItLXNuYXBzaG90XCIsXG4gICAgICAgIGlucHV0LnNvdXJjZVNuYXBzaG90UmVmLFxuICAgICAgICAuLi5pbnB1dC5pbmNsdWRlLmZsYXRNYXAoKGVudHJ5KSA9PiBbXCItLWluY2x1ZGVcIiwgZW50cnldKSxcbiAgICAgIF0sXG4gICAgfSk7XG4gICAgcmV0dXJuIHtcbiAgICAgIHNvdXJjZVdvcmtzcGFjZUlkOiBpbnB1dC5zb3VyY2VXb3Jrc3BhY2VJZCxcbiAgICAgIHNvdXJjZVNuYXBzaG90UmVmOiBpbnB1dC5zb3VyY2VTbmFwc2hvdFJlZixcbiAgICAgIGluY2x1ZGU6IFsuLi5pbnB1dC5pbmNsdWRlXSxcbiAgICAgIGltcG9ydGVkOiB0cnVlLFxuICAgICAgb2JzZXJ2ZWRBdDogdGhpcy5ub3coKS50b0lTT1N0cmluZygpLFxuICAgIH07XG4gIH1cblxuICAvKipcbiAgICogRGVsZWdhdGUgdG8gdGhlIGV4aXN0aW5nIHByb2JlIHN1aXRlIHJhdGhlciB0aGFuIHJlaW1wbGVtZW50aW5nIGl0LlxuICAgKlxuICAgKiBgcHJvYmVXb3Jrc3BhY2VIb3N0QWdlbnRzYCBhbHJlYWR5IG93bnMgdGhlIHJ1bGVzIHRoYXQgbWFrZSB0aGlzIGV2aWRlbmNlIHRydXN0d29ydGh5IOKAlCB0aGVcbiAgICogc2VxdWVudGlhbCBvcmRlcmluZywgdGhlIFwiZXhpdCAwIGJ1dCB1bnBhcnNlYWJsZSBpcyBhIEZBSUxFRCBwcm9iZVwiIHJ1bGUsIGFuZCB0aGUgc3ViamVjdFxuICAgKiBkaXNjbG9zdXJlIHBvbGljeS4gQSBzZWNvbmQgaW1wbGVtZW50YXRpb24gaGVyZSB3b3VsZCBiZSBhIHNlY29uZCBzZXQgb2YgdGhvc2UgcnVsZXMgdG8ga2VlcFxuICAgKiBpbiBzeW5jLCBhbmQgdGhlIG9uZSB0aGF0IGRyaWZ0ZWQgd291bGQgYmUgdGhlIG9uZSBub2JvZHkgd2FzIHJlYWRpbmcuXG4gICAqL1xuICBhc3luYyBwcm9iZUFnZW50VmVyaWZpY2F0aW9uKHJlcXVlc3RlZEFnZW50cz86IHJlYWRvbmx5IFdvcmtzcGFjZUhvc3RDYW5hcnlBZ2VudFtdKTogUHJvbWlzZTxXb3Jrc3BhY2VIb3N0QWdlbnRWZXJpZmljYXRpb25SZXBvcnQ+IHtcbiAgICByZXR1cm4gYXdhaXQgcHJvYmVXb3Jrc3BhY2VIb3N0QWdlbnRzKHtcbiAgICAgIHJ1bm5lcjogdGhpcy5hZ2VudFByb2JlUnVubmVyLFxuICAgICAgcmVxdWVzdGVkQWdlbnRzLFxuICAgICAgbm93OiB0aGlzLm5vdyxcbiAgICAgIC8vIEQtMjU5IERlZmVjdCAyOiBleGVjIGFuIGV4cGxpY2l0IHBhdGgsIG5ldmVyIGEgYmFyZSBuYW1lIGEgd3JhcHBlciBjb3VsZCBhbnN3ZXIuIFRoZVxuICAgICAgLy8gYXR0ZXN0YXRpb24gc2F5cyBXSElDSCB2ZW5kb3IgQ0xJcyBib290c3RyYXAgaW5zdGFsbGVkOyB0aGUgcGF0aCBleGVjdXRlZCBpcyB0aGF0IENMSSdzXG4gICAgICAvLyBjb3B5IGluIHRoZSBjdXN0b21lciBhZ2VudCB0b29sY2hhaW4gKEQtNDIzKSwgYmVjYXVzZSB0aGUgYXR0ZXN0ZWQgaW5zdGFsbCBsaXZlcyBpbiB0aGVcbiAgICAgIC8vIHBsYXRmb3JtIGFnZW50IGhvbWUsIHdoaWNoIHRoZSBhY2NvdW50IHJ1bm5pbmcgdGhlc2UgcHJvYmVzIGNhbm5vdCByZWFkLlxuICAgICAgcnVudGltZVBhdGhzOiB0aGlzLmN1c3RvbWVyVG9vbGNoYWluUnVudGltZVBhdGhzKFxuICAgICAgICBhd2FpdCB0aGlzLnJlYWRBdHRlc3RlZEFnZW50UnVudGltZVBhdGhzKCksXG4gICAgICApLFxuICAgICAgLy8gVGhlIENVU1RPTUVSIHdvcmtzcGFjZSBhY2NvdW50IChELTQyMSksIHRoZSBpZGVudGl0eSBldmVyeSBjdXN0b21lci1kcml2ZW4gYWdlbnQgcnVuc1xuICAgICAgLy8gYXMg4oCUIHNvIGEgcGFzc2luZyBwcm9iZSBwcm92ZXMgdGhlIHByb2R1Y3QgcGF0aCwgbm90IGEgcGxhdGZvcm0tb25seSBvbmUuIEhPTUUgdHJhdmVsc1xuICAgICAgLy8gd2l0aCBpdDogdGhlIGRlbGl2ZXJlZCBDbGF1ZGUvQ29kZXggbWF0ZXJpYWwgbGl2ZXMgaW4gdGhhdCBhY2NvdW50J3MgMDcwMCBob21lLCBhbmQgYVxuICAgICAgLy8gcHJvYmUgd2l0aCBhbnkgb3RoZXIgSE9NRSB3b3VsZCBsb29rIGZvciBjcmVkZW50aWFscyB0aGF0IGFyZSBub3QgdGhlcmUgYW5kIGZhaWxcbiAgICAgIC8vIGlkZW50aWNhbGx5IHRvIGEgZ2VudWluZSBjcmVkZW50aWFsIGZhdWx0LiBELTA0MyBpcyBpbnRhY3QgYmVjYXVzZSB0aGlzIGFjY291bnQgcmVhY2hlc1xuICAgICAgLy8gb25seSB0aGUgdG9vbGNoYWluLCBuZXZlciBgJFJVTlRJTUVfUk9PVGAuXG4gICAgICBlbnY6IHtcbiAgICAgICAgSE9NRTogdGhpcy53b3Jrc3BhY2VIb21lLFxuICAgICAgICBVU0VSOiB0aGlzLndvcmtzcGFjZVVzZXIsXG4gICAgICAgIExPR05BTUU6IHRoaXMud29ya3NwYWNlVXNlcixcbiAgICAgICAgUEFUSDogdGhpcy5hZ2VudFByb2JlUGF0aCxcbiAgICAgIH0sXG4gICAgICBydW5Bc1VzZXI6IHRoaXMud29ya3NwYWNlVXNlcixcbiAgICB9KTtcbiAgfVxuXG4gIC8qKiBNYXAgZWFjaCBhdHRlc3RlZCB2ZW5kb3IgQ0xJIG9udG8gaXRzIGN1c3RvbWVyLXRvb2xjaGFpbiBjb3B5IChELTQyMykuICovXG4gIHByaXZhdGUgY3VzdG9tZXJUb29sY2hhaW5SdW50aW1lUGF0aHMoXG4gICAgYXR0ZXN0ZWQ6IFBhcnRpYWw8UmVjb3JkPFdvcmtzcGFjZUhvc3RDYW5hcnlBZ2VudCwgc3RyaW5nPj4sXG4gICk6IFBhcnRpYWw8UmVjb3JkPFdvcmtzcGFjZUhvc3RDYW5hcnlBZ2VudCwgc3RyaW5nPj4ge1xuICAgIGNvbnN0IHBhdGhzOiBQYXJ0aWFsPFJlY29yZDxXb3Jrc3BhY2VIb3N0Q2FuYXJ5QWdlbnQsIHN0cmluZz4+ID0ge307XG4gICAgZm9yIChjb25zdCBhZ2VudCBvZiBPYmplY3Qua2V5cyhhdHRlc3RlZCkgYXMgV29ya3NwYWNlSG9zdENhbmFyeUFnZW50W10pIHtcbiAgICAgIHBhdGhzW2FnZW50XSA9IGpvaW4odGhpcy5jdXN0b21lckFnZW50VG9vbGNoYWluQmluLCBhZ2VudCk7XG4gICAgfVxuICAgIHJldHVybiBwYXRocztcbiAgfVxuXG4gIC8qKlxuICAgKiBSZWFkIHRoZSB2ZW5kb3IgcnVudGltZSBwYXRocyBib290c3RyYXAgcmVjb3JkZWQgaW4gaXRzIGF0dGVzdGF0aW9uIChELTI1OSBEZWZlY3QgMikuXG4gICAqXG4gICAqIEFCU0VOQ0UgSVMgTk9UIEFOIEVSUk9SLCBpbiB0aHJlZSBkaXN0aW5jdCBzaGFwZXMsIGFuZCBlYWNoIG9uZSBpcyBhIHJlYWwgaG9zdDogbm8gYXR0ZXN0YXRpb25cbiAgICogZmlsZSAodGhpcyBhZGFwdGVyIHJ1bm5pbmcgc29tZXdoZXJlIHRoYXQgbmV2ZXIgYm9vdHN0cmFwcGVkKSwgbm8gYGFnZW50UnVudGltZXNgIGtleSAoYSBob3N0XG4gICAqIHByb3Zpc2lvbmVkIGJlZm9yZSB0aGUgdmVuZG9yIGluc3RhbGxzIGV4aXN0ZWQpLCBvciBhIGtleSBtaXNzaW5nIG9uZSBhZ2VudCAoYSBwYXJ0aWFsXG4gICAqIGluc3RhbGwpLiBBbGwgdGhyZWUgZmFsbCBiYWNrIHRvIHRoZSBwcm9iZSdzIG93biBjb21tYW5kIGFuZCB0aGVyZWZvcmUgRkFJTCB0aGUgcHJvYmUsIHdoaWNoXG4gICAqIGlzIHRoZSBob25lc3QgdmVyZGljdCDigJQgdGhvc2UgaG9zdHMgZ2VudWluZWx5IGNhbm5vdCBhdXRoZW50aWNhdGUgdGhhdCBhZ2VudC5cbiAgICpcbiAgICogTUFMRk9STUVEIElTIGFuIGVycm9yLCBhbmQgdGhlIGRpZmZlcmVuY2UgbWF0dGVycy4gVW5yZWFkYWJsZSBKU09OLCBhIG5vbi1vYmplY3RcbiAgICogYGFnZW50UnVudGltZXNgLCBvciBhIG5vbi1hYnNvbHV0ZSBwYXRoIG1lYW5zIHRoZSBhdHRlc3RhdGlvbiBzYXlzIHNvbWV0aGluZyB3ZSBjYW5ub3QgYWN0IG9uO1xuICAgKiB0cmVhdGluZyB0aGF0IGFzIFwibm8gcGF0aCByZWNvcmRlZFwiIHdvdWxkIHNpbGVudGx5IGRvd25ncmFkZSBpdCB0byB0aGUgZmFsbGJhY2sgYWJvdmUgYW5kXG4gICAqIHJlcG9ydCBhIHByb2JlIGZhaWx1cmUgd2hvc2UgcmVhbCBjYXVzZSB3YXMgYSBjb3JydXB0IGF0dGVzdGF0aW9uIG5vYm9keSBsb29rZWQgYXQuXG4gICAqL1xuICBwcml2YXRlIGFzeW5jIHJlYWRBdHRlc3RlZEFnZW50UnVudGltZVBhdGhzKCk6IFByb21pc2U8XG4gICAgUGFydGlhbDxSZWNvcmQ8V29ya3NwYWNlSG9zdENhbmFyeUFnZW50LCBzdHJpbmc+PlxuICA+IHtcbiAgICBjb25zdCBieXRlcyA9IGF3YWl0IHRoaXMuc3lzdGVtLnJlYWRGaWxlSWZQcmVzZW50KFxuICAgICAgdGhpcy5hZ2VudFJ1bnRpbWVBdHRlc3RhdGlvblBhdGgsXG4gICAgKTtcbiAgICBpZiAoIWJ5dGVzKSByZXR1cm4ge307XG4gICAgbGV0IHBhcnNlZDogdW5rbm93bjtcbiAgICB0cnkge1xuICAgICAgcGFyc2VkID0gSlNPTi5wYXJzZShieXRlcy50b1N0cmluZyhcInV0ZjhcIikpO1xuICAgIH0gY2F0Y2gge1xuICAgICAgdGhyb3cgbmV3IFdvcmtzcGFjZUhvc3RPcGVyYXRpb25FcnJvcihcbiAgICAgICAgXCJyZWFkQXR0ZXN0ZWRBZ2VudFJ1bnRpbWVQYXRoc1wiLFxuICAgICAgICAxLFxuICAgICAgICBgYm9vdHN0cmFwIGF0dGVzdGF0aW9uIGF0ICR7dGhpcy5hZ2VudFJ1bnRpbWVBdHRlc3RhdGlvblBhdGh9IGlzIG5vdCB2YWxpZCBKU09OYCxcbiAgICAgICk7XG4gICAgfVxuICAgIGNvbnN0IHJ1bnRpbWUgPSAocGFyc2VkIGFzIHsgcnVudGltZT86IHVua25vd24gfSB8IG51bGwpPy5ydW50aW1lO1xuICAgIGNvbnN0IGF0dGVzdGVkID1cbiAgICAgIHJ1bnRpbWUgJiYgdHlwZW9mIHJ1bnRpbWUgPT09IFwib2JqZWN0XCJcbiAgICAgICAgPyAocnVudGltZSBhcyB7IGFnZW50UnVudGltZXM/OiB1bmtub3duIH0pLmFnZW50UnVudGltZXNcbiAgICAgICAgOiB1bmRlZmluZWQ7XG4gICAgaWYgKGF0dGVzdGVkID09PSB1bmRlZmluZWQpIHJldHVybiB7fTtcbiAgICBpZiAoXG4gICAgICB0eXBlb2YgYXR0ZXN0ZWQgIT09IFwib2JqZWN0XCIgfHxcbiAgICAgIGF0dGVzdGVkID09PSBudWxsIHx8XG4gICAgICBBcnJheS5pc0FycmF5KGF0dGVzdGVkKVxuICAgICkge1xuICAgICAgdGhyb3cgbmV3IFdvcmtzcGFjZUhvc3RPcGVyYXRpb25FcnJvcihcbiAgICAgICAgXCJyZWFkQXR0ZXN0ZWRBZ2VudFJ1bnRpbWVQYXRoc1wiLFxuICAgICAgICAxLFxuICAgICAgICBcImJvb3RzdHJhcCBhdHRlc3RhdGlvbiBydW50aW1lLmFnZW50UnVudGltZXMgaXMgbm90IGFuIG9iamVjdFwiLFxuICAgICAgKTtcbiAgICB9XG4gICAgY29uc3QgcmVjb3JkID0gYXR0ZXN0ZWQgYXMgUmVjb3JkPHN0cmluZywgdW5rbm93bj47XG4gICAgY29uc3QgcGF0aHM6IFBhcnRpYWw8UmVjb3JkPFdvcmtzcGFjZUhvc3RDYW5hcnlBZ2VudCwgc3RyaW5nPj4gPSB7fTtcbiAgICBmb3IgKGNvbnN0IGFnZW50IG9mIFdPUktTUEFDRV9IT1NUX0NBTkFSWV9BR0VOVFMpIHtcbiAgICAgIGNvbnN0IHZhbHVlID0gcmVjb3JkW2FnZW50XTtcbiAgICAgIGlmICh2YWx1ZSA9PT0gdW5kZWZpbmVkKSBjb250aW51ZTtcbiAgICAgIGlmICh0eXBlb2YgdmFsdWUgIT09IFwic3RyaW5nXCIgfHwgIWlzQWJzb2x1dGUodmFsdWUpKSB7XG4gICAgICAgIHRocm93IG5ldyBXb3Jrc3BhY2VIb3N0T3BlcmF0aW9uRXJyb3IoXG4gICAgICAgICAgXCJyZWFkQXR0ZXN0ZWRBZ2VudFJ1bnRpbWVQYXRoc1wiLFxuICAgICAgICAgIDEsXG4gICAgICAgICAgYGF0dGVzdGVkIHJ1bnRpbWUgcGF0aCBmb3IgJyR7YWdlbnR9JyBpcyBub3QgYW4gYWJzb2x1dGUgcGF0aGAsXG4gICAgICAgICk7XG4gICAgICB9XG4gICAgICAvLyBUaGUgcmVsZWFzZSBiaW4gaG9sZHMgdGhlIHBzdSB3cmFwcGVycy4gQSByZXNvbHZlIHRoYXQgbGFuZGVkIHRoZXJlIGRpZCBOT1QgZmluZCBhIHZlbmRvclxuICAgICAgLy8gQ0xJLCBzbyBwcm9iaW5nIGl0IHdvdWxkIHJlcHJvZHVjZSBELTI0NyBleGFjdGx5IOKAlCBhIGdyZWVuLWxvb2tpbmcgcHJvYmUgbWVhc3VyaW5nIHRoZVxuICAgICAgLy8gd3JvbmcgYmluYXJ5LiBCb290c3RyYXAncyByZXNvbHZlIGFscmVhZHkgZXhjbHVkZXMgdGhpcyBkaXJlY3RvcnkgZnJvbSBpdHMgc2VhcmNoIHBhdGg7XG4gICAgICAvLyB0aGlzIHJlZnVzZXMgdGhlIHNhbWUgdGhpbmcgYXQgdGhlIHBvaW50IG9mIFVTRSwgd2hlcmUgYSBoYW5kLWVkaXRlZCBvciBmdXR1cmUtcmVncmVzc2VkXG4gICAgICAvLyBhdHRlc3RhdGlvbiB3b3VsZCBvdGhlcndpc2UgYXJyaXZlIHVuY2hhbGxlbmdlZC5cbiAgICAgIGlmIChcbiAgICAgICAgdmFsdWUgPT09IFdPUktTUEFDRV9IT1NUX1JFTEVBU0VfQklOX0RJUiB8fFxuICAgICAgICB2YWx1ZS5zdGFydHNXaXRoKGAke1dPUktTUEFDRV9IT1NUX1JFTEVBU0VfQklOX0RJUn0vYClcbiAgICAgICkge1xuICAgICAgICB0aHJvdyBuZXcgV29ya3NwYWNlSG9zdE9wZXJhdGlvbkVycm9yKFxuICAgICAgICAgIFwicmVhZEF0dGVzdGVkQWdlbnRSdW50aW1lUGF0aHNcIixcbiAgICAgICAgICAxLFxuICAgICAgICAgIGBhdHRlc3RlZCBydW50aW1lIHBhdGggZm9yICcke2FnZW50fScgaXMgaW5zaWRlICR7V09SS1NQQUNFX0hPU1RfUkVMRUFTRV9CSU5fRElSfSwgd2hpY2ggaG9sZHMgbGF1bmNoZXIgd3JhcHBlcnMgcmF0aGVyIHRoYW4gdmVuZG9yIENMSXMgKEQtMjU5KWAsXG4gICAgICAgICk7XG4gICAgICB9XG4gICAgICBwYXRoc1thZ2VudF0gPSB2YWx1ZTtcbiAgICB9XG4gICAgcmV0dXJuIHBhdGhzO1xuICB9XG5cbiAgYXN5bmMgZGVzY3JpYmVDbG9uZWRSZXBvc2l0b3J5KGlucHV0Pzoge1xuICAgIHJlYWRvbmx5IGRlc3RpbmF0aW9uOiBzdHJpbmc7XG4gICAgcmVhZG9ubHkgdmlzaWJpbGl0eTogXCJwdWJsaWNcIiB8IFwicHJpdmF0ZVwiO1xuICB9KTogUHJvbWlzZTx7XG4gICAgcmVhZG9ubHkgdmlzaWJpbGl0eTogXCJwdWJsaWNcIiB8IFwicHJpdmF0ZVwiO1xuICAgIHJlYWRvbmx5IGNsb25lZDogYm9vbGVhbjtcbiAgfT4ge1xuICAgIGlmICghaW5wdXQpIHJldHVybiB7IHZpc2liaWxpdHk6IFwicHVibGljXCIsIGNsb25lZDogZmFsc2UgfTtcbiAgICAvLyBgdmVyaWZ5LWluaXRpYWxpemF0aW9uYCBpcyBhIGZyZXNoIHByb2Nlc3MuIFRoZSB2YWxpZGF0ZWQgZGVzdGluYXRpb24gaXMgY2FycmllZCBvbiB0aGF0XG4gICAgLy8gc3RlcCwgc28gdGhpcyBvYnNlcnZhdGlvbiBjYW5ub3QgZGVwZW5kIG9uIGEgY2xvbmUgcmVtZW1iZXJlZCBieSBhbiBlYXJsaWVyIEpTIG9iamVjdC5cbiAgICBjb25zdCBkZXN0aW5hdGlvbiA9IHJlc29sdmVXaXRoaW5Sb290KFxuICAgICAgdGhpcy53b3Jrc3BhY2VSb290LFxuICAgICAgaW5wdXQuZGVzdGluYXRpb24sXG4gICAgICBcImRlc3RpbmF0aW9uXCIsXG4gICAgKTtcbiAgICBjb25zdCBjbG9uZWQgPSBhd2FpdCB0aGlzLnN5c3RlbS5wYXRoRXhpc3RzKGpvaW4oZGVzdGluYXRpb24sIFwiLmdpdFwiKSk7XG4gICAgcmV0dXJuIHsgdmlzaWJpbGl0eTogaW5wdXQudmlzaWJpbGl0eSwgY2xvbmVkIH07XG4gIH1cbn1cblxuLyoqXG4gKiBQcm9kdWN0aW9uIGNyZWRlbnRpYWwgbWF0ZXJpYWxpemVyLlxuICpcbiAqIFRoZSBob3N0IGlzIGEgY3JlZGVudGlhbCBSRUNJUElFTlQsIG5ldmVyIGEgbWludGVyOiB0aGUgY29udHJvbGxlciBkZWxpdmVycyBtYXRlcmlhbCBvdXQgb2ZcbiAqIGJhbmQgKG1ldGFkYXRhIHNlcnZlciwgaW5qZWN0ZWQgZmlsZSwgZm9yd2FyZGVkIHJlZmVyZW5jZSkgYW5kIHRoZSBob3N0J3Mgam9iIGlzIHRvIGNvbmZpcm0gdGhlXG4gKiBkZWxpdmVyeSBsYW5kZWQsIGNvbmZpcm0gaXQgc3RpbGwgaG9sZHMsIGFuZCBjb25maXJtIGEgcmV2b2NhdGlvbiBhY3R1YWxseSB0b29rIGVmZmVjdC4gVGhhdCBpc1xuICogd2h5IGFsbCBmb3VyIG9wZXJhdGlvbnMgYXJlIG9ic2VydmF0aW9ucyBhbmQgbm9uZSBvZiB0aGVtIHdyaXRlcyBhIGNyZWRlbnRpYWwuXG4gKlxuICogRXZlcnkgcmV0dXJuZWQgZGV0YWlsIGlzIHB1YmxpYzogdGhlIGZhbWlseSwgdGhlIGRlbGl2ZXJ5IGtpbmQsIHRoZSBnZW5lcmF0aW9uLCBhbmQgYSBib29sZWFuLlxuICogVGhlIHJlc29sdmVyIHJlLWFzc2VydHMgc2VjcmV0IGlzb2xhdGlvbiBvdmVyIHdoYXRldmVyIHRoaXMgcmV0dXJucywgc28gYSBtYXRlcmlhbGl6ZXIgdGhhdFxuICogbGVha2VkIG1hdGVyaWFsIHdvdWxkIGZhaWwgdGhlcmUg4oCUIGJ1dCB0aGUgZGVzaWduIGludGVudCBpcyB0aGF0IHRoZXJlIGlzIG5vdGhpbmcgdG8gbGVhay5cbiAqL1xuZXhwb3J0IGNsYXNzIFByb2R1Y3Rpb25Xb3Jrc3BhY2VIb3N0Q3JlZGVudGlhbE1hdGVyaWFsaXplciBpbXBsZW1lbnRzIFdvcmtzcGFjZUhvc3RDcmVkZW50aWFsTWF0ZXJpYWxpemVyIHtcbiAgcmVhZG9ubHkgZmFtaWx5OiBXb3Jrc3BhY2VIb3N0Q3JlZGVudGlhbEZhbWlseTtcbiAgcHJpdmF0ZSByZWFkb25seSBzeXN0ZW06IFdvcmtzcGFjZUhvc3RTeXN0ZW07XG4gIHByaXZhdGUgcmVhZG9ubHkgbG9jYXRlOiAoXG4gICAgYmluZGluZzogV29ya3NwYWNlSG9zdENyZWRlbnRpYWxCaW5kaW5nRGVzY3JpcHRvcixcbiAgKSA9PiBzdHJpbmcgfCBudWxsO1xuICBwcml2YXRlIHJlYWRvbmx5IGdpdENyZWRlbnRpYWxCaW5kaW5ncz86IFdvcmtzcGFjZUhvc3RHaXRDcmVkZW50aWFsQmluZGluZ1JlZ2lzdHJ5O1xuICBwcml2YXRlIHJlYWRvbmx5IGFnZW50SG9tZUNvbnN1bWVyPzogV29ya3NwYWNlSG9zdEFnZW50SG9tZUNvbnN1bWVyO1xuICBwcml2YXRlIHJlYWRvbmx5IHJlY29yZFJldm9jYXRpb24/OiAoZ2VuZXJhdGlvbjogbnVtYmVyKSA9PiBQcm9taXNlPHZvaWQ+O1xuICBwcml2YXRlIHJlYWRvbmx5IGxpZmVjeWNsZUxvY2tQYXRoPzogc3RyaW5nO1xuXG4gIGNvbnN0cnVjdG9yKFxuICAgIGZhbWlseTogV29ya3NwYWNlSG9zdENyZWRlbnRpYWxGYW1pbHksXG4gICAgc3lzdGVtOiBXb3Jrc3BhY2VIb3N0U3lzdGVtLFxuICAgIGxvY2F0ZTogKFxuICAgICAgYmluZGluZzogV29ya3NwYWNlSG9zdENyZWRlbnRpYWxCaW5kaW5nRGVzY3JpcHRvcixcbiAgICApID0+IHN0cmluZyB8IG51bGwsXG4gICAgZ2l0Q3JlZGVudGlhbEJpbmRpbmdzPzogV29ya3NwYWNlSG9zdEdpdENyZWRlbnRpYWxCaW5kaW5nUmVnaXN0cnksXG4gICAgYWdlbnRIb21lQ29uc3VtZXI/OiBXb3Jrc3BhY2VIb3N0QWdlbnRIb21lQ29uc3VtZXIsXG4gICAgcmVjb3JkUmV2b2NhdGlvbj86IChnZW5lcmF0aW9uOiBudW1iZXIpID0+IFByb21pc2U8dm9pZD4sXG4gICAgbGlmZWN5Y2xlTG9ja1BhdGg/OiBzdHJpbmcsXG4gICkge1xuICAgIHRoaXMuZmFtaWx5ID0gZmFtaWx5O1xuICAgIHRoaXMuc3lzdGVtID0gc3lzdGVtO1xuICAgIHRoaXMubG9jYXRlID0gbG9jYXRlO1xuICAgIHRoaXMuZ2l0Q3JlZGVudGlhbEJpbmRpbmdzID0gZ2l0Q3JlZGVudGlhbEJpbmRpbmdzO1xuICAgIHRoaXMuYWdlbnRIb21lQ29uc3VtZXIgPSBhZ2VudEhvbWVDb25zdW1lcjtcbiAgICB0aGlzLnJlY29yZFJldm9jYXRpb24gPSByZWNvcmRSZXZvY2F0aW9uO1xuICAgIHRoaXMubGlmZWN5Y2xlTG9ja1BhdGggPSBsaWZlY3ljbGVMb2NrUGF0aDtcbiAgfVxuXG4gIHByaXZhdGUgYXN5bmMgd2l0aExpZmVjeWNsZUxvY2s8VD4odGFzazogKCkgPT4gUHJvbWlzZTxUPik6IFByb21pc2U8VD4ge1xuICAgIGlmICghdGhpcy5saWZlY3ljbGVMb2NrUGF0aCkgcmV0dXJuIGF3YWl0IHRhc2soKTtcbiAgICByZXR1cm4gYXdhaXQgd2l0aFdvcmtzcGFjZUhvc3RDcmVkZW50aWFsRmlsZXN5c3RlbUxvY2soXG4gICAgICB0aGlzLnN5c3RlbSxcbiAgICAgIHRoaXMubGlmZWN5Y2xlTG9ja1BhdGgsXG4gICAgICB0YXNrLFxuICAgICk7XG4gIH1cblxuICBwcml2YXRlIGFnZW50RmFtaWx5KCk6IFdvcmtzcGFjZUhvc3RBZ2VudEhvbWVGYW1pbHkgfCBudWxsIHtcbiAgICByZXR1cm4gV09SS1NQQUNFX0hPU1RfQUdFTlRfSE9NRV9GQU1JTElFUy5pbmNsdWRlcyhcbiAgICAgIHRoaXMuZmFtaWx5IGFzIFdvcmtzcGFjZUhvc3RBZ2VudEhvbWVGYW1pbHksXG4gICAgKVxuICAgICAgPyAodGhpcy5mYW1pbHkgYXMgV29ya3NwYWNlSG9zdEFnZW50SG9tZUZhbWlseSlcbiAgICAgIDogbnVsbDtcbiAgfVxuXG4gIHByaXZhdGUgYXN5bmMgcmVxdWlyZU1hdGVyaWFsKFxuICAgIGJpbmRpbmc6IFdvcmtzcGFjZUhvc3RDcmVkZW50aWFsQmluZGluZ0Rlc2NyaXB0b3IsXG4gICAgb3BlcmF0aW9uOiBzdHJpbmcsXG4gICk6IFByb21pc2U8eyByZWFkb25seSBwYXRoOiBzdHJpbmc7IHJlYWRvbmx5IGJ5dGVzOiBCdWZmZXIgfSB8IG51bGw+IHtcbiAgICBjb25zdCBwYXRoID0gdGhpcy5sb2NhdGUoYmluZGluZyk7XG4gICAgaWYgKHBhdGggPT09IG51bGwpIHJldHVybiBudWxsO1xuICAgIGNvbnN0IGJ5dGVzID0gYXdhaXQgdGhpcy5zeXN0ZW0ucmVhZEZpbGVJZlByZXNlbnQocGF0aCk7XG4gICAgaWYgKGJ5dGVzID09PSBudWxsKSB7XG4gICAgICB0aHJvdyBuZXcgV29ya3NwYWNlSG9zdE9wZXJhdGlvbkVycm9yKFxuICAgICAgICBgY3JlZGVudGlhbC4ke2JpbmRpbmcuY2hhbm5lbH0uJHtvcGVyYXRpb259YCxcbiAgICAgICAgMSxcbiAgICAgICAgYGRlbGl2ZXJlZCBtYXRlcmlhbCBmb3IgZmFtaWx5ICcke3RoaXMuZmFtaWx5fScgaXMgbm90IHByZXNlbnQgb24gdGhlIGhvc3RgLFxuICAgICAgKTtcbiAgICB9XG4gICAgcmV0dXJuIHsgcGF0aCwgYnl0ZXMgfTtcbiAgfVxuXG4gIHByaXZhdGUgZGVzY3JpYmUoXG4gICAgYmluZGluZzogV29ya3NwYWNlSG9zdENyZWRlbnRpYWxCaW5kaW5nRGVzY3JpcHRvcixcbiAgICBwcmVzZW50OiBib29sZWFuLFxuICApOiBSZWFkb25seTxSZWNvcmQ8c3RyaW5nLCB1bmtub3duPj4ge1xuICAgIHJldHVybiB7XG4gICAgICBmYW1pbHk6IHRoaXMuZmFtaWx5LFxuICAgICAgY2hhbm5lbDogYmluZGluZy5jaGFubmVsLFxuICAgICAgZGVsaXZlcnlLaW5kOiBiaW5kaW5nLmRlbGl2ZXJ5S2luZCxcbiAgICAgIGdlbmVyYXRpb246IGJpbmRpbmcuZ2VuZXJhdGlvbixcbiAgICAgIHByZXNlbnQsXG4gICAgfTtcbiAgfVxuXG4gIGFzeW5jIGJpbmQoXG4gICAgYmluZGluZzogV29ya3NwYWNlSG9zdENyZWRlbnRpYWxCaW5kaW5nRGVzY3JpcHRvcixcbiAgKTogUHJvbWlzZTxSZWFkb25seTxSZWNvcmQ8c3RyaW5nLCB1bmtub3duPj4+IHtcbiAgICByZXR1cm4gYXdhaXQgdGhpcy53aXRoTGlmZWN5Y2xlTG9jayhhc3luYyAoKSA9PiB7XG4gICAgICBjb25zdCBtYXRlcmlhbCA9IGF3YWl0IHRoaXMucmVxdWlyZU1hdGVyaWFsKGJpbmRpbmcsIFwiYmluZFwiKTtcbiAgICAgIGNvbnN0IGFnZW50RmFtaWx5ID0gdGhpcy5hZ2VudEZhbWlseSgpO1xuICAgICAgaWYgKGFnZW50RmFtaWx5KSB7XG4gICAgICAgIGlmICghdGhpcy5hZ2VudEhvbWVDb25zdW1lciB8fCAhbWF0ZXJpYWwpIHtcbiAgICAgICAgICB0aHJvdyBuZXcgV29ya3NwYWNlSG9zdE9wZXJhdGlvbkVycm9yKFxuICAgICAgICAgICAgYGNyZWRlbnRpYWwuJHtiaW5kaW5nLmNoYW5uZWx9LmJpbmRgLFxuICAgICAgICAgICAgMSxcbiAgICAgICAgICAgIGBubyBhZ2VudC1ob21lIGNvbnN1bWVyIGlzIGNvbmZpZ3VyZWQgZm9yIGZhbWlseSAnJHt0aGlzLmZhbWlseX0nYCxcbiAgICAgICAgICApO1xuICAgICAgICB9XG4gICAgICAgIGF3YWl0IHRoaXMuYWdlbnRIb21lQ29uc3VtZXIuaW5zdGFsbChcbiAgICAgICAgICBhZ2VudEZhbWlseSxcbiAgICAgICAgICBiaW5kaW5nLmdlbmVyYXRpb24sXG4gICAgICAgICAgbWF0ZXJpYWwuYnl0ZXMsXG4gICAgICAgICAgeyBsb2NrSGVsZDogdHJ1ZSB9LFxuICAgICAgICApO1xuICAgICAgfSBlbHNlIGlmIChiaW5kaW5nLmNoYW5uZWwgPT09IFwiZ2l0XCIgJiYgbWF0ZXJpYWwpIHtcbiAgICAgICAgaWYgKCF0aGlzLmdpdENyZWRlbnRpYWxCaW5kaW5ncykge1xuICAgICAgICAgIHRocm93IG5ldyBXb3Jrc3BhY2VIb3N0T3BlcmF0aW9uRXJyb3IoXG4gICAgICAgICAgICBcImNyZWRlbnRpYWwuZ2l0LmJpbmRcIixcbiAgICAgICAgICAgIDEsXG4gICAgICAgICAgICBcIm5vIGR1cmFibGUgR2l0IGJpbmRpbmcgcmVnaXN0cnkgaXMgY29uZmlndXJlZFwiLFxuICAgICAgICAgICk7XG4gICAgICAgIH1cbiAgICAgICAgYXdhaXQgdGhpcy5naXRDcmVkZW50aWFsQmluZGluZ3MuYmluZChiaW5kaW5nLCBtYXRlcmlhbC5wYXRoLCB7XG4gICAgICAgICAgbG9ja0hlbGQ6IHRydWUsXG4gICAgICAgIH0pO1xuICAgICAgfSBlbHNlIGlmIChiaW5kaW5nLmNoYW5uZWwgIT09IFwiY2xvdWRcIiAmJiAhbWF0ZXJpYWwpIHtcbiAgICAgICAgdGhyb3cgbmV3IFdvcmtzcGFjZUhvc3RPcGVyYXRpb25FcnJvcihcbiAgICAgICAgICBgY3JlZGVudGlhbC4ke2JpbmRpbmcuY2hhbm5lbH0uYmluZGAsXG4gICAgICAgICAgMSxcbiAgICAgICAgICBgZmFtaWx5ICcke3RoaXMuZmFtaWx5fScgcmVxdWlyZXMgZGVsaXZlcmVkIG1hdGVyaWFsYCxcbiAgICAgICAgKTtcbiAgICAgIH1cbiAgICAgIHJldHVybiB0aGlzLmRlc2NyaWJlKGJpbmRpbmcsIHRydWUpO1xuICAgIH0pO1xuICB9XG5cbiAgYXN5bmMgdmVyaWZ5Qm91bmQoXG4gICAgYmluZGluZzogV29ya3NwYWNlSG9zdENyZWRlbnRpYWxCaW5kaW5nRGVzY3JpcHRvcixcbiAgKTogUHJvbWlzZTxSZWFkb25seTxSZWNvcmQ8c3RyaW5nLCB1bmtub3duPj4+IHtcbiAgICByZXR1cm4gYXdhaXQgdGhpcy53aXRoTGlmZWN5Y2xlTG9jayhhc3luYyAoKSA9PiB7XG4gICAgICBjb25zdCBtYXRlcmlhbCA9IGF3YWl0IHRoaXMucmVxdWlyZU1hdGVyaWFsKGJpbmRpbmcsIFwidmVyaWZ5LWJvdW5kXCIpO1xuICAgICAgY29uc3QgYWdlbnRGYW1pbHkgPSB0aGlzLmFnZW50RmFtaWx5KCk7XG4gICAgICBpZiAoYWdlbnRGYW1pbHkpIHtcbiAgICAgICAgaWYgKCF0aGlzLmFnZW50SG9tZUNvbnN1bWVyIHx8ICFtYXRlcmlhbCkge1xuICAgICAgICAgIHRocm93IG5ldyBXb3Jrc3BhY2VIb3N0T3BlcmF0aW9uRXJyb3IoXG4gICAgICAgICAgICBgY3JlZGVudGlhbC4ke2JpbmRpbmcuY2hhbm5lbH0udmVyaWZ5LWJvdW5kYCxcbiAgICAgICAgICAgIDEsXG4gICAgICAgICAgICBgbm8gYWdlbnQtaG9tZSBjb25zdW1lciBpcyBjb25maWd1cmVkIGZvciBmYW1pbHkgJyR7dGhpcy5mYW1pbHl9J2AsXG4gICAgICAgICAgKTtcbiAgICAgICAgfVxuICAgICAgICBhd2FpdCB0aGlzLmFnZW50SG9tZUNvbnN1bWVyLnZlcmlmeShcbiAgICAgICAgICBhZ2VudEZhbWlseSxcbiAgICAgICAgICBiaW5kaW5nLmdlbmVyYXRpb24sXG4gICAgICAgICAgbWF0ZXJpYWwuYnl0ZXMsXG4gICAgICAgICAgeyBsb2NrSGVsZDogdHJ1ZSB9LFxuICAgICAgICApO1xuICAgICAgfSBlbHNlIGlmIChiaW5kaW5nLmNoYW5uZWwgPT09IFwiZ2l0XCIgJiYgbWF0ZXJpYWwpIHtcbiAgICAgICAgYXdhaXQgdGhpcy5naXRDcmVkZW50aWFsQmluZGluZ3M/LnZlcmlmeUJvdW5kKGJpbmRpbmcsIG1hdGVyaWFsLnBhdGgsIHtcbiAgICAgICAgICBsb2NrSGVsZDogdHJ1ZSxcbiAgICAgICAgfSk7XG4gICAgICB9XG4gICAgICByZXR1cm4gdGhpcy5kZXNjcmliZShiaW5kaW5nLCB0cnVlKTtcbiAgICB9KTtcbiAgfVxuXG4gIGFzeW5jIHJldm9rZShcbiAgICBiaW5kaW5nOiBXb3Jrc3BhY2VIb3N0Q3JlZGVudGlhbEJpbmRpbmdEZXNjcmlwdG9yLFxuICApOiBQcm9taXNlPFJlYWRvbmx5PFJlY29yZDxzdHJpbmcsIHVua25vd24+Pj4ge1xuICAgIHJldHVybiBhd2FpdCB0aGlzLndpdGhMaWZlY3ljbGVMb2NrKGFzeW5jICgpID0+IHtcbiAgICAgIGNvbnN0IHBhdGggPSB0aGlzLmxvY2F0ZShiaW5kaW5nKTtcbiAgICAgIGNvbnN0IGFnZW50RmFtaWx5ID0gdGhpcy5hZ2VudEZhbWlseSgpO1xuICAgICAgaWYgKGFnZW50RmFtaWx5KSB7XG4gICAgICAgIGlmICghdGhpcy5hZ2VudEhvbWVDb25zdW1lcikge1xuICAgICAgICAgIHRocm93IG5ldyBXb3Jrc3BhY2VIb3N0T3BlcmF0aW9uRXJyb3IoXG4gICAgICAgICAgICBgY3JlZGVudGlhbC4ke2JpbmRpbmcuY2hhbm5lbH0ucmV2b2tlYCxcbiAgICAgICAgICAgIDEsXG4gICAgICAgICAgICBgbm8gYWdlbnQtaG9tZSBjb25zdW1lciBpcyBjb25maWd1cmVkIGZvciBmYW1pbHkgJyR7dGhpcy5mYW1pbHl9J2AsXG4gICAgICAgICAgKTtcbiAgICAgICAgfVxuICAgICAgICBhd2FpdCB0aGlzLmFnZW50SG9tZUNvbnN1bWVyLnJldm9rZShhZ2VudEZhbWlseSwgYmluZGluZy5nZW5lcmF0aW9uLCB7XG4gICAgICAgICAgbG9ja0hlbGQ6IHRydWUsXG4gICAgICAgIH0pO1xuICAgICAgfVxuICAgICAgYXdhaXQgdGhpcy5naXRDcmVkZW50aWFsQmluZGluZ3M/LnJldm9rZShiaW5kaW5nLCB7IGxvY2tIZWxkOiB0cnVlIH0pO1xuICAgICAgaWYgKHBhdGggIT09IG51bGwpIGF3YWl0IHRoaXMuc3lzdGVtLnJlbW92ZVBhdGgocGF0aCk7XG4gICAgICAvLyBUaGUgbGVkZ2VyIGlzIHJhaXNlZCBiZWZvcmUgc3VjY2VzcyBpcyByZXBvcnRlZCwgYmVjYXVzZSBpdCBpcyB0aGUgb25seSBkdXJhYmxlIHRyYWNlIHRoYXRcbiAgICAgIC8vIHRoaXMgZ2VuZXJhdGlvbiB3YXMgZGVzdHJveWVkLiBLZWVwIHRoZSB3aG9sZSBzZXF1ZW5jZSB1bmRlciBvbmUgZmFtaWx5IGxvY2sgc28gYSBkZWxpdmVyeVxuICAgICAgLy8gY2Fubm90IHNsaXAgYmV0d2VlbiB1bmxpbmsgYW5kIHRoZSBoaWdoLXdhdGVyIHVwZGF0ZS5cbiAgICAgIGlmIChwYXRoICE9PSBudWxsKSBhd2FpdCB0aGlzLnJlY29yZFJldm9jYXRpb24/LihiaW5kaW5nLmdlbmVyYXRpb24pO1xuICAgICAgcmV0dXJuIHRoaXMuZGVzY3JpYmUoYmluZGluZywgZmFsc2UpO1xuICAgIH0pO1xuICB9XG5cbiAgYXN5bmMgdmVyaWZ5UmV2b2tlZChcbiAgICBiaW5kaW5nOiBXb3Jrc3BhY2VIb3N0Q3JlZGVudGlhbEJpbmRpbmdEZXNjcmlwdG9yLFxuICApOiBQcm9taXNlPFJlYWRvbmx5PFJlY29yZDxzdHJpbmcsIHVua25vd24+Pj4ge1xuICAgIHJldHVybiBhd2FpdCB0aGlzLndpdGhMaWZlY3ljbGVMb2NrKGFzeW5jICgpID0+IHtcbiAgICAgIGNvbnN0IHBhdGggPSB0aGlzLmxvY2F0ZShiaW5kaW5nKTtcbiAgICAgIC8vIFJldm9jYXRpb24gb2YgYW4gYW1iaWVudCBmYW1pbHkgaXMgYXNzZXJ0ZWQgYnkgdGhlIElTU1VFUiwgbm90IG9ic2VydmFibGUgaGVyZTsgc2F5aW5nXG4gICAgICAvLyBvdGhlcndpc2Ugd291bGQgbWFudWZhY3R1cmUgZXZpZGVuY2UuIEZhbWlsaWVzIHdpdGggYW4gb24taG9zdCBhcnRpZmFjdCBhcmUgcmVhbGx5IGNoZWNrZWQuXG4gICAgICBpZiAocGF0aCA9PT0gbnVsbCkgcmV0dXJuIHRoaXMuZGVzY3JpYmUoYmluZGluZywgZmFsc2UpO1xuICAgICAgaWYgKGF3YWl0IHRoaXMuc3lzdGVtLnBhdGhFeGlzdHMocGF0aCkpIHtcbiAgICAgICAgdGhyb3cgbmV3IFdvcmtzcGFjZUhvc3RPcGVyYXRpb25FcnJvcihcbiAgICAgICAgICBgY3JlZGVudGlhbC4ke2JpbmRpbmcuY2hhbm5lbH0udmVyaWZ5LXJldm9rZWRgLFxuICAgICAgICAgIDEsXG4gICAgICAgICAgYG1hdGVyaWFsIGZvciBmYW1pbHkgJyR7dGhpcy5mYW1pbHl9JyBpcyBzdGlsbCBwcmVzZW50IGFmdGVyIHJldm9jYXRpb25gLFxuICAgICAgICApO1xuICAgICAgfVxuICAgICAgY29uc3QgYWdlbnRGYW1pbHkgPSB0aGlzLmFnZW50RmFtaWx5KCk7XG4gICAgICBpZiAoYWdlbnRGYW1pbHkpIHtcbiAgICAgICAgaWYgKCF0aGlzLmFnZW50SG9tZUNvbnN1bWVyKSB7XG4gICAgICAgICAgdGhyb3cgbmV3IFdvcmtzcGFjZUhvc3RPcGVyYXRpb25FcnJvcihcbiAgICAgICAgICAgIGBjcmVkZW50aWFsLiR7YmluZGluZy5jaGFubmVsfS52ZXJpZnktcmV2b2tlZGAsXG4gICAgICAgICAgICAxLFxuICAgICAgICAgICAgYG5vIGFnZW50LWhvbWUgY29uc3VtZXIgaXMgY29uZmlndXJlZCBmb3IgZmFtaWx5ICcke3RoaXMuZmFtaWx5fSdgLFxuICAgICAgICAgICk7XG4gICAgICAgIH1cbiAgICAgICAgYXdhaXQgdGhpcy5hZ2VudEhvbWVDb25zdW1lci52ZXJpZnlSZXZva2VkKFxuICAgICAgICAgIGFnZW50RmFtaWx5LFxuICAgICAgICAgIGJpbmRpbmcuZ2VuZXJhdGlvbixcbiAgICAgICAgICB7IGxvY2tIZWxkOiB0cnVlIH0sXG4gICAgICAgICk7XG4gICAgICB9XG4gICAgICBhd2FpdCB0aGlzLmdpdENyZWRlbnRpYWxCaW5kaW5ncz8udmVyaWZ5UmV2b2tlZChiaW5kaW5nLCB7XG4gICAgICAgIGxvY2tIZWxkOiB0cnVlLFxuICAgICAgfSk7XG4gICAgICByZXR1cm4gdGhpcy5kZXNjcmliZShiaW5kaW5nLCBmYWxzZSk7XG4gICAgfSk7XG4gIH1cbn1cblxuLyoqIFdoZXJlIGVhY2ggZmFtaWx5J3MgZGVsaXZlcmVkIG1hdGVyaWFsIGxpdmVzIG9uIHRoZSBob3N0LCBvciBudWxsIHdoZW4gaXQgaXMgYW1iaWVudC4gKi9cbmV4cG9ydCBjb25zdCBXT1JLU1BBQ0VfSE9TVF9DUkVERU5USUFMX01BVEVSSUFMX1JPT1QgPVxuICBcIi92YXIvbGliL3BhcGVyY3VzcC9jcmVkZW50aWFsc1wiO1xuXG5mdW5jdGlvbiBtYXRlcmlhbFBhdGhGb3IoXG4gIHJvb3Q6IHN0cmluZyxcbiAgZmFtaWx5OiBXb3Jrc3BhY2VIb3N0Q3JlZGVudGlhbEZhbWlseSxcbik6IChiaW5kaW5nOiBXb3Jrc3BhY2VIb3N0Q3JlZGVudGlhbEJpbmRpbmdEZXNjcmlwdG9yKSA9PiBzdHJpbmcgfCBudWxsIHtcbiAgcmV0dXJuIChiaW5kaW5nKSA9PiB7XG4gICAgLy8gRGVyaXZlZCBmcm9tIHRoZSBmYW1pbHkgc3BlYywgbmV2ZXIgZnJvbSBhIGhhcmQtY29kZWQgZmFtaWx5IG5hbWUgKEQtMjE1KTogYSBmYW1pbHkgdGhhdCBpc1xuICAgIC8vIGFuc3dlcmVkIGFtYmllbnRseSBieSB0aGUgZW52aXJvbm1lbnQgaGFzIG5vIGZpbGUgdG8gY2hlY2ssIGFuZCBpbnZlbnRpbmcgb25lIHdvdWxkIG1ha2VcbiAgICAvLyBiaW5kKCkgcGFzcyBhZ2FpbnN0IGEgcGF0aCB3ZSBjcmVhdGVkIG91cnNlbHZlcy4gS2V5aW5nIG9uIHRoZSBzcGVjIG1lYW5zIGEgZmlmdGggZmFtaWx5XG4gICAgLy8gaGFzIHRvIGRlY2xhcmUgd2hpY2ggaXQgaXMgaW5zdGVhZCBvZiBzaWxlbnRseSBpbmhlcml0aW5nIHRoZSB3cm9uZyBicmFuY2guXG4gICAgaWYgKFxuICAgICAgIVdPUktTUEFDRV9IT1NUX0NSRURFTlRJQUxfRkFNSUxZX1NQRUNTW2ZhbWlseV0ucmVxdWlyZXNEZWxpdmVyZWRNYXRlcmlhbFxuICAgIClcbiAgICAgIHJldHVybiBudWxsO1xuICAgIC8vIFRoZSBsYXlvdXQgaXMgb3duZWQgYnkgdGhlIGRlbGl2ZXJ5IG1vZHVsZSDigJQgdGhlIHdyaXRlciBhbmQgdGhpcyByZWFkZXIgbXVzdCBhZ3JlZSBvbiB0aGVcbiAgICAvLyBwYXRoLCBhbmQgdHdvIGBqb2luYCBjYWxscyB0aGF0IGhhcHBlbiB0byBtYXRjaCB0b2RheSBhcmUgaG93IHRoZXkgc3RvcCBtYXRjaGluZyBsYXRlci5cbiAgICByZXR1cm4gd29ya3NwYWNlSG9zdENyZWRlbnRpYWxNYXRlcmlhbFBhdGgoXG4gICAgICByb290LFxuICAgICAgZmFtaWx5LFxuICAgICAgYmluZGluZy5nZW5lcmF0aW9uLFxuICAgICk7XG4gIH07XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBjcmVhdGVQcm9kdWN0aW9uV29ya3NwYWNlSG9zdENyZWRlbnRpYWxNYXRlcmlhbGl6ZXJzKFxuICBzeXN0ZW06IFdvcmtzcGFjZUhvc3RTeXN0ZW0sXG4gIG1hdGVyaWFsUm9vdDogc3RyaW5nID0gV09SS1NQQUNFX0hPU1RfQ1JFREVOVElBTF9NQVRFUklBTF9ST09ULFxuICBnaXRDcmVkZW50aWFsQmluZGluZ3M/OiBXb3Jrc3BhY2VIb3N0R2l0Q3JlZGVudGlhbEJpbmRpbmdSZWdpc3RyeSxcbiAgYWdlbnRIb21lQ29uc3VtZXI/OiBXb3Jrc3BhY2VIb3N0QWdlbnRIb21lQ29uc3VtZXIsXG4pOiByZWFkb25seSBXb3Jrc3BhY2VIb3N0Q3JlZGVudGlhbE1hdGVyaWFsaXplcltdIHtcbiAgY29uc3QgZHVyYWJsZUdpdEJpbmRpbmdzID1cbiAgICBnaXRDcmVkZW50aWFsQmluZGluZ3MgPz9cbiAgICBuZXcgV29ya3NwYWNlSG9zdEdpdENyZWRlbnRpYWxCaW5kaW5nUmVnaXN0cnkoc3lzdGVtLCBtYXRlcmlhbFJvb3QpO1xuICBjb25zdCBkdXJhYmxlQWdlbnRIb21lID1cbiAgICBhZ2VudEhvbWVDb25zdW1lciA/P1xuICAgIG5ldyBXb3Jrc3BhY2VIb3N0QWdlbnRIb21lQ29uc3VtZXIoe1xuICAgICAgZmlsZXN5c3RlbTogc3lzdGVtLFxuICAgICAgbWF0ZXJpYWxSb290LFxuICAgICAgLy8gRC00MjE6IHRoZSBjdXN0b21lciB3b3Jrc3BhY2UgYWNjb3VudCBydW5zIGV2ZXJ5IGN1c3RvbWVyLWRyaXZlbiBhZ2VudC5cbiAgICAgIGFnZW50SG9tZTogV09SS1NQQUNFX0hPU1RfREVGQVVMVF9XT1JLU1BBQ0VfSE9NRSxcbiAgICAgIGFnZW50VXNlcjogREVGQVVMVF9XT1JLU1BBQ0VfSE9TVF9XT1JLU1BBQ0VfVVNFUixcbiAgICAgIGFnZW50R3JvdXA6IERFRkFVTFRfV09SS1NQQUNFX0hPU1RfV09SS1NQQUNFX1VTRVIsXG4gICAgICBsZWdhY3lIb21lczogW3sgaG9tZTogV09SS1NQQUNFX0hPU1RfREVGQVVMVF9BR0VOVF9IT01FIH1dLFxuICAgIH0pO1xuICAvLyBFbnVtZXJhdGVkIGV4cGxpY2l0bHkgcmF0aGVyIHRoYW4gbWFwcGVkIG92ZXIgV09SS1NQQUNFX0hPU1RfQ1JFREVOVElBTF9GQU1JTElFUzogYWRkaW5nIGFcbiAgLy8gZmFtaWx5IHNob3VsZCBiZSBhIGRlY2lzaW9uIHRoYXQgbGFuZHMgaGVyZSBkZWxpYmVyYXRlbHksIG5vdCBvbmUgdGhhdCBzaWxlbnRseSBhY3F1aXJlcyBhXG4gIC8vIGRlZmF1bHQgYmluZGluZyBwb2xpY3kgZnJvbSBhIGxvb3AuXG4gIGNvbnN0IGZhbWlsaWVzOiByZWFkb25seSBXb3Jrc3BhY2VIb3N0Q3JlZGVudGlhbEZhbWlseVtdID0gW1xuICAgIFwiY2xvdWQtd29ya2xvYWQtaWRlbnRpdHlcIixcbiAgICBcImdpdC1zaG9ydC1saXZlZC1kZWxlZ2F0aW9uXCIsXG4gICAgXCJhZ2VudC1mb3J3YXJkZWQtcmVmZXJlbmNlXCIsXG4gICAgXCJhZ2VudC1lbmNyeXB0ZWQtcmVmZXJlbmNlXCIsXG4gIF07XG4gIHJldHVybiBmYW1pbGllcy5tYXAoXG4gICAgKGZhbWlseSkgPT5cbiAgICAgIG5ldyBQcm9kdWN0aW9uV29ya3NwYWNlSG9zdENyZWRlbnRpYWxNYXRlcmlhbGl6ZXIoXG4gICAgICAgIGZhbWlseSxcbiAgICAgICAgc3lzdGVtLFxuICAgICAgICBtYXRlcmlhbFBhdGhGb3IobWF0ZXJpYWxSb290LCBmYW1pbHkpLFxuICAgICAgICBkdXJhYmxlR2l0QmluZGluZ3MsXG4gICAgICAgIGR1cmFibGVBZ2VudEhvbWUsXG4gICAgICAgIC8vIE9ubHkgZmFtaWxpZXMgd2l0aCBhbiBvbi1ob3N0IGFydGlmYWN0IGhhdmUgYW55dGhpbmcgdG8gcmV2b2tlLCBzbyBvbmx5IHRoZXkgY2FycnkgYVxuICAgICAgICAvLyBsZWRnZXIuIFBhc3Npbmcgb25lIGZvciBhbiBhbWJpZW50IGZhbWlseSB3b3VsZCBjcmVhdGUgYSByZXZvY2F0aW9uIHJlY29yZCBmb3IgbWF0ZXJpYWxcbiAgICAgICAgLy8gdGhhdCBuZXZlciBleGlzdGVkLlxuICAgICAgICBXT1JLU1BBQ0VfSE9TVF9DUkVERU5USUFMX0ZBTUlMWV9TUEVDU1tmYW1pbHldLnJlcXVpcmVzRGVsaXZlcmVkTWF0ZXJpYWxcbiAgICAgICAgICA/IGFzeW5jIChnZW5lcmF0aW9uOiBudW1iZXIpID0+XG4gICAgICAgICAgICAgIC8vIFRocm91Z2ggdGhlIFNBTUUgYHN5c3RlbWAgc2VhbSBldmVyeSBvdGhlciBob3N0IG9wZXJhdGlvbiB1c2VzLiBBIHNlY29uZFxuICAgICAgICAgICAgICAvLyBmaWxlc3lzdGVtIGhlcmUg4oCUIGV2ZW4gb25lIGRlZmF1bHRpbmcgdG8gdGhlIHJlYWwgbm9kZSBpbXBsZW1lbnRhdGlvbiDigJQgbWVhbnMgYVxuICAgICAgICAgICAgICAvLyBjYWxsZXIgdGhhdCBmYWtlZCB0aGUgaG9zdCBzdGlsbCB3cml0ZXMgdG8gdGhlIG1hY2hpbmUgcnVubmluZyBpdC5cbiAgICAgICAgICAgICAgYXdhaXQgcmVjb3JkV29ya3NwYWNlSG9zdENyZWRlbnRpYWxSZXZvY2F0aW9uKFxuICAgICAgICAgICAgICAgIHN5c3RlbSxcbiAgICAgICAgICAgICAgICBtYXRlcmlhbFJvb3QsXG4gICAgICAgICAgICAgICAgZmFtaWx5LFxuICAgICAgICAgICAgICAgIGdlbmVyYXRpb24sXG4gICAgICAgICAgICAgICAgeyBsb2NrSGVsZDogdHJ1ZSB9LFxuICAgICAgICAgICAgICApXG4gICAgICAgICAgOiB1bmRlZmluZWQsXG4gICAgICAgIFdPUktTUEFDRV9IT1NUX0NSRURFTlRJQUxfRkFNSUxZX1NQRUNTW2ZhbWlseV0ucmVxdWlyZXNEZWxpdmVyZWRNYXRlcmlhbFxuICAgICAgICAgID8gd29ya3NwYWNlSG9zdENyZWRlbnRpYWxGYW1pbHlMb2NrUGF0aChtYXRlcmlhbFJvb3QsIGZhbWlseSlcbiAgICAgICAgICA6IHVuZGVmaW5lZCxcbiAgICAgICksXG4gICk7XG59XG5cbmV4cG9ydCBpbnRlcmZhY2UgUHJvZHVjdGlvbldvcmtzcGFjZUhvc3RSZW1vdGVJbml0aWFsaXplck9wdGlvbnMgZXh0ZW5kcyBQcm9kdWN0aW9uV29ya3NwYWNlSG9zdE9wdGlvbnMge31cblxuLyoqXG4gKiBUaGUgc2luZ2xlIHdpcmluZyB0aGUgcGFja2FnZWQgZXhlY3V0YWJsZSB1c2VzLlxuICpcbiAqIEtlZXBpbmcgdGhpcyBoZXJlIHJhdGhlciB0aGFuIGluIHRoZSBiaW4gZmlsZSBpcyB3aGF0IG1ha2VzIHRoZSBiaW4gYSB0aHJlZS1saW5lIHByb2dyYW06IHRoZVxuICogZGVwZW5kZW5jeSBncmFwaCBpcyBhc3NlbWJsZWQgYnkgY29kZSBhIHRlc3QgY2FuIGNhbGwsIGFuZCB0aGUgb25seSB1bnRlc3RlZCBsaW5lcyBhcmUgdGhlIG9uZXNcbiAqIHRoYXQgcmVhZCBgcHJvY2Vzcy5hcmd2YCBhbmQgYHByb2Nlc3Muc3RkaW5gLlxuICovXG5leHBvcnQgZnVuY3Rpb24gY3JlYXRlUHJvZHVjdGlvbldvcmtzcGFjZUhvc3RSZW1vdGVJbml0aWFsaXplckRlcHMoXG4gIG9wdGlvbnM6IFByb2R1Y3Rpb25Xb3Jrc3BhY2VIb3N0UmVtb3RlSW5pdGlhbGl6ZXJPcHRpb25zID0ge30sXG4pOiBXb3Jrc3BhY2VIb3N0UmVtb3RlSW5pdGlhbGl6ZXJEZXBzIHtcbiAgY29uc3Qgc3lzdGVtID0gb3B0aW9ucy5zeXN0ZW0gPz8gbmV3IE5vZGVXb3Jrc3BhY2VIb3N0U3lzdGVtKCk7XG4gIGNvbnN0IG1hdGVyaWFsUm9vdCA9XG4gICAgb3B0aW9ucy5jcmVkZW50aWFsTWF0ZXJpYWxSb290ID8/IFdPUktTUEFDRV9IT1NUX0NSRURFTlRJQUxfTUFURVJJQUxfUk9PVDtcbiAgY29uc3Qgd29ya3NwYWNlVXNlciA9XG4gICAgb3B0aW9ucy53b3Jrc3BhY2VVc2VyID8/IERFRkFVTFRfV09SS1NQQUNFX0hPU1RfV09SS1NQQUNFX1VTRVI7XG4gIGNvbnN0IHdvcmtzcGFjZUdyb3VwID0gb3B0aW9ucy53b3Jrc3BhY2VHcm91cCA/PyB3b3Jrc3BhY2VVc2VyO1xuICBjb25zdCB3b3Jrc3BhY2VIb21lID0gb3B0aW9ucy53b3Jrc3BhY2VIb21lID8/IGAvaG9tZS8ke3dvcmtzcGFjZVVzZXJ9YDtcbiAgY29uc3QgYWdlbnRVc2VyID0gb3B0aW9ucy5hZ2VudFVzZXIgPz8gREVGQVVMVF9XT1JLU1BBQ0VfSE9TVF9BR0VOVF9VU0VSO1xuICBjb25zdCBhZ2VudEdyb3VwID0gb3B0aW9ucy5hZ2VudEdyb3VwID8/IGFnZW50VXNlcjtcbiAgY29uc3QgYWdlbnRIb21lID0gb3B0aW9ucy5hZ2VudEhvbWUgPz8gYC9ob21lLyR7YWdlbnRVc2VyfWA7XG4gIGNvbnN0IGdpdENyZWRlbnRpYWxCaW5kaW5ncyA9XG4gICAgb3B0aW9ucy5naXRDcmVkZW50aWFsQmluZGluZ3MgPz9cbiAgICBuZXcgV29ya3NwYWNlSG9zdEdpdENyZWRlbnRpYWxCaW5kaW5nUmVnaXN0cnkoc3lzdGVtLCBtYXRlcmlhbFJvb3QpO1xuICAvLyBUaGUgZGVsaXZlcmVkIENsYXVkZS9Db2RleC9PTVAgbWF0ZXJpYWwgbGFuZHMgaW4gdGhlIENVU1RPTUVSIHdvcmtzcGFjZSBhY2NvdW50J3MgMDcwMCBob21lXG4gIC8vIChELTQyMSk6IHRoYXQgYWNjb3VudCBydW5zIGV2ZXJ5IGN1c3RvbWVyLWRyaXZlbiBhZ2VudCwgYW5kIHRoZSBwcm9iZSBydW5zIGFzIGl0LCBzbyBhIHBhc3NcbiAgLy8gcHJvdmVzIHRoZSBwcm9kdWN0IHBhdGguIFRoZSBwbGF0Zm9ybSBhZ2VudCBpZGVudGl0eSdzIGhvbWUgaXMgd2hlcmUgRC0yNDggcHV0IHRoZSBtYXRlcmlhbDtcbiAgLy8gaXQgaXMgYSBsZWdhY3kgbG9jYXRpb24gbm93LCBtaWdyYXRlZCBhd2F5IGZyb20gb24gdGhlIG5leHQgYmluZCBhbmQgc3dlcHQgb24gZXZlcnkgcmV2b2tlLlxuICAvL1xuICAvLyBUaGUgaG9zdCBpcyBidWlsdCBGSVJTVDogaXRzIGNvbnN0cnVjdG9yIG93bnMgdGhlIGlkZW50aXR5LWNvbGxhcHNlIHJlZnVzYWwgKGFnZW50VXNlciA9PT1cbiAgLy8gd29ya3NwYWNlVXNlciksIHdoaWNoIG11c3Qgd2luIG92ZXIgdGhlIGNvbnN1bWVyJ3Mgd2Vha2VyIFwibGVnYWN5IGhvbWUgZXF1YWxzIGluc3RhbGwgaG9tZVwiLlxuICBjb25zdCBob3N0ID0gbmV3IFByb2R1Y3Rpb25Xb3Jrc3BhY2VIb3N0UmVtb3RlSW5pdGlhbGl6ZXJIb3N0KHtcbiAgICAuLi5vcHRpb25zLFxuICAgIHN5c3RlbSxcbiAgICBjcmVkZW50aWFsTWF0ZXJpYWxSb290OiBtYXRlcmlhbFJvb3QsXG4gICAgd29ya3NwYWNlSG9tZSxcbiAgICB3b3Jrc3BhY2VVc2VyLFxuICAgIHdvcmtzcGFjZUdyb3VwLFxuICAgIGFnZW50SG9tZSxcbiAgICBhZ2VudFVzZXIsXG4gICAgYWdlbnRHcm91cCxcbiAgICBnaXRDcmVkZW50aWFsQmluZGluZ3MsXG4gIH0pO1xuICBjb25zdCBhZ2VudEhvbWVDb25zdW1lciA9IG5ldyBXb3Jrc3BhY2VIb3N0QWdlbnRIb21lQ29uc3VtZXIoe1xuICAgIGZpbGVzeXN0ZW06IHN5c3RlbSxcbiAgICBtYXRlcmlhbFJvb3QsXG4gICAgYWdlbnRIb21lOiB3b3Jrc3BhY2VIb21lLFxuICAgIGFnZW50VXNlcjogd29ya3NwYWNlVXNlcixcbiAgICBhZ2VudEdyb3VwOiB3b3Jrc3BhY2VHcm91cCxcbiAgICBsZWdhY3lIb21lczogW3sgaG9tZTogYWdlbnRIb21lIH1dLFxuICB9KTtcbiAgcmV0dXJuIHtcbiAgICBob3N0LFxuICAgIGNyZWRlbnRpYWxzOiBuZXcgV29ya3NwYWNlSG9zdENyZWRlbnRpYWxSZXNvbHZlcihcbiAgICAgIGNyZWF0ZVByb2R1Y3Rpb25Xb3Jrc3BhY2VIb3N0Q3JlZGVudGlhbE1hdGVyaWFsaXplcnMoXG4gICAgICAgIHN5c3RlbSxcbiAgICAgICAgbWF0ZXJpYWxSb290LFxuICAgICAgICBnaXRDcmVkZW50aWFsQmluZGluZ3MsXG4gICAgICAgIGFnZW50SG9tZUNvbnN1bWVyLFxuICAgICAgKSxcbiAgICApLFxuICAgIC4uLihvcHRpb25zLm5vdyA/IHsgbm93OiBvcHRpb25zLm5vdyB9IDoge30pLFxuICB9O1xufVxuIl0sImZpbGUiOiIvQGZzL2hvbWUvbWFyc2gtb2ZmaWNlL3BhcGVyY3VwYWktd29ya3NwYWNlL3BhcGVyY3VzcC9saWJzL2dlbmVyaWMvZGVwbG95bWVudC1kcml2ZXIvc3JjL3dvcmtzcGFjZS1ob3N0LXJlbW90ZS1pbml0aWFsaXplci1ob3N0LnRzIn0=

//# vitestCache=W3siZmlsZSI6IjEiLCJpZCI6IjEiLCJ1cmwiOiIyIiwiaW1wb3J0ZWRVcmxzIjoiMyIsIm1hcHBpbmdzIjpmYWxzZX0sIi9ob21lL21hcnNoLW9mZmljZS9wYXBlcmN1cGFpLXdvcmtzcGFjZS9wYXBlcmN1c3AvbGlicy9nZW5lcmljL2RlcGxveW1lbnQtZHJpdmVyL3NyYy93b3Jrc3BhY2UtaG9zdC1yZW1vdGUtaW5pdGlhbGl6ZXItaG9zdC50cyIsIi9AZnMvaG9tZS9tYXJzaC1vZmZpY2UvcGFwZXJjdXBhaS13b3Jrc3BhY2UvcGFwZXJjdXNwL2xpYnMvZ2VuZXJpYy9kZXBsb3ltZW50LWRyaXZlci9zcmMvd29ya3NwYWNlLWhvc3QtcmVtb3RlLWluaXRpYWxpemVyLWhvc3QudHMiLFtdXQ==