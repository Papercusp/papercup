import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  WorkspaceHostOperationError,
  WorkspaceHostGitCredentialBindingRegistry,
  WORKSPACE_HOST_DEFAULT_WORKSPACE_ROOT,
  WORKSPACE_HOST_RELEASE_BIN_DIR,
  WORKSPACE_HOST_BOOTSTRAP_ATTESTATION_FILE,
  createProductionWorkspaceHostRemoteInitializerDeps,
  type WorkspaceHostCommandInput,
  type WorkspaceHostSystem,
} from "./workspace-host-remote-initializer-host";
import { WORKSPACE_HOST_DATA_ROOT } from "./workspace-host-bootstrap";
import {
  encodeWorkspaceHostAgentHomeBundle,
  workspaceHostAgentHomePaths,
} from "./workspace-host-agent-home";
import {
  buildWorkspaceHostCredentialReference,
  buildWorkspaceHostCredentialRevocationReference,
} from "./workspace-host-credential-namespace";
import {
  NodeWorkspaceHostCredentialDeliveryFilesystem,
  WORKSPACE_HOST_CREDENTIAL_DELIVERY_PROTOCOL_VERSION,
  WorkspaceHostCredentialGenerationConflictError,
  WorkspaceHostCredentialMaterial,
  executeWorkspaceHostCredentialDelivery,
  parseWorkspaceHostCredentialDeliveryRequest,
  workspaceHostCredentialMaterialPath,
} from "./workspace-host-credential-delivery";
import type {
  WorkspaceHostAgentProbeInvocation,
  WorkspaceHostAgentProbeRunner,
} from "./workspace-host-agent-authentication";

const MATERIAL_ROOT = "/credentials";
const MATERIAL_PATH = workspaceHostCredentialMaterialPath(
  MATERIAL_ROOT,
  "git-short-lived-delegation",
  7,
);
const AUTHORIZATION_MATERIAL =
  "https://git-user:private-token-value@github.com";
const NOW = new Date("2026-08-26T22:00:00.000Z");
const AGENT_FIELDS = { hostId: "host-1", agentSet: "claude-codex-omp" };

class RecordingSystem implements WorkspaceHostSystem {
  readonly commands: WorkspaceHostCommandInput[] = [];
  readonly present = new Set<string>();
  readonly files = new Map<string, Buffer>();

  async run(input: WorkspaceHostCommandInput) {
    this.commands.push(input);
    return { exitCode: 0, stdout: "", stderr: "" };
  }
  async ensureDirectory(path: string) {
    this.present.add(path);
  }
  async pathExists(path: string) {
    return this.present.has(path);
  }
  async removePath(path: string) {
    this.present.delete(path);
    this.files.delete(path);
  }
  // The credential-delivery half of the seam. Faked here for the same reason the rest is: revoke()
  // writes the revocation ledger through it, and a double that omitted these would fall through to
  // the real filesystem and try to write under the production credential root.
  async writePrivateFile(path: string, bytes: Buffer) {
    this.files.set(path, Buffer.from(bytes));
    this.present.add(path);
  }
  async readFileIfPresent(path: string) {
    return this.files.get(path) ?? null;
  }
}

class PausingRecordingSystem extends RecordingSystem {
  private pausePath: string | null = null;
  private didPause = false;
  private markPaused: (() => void) | undefined;
  private releasePause: (() => void) | undefined;
  readonly paused: Promise<void>;

  constructor() {
    super();
    this.paused = new Promise<void>((resolve) => {
      this.markPaused = resolve;
    });
  }

  pauseRemovalAt(path: string): void {
    this.pausePath = path;
  }

  release(): void {
    this.releasePause?.();
  }

  override async removePath(path: string): Promise<void> {
    if (!this.didPause && path === this.pausePath) {
      this.didPause = true;
      this.markPaused?.();
      await new Promise<void>((resolve) => {
        this.releasePause = resolve;
      });
    }
    await super.removePath(path);
  }
}

function place(system: RecordingSystem, path: string, bytes: Buffer): void {
  system.files.set(path, Buffer.from(bytes));
  system.present.add(path);
}

