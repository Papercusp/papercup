import { isAbsolute, join, normalize } from "node:path";
import { withWorkspaceHostCredentialFilesystemLock } from "./workspace-host-credential-delivery";
import { WORKSPACE_HOST_OMP_LOCAL_MODEL } from "./workspace-host-agent-authentication";

/** The sealed material format installed into one workspace user's native agent homes. */
export const WORKSPACE_HOST_AGENT_HOME_BUNDLE_VERSION =
  "papercusp-workspace-host-agent-home-bundle-v2";

/** Read compatibility for material sealed before local-inference OMP was supported (D-230). */
export const WORKSPACE_HOST_AGENT_HOME_LEGACY_BUNDLE_VERSION =
  "papercusp-workspace-host-agent-home-bundle-v1";

export const WORKSPACE_HOST_AGENT_HOME_FILES = {
  claude: [".claude", ".credentials.json"],
  codex: [".codex", "auth.json"],
  omp: [".omp", "agent", "auth.json"],
} as const;

/**
 * OMP's user-level model registry is separate from its credential file.  Keep the relative path
 * here, next to the native-home layout, so the bind and probe cannot silently disagree about
 * where a local provider is written.  This file contains no credentials; it only points OMP at
 * the host's loopback Ollama API and enables its model discovery protocol.
 */
export const WORKSPACE_HOST_AGENT_HOME_OMP_MODELS_RELATIVE_PATH =
  ".omp/agent/models.yml";

/** The direct, loopback-only Ollama endpoint installed by the host bootstrap. */
export const WORKSPACE_HOST_AGENT_HOME_OLLAMA_BASE_URL =
  "http://127.0.0.1:11434/v1";

/**
 * OMP models.yml for a credential-free agent bundle.  Do not add an API key here: `auth: none`
 * keeps the OMP credential contract honest.  Keep both discovery and the one pinned local model:
 * discovery refreshes a host whose model set changes, while the explicit entry makes a cold agent
 * home usable before OMP has created its model catalog (the readiness probe is the first OMP call
 * on a freshly provisioned host and cannot assume `omp models` ran first).
 */
export const WORKSPACE_HOST_AGENT_HOME_OMP_LOCAL_MODELS_YML = [
  "providers:",
  "  ollama:",
  `    baseUrl: ${WORKSPACE_HOST_AGENT_HOME_OLLAMA_BASE_URL}`,
  "    api: openai-completions",
  "    auth: none",
  "    discovery:",
  "      type: ollama",
  "    models:",
  `      - id: ${WORKSPACE_HOST_OMP_LOCAL_MODEL}`,
  `        name: ${WORKSPACE_HOST_OMP_LOCAL_MODEL}`,
  "        api: openai-completions",
  "        input:",
  "          - text",
  "",
].join("\n");

export const WORKSPACE_HOST_AGENT_HOME_STATE_VERSION =
  "papercusp-workspace-host-agent-home-state-v1";

export const WORKSPACE_HOST_AGENT_HOME_FAMILIES = [
  "agent-forwarded-reference",
  "agent-encrypted-reference",
] as const;
export type WorkspaceHostAgentHomeFamily =
  (typeof WORKSPACE_HOST_AGENT_HOME_FAMILIES)[number];

export type WorkspaceHostAgentHomeFile =
  keyof typeof WORKSPACE_HOST_AGENT_HOME_FILES;

export interface WorkspaceHostAgentHomeBundleFiles {
  readonly claude: Buffer;
  readonly codex: Buffer;
  /**
   * `null` means OMP is intentionally credential-free and must prove readiness by local inference.
   * It is not encoded as `{}` because creating a plausible-looking auth file would turn absence of
   * credentials into fabricated authentication state.
   */
  readonly omp: Buffer | null;
}

export interface WorkspaceHostAgentHomeBundle {
  readonly contractVersion:
    | typeof WORKSPACE_HOST_AGENT_HOME_BUNDLE_VERSION
    | typeof WORKSPACE_HOST_AGENT_HOME_LEGACY_BUNDLE_VERSION;
  readonly files: WorkspaceHostAgentHomeBundleFiles;
}

