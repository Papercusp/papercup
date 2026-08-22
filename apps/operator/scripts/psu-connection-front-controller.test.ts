import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  PSU_CONNECTION_STORE_VERSION,
  defaultPsuConnectionStorePath,
  loadPsuConnectionStore,
  normalizeGcpIapProfile,
  parsePsuConnectionArgs,
  runPsuConnectionFrontController,
  savePsuConnectionStore,
} from "./psu-connection-front-controller.mjs";

const roots: string[] = [];

function tempHome(): string {
  const root = mkdtempSync(join(tmpdir(), "papercusp-psu-connections-"));
  roots.push(root);
  return root;
}

function gcpProfile(name = "cloud") {
  return normalizeGcpIapProfile({
    name,
    projectId: "papercusp-dev-123",
    zone: "us-central1-a",
    instanceName: "workspace-1",
    sshUser: "alice_example_com",
  });
}

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

describe("psu connection transport argv", () => {
  it("strips only transport flags and preserves every other argv cell in exact order", () => {
    const parsed = parsePsuConnectionArgs([
      "--connect",
      "cloud",
      "--resume=session 1",
      "--fork",
      "--model=gpt-5.6-sol:xhigh",
      "--",
      "--connect=owned-by-remote-psu",
      "",
    ]);

    expect(parsed.transport).toMatchObject({
      explicitConnect: true,
      selection: "cloud",
    });
    expect(parsed.forwardedArgv).toEqual([
      "--resume=session 1",
      "--fork",
      "--model=gpt-5.6-sol:xhigh",
      "--",
      "--connect=owned-by-remote-psu",
      "",
    ]);
  });

  it("parses namespaced GCP IAP profile maintenance without claiming remote psu flags", () => {
    const parsed = parsePsuConnectionArgs([
      "--connect-add-gcp-iap=cloud",
      "--connect-project=papercusp-dev-123",
      "--connect-zone",
      "us-central1-a",
      "--connect-instance=workspace-1",
      "--connect-user=alice_example_com",
      "--account=default",
    ]);
    expect(parsed.transport).toMatchObject({
      addName: "cloud",
      projectId: "papercusp-dev-123",
      zone: "us-central1-a",
      instanceName: "workspace-1",
      sshUser: "alice_example_com",
    });
    expect(parsed.forwardedArgv).toEqual(["--account=default"]);
  });
});

describe("psu connection profile store", () => {
  it("persists a versioned normalized GCP-IAP-only store with private permissions", () => {
    const path = defaultPsuConnectionStorePath(tempHome());
    savePsuConnectionStore(
      { version: PSU_CONNECTION_STORE_VERSION, profiles: [gcpProfile()] },
      path,
    );

    expect(loadPsuConnectionStore(path)).toEqual({
      version: PSU_CONNECTION_STORE_VERSION,
      profiles: [gcpProfile()],
    });
    if (process.platform !== "win32")
      expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it("normalizes GCP to IAP with declared capabilities and rejects shell-shaped provider identity", () => {
    const profile = gcpProfile();
    expect(profile).toMatchObject({
      kind: "gcp-iap-ssh",
      target: "alice_example_com@workspace-1",
      features: {
        command: true,
        pty: true,
        tcpForward: true,
        fileTransfer: true,
      },
      audited: true,
    });
    expect(profile.endpoint).toContain("gcp-iap-ssh://");
    expect(profile.constraints.join(" ")).toContain("No public IP");
    expect(() =>
      normalizeGcpIapProfile({
        ...profile,
        projectId: "project; touch /tmp/bad",
      }),
    ).toThrow("GCP project id");
  });
});

describe("psu remote front controller", () => {
  it("reuses a ControlMaster, probes the forwarded operator, and lets remote psu own every launch picker", async () => {
    const home = tempHome();
    const storePath = defaultPsuConnectionStorePath(home);
    savePsuConnectionStore(
      { version: PSU_CONNECTION_STORE_VERSION, profiles: [gcpProfile()] },
      storePath,
    );
    const commands: Array<{ command: string; args: readonly string[] }> = [];
    const interactive: Array<{ command: string; args: readonly string[] }> = [];
    const probes: string[] = [];
    const runCommand = vi.fn(
      async (command: string, args: readonly string[]) => {
        commands.push({ command, args });
        if (args.includes("check")) return { code: 1, signal: null };
        return { code: 0, signal: null };
      },
    );

    const result = await runPsuConnectionFrontController(
      [
        "--connect=cloud",
        "--role=su",
        "--resume=session 1",
        "--fork",
        "--account=auto",
        "--",
        "--backend-owned=value with spaces",
      ],
      {
        home,
        storePath,
        interactive: false,
        commandAvailable: () => true,
        runCommand,
        async runInteractive(command: string, args: readonly string[]) {
          interactive.push({ command, args });
          return { code: 0, signal: null };
        },
        async reservePort() {
          return { port: 45123, async release() {} };
        },
        async probeOperator(origin: string) {
          probes.push(origin);
        },
        notice: vi.fn(),
      },
    );

    expect(result).toEqual({
      handled: true,
      argv: [
        "--role=su",
        "--resume=session 1",
        "--fork",
        "--account=auto",
        "--",
        "--backend-owned=value with spaces",
      ],
      exitCode: 0,
    });
    expect(probes).toEqual(["http://127.0.0.1:45123"]);
    expect(
      commands.some(({ args }) => args.includes("ControlMaster=yes")),
    ).toBe(true);
    expect(
      commands.some(({ args }) =>
        args.some((arg) => arg.includes("start-iap-tunnel workspace-1")),
      ),
    ).toBe(true);
    expect(commands.at(-1)?.args).toContain("cancel");
    expect(interactive).toHaveLength(1);
    expect(interactive[0]?.args).toContain("-tt");
    expect(interactive[0]?.args.at(-1)).toContain(
      `'env' 'PAPERCUSP_PSU_CONNECTION_FORWARDED=1' 'psu' '--role=su' '--resume=session 1' '--fork' '--account=auto' '--' '--backend-owned=value with spaces'`,
    );
  });

  it("bypasses transport parsing after the local controller forwards into remote psu", async () => {
    const home = tempHome();
    await expect(
      runPsuConnectionFrontController(["--connect=backend-owned", "--resume"], {
        home,
        transportForwarded: true,
      }),
    ).resolves.toEqual({
      handled: false,
      argv: ["--connect=backend-owned", "--resume"],
    });
  });

  it("keeps a scripted invocation local by default without changing argv", async () => {
    const home = tempHome();
    await expect(
      runPsuConnectionFrontController(["--no-picker", "--agent=codex"], {
        home,
        interactive: false,
      }),
    ).resolves.toEqual({
      handled: false,
      argv: ["--no-picker", "--agent=codex"],
    });
  });

  it("keeps launcher help local and side-effect-free without claiming backend help", async () => {
    const home = tempHome();
    const pickConnection = vi.fn(async () => {
      throw new Error(
        "the connection picker must not run for local launcher help",
      );
    });

    await expect(
      runPsuConnectionFrontController(["--help"], {
        home,
        interactive: true,
        pickConnection,
      }),
    ).resolves.toEqual({ handled: false, argv: ["--help"] });
    expect(pickConnection).not.toHaveBeenCalled();

    await expect(
      runPsuConnectionFrontController(["--", "--help"], {
        home,
        interactive: true,
        pickConnection: async () => "local",
      }),
    ).resolves.toEqual({ handled: false, argv: ["--", "--help"] });
  });
});