function gitBinding(expiresAt = "2026-08-26T23:00:00.000Z", generation = 7) {
  const fields = {
    forge: "github",
    owner: "papercupai",
    repository: "private-canary",
  };
  return {
    channel: "git" as const,
    credentialRef: {
      kind: "git" as const,
      ref: buildWorkspaceHostCredentialReference(
        "git-short-lived-delegation",
        fields,
      ),
    },
    delivery: {
      kind: "short-lived-delegation" as const,
      generation,
      audience: "workspace-host-canary",
      expiresAt,
      revocationRef: buildWorkspaceHostCredentialRevocationReference(
        "git-short-lived-delegation",
        fields,
        generation,
      ),
    },
    requestedAt: "2026-08-26T21:00:00.000Z",
  };
}

function agentBinding(generation = 7) {
  return {
    channel: "agent" as const,
    credentialRef: {
      kind: "agent" as const,
      ref: buildWorkspaceHostCredentialReference(
        "agent-encrypted-reference",
        AGENT_FIELDS,
      ),
    },
    delivery: {
      kind: "encrypted-reference" as const,
      generation,
      audience: "workspace-host-canary",
      revocationRef: buildWorkspaceHostCredentialRevocationReference(
        "agent-encrypted-reference",
        AGENT_FIELDS,
        generation,
      ),
    },
    requestedAt: "2026-08-26T21:00:00.000Z",
  };
}

function fixture() {
  const system = new RecordingSystem();
  const deps = createProductionWorkspaceHostRemoteInitializerDeps({
    system,
    workspaceRoot: "/workspaces",
    credentialMaterialRoot: MATERIAL_ROOT,
    now: () => NOW,
  });
  return { system, deps };
}