/** Public, secret-free record of which delivered generation currently backs the native homes. */
export interface WorkspaceHostAgentHomeState {
  readonly contractVersion: typeof WORKSPACE_HOST_AGENT_HOME_STATE_VERSION;
  readonly family: WorkspaceHostAgentHomeFamily;
  readonly generation: number;
  readonly home: string;
  readonly files: Readonly<Record<WorkspaceHostAgentHomeFile, string>>;
}

/** Minimal host filesystem seam shared by the agent-home consumer and production host adapter. */
export interface WorkspaceHostAgentHomeFilesystem {
  ensureDirectory(path: string): Promise<void>;
  writePrivateFile(path: string, bytes: Buffer): Promise<void>;
  readFileIfPresent(path: string): Promise<Buffer | null>;
  removePath(path: string): Promise<void>;
  pathExists(path: string): Promise<boolean>;
  /** Optional because hermetic doubles need not model uid/gid; production provides it. */
  setOwnership?(path: string, owner: string, group: string): Promise<void>;
  /** Return the lstat kind without following symlinks; production uses this to reject redirection. */
  pathKind?(
    path: string,
  ): Promise<"missing" | "directory" | "file" | "symlink" | "other">;
  /** Optional cross-process critical section shared with credential delivery. */
  withExclusiveLock?<T>(path: string, task: () => Promise<T>): Promise<T>;
}

export class WorkspaceHostAgentHomeStateError extends Error {
  readonly family?: WorkspaceHostAgentHomeFamily;
  readonly generation?: number;

  constructor(
    message: string,
    details: {
      family?: WorkspaceHostAgentHomeFamily;
      generation?: number;
    } = {},
  ) {
    super(message);
    this.name = "WorkspaceHostAgentHomeStateError";
    this.family = details.family;
    this.generation = details.generation;
  }
}

export class WorkspaceHostAgentHomeBundleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkspaceHostAgentHomeBundleError";
  }
}

function record(
  value: unknown,
  label: string,
): Readonly<Record<string, unknown>> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new WorkspaceHostAgentHomeBundleError(`${label} must be an object`);
  }
  return value as Readonly<Record<string, unknown>>;
}

function exactKeys(
  value: Readonly<Record<string, unknown>>,
  expected: readonly string[],
  label: string,
): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (
    actual.length !== wanted.length ||
    actual.some((key, index) => key !== wanted[index])
  ) {
    throw new WorkspaceHostAgentHomeBundleError(
      `${label} must contain exactly ${wanted.join(", ")}`,
    );
  }
}

