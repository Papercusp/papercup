import { mkdtemp, mkdir, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  WORKSPACE_HOST_AGENT_HOME_BUNDLE_VERSION,
  WORKSPACE_HOST_AGENT_HOME_LEGACY_BUNDLE_VERSION,
  WorkspaceHostAgentHomeConsumer,
  encodeWorkspaceHostAgentHomeState,
  encodeWorkspaceHostAgentHomeBundle,
  parseWorkspaceHostAgentHomeBundle,
  WORKSPACE_HOST_AGENT_HOME_OMP_LOCAL_MODELS_YML,
  workspaceHostAgentHomePaths,
  workspaceHostAgentHomeOmpModelsPath,
  workspaceHostAgentHomeStatePath,
  type WorkspaceHostAgentHomeFilesystem,
} from "./workspace-host-agent-home";
import { NodeWorkspaceHostSystem } from "./workspace-host-remote-initializer-host";

const files = {
  claude: Buffer.from(
    JSON.stringify({ claudeAiOauth: { accessToken: "claude-secret" } }),
  ),
  codex: Buffer.from(
    JSON.stringify({
      auth_mode: "chatgpt",
      tokens: { access_token: "codex-secret" },
    }),
  ),
  omp: Buffer.from(
    JSON.stringify({
      anthropic: { type: "oauth", token: { access: "omp-secret" } },
    }),
  ),
};
const rotated = {
  claude: Buffer.from(
    JSON.stringify({ claudeAiOauth: { accessToken: "claude-rotated" } }),
  ),
  codex: Buffer.from(
    JSON.stringify({
      auth_mode: "chatgpt",
      tokens: { access_token: "codex-rotated" },
    }),
  ),
  omp: Buffer.from(
    JSON.stringify({
      anthropic: { type: "oauth", token: { access: "omp-rotated" } },
    }),
  ),
};
// The AGENT identity's home, not the SSH login's (D-248). These were the same path until the
// third identity split them, which is precisely why the delivered credentials sitting in the
// customer's own home read as correct here for as long as they did.
const HOME = "/home/papercusp-agent";
const ROOT = "/credentials";

class MemoryAgentHomeFilesystem implements WorkspaceHostAgentHomeFilesystem {
  readonly files = new Map<string, Buffer>();
  readonly directories = new Set<string>();
  readonly ownership: Array<{ path: string; owner: string; group: string }> =
    [];
  readonly writes: string[] = [];

  async ensureDirectory(path: string): Promise<void> {
    this.directories.add(path);
  }
  async writePrivateFile(path: string, bytes: Buffer): Promise<void> {
    this.writes.push(path);
    this.files.set(path, Buffer.from(bytes));
  }
  async readFileIfPresent(path: string): Promise<Buffer | null> {
    return this.files.get(path) ?? null;
  }
  async removePath(path: string): Promise<void> {
    this.files.delete(path);
    this.directories.delete(path);
  }
  async pathExists(path: string): Promise<boolean> {
    return this.files.has(path) || this.directories.has(path);
  }
  async setOwnership(
    path: string,
    owner: string,
    group: string,
  ): Promise<void> {
    this.ownership.push({ path, owner, group });
  }
}

class PausingAgentHomeFilesystem extends MemoryAgentHomeFilesystem {
  private releasePause: (() => void) | undefined;
  private markPaused: (() => void) | undefined;
  readonly paused: Promise<void>;
  private pausePath: string | null = null;
  private didPause = false;

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

/**
 * Models the workspace user racing a privileged lifecycle operation through its writable home.
 * A native-home read/remove is safe only while the consumer has pinned the home root-owned.
 */
class WorkspaceUserRaceFilesystem extends MemoryAgentHomeFilesystem {
  private readonly owners = new Map<string, string>();
  enforcePinnedHome = false;

  override async setOwnership(
    path: string,
    owner: string,
    group: string,
  ): Promise<void> {
    this.owners.set(path, `${owner}:${group}`);
    await super.setOwnership(path, owner, group);
  }

  private requirePinnedHome(path: string): void {
    if (
      this.enforcePinnedHome &&
      path.startsWith(`${HOME}/`) &&
      this.owners.get(HOME) !== "root:root"
    ) {
      throw new Error("simulated workspace-user home swap");
    }
  }

  override async readFileIfPresent(path: string): Promise<Buffer | null> {
    this.requirePinnedHome(path);
    return await super.readFileIfPresent(path);
  }