describe("ProductionWorkspaceHostRemoteInitializerHost private Git credentials", () => {
  it.each(
    ["approve", "reject"].flatMap((action) =>
      [false, true].flatMap((scoped) =>
        [false, true].map((newline) => ({ action, scoped, newline, quoted: false })),
      ),
    ).concat([{ action: "approve", scoped: true, newline: false, quoted: true }]),
  )("keeps delivered bytes immutable after real Git $action (scoped=$scoped, newline=$newline, quoted=$quoted)", async ({ action, scoped, newline, quoted }) => {
    const directory = await mkdtemp(join(tmpdir(), "workspace-git-"));
    try {
      // Exercise shell quoting too: the helper's path is data, never shell code.
      const materialRoot = join(directory, quoted ? "credential's $(false) store" : "credentials");
      const materialPath = workspaceHostCredentialMaterialPath(
        materialRoot,
        "git-short-lived-delegation",
        7,
      );
      const repositoryPath = "papercupai/private-canary.git";
      const bytes = Buffer.from(
        AUTHORIZATION_MATERIAL +
          (scoped ? `/${repositoryPath}` : "") +
          (newline ? "\n" : ""),
      );
      const request = parseWorkspaceHostCredentialDeliveryRequest({
        protocolVersion: WORKSPACE_HOST_CREDENTIAL_DELIVERY_PROTOCOL_VERSION,
        channel: "git",
        credentialRef: gitBinding().credentialRef.ref,
        generation: 7,
        material: bytes.toString("base64"),
      });
      const delivery = {
        filesystem: new NodeWorkspaceHostCredentialDeliveryFilesystem(),
        materialRoot,
        now: () => NOW,
      };
      await executeWorkspaceHostCredentialDelivery(request, delivery);

      // Only the clone transport is recorded. Delivery and Git's credential protocol use the
      // real filesystem and executable, without a network or any real authorization material.
      const system = new RecordingSystem();
      place(system, materialPath, bytes);
      system.present.add("/workspaces/repository/.git");
      const deps = createProductionWorkspaceHostRemoteInitializerDeps({
        system,
        workspaceRoot: "/workspaces",
        credentialMaterialRoot: materialRoot,
        now: () => NOW,
      });
      await deps.credentials.run("bind", gitBinding());
      await deps.host.cloneRepository({
        repositoryUrl: `https://github.com/${repositoryPath}`,
        visibility: "private",
        destination: "repository",
        credentialChannel: "git",
      });

      const ambientPath = join(directory, "ambient-material");
      const configPath = join(directory, "gitconfig");
      await writeFile(configPath, `[credential]\n\thelper = store --file=${ambientPath}\n`);
      const env = {
        PATH: process.env.PATH,
        HOME: directory,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: configPath,
        ...system.commands[0]!.env,
      };
      // useHttpPath requires a stored path to match a path-bearing request. A host-only
      // fixture exercises the host-only protocol; it must not authorize arbitrary paths.
      const query = `protocol=https\nhost=github.com\n${scoped ? `path=${repositoryPath}\n` : ""}\n`;
      const filled = spawnSync("git", ["credential", "fill"], {
        input: query,
        encoding: "utf8",
        env,
        cwd: directory,
        timeout: 5_000,
      });
      expect(filled.status, filled.stderr).toBe(0);
      expect(filled.stdout).toContain("username=git-user\n");
      expect(filled.stdout).toContain("password=private-token-value\n");
      const outsideScope = spawnSync("git", ["credential", "fill"], {
        input: "protocol=https\nhost=github.com\npath=other/repository.git\n\n",
        encoding: "utf8",
        env,
        cwd: directory,
        timeout: 5_000,
      });
      expect(outsideScope.status).toBe(128);
      expect(outsideScope.stdout).not.toContain("private-token-value");
      const result = spawnSync("git", ["credential", action], {
        input: filled.stdout + "\n",
        encoding: "utf8",
        env,
        cwd: directory,
        timeout: 5_000,
      });
      expect(result.status, result.stderr).toBe(0);
      expect(await readFile(materialPath)).toEqual(bytes);
      expect((await stat(materialPath)).mode & 0o777).toBe(0o600);
      await expect(stat(ambientPath)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(executeWorkspaceHostCredentialDelivery(request, delivery)).resolves.toMatchObject({
        generation: 7,
        present: true,
      });
      await expect(executeWorkspaceHostCredentialDelivery({
        ...request,
        material: new WorkspaceHostCredentialMaterial(Buffer.from("different material")),
      }, delivery)).rejects.toBeInstanceOf(WorkspaceHostCredentialGenerationConflictError);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("consumes only bound git-channel material outside argv and public evidence", async () => {
    const { system, deps } = fixture();
    place(system, MATERIAL_PATH, Buffer.from(AUTHORIZATION_MATERIAL));
    system.present.add("/workspaces/repository/.git");
    await deps.credentials.run("bind", gitBinding());

    // A fresh dependency graph models the next SSH step/new process. The bind must survive it.
    const fresh = createProductionWorkspaceHostRemoteInitializerDeps({
      system,
      workspaceRoot: "/workspaces",
      credentialMaterialRoot: MATERIAL_ROOT,
      now: () => NOW,
    });
    const evidence = await fresh.host.cloneRepository({
      repositoryUrl: "https://github.com/papercupai/private-canary.git",
      visibility: "private",
      destination: "repository",
      credentialChannel: "git",
    });

    expect(system.commands).toHaveLength(1);
    const command = system.commands[0]!;
    expect(command.args).toEqual([
      "clone",
      "--quiet",
      "https://github.com/papercupai/private-canary.git",
      "/workspaces/repository",
    ]);
    expect(command.env).toMatchObject({
      GIT_TERMINAL_PROMPT: "0",
      GIT_CONFIG_KEY_0: "credential.helper",
      GIT_CONFIG_VALUE_0: "",
      GIT_CONFIG_KEY_1: "credential.helper",
      GIT_CONFIG_VALUE_1: expect.stringContaining(`--file='${MATERIAL_PATH}' get`),
      GIT_CONFIG_KEY_2: "credential.useHttpPath",
      GIT_CONFIG_VALUE_2: "true",
    });
    expect(JSON.stringify(command.args)).not.toContain(AUTHORIZATION_MATERIAL);
    expect(JSON.stringify(evidence)).not.toContain(MATERIAL_PATH);
    expect(JSON.stringify(evidence)).not.toContain(AUTHORIZATION_MATERIAL);
    expect(evidence).toMatchObject({
      visibility: "private",
      credentialChannel: "git",
      cloned: true,
    });
  });

  it("fails closed before spawning git when bound material is absent", async () => {
    const { system, deps } = fixture();
    place(system, MATERIAL_PATH, Buffer.from(AUTHORIZATION_MATERIAL));
    await deps.credentials.run("bind", gitBinding());
    system.present.delete(MATERIAL_PATH);

    await expect(
      deps.host.cloneRepository({
        repositoryUrl: "https://github.com/papercupai/private-canary.git",
        visibility: "private",
        destination: "repository",
        credentialChannel: "git",
      }),
    ).rejects.toThrow("bound git credential material is absent");
    expect(system.commands).toEqual([]);
  });

  it("refuses a private clone routed through any channel other than git", async () => {
    const { system, deps } = fixture();

    await expect(
      deps.host.cloneRepository({
        repositoryUrl: "https://github.com/papercupai/private-canary.git",
        visibility: "private",
        destination: "repository",
        credentialChannel: "cloud",
      }),
    ).rejects.toThrow("must consume the bound 'git' credential channel");
    expect(system.commands).toEqual([]);
  });

  it("fails closed before spawning git when bound material is expired", async () => {
    const { system, deps } = fixture();
    place(system, MATERIAL_PATH, Buffer.from(AUTHORIZATION_MATERIAL));
    await deps.credentials.run("bind", gitBinding("2026-08-26T21:59:59.000Z"));

    await expect(
      deps.host.cloneRepository({
        repositoryUrl: "https://github.com/papercupai/private-canary.git",
        visibility: "private",
        destination: "repository",
        credentialChannel: "git",
      }),
    ).rejects.toThrow("bound git credential material has expired");
    expect(system.commands).toEqual([]);
  });

  it("fails closed before spawning git after the active binding is revoked", async () => {
    const { system, deps } = fixture();
    const binding = gitBinding();
    place(system, MATERIAL_PATH, Buffer.from(AUTHORIZATION_MATERIAL));
    await deps.credentials.run("bind", binding);
    await deps.credentials.run("revoke", binding);

    await expect(
      deps.host.cloneRepository({
        repositoryUrl: "https://github.com/papercupai/private-canary.git",
        visibility: "private",
        destination: "repository",
        credentialChannel: "git",
      }),
    ).rejects.toBeInstanceOf(WorkspaceHostOperationError);
    expect(system.commands).toEqual([]);
  });

  it("keeps a newer Git generation active when an old process revokes its generation", async () => {
    const { system, deps } = fixture();
    place(system, MATERIAL_PATH, Buffer.from(AUTHORIZATION_MATERIAL));
    await deps.credentials.run("bind", gitBinding());

    const generation8Path = workspaceHostCredentialMaterialPath(
      MATERIAL_ROOT,
      "git-short-lived-delegation",
      8,
    );
    place(
      system,
      generation8Path,
      Buffer.from("https://git-user:rotated@github.com"),
    );
    const rotated = createProductionWorkspaceHostRemoteInitializerDeps({
      system,
      workspaceRoot: "/workspaces",
      credentialMaterialRoot: MATERIAL_ROOT,
      now: () => NOW,
    });
    await rotated.credentials.run(
      "bind",
      gitBinding("2026-08-26T23:00:00.000Z", 8),
    );

    // Model a delayed generation-7 process after generation 8 is already active.
    const stale = createProductionWorkspaceHostRemoteInitializerDeps({
      system,
      workspaceRoot: "/workspaces",
      credentialMaterialRoot: MATERIAL_ROOT,
      now: () => NOW,
    });
    await stale.credentials.run("revoke", gitBinding());
    await stale.credentials.run("verify-revoked", gitBinding());

    system.present.add("/workspaces/repository/.git");
    await rotated.host.cloneRepository({
      repositoryUrl: "https://github.com/papercupai/private-canary.git",
      visibility: "private",
      destination: "repository",
      credentialChannel: "git",
    });
    expect(system.commands.at(-1)?.env?.GIT_CONFIG_VALUE_1).toContain(
      `--file='${generation8Path}' get`,
    );
  });

  it("serializes a racing stale Git revoke before a newer cross-process bind", async () => {
    const system = new PausingRecordingSystem();
    const first = createProductionWorkspaceHostRemoteInitializerDeps({
      system,
      workspaceRoot: "/workspaces",
      credentialMaterialRoot: MATERIAL_ROOT,
      now: () => NOW,
    });
    place(system, MATERIAL_PATH, Buffer.from(AUTHORIZATION_MATERIAL));
    await first.credentials.run("bind", gitBinding());
    system.pauseRemovalAt(
      WorkspaceHostGitCredentialBindingRegistry.statePath(MATERIAL_ROOT),
    );

    const staleRevoke = first.credentials.run("revoke", gitBinding());
    await system.paused;
    const generation8Path = workspaceHostCredentialMaterialPath(
      MATERIAL_ROOT,
      "git-short-lived-delegation",
      8,
    );
    place(
      system,
      generation8Path,
      Buffer.from("https://git-user:rotated@github.com"),
    );
    const newer = createProductionWorkspaceHostRemoteInitializerDeps({
      system,
      workspaceRoot: "/workspaces",
      credentialMaterialRoot: MATERIAL_ROOT,
      now: () => NOW,
    });
    let newerFinished = false;
    const newerBind = newer.credentials
      .run("bind", gitBinding("2026-08-26T23:00:00.000Z", 8))
      .then(() => {
        newerFinished = true;
      });
    await Promise.resolve();
    expect(newerFinished).toBe(false);

    system.release();
    await Promise.all([staleRevoke, newerBind]);
    system.present.add("/workspaces/repository/.git");
    await newer.host.cloneRepository({
      repositoryUrl: "https://github.com/papercupai/private-canary.git",
      visibility: "private",
      destination: "repository",
      credentialChannel: "git",
    });
    expect(system.commands.at(-1)?.env?.GIT_CONFIG_VALUE_1).toContain(
      `--file='${generation8Path}' get`,
    );
  });

  it("keeps the canonical workspace root aligned with the bootstrap data root", () => {
    expect(WORKSPACE_HOST_DEFAULT_WORKSPACE_ROOT).toBe(
      WORKSPACE_HOST_DATA_ROOT,
    );
  });
});

describe("ProductionWorkspaceHostRemoteInitializerHost agent credential consumer", () => {
  it("materializes delivered bytes into native homes and verifies them in a fresh process", async () => {
    const { system, deps } = fixture();
    const bundle = encodeWorkspaceHostAgentHomeBundle({
      claude: Buffer.from('{"account":"claude-canary"}'),
      codex: Buffer.from('{"account":"codex-canary"}'),
      omp: Buffer.from('{"account":"omp-canary"}'),
    });
    const materialPath = workspaceHostCredentialMaterialPath(
      MATERIAL_ROOT,
      "agent-encrypted-reference",
      7,
    );
    place(system, materialPath, bundle);

    await deps.credentials.run("bind", agentBinding());
    const fresh = createProductionWorkspaceHostRemoteInitializerDeps({
      system,
      workspaceRoot: "/workspaces",
      credentialMaterialRoot: MATERIAL_ROOT,
      now: () => NOW,
    });
    await expect(
      fresh.credentials.run("verify-bound", agentBinding()),
    ).resolves.toMatchObject({
      family: "agent-encrypted-reference",
      generation: 7,
    });

    // The AGENT identity's home (D-248). Before the split this was the SSH login's own home, so
    // the customer owned and could read the platform's Claude/Codex credentials at 0600.
    const paths = workspaceHostAgentHomePaths("/home/papercusp-agent");
    expect(system.files.get(paths.claude)).toEqual(
      Buffer.from('{"account":"claude-canary"}'),
    );
    expect(system.files.get(paths.codex)).toEqual(
      Buffer.from('{"account":"codex-canary"}'),
    );
    expect(system.files.get(paths.omp)).toEqual(
      Buffer.from('{"account":"omp-canary"}'),
    );

    await fresh.credentials.run("revoke", agentBinding());
    for (const path of Object.values(paths))
      expect(system.files.has(path)).toBe(false);
    await expect(
      fresh.credentials.run("verify-revoked", agentBinding()),
    ).resolves.toMatchObject({
      operation: "verify-revoked",
    });
  });
});

describe("ProductionWorkspaceHostRemoteInitializerHost agent probe environment", () => {
  it("runs the probes as the AGENT identity with only explicit variables, never the SSH login and never ambient controller credentials (D-248)", async () => {
    const invocations: WorkspaceHostAgentProbeInvocation[] = [];
    const runner: WorkspaceHostAgentProbeRunner = {
      async run(invocation) {
        invocations.push(invocation);
        return invocation.command === "omp"
          ? { exitCode: 0, stdout: '{"account":"can…001"}' }
          : { exitCode: 0, stdout: "logged in as canary@example.test" };
      },
    };
    const system = new RecordingSystem();
    const host = createProductionWorkspaceHostRemoteInitializerDeps({
      system,
      workspaceRoot: "/workspaces",
      credentialMaterialRoot: MATERIAL_ROOT,
      agentProbeRunner: runner,
      now: () => NOW,
    }).host;
    await host.probeAgentVerification();
    for (const invocation of invocations) {
      // The identity here decides which account the bootstrap must grant runtime read to, and
      // D-043 rules that it cannot be the SSH login. Asserting the negative alongside the
      // positive because the two were the same string until D-248 split them, so an accidental
      // revert reads as a passing test unless the wrong value is named explicitly.
      expect(invocation.env).toEqual({
        HOME: "/home/papercusp-agent",
        USER: "papercusp-agent",
        LOGNAME: "papercusp-agent",
        PATH: "/opt/papercusp/current/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
      });
      expect(invocation.env).not.toHaveProperty("ANTHROPIC_API_KEY");
      expect(invocation.env).not.toHaveProperty("OPENAI_API_KEY");
      expect(invocation.runAsUser).toBe("papercusp-agent");
      expect(invocation.runAsUser).not.toBe("papercusp-workspace");
    }
  });

  it("execs the vendor path the attestation recorded, not the bare name that resolves to a launcher wrapper (D-259 Defect 2)", async () => {
    const vendor = {
      claude: "/home/papercusp-agent/.local/bin/claude",
      codex: "/home/papercusp-agent/.papercusp/runtime/node_modules/.bin/codex",
      omp: "/home/papercusp-agent/.local/bin/omp",
    };
    const invocations: WorkspaceHostAgentProbeInvocation[] = [];
    const runner: WorkspaceHostAgentProbeRunner = {
      async run(invocation) {
        invocations.push(invocation);
        return invocation.command === vendor.omp
          ? { exitCode: 0, stdout: '{"account":"can…001"}' }
          : { exitCode: 0, stdout: "logged in as canary@example.test" };
      },
    };
    const system = new RecordingSystem();
    await system.writePrivateFile(
      WORKSPACE_HOST_BOOTSTRAP_ATTESTATION_FILE,
      Buffer.from(
        JSON.stringify({
          runtime: {
            agentRuntimesInstalledByBootstrap: true,
            agentRuntimes: vendor,
          },
        }),
      ),
    );
    const host = createProductionWorkspaceHostRemoteInitializerDeps({
      system,
      workspaceRoot: "/workspaces",
      credentialMaterialRoot: MATERIAL_ROOT,
      agentProbeRunner: runner,
      now: () => NOW,
    }).host;

    await host.probeAgentVerification();

    expect(invocations.map((invocation) => invocation.command)).toEqual([
      vendor.claude,
      vendor.codex,
      vendor.omp,
    ]);
    // The probe PATH still leads with the release bin, and that is fine — the point is that the
    // command is no longer a bare name for that path to resolve. Asserting both together is what
    // pins the fix: a regression restores the bare name while this env stays identical.
    for (const invocation of invocations) {
      expect(invocation.env?.PATH).toBe(
        `${WORKSPACE_HOST_RELEASE_BIN_DIR}:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`,
      );
      expect(invocation.command.startsWith(WORKSPACE_HOST_RELEASE_BIN_DIR)).toBe(
        false,
      );
    }
  });

  it("falls back to the bare command when no attestation exists, so a pre-install host fails its probe rather than erroring", async () => {
    const invocations: WorkspaceHostAgentProbeInvocation[] = [];
    const runner: WorkspaceHostAgentProbeRunner = {
      async run(invocation) {
        invocations.push(invocation);
        return { exitCode: 127, stdout: "" };
      },
    };
    const host = createProductionWorkspaceHostRemoteInitializerDeps({
      system: new RecordingSystem(),
      workspaceRoot: "/workspaces",
      credentialMaterialRoot: MATERIAL_ROOT,
      agentProbeRunner: runner,
      now: () => NOW,
    }).host;

    const report = await host.probeAgentVerification();

    // `codex` and `omp` twice each are correct, not duplicates: for both agents the
    // account probe failed, so the second spec ran as the documented fallback — codex's
    // live-inference probe (D-265) and omp's local-inference probe — and both fell back to the
    // bare name because this host has no attestation.
    expect(invocations.map((invocation) => invocation.command)).toEqual([
      "claude",
      "codex",
      "codex",
      "omp",
      "omp",
    ]);
    expect(report.allReady).toBe(false);
  });

  it("refuses an attested path inside the release bin — that directory holds wrappers, not vendor CLIs", async () => {
    const system = new RecordingSystem();
    await system.writePrivateFile(
      WORKSPACE_HOST_BOOTSTRAP_ATTESTATION_FILE,
      Buffer.from(
        JSON.stringify({
          runtime: {
            agentRuntimes: {
              claude: `${WORKSPACE_HOST_RELEASE_BIN_DIR}/claude`,
            },
          },
        }),
      ),
    );
    const host = createProductionWorkspaceHostRemoteInitializerDeps({
      system,
      workspaceRoot: "/workspaces",
      credentialMaterialRoot: MATERIAL_ROOT,
      agentProbeRunner: { async run() {
        throw new Error("probe must not run against a wrapper path");
      } },
      now: () => NOW,
    }).host;

    await expect(host.probeAgentVerification()).rejects.toThrow(
      /holds launcher wrappers rather than vendor CLIs/,
    );
  });

  it("refuses a corrupt attestation instead of silently degrading to the bare-name fallback", async () => {
    // The distinction the fallback above depends on: ABSENT means "this host has no vendor
    // runtime" and is a legitimate probe failure; MALFORMED means the attestation says something
    // unreadable, and treating that as absent would report a probe failure whose real cause was a
    // corrupt attestation nobody ever looked at.
    for (const body of ["{not json", JSON.stringify({ runtime: { agentRuntimes: ["/usr/bin/claude"] } }), JSON.stringify({ runtime: { agentRuntimes: { claude: "claude" } } })]) {
      const system = new RecordingSystem();
      await system.writePrivateFile(
        WORKSPACE_HOST_BOOTSTRAP_ATTESTATION_FILE,
        Buffer.from(body),
      );
      const host = createProductionWorkspaceHostRemoteInitializerDeps({
        system,
        workspaceRoot: "/workspaces",
        credentialMaterialRoot: MATERIAL_ROOT,
        agentProbeRunner: { async run() {
          throw new Error("probe must not run against a corrupt attestation");
        } },
        now: () => NOW,
      }).host;
      await expect(host.probeAgentVerification()).rejects.toThrow();
    }
  });

  it("refuses to run the agents as the workspace SSH account (D-043, D-248)", () => {
    // The collapse is the whole defect, and nothing downstream catches it: delivered credentials
    // land in the customer's own home and the customer's login must read the runtime, while
    // every individual check still passes.
    expect(() =>
      createProductionWorkspaceHostRemoteInitializerDeps({
        system: new RecordingSystem(),
        workspaceRoot: "/workspaces",
        credentialMaterialRoot: MATERIAL_ROOT,
        agentUser: "papercusp-workspace",
        now: () => NOW,
      }),
    ).toThrow(/agentUser must differ from workspaceUser/);
  });
});

describe("ProductionWorkspaceHostRemoteInitializerHost cloned-repository observation", () => {
  // The packaged initializer builds a fresh dependency graph for every SSH invocation, so the
  // clone step and the verify-initialization step never share a JS object. These tests instantiate
  // separate production adapters over ONE filesystem for exactly that reason: a clone descriptor
  // remembered on the cloning instance would satisfy neither of them.
  it("reports a clone performed by a separate adapter over the same filesystem", async () => {
    const system = new RecordingSystem();
    const cloning = createProductionWorkspaceHostRemoteInitializerDeps({
      system,
      workspaceRoot: "/workspaces",
      credentialMaterialRoot: MATERIAL_ROOT,
      now: () => NOW,
    });
    // `run` is a double, so the clone's filesystem effect is modelled rather than executed.
    system.present.add("/workspaces/repository/.git");
    await cloning.host.cloneRepository({
      repositoryUrl: "https://github.com/papercupai/public-canary.git",
      visibility: "public",
      destination: "repository",
    });

    const verifying = createProductionWorkspaceHostRemoteInitializerDeps({
      system,
      workspaceRoot: "/workspaces",
      credentialMaterialRoot: MATERIAL_ROOT,
      now: () => NOW,
    });
    // The adapters must be genuinely distinct, or this asserts nothing about a fresh process.
    expect(verifying.host).not.toBe(cloning.host);

    await expect(
      verifying.host.describeClonedRepository({
        destination: "repository",
        visibility: "public",
      }),
    ).resolves.toEqual({ visibility: "public", cloned: true });
  });

  // Non-vacuity control: without this, an implementation returning a constant `cloned: true` would
  // pass the test above. The observation has to be able to say NO.
  it("reports cloned:false when no .git directory is present", async () => {
    const system = new RecordingSystem();
    const { host } = createProductionWorkspaceHostRemoteInitializerDeps({
      system,
      workspaceRoot: "/workspaces",
      credentialMaterialRoot: MATERIAL_ROOT,
      now: () => NOW,
    });

    await expect(
      host.describeClonedRepository({
        destination: "repository",
        visibility: "public",
      }),
    ).resolves.toEqual({ visibility: "public", cloned: false });
  });
});