function decodeJsonFile(
  value: unknown,
  label: WorkspaceHostAgentHomeFile,
): Buffer {
  if (typeof value !== "string" || value.length === 0) {
    throw new WorkspaceHostAgentHomeBundleError(
      `files.${label} must be canonical base64`,
    );
  }
  const bytes = Buffer.from(value, "base64");
  if (bytes.length === 0 || bytes.toString("base64") !== value) {
    throw new WorkspaceHostAgentHomeBundleError(
      `files.${label} must be canonical base64`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new WorkspaceHostAgentHomeBundleError(
      `files.${label} must decode to valid JSON`,
    );
  }
  record(parsed, `files.${label} JSON`);
  return bytes;
}

/** Parse without ever echoing a decoded byte into an error or receipt. */
export function parseWorkspaceHostAgentHomeBundle(
  material: Buffer,
): WorkspaceHostAgentHomeBundle {
  let parsed: unknown;
  try {
    parsed = JSON.parse(material.toString("utf8"));
  } catch {
    throw new WorkspaceHostAgentHomeBundleError(
      "agent-home material must be valid JSON",
    );
  }
  const body = record(parsed, "agent-home material");
  exactKeys(body, ["contractVersion", "files"], "agent-home material");
  if (
    body.contractVersion !== WORKSPACE_HOST_AGENT_HOME_BUNDLE_VERSION &&
    body.contractVersion !== WORKSPACE_HOST_AGENT_HOME_LEGACY_BUNDLE_VERSION
  ) {
    throw new WorkspaceHostAgentHomeBundleError(
      `agent-home material must use ${WORKSPACE_HOST_AGENT_HOME_BUNDLE_VERSION} or ${WORKSPACE_HOST_AGENT_HOME_LEGACY_BUNDLE_VERSION}`,
    );
  }
  const files = record(body.files, "agent-home material.files");
  exactKeys(
    files,
    Object.keys(WORKSPACE_HOST_AGENT_HOME_FILES),
    "agent-home material.files",
  );
  return {
    contractVersion: body.contractVersion,
    files: {
      claude: decodeJsonFile(files.claude, "claude"),
      codex: decodeJsonFile(files.codex, "codex"),
      omp:
        body.contractVersion === WORKSPACE_HOST_AGENT_HOME_BUNDLE_VERSION &&
        files.omp === null
          ? null
          : decodeJsonFile(files.omp, "omp"),
    },
  };
}

/** Explicit secret-bearing encoder used by setup code and hermetic tests. */
export function encodeWorkspaceHostAgentHomeBundle(
  files: WorkspaceHostAgentHomeBundleFiles,
): Buffer {
  for (const label of ["claude", "codex"] as const) {
    const bytes = files[label];
    decodeJsonFile(bytes.toString("base64"), label);
  }
  if (files.omp !== null) {
    decodeJsonFile(files.omp.toString("base64"), "omp");
  }
  return Buffer.from(
    JSON.stringify({
      contractVersion: WORKSPACE_HOST_AGENT_HOME_BUNDLE_VERSION,
      files: {
        claude: files.claude.toString("base64"),
        codex: files.codex.toString("base64"),
        omp: files.omp?.toString("base64") ?? null,
      },
    }),
    "utf8",
  );
}

export function workspaceHostAgentHomePaths(
  home: string,
): Readonly<Record<WorkspaceHostAgentHomeFile, string>> {
  requireExplicitWorkspaceHostHome(home);
  return {
    claude: join(home, ...WORKSPACE_HOST_AGENT_HOME_FILES.claude),
    codex: join(home, ...WORKSPACE_HOST_AGENT_HOME_FILES.codex),
    omp: join(home, ...WORKSPACE_HOST_AGENT_HOME_FILES.omp),
  };
}

/** Resolve OMP's model registry below the explicit agent identity home. */
export function workspaceHostAgentHomeOmpModelsPath(home: string): string {
  requireExplicitWorkspaceHostHome(home);
  return join(
    home,
    ...WORKSPACE_HOST_AGENT_HOME_OMP_MODELS_RELATIVE_PATH.split("/"),
  );
}

/**
 * Refuse an inferred, relative, or non-canonical home before a root-owned consumer writes into it.
 * The caller supplies the target home explicitly; it is never recovered from the ambient HOME —
 * which matters more since D-248, because the root consumer now writes into the AGENT identity's
 * home and the process running it is root, whose own HOME is `/root`.
 */
export function requireExplicitWorkspaceHostHome(home: string): string {
  if (
    typeof home !== "string" ||
    !isAbsolute(home) ||
    home === "/" ||
    normalize(home) !== home ||
    /[\r\n\0]/.test(home)
  ) {
    throw new WorkspaceHostAgentHomeBundleError(
      "workspace user home must be an absolute, canonical, non-root path",
    );
  }
  return home;
}

/** Directories the consumer creates/checks in parent-first order. */
export function workspaceHostAgentHomeDirectories(
  home: string,
): readonly string[] {
  requireExplicitWorkspaceHostHome(home);
  return [
    home,
    join(home, ".claude"),
    join(home, ".codex"),
    join(home, ".omp"),
    join(home, ".omp", "agent"),
  ];
}

/** Root-private active record; the native files themselves remain below the explicit user home. */
export function workspaceHostAgentHomeStatePath(materialRoot: string): string {
  return join(materialRoot, "active", "agent-home.json");
}

/** One lock for the shared three-file native home, regardless of which agent family supplied it. */
export function workspaceHostAgentHomeLockPath(materialRoot: string): string {
  return join(materialRoot, "active", ".agent-home.lifecycle.lock");
}

export function encodeWorkspaceHostAgentHomeState(
  family: WorkspaceHostAgentHomeFamily,
  generation: number,
  home: string,
): Buffer {
  if (!WORKSPACE_HOST_AGENT_HOME_FAMILIES.includes(family)) {
    throw new WorkspaceHostAgentHomeBundleError(
      `unsupported agent-home family '${family}'`,
    );
  }
  if (!Number.isSafeInteger(generation) || generation < 1) {
    throw new WorkspaceHostAgentHomeBundleError(
      "agent-home generation must be a positive safe integer",
    );
  }
  const files = workspaceHostAgentHomePaths(home);
  return Buffer.from(
    JSON.stringify({
      contractVersion: WORKSPACE_HOST_AGENT_HOME_STATE_VERSION,
      family,
      generation,
      home,
      files,
    }),
    "utf8",
  );
}

/** Parse fail-closed: a tampered state file must never redirect root-owned cleanup outside HOME. */
export function parseWorkspaceHostAgentHomeState(
  material: Buffer,
): WorkspaceHostAgentHomeState {
  let parsed: unknown;
  try {
    parsed = JSON.parse(material.toString("utf8"));
  } catch {
    throw new WorkspaceHostAgentHomeBundleError(
      "agent-home state must be valid JSON",
    );
  }
  const body = record(parsed, "agent-home state");
  exactKeys(
    body,
    ["contractVersion", "family", "generation", "home", "files"],
    "agent-home state",
  );
  if (body.contractVersion !== WORKSPACE_HOST_AGENT_HOME_STATE_VERSION) {
    throw new WorkspaceHostAgentHomeBundleError(
      `agent-home state must use ${WORKSPACE_HOST_AGENT_HOME_STATE_VERSION}`,
    );
  }
  if (
    typeof body.family !== "string" ||
    !WORKSPACE_HOST_AGENT_HOME_FAMILIES.includes(
      body.family as WorkspaceHostAgentHomeFamily,
    )
  ) {
    throw new WorkspaceHostAgentHomeBundleError(
      "agent-home state has an unsupported family",
    );
  }
  if (
    !Number.isSafeInteger(body.generation) ||
    (body.generation as number) < 1
  ) {
    throw new WorkspaceHostAgentHomeBundleError(
      "agent-home state generation must be a positive safe integer",
    );
  }
  if (typeof body.home !== "string") {
    throw new WorkspaceHostAgentHomeBundleError(
      "agent-home state.home must be a string",
    );
  }
  const home = requireExplicitWorkspaceHostHome(body.home);
  const files = record(body.files, "agent-home state.files");
  exactKeys(
    files,
    Object.keys(WORKSPACE_HOST_AGENT_HOME_FILES),
    "agent-home state.files",
  );
  const expected = workspaceHostAgentHomePaths(home);
  for (const label of Object.keys(expected) as WorkspaceHostAgentHomeFile[]) {
    if (files[label] !== expected[label]) {
      throw new WorkspaceHostAgentHomeBundleError(
        `agent-home state.files.${label} does not resolve inside the recorded home`,
      );
    }
  }
  return {
    contractVersion: WORKSPACE_HOST_AGENT_HOME_STATE_VERSION,
    family: body.family as WorkspaceHostAgentHomeFamily,
    generation: body.generation as number,
    home,
    files: expected,
  };
}

export interface WorkspaceHostAgentHomeConsumerOptions {
  readonly filesystem: WorkspaceHostAgentHomeFilesystem;
  readonly materialRoot: string;
  /**
   * Home of the identity that RUNS the agents — `papercusp-agent`, not the SSH login (D-248).
   *
   * These three were named `workspaceHome`/`workspaceUser`/`workspaceGroup` while the SSH
   * account was the agent-running identity. That naming is what made the conflation invisible:
   * the delivered Claude/Codex material landed in the customer's own login home, owned 0600 by
   * the customer, and nothing in the type read as wrong. Named for what they are, a future
   * caller passing the SSH account here has to type the mismatch out.
   */
  readonly agentHome: string;
  readonly agentUser?: string;
  readonly agentGroup?: string;
}

export interface WorkspaceHostAgentHomeConsumerEvidence {
  readonly family: WorkspaceHostAgentHomeFamily;
  readonly generation: number;
  readonly present: boolean;
  readonly home: string;
}

function compareBytes(left: Buffer, right: Buffer): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

/**
 * Installs and verifies the managed native agent credential files from delivered material.
 *
 * A v2 bundle may explicitly name OMP as credential-free (`files.omp: null`). In that case the
 * consumer positively removes and verifies absence of `.omp/agent/auth.json`; the separate D-230
 * readiness probe must prove real local inference. Claude and Codex remain mandatory material.
 *
 * The active record is committed LAST. A fresh initializer process therefore sees either the
 * previous complete generation or the new complete generation, never a process-local half-state.
 * Generation checks make an old revoke harmless after a newer rotation has won the race.
 */
export class WorkspaceHostAgentHomeConsumer {
  private readonly filesystem: WorkspaceHostAgentHomeFilesystem;
  private readonly materialRoot: string;
  private readonly agentHome: string;
  private readonly agentUser?: string;
  private readonly agentGroup?: string;

  constructor(options: WorkspaceHostAgentHomeConsumerOptions) {
    this.filesystem = options.filesystem;
    this.materialRoot = options.materialRoot;
    this.agentHome = requireExplicitWorkspaceHostHome(options.agentHome);
    if (
      (options.agentUser && !options.agentGroup) ||
      (!options.agentUser && options.agentGroup)
    ) {
      throw new WorkspaceHostAgentHomeBundleError(
        "agentUser and agentGroup must be supplied together",
      );
    }
    this.agentUser = options.agentUser;
    this.agentGroup = options.agentGroup;
  }

  private async readState(): Promise<WorkspaceHostAgentHomeState | null> {
    const raw = await this.filesystem.readFileIfPresent(
      workspaceHostAgentHomeStatePath(this.materialRoot),
    );
    if (raw === null) return null;
    const state = parseWorkspaceHostAgentHomeState(raw);
    if (state.home !== this.agentHome) {
      throw new WorkspaceHostAgentHomeStateError(
        "active agent-home state names a different agent home",
        { family: state.family, generation: state.generation },
      );
    }
    return state;
  }

  private async own(path: string): Promise<void> {
    if (this.agentUser && this.agentGroup && this.filesystem.setOwnership) {
      await this.filesystem.setOwnership(path, this.agentUser, this.agentGroup);
    }
  }

  private async requireRealDirectory(directory: string): Promise<void> {
    if (!this.filesystem.pathKind) return;
    const kind = await this.filesystem.pathKind(directory);
    if (kind !== "directory") {
      throw new WorkspaceHostAgentHomeStateError(
        `workspace agent-home directory '${directory}' is not a real directory`,
      );
    }
  }

  /**
   * Temporarily make the home and credential directories root-owned while the root consumer
   * writes. This closes the check/write symlink race: the workspace user cannot swap a validated
   * parent out from under the subsequent atomic rename. Final ownership is restored in reverse
   * order with the home last, so the steady state remains a normal user-owned 0700 native home.
   */
  private async secureHomeLayout(): Promise<readonly string[]> {
    const directories = workspaceHostAgentHomeDirectories(this.agentHome);
    const secured: string[] = [];
    try {
      for (const directory of directories) {
        await this.filesystem.ensureDirectory(directory);
        await this.requireRealDirectory(directory);
        if (this.agentUser && this.agentGroup && this.filesystem.setOwnership) {
          await this.filesystem.setOwnership(directory, "root", "root");
        }
        secured.push(directory);
      }
      return secured;
    } catch (error) {
      await this.restoreHomeLayout(secured).catch(() => undefined);
      throw error;
    }
  }

  private async restoreHomeLayout(
    directories: readonly string[],
    files: readonly string[] = [],
  ): Promise<void> {
    // Restore children first and the home last. Until the final chown the workspace user cannot
    // rename a validated child into a symlink through its parent.
    for (const path of files) await this.own(path);
    for (const directory of [...directories].reverse())
      await this.own(directory);
  }

  /**
   * Reconcile the non-secret OMP registry required by the credential-free local-inference path.
   *
   * The agent home is a platform-owned identity home, so this managed registry is deliberately
   * deterministic rather than merged with an ambient service-user config.  A stale gateway or
   * malformed registry would otherwise make the readiness probe select the wrong endpoint while
   * still looking like a valid OMP installation.  The write is idempotent and is performed while
   * secureHomeLayout() has pinned every parent directory root-owned.
   */
  private async ensureLocalOmpModelsConfig(
    family: WorkspaceHostAgentHomeFamily,
    generation: number,
  ): Promise<string> {
    const path = workspaceHostAgentHomeOmpModelsPath(this.agentHome);
    const expected = Buffer.from(
      WORKSPACE_HOST_AGENT_HOME_OMP_LOCAL_MODELS_YML,
      "utf8",
    );
    let kind: "missing" | "directory" | "file" | "symlink" | "other" =
      "missing";
    if (this.filesystem.pathKind) {
      kind = await this.filesystem.pathKind(path);
      if (kind !== "missing" && kind !== "file") {
        throw new WorkspaceHostAgentHomeStateError(
          "workspace agent-home OMP models registry is not a regular file",
          { family, generation },
        );
      }
    }
    // When pathKind is unavailable (the hermetic seam), readFileIfPresent is the only presence
    // signal; do not treat its default `missing` sentinel as proof that a file is absent or the
    // idempotent path would rewrite the registry on every bind.
    const existing =
      kind === "missing" && this.filesystem.pathKind
        ? null
        : await this.filesystem.readFileIfPresent(path);
    if (existing === null || !compareBytes(existing, expected)) {
      await this.filesystem.writePrivateFile(path, expected);
    }
    if (this.filesystem.pathKind) {
      const finalKind = await this.filesystem.pathKind(path);
      if (finalKind !== "file") {
        throw new WorkspaceHostAgentHomeStateError(
          "workspace agent-home OMP models registry is not a regular file after write",
          { family, generation },
        );
      }
    }
    return path;
  }

  private async verifyLocalOmpModelsConfig(
    family: WorkspaceHostAgentHomeFamily,
    generation: number,
  ): Promise<void> {
    const path = workspaceHostAgentHomeOmpModelsPath(this.agentHome);
    if (this.filesystem.pathKind) {
      const kind = await this.filesystem.pathKind(path);
      if (kind !== "file") {
        throw new WorkspaceHostAgentHomeStateError(
          "workspace agent-home OMP models registry is absent or not a regular file",
          { family, generation },
        );
      }
    }
    const existing = await this.filesystem.readFileIfPresent(path);
    if (
      existing === null ||
      !compareBytes(
        existing,
        Buffer.from(WORKSPACE_HOST_AGENT_HOME_OMP_LOCAL_MODELS_YML, "utf8"),
      )
    ) {
      throw new WorkspaceHostAgentHomeStateError(
        "workspace agent-home OMP models registry is absent or stale",
        { family, generation },
      );
    }
  }

  private lockPath(family: WorkspaceHostAgentHomeFamily): string {
    // Both agent families install the same native files and active marker. They must therefore
    // serialize against one another even though their delivered-material directories differ.
    return workspaceHostAgentHomeLockPath(this.materialRoot);
  }

  private async withLock<T>(
    family: WorkspaceHostAgentHomeFamily,
    task: () => Promise<T>,
    lockHeld = false,
  ): Promise<T> {
    if (lockHeld) return await task();
    return await withWorkspaceHostCredentialFilesystemLock(
      this.filesystem,
      this.lockPath(family),
      task,
    );
  }

  private async installUnlocked(
    family: WorkspaceHostAgentHomeFamily,
    generation: number,
    material: Buffer,
  ): Promise<WorkspaceHostAgentHomeConsumerEvidence> {
    if (!WORKSPACE_HOST_AGENT_HOME_FAMILIES.includes(family)) {
      throw new WorkspaceHostAgentHomeStateError(
        `unsupported agent-home family '${family}'`,
      );
    }
    if (!Number.isSafeInteger(generation) || generation < 1) {
      throw new WorkspaceHostAgentHomeStateError(
        "agent-home generation must be a positive safe integer",
      );
    }
    const bundle = parseWorkspaceHostAgentHomeBundle(material);
    const current = await this.readState();
    if (current && current.generation > generation) {
      throw new WorkspaceHostAgentHomeStateError(
        `agent-home generation ${generation} is older than active generation ${current.generation}`,
        { family, generation },
      );
    }
    if (
      current &&
      current.generation === generation &&
      (current.family !== family || current.home !== this.agentHome)
    ) {
      throw new WorkspaceHostAgentHomeStateError(
        `agent-home generation ${generation} is already active for another family or home`,
        { family, generation },
      );
    }

    const securedDirectories = await this.secureHomeLayout();
    const installedFiles: string[] = [];
    try {
      const paths = workspaceHostAgentHomePaths(this.agentHome);
      const nativeFiles = await Promise.all(
        (Object.keys(paths) as WorkspaceHostAgentHomeFile[]).map(
          async (label) => ({
            label,
            existing: await this.filesystem.readFileIfPresent(paths[label]),
          }),
        ),
      );
      // A native CLI may have refreshed its credentials since this generation was installed.
      // Rebinding the immutable seed must not discard those bytes. Check every credential
      // before any write, and require a newer generation instead of accepting changed material.
      if (current?.generation === generation) {
        for (const { label, existing } of nativeFiles) {
          const expected = bundle.files[label];
          if (
            existing !== null &&
            expected !== null &&
            !compareBytes(existing, expected)
          ) {
            throw new WorkspaceHostAgentHomeStateError(
              `agent-home credential '${label}' changed after generation ${generation} was installed; ` +
                "a newer verified credential generation is required",
              { family, generation },
            );
          }
        }
      }
      for (const { label, existing } of nativeFiles) {
        const bytes = bundle.files[label];
        if (bytes === null) {
          if (existing !== null) {
            await this.removeNativeFile(paths[label], family, generation);
          }
          if (this.filesystem.pathKind) {
            const kind = await this.filesystem.pathKind(paths[label]);
            if (kind !== "missing") {
              throw new WorkspaceHostAgentHomeStateError(
                `workspace agent-home file '${label}' must be absent for credential-free verification`,
                { family, generation },
              );
            }
          }
          continue;
        }
        if (existing === null || !compareBytes(existing, bytes)) {
          await this.filesystem.writePrivateFile(paths[label], bytes);
        }
        // Check the final path without following a user-created symlink before changing ownership.
        if (this.filesystem.pathKind) {
          const kind = await this.filesystem.pathKind(paths[label]);
          if (kind !== "file") {
            throw new WorkspaceHostAgentHomeStateError(
              `workspace agent-home file '${label}' is not a regular file`,
              { family, generation },
            );
          }
        }
        installedFiles.push(paths[label]);
      }
      // A credential-free OMP bundle must still have a model registry.  Without this file OMP
      // falls back to its built-in providers and reports the local model as "not found" even
      // though bootstrap pulled it into the host's loopback Ollama service.
      if (bundle.files.omp === null) {
        installedFiles.push(
          await this.ensureLocalOmpModelsConfig(family, generation),
        );
      }
      // State is the commit marker and is intentionally written after every native file succeeds.
      await this.filesystem.ensureDirectory(join(this.materialRoot, "active"));
      await this.filesystem.writePrivateFile(
        workspaceHostAgentHomeStatePath(this.materialRoot),
        encodeWorkspaceHostAgentHomeState(family, generation, this.agentHome),
      );
    } finally {
      await this.restoreHomeLayout(securedDirectories, installedFiles);
    }
    return { family, generation, present: true, home: this.agentHome };
  }

  private async removeNativeFile(
    path: string,
    family: WorkspaceHostAgentHomeFamily,
    generation: number,
  ): Promise<void> {
    if (this.filesystem.pathKind) {
      const kind = await this.filesystem.pathKind(path);
      if (kind !== "missing" && kind !== "file") {
        throw new WorkspaceHostAgentHomeStateError(
          "refusing to remove a non-regular agent-home path",
          { family, generation },
        );
      }
    }
    await this.filesystem.removePath(path);
  }

  async install(
    family: WorkspaceHostAgentHomeFamily,
    generation: number,
    material: Buffer,
    options: { readonly lockHeld?: boolean } = {},
  ): Promise<WorkspaceHostAgentHomeConsumerEvidence> {
    return await this.withLock(
      family,
      () => this.installUnlocked(family, generation, material),
      options.lockHeld === true,
    );
  }

  async verify(
    family: WorkspaceHostAgentHomeFamily,
    generation: number,
    material: Buffer,
    options: { readonly lockHeld?: boolean } = {},
  ): Promise<WorkspaceHostAgentHomeConsumerEvidence> {
    return await this.withLock(
      family,
      async () => {
        const bundle = parseWorkspaceHostAgentHomeBundle(material);
        const current = await this.readState();
        if (
          !current ||
          current.family !== family ||
          current.generation !== generation ||
          current.home !== this.agentHome
        ) {
          throw new WorkspaceHostAgentHomeStateError(
            `agent-home generation ${generation} is not the active installed generation`,
            { family, generation },
          );
        }
        const securedDirectories = await this.secureHomeLayout();
        try {
          const paths = workspaceHostAgentHomePaths(this.agentHome);
          for (const label of Object.keys(
            paths,
          ) as WorkspaceHostAgentHomeFile[]) {
            const expectedBytes = bundle.files[label];
            if (this.filesystem.pathKind) {
              const kind = await this.filesystem.pathKind(paths[label]);
              if (
                expectedBytes === null ? kind !== "missing" : kind !== "file"
              ) {
                throw new WorkspaceHostAgentHomeStateError(
                  `agent-home file '${label}' is absent, stale, or points outside the explicit home`,
                  { family, generation },
                );
              }
            }
            const bytes = await this.filesystem.readFileIfPresent(paths[label]);
            if (expectedBytes === null) {
              if (bytes !== null) {
                throw new WorkspaceHostAgentHomeStateError(
                  `agent-home file '${label}' must be absent for credential-free verification`,
                  { family, generation },
                );
              }
              continue;
            }
            if (
              bytes === null ||
              current.files[label] !== paths[label] ||
              !compareBytes(bytes, expectedBytes)
            ) {
              throw new WorkspaceHostAgentHomeStateError(
                `agent-home file '${label}' is absent, stale, or points outside the explicit home`,
                { family, generation },
              );
            }
          }
          if (bundle.files.omp === null) {
            await this.verifyLocalOmpModelsConfig(family, generation);
          }
        } finally {
          await this.restoreHomeLayout(securedDirectories);
        }
        return { family, generation, present: true, home: this.agentHome };
      },
      options.lockHeld === true,
    );
  }

  async revoke(
    family: WorkspaceHostAgentHomeFamily,
    generation: number,
    options: { readonly lockHeld?: boolean } = {},
  ): Promise<WorkspaceHostAgentHomeConsumerEvidence> {
    return await this.withLock(
      family,
      async () => {
        const current = await this.readState();
        // A malformed/tampered state that names another canonical home is never a reason for a
        // root consumer to remove files there. Fail closed instead of treating it as a stale no-op.
        if (current && current.home !== this.agentHome) {
          throw new WorkspaceHostAgentHomeStateError(
            "active agent-home state names a different agent home",
            { family: current.family, generation: current.generation },
          );
        }
        // A stale revoke is deliberately a no-op: a newer generation owns these same paths now.
        if (
          !current ||
          current.family !== family ||
          current.generation !== generation
        ) {
          return {
            family,
            generation,
            present: false,
            home: this.agentHome,
          };
        }
        const securedDirectories = await this.secureHomeLayout();
        try {
          const paths = workspaceHostAgentHomePaths(this.agentHome);
          for (const path of Object.values(paths)) {
            await this.removeNativeFile(path, family, generation);
          }
          await this.removeNativeFile(
            workspaceHostAgentHomeStatePath(this.materialRoot),
            family,
            generation,
          );
        } finally {
          await this.restoreHomeLayout(securedDirectories);
        }
        return { family, generation, present: false, home: this.agentHome };
      },
      options.lockHeld === true,
    );
  }

  async verifyRevoked(
    family: WorkspaceHostAgentHomeFamily,
    generation: number,
    options: { readonly lockHeld?: boolean } = {},
  ): Promise<WorkspaceHostAgentHomeConsumerEvidence> {
    return await this.withLock(
      family,
      async () => {
        const current = await this.readState();
        if (current?.family === family && current.generation === generation) {
          throw new WorkspaceHostAgentHomeStateError(
            `agent-home generation ${generation} is still active after revocation`,
            { family, generation },
          );
        }
        return { family, generation, present: false, home: this.agentHome };
      },
      options.lockHeld === true,
    );
  }
}