  override async removePath(path: string): Promise<void> {
    this.requirePinnedHome(path);
    await super.removePath(path);
  }
}

function consumer(
  filesystem: MemoryAgentHomeFilesystem,
): WorkspaceHostAgentHomeConsumer {
  return new WorkspaceHostAgentHomeConsumer({
    filesystem,
    materialRoot: ROOT,
    agentHome: HOME,
    agentUser: "papercusp-agent",
    agentGroup: "papercusp-agent",
  });
}

describe("workspace-host sealed agent-home bundle", () => {
  it("round-trips exactly three fixed native-home JSON members", () => {
    const parsed = parseWorkspaceHostAgentHomeBundle(
      encodeWorkspaceHostAgentHomeBundle(files),
    );
    expect(parsed.contractVersion).toBe(
      WORKSPACE_HOST_AGENT_HOME_BUNDLE_VERSION,
    );
    expect(parsed.files).toEqual(files);
    expect(workspaceHostAgentHomePaths(HOME)).toEqual({
      claude: `${HOME}/.claude/.credentials.json`,
      codex: `${HOME}/.codex/auth.json`,
      omp: `${HOME}/.omp/agent/auth.json`,
    });
  });

  it("reads legacy three-file bundles without weakening their required OMP member", () => {
    const material = Buffer.from(
      JSON.stringify({
        contractVersion: WORKSPACE_HOST_AGENT_HOME_LEGACY_BUNDLE_VERSION,
        files: Object.fromEntries(
          Object.entries(files).map(([label, bytes]) => [
            label,
            bytes.toString("base64"),
          ]),
        ),
      }),
    );
    const parsed = parseWorkspaceHostAgentHomeBundle(material);
    expect(parsed.contractVersion).toBe(
      WORKSPACE_HOST_AGENT_HOME_LEGACY_BUNDLE_VERSION,
    );
    expect(parsed.files).toEqual(files);

    const withoutOmp = JSON.parse(material.toString("utf8"));
    delete withoutOmp.files.omp;
    expect(() =>
      parseWorkspaceHostAgentHomeBundle(
        Buffer.from(JSON.stringify(withoutOmp)),
      ),
    ).toThrow(/exactly/);
  });

  it("represents local-inference OMP as absence and removes stale auth bytes on rotation", async () => {
    const credentialFreeOmp = { ...rotated, omp: null };
    const material = encodeWorkspaceHostAgentHomeBundle(credentialFreeOmp);
    const encoded = JSON.parse(material.toString("utf8"));
    expect(encoded.files.omp).toBeNull();
    expect(parseWorkspaceHostAgentHomeBundle(material).files.omp).toBeNull();

    const filesystem = new MemoryAgentHomeFilesystem();
    await consumer(filesystem).install(
      "agent-encrypted-reference",
      1,
      encodeWorkspaceHostAgentHomeBundle(files),
    );
    const ompPath = workspaceHostAgentHomePaths(HOME).omp;
    expect(filesystem.files.has(ompPath)).toBe(true);

    await consumer(filesystem).install(
      "agent-encrypted-reference",
      2,
      material,
    );
    await expect(
      consumer(filesystem).verify("agent-encrypted-reference", 2, material),
    ).resolves.toMatchObject({ generation: 2, present: true });
    expect(filesystem.files.has(ompPath)).toBe(false);
  });

  it("seeds and verifies a direct loopback Ollama discovery provider for credential-free OMP", async () => {
    const filesystem = new MemoryAgentHomeFilesystem();
    const material = encodeWorkspaceHostAgentHomeBundle({
      ...files,
      omp: null,
    });
    const modelsPath = workspaceHostAgentHomeOmpModelsPath(HOME);

    await consumer(filesystem).install(
      "agent-encrypted-reference",
      1,
      material,
    );
    expect(filesystem.files.get(modelsPath)?.toString("utf8")).toBe(
      WORKSPACE_HOST_AGENT_HOME_OMP_LOCAL_MODELS_YML,
    );
    await expect(
      consumer(filesystem).verify("agent-encrypted-reference", 1, material),
    ).resolves.toMatchObject({ generation: 1, present: true });
    expect(
      filesystem.ownership.filter((entry) => entry.path === modelsPath),
    ).toEqual(
      expect.arrayContaining([
        {
          path: modelsPath,
          owner: "papercusp-agent",
          group: "papercusp-agent",
        },
      ]),
    );
  });

  it("reconciles a stale local OMP registry idempotently", async () => {
    const filesystem = new MemoryAgentHomeFilesystem();
    const material = encodeWorkspaceHostAgentHomeBundle({
      ...files,
      omp: null,
    });
    const modelsPath = workspaceHostAgentHomeOmpModelsPath(HOME);
    filesystem.files.set(modelsPath, Buffer.from("providers:\n  ollama: {}\n"));

    await consumer(filesystem).install(
      "agent-encrypted-reference",
      1,
      material,
    );
    await consumer(filesystem).install(
      "agent-encrypted-reference",
      1,
      material,
    );
    expect(filesystem.files.get(modelsPath)?.toString("utf8")).toBe(
      WORKSPACE_HOST_AGENT_HOME_OMP_LOCAL_MODELS_YML,
    );
    expect(
      filesystem.writes.filter((path) => path === modelsPath),
    ).toHaveLength(1);
  });

  it("fails verification when the credential-free OMP registry is removed or changed", async () => {
    const filesystem = new MemoryAgentHomeFilesystem();
    const material = encodeWorkspaceHostAgentHomeBundle({
      ...files,
      omp: null,
    });
    const modelsPath = workspaceHostAgentHomeOmpModelsPath(HOME);
    await consumer(filesystem).install(
      "agent-encrypted-reference",
      1,
      material,
    );

    filesystem.files.set(modelsPath, Buffer.from("providers: {}\n"));
    await expect(
      consumer(filesystem).verify("agent-encrypted-reference", 1, material),
    ).rejects.toThrow(/models registry is absent or stale/);
  });

  it("rejects an omitted, extra, malformed, or non-JSON member without echoing bytes", () => {
    const valid = JSON.parse(
      encodeWorkspaceHostAgentHomeBundle(files).toString("utf8"),
    );
    for (const candidate of [
      { ...valid, files: { ...valid.files, omp: undefined } },
      { ...valid, files: { ...valid.files, extra: "e30=" } },
      { ...valid, files: { ...valid.files, codex: "not-base64" } },
      {
        ...valid,
        files: {
          ...valid.files,
          claude: Buffer.from("not-json").toString("base64"),
        },
      },
    ]) {
      expect(() =>
        parseWorkspaceHostAgentHomeBundle(
          Buffer.from(JSON.stringify(candidate)),
        ),
      ).toThrow();
    }
    try {
      parseWorkspaceHostAgentHomeBundle(
        Buffer.from(
          JSON.stringify({
            ...valid,
            files: { ...valid.files, omp: "private-secret" },
          }),
        ),
      );
    } catch (error) {
      expect(String(error)).not.toContain("private-secret");
    }
  });

  it("installs and verifies exact native files through a fresh consumer process", async () => {
    const filesystem = new MemoryAgentHomeFilesystem();
    await consumer(filesystem).install(
      "agent-encrypted-reference",
      1,
      encodeWorkspaceHostAgentHomeBundle(files),
    );
    await expect(
      consumer(filesystem).verify(
        "agent-encrypted-reference",
        1,
        encodeWorkspaceHostAgentHomeBundle(files),
      ),
    ).resolves.toMatchObject({ generation: 1, present: true, home: HOME });

    const paths = workspaceHostAgentHomePaths(HOME);
    expect(filesystem.files.get(paths.claude)).toEqual(files.claude);
    expect(filesystem.files.get(paths.codex)).toEqual(files.codex);
    expect(filesystem.files.get(paths.omp)).toEqual(files.omp);
    expect(filesystem.files.has(workspaceHostAgentHomeStatePath(ROOT))).toBe(
      true,
    );
    expect(filesystem.ownership).toEqual(
      expect.arrayContaining([
        {
          path: paths.claude,
          owner: "papercusp-agent",
          group: "papercusp-agent",
        },
        {
          path: paths.codex,
          owner: "papercusp-agent",
          group: "papercusp-agent",
        },
        {
          path: paths.omp,
          owner: "papercusp-agent",
          group: "papercusp-agent",
        },
      ]),
    );
  });

  it("detects stale native bytes rather than trusting only the active generation marker", async () => {
    const filesystem = new MemoryAgentHomeFilesystem();
    await consumer(filesystem).install(
      "agent-encrypted-reference",
      1,
      encodeWorkspaceHostAgentHomeBundle(files),
    );
    filesystem.files.set(
      workspaceHostAgentHomePaths(HOME).codex,
      Buffer.from("{}"),
    );
    await expect(
      consumer(filesystem).verify(
        "agent-encrypted-reference",
        1,
        encodeWorkspaceHostAgentHomeBundle(files),
      ),
    ).rejects.toThrow(/absent, stale/);
  });

  it("rotates monotonically and makes an old revoke harmless to the active generation", async () => {
    const filesystem = new MemoryAgentHomeFilesystem();
    const first = consumer(filesystem);
    await first.install(
      "agent-encrypted-reference",
      1,
      encodeWorkspaceHostAgentHomeBundle(files),
    );
    await consumer(filesystem).install(
      "agent-encrypted-reference",
      2,
      encodeWorkspaceHostAgentHomeBundle(rotated),
    );

    await consumer(filesystem).revoke("agent-encrypted-reference", 1);
    await expect(
      consumer(filesystem).verify(
        "agent-encrypted-reference",
        2,
        encodeWorkspaceHostAgentHomeBundle(rotated),
      ),
    ).resolves.toMatchObject({ generation: 2, present: true });
    await expect(
      consumer(filesystem).install(
        "agent-encrypted-reference",
        1,
        encodeWorkspaceHostAgentHomeBundle(files),
      ),
    ).rejects.toThrow(/older than active generation 2/);

    await consumer(filesystem).revoke("agent-encrypted-reference", 2);
    await expect(
      consumer(filesystem).verifyRevoked("agent-encrypted-reference", 2),
    ).resolves.toMatchObject({ present: false });
    for (const path of Object.values(workspaceHostAgentHomePaths(HOME))) {
      expect(filesystem.files.has(path)).toBe(false);
    }
  });

  it("serializes a stale revoke against a newer install across fresh consumers", async () => {
    const filesystem = new PausingAgentHomeFilesystem();
    await consumer(filesystem).install(
      "agent-encrypted-reference",
      1,
      encodeWorkspaceHostAgentHomeBundle(files),
    );
    filesystem.pauseRemovalAt(workspaceHostAgentHomePaths(HOME).claude);

    const staleRevoke = consumer(filesystem).revoke(
      "agent-encrypted-reference",
      1,
    );
    await filesystem.paused;
    let newerFinished = false;
    const newerInstall = consumer(filesystem)
      .install(
        "agent-encrypted-reference",
        2,
        encodeWorkspaceHostAgentHomeBundle(rotated),
      )
      .then(() => {
        newerFinished = true;
      });
    await Promise.resolve();
    expect(newerFinished).toBe(false);

    filesystem.release();
    await Promise.all([staleRevoke, newerInstall]);
    await expect(
      consumer(filesystem).verify(
        "agent-encrypted-reference",
        2,
        encodeWorkspaceHostAgentHomeBundle(rotated),
      ),
    ).resolves.toMatchObject({ generation: 2, present: true });
  });

  it("pins the user-controlled home while verifying and revoking native files", async () => {
    const filesystem = new WorkspaceUserRaceFilesystem();
    const material = encodeWorkspaceHostAgentHomeBundle(files);
    await consumer(filesystem).install(
      "agent-encrypted-reference",
      1,
      material,
    );

    filesystem.enforcePinnedHome = true;
    await expect(
      consumer(filesystem).verify("agent-encrypted-reference", 1, material),
    ).resolves.toMatchObject({ generation: 1, present: true });
    await expect(
      consumer(filesystem).revoke("agent-encrypted-reference", 1),
    ).resolves.toMatchObject({ generation: 1, present: false });
  });

  it("refuses a valid-looking active state for a different explicit home before revoke", async () => {
    const filesystem = new MemoryAgentHomeFilesystem();
    const otherHome = join(tmpdir(), "another-workspace");
    filesystem.files.set(
      workspaceHostAgentHomeStatePath(ROOT),
      encodeWorkspaceHostAgentHomeState(
        "agent-encrypted-reference",
        1,
        otherHome,
      ),
    );
    const otherPath = workspaceHostAgentHomePaths(otherHome).claude;
    filesystem.files.set(otherPath, Buffer.from("do-not-remove"));

    await expect(
      consumer(filesystem).revoke("agent-encrypted-reference", 1),
    ).rejects.toThrow(/different agent home/);
    expect(filesystem.files.get(otherPath)?.toString()).toBe("do-not-remove");
  });

  it("rejects a symlinked native directory before privileged material can follow it", async () => {
    const temporary = await mkdtemp(join(tmpdir(), "agent-home-symlink-"));
    try {
      const home = join(temporary, "home");
      const trap = join(temporary, "trap");
      await mkdir(home, { mode: 0o700 });
      await mkdir(trap, { mode: 0o700 });
      await symlink(trap, join(home, ".claude"));
      const guarded = new WorkspaceHostAgentHomeConsumer({
        filesystem: new NodeWorkspaceHostSystem(),
        materialRoot: join(temporary, "credentials"),
        agentHome: home,
      });

      await expect(
        guarded.install(
          "agent-encrypted-reference",
          1,
          encodeWorkspaceHostAgentHomeBundle(files),
        ),
      ).rejects.toThrow(/symlink|not a real directory/);
      await expect(
        readFile(join(trap, ".credentials.json")),
      ).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  });
});
