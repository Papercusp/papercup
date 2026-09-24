import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  HOSTED_LOGIN_CHOICE,
  PSU_CONNECTION_STORE_VERSION,
  defaultPsuConnectionStorePath,
  loadPsuConnectionStore,
  normalizeGcpIapProfile,
  normalizeHostedPortalOrigin,
  normalizeHostedProfile,
  parsePsuConnectionArgs,
  runPsuConnectionFrontController,
  savePsuConnectionStore,
} from "./psu-connection-front-controller.mjs";

const PORTAL = "https://portal.example.test";
const TOKEN = `pct_${"a".repeat(43)}`;
const NEW_TOKEN = `pct_${"b".repeat(43)}`;
const TICKET = `ht_${"t".repeat(43)}`;

function hostedProfile(accessToken = TOKEN) {
  return normalizeHostedProfile({
    origin: PORTAL,
    accessToken,
    tokenId: "hct_token-1",
    organizationId: "e91577da-655b-4b24-b122-ab57b4f9d211",
    userId: "user_01",
    expiresAt: "2026-10-24T00:00:00.000Z",
  });
}

type FetchCall = { url: string; method: string; headers: Record<string, string>; body: unknown };

/** A scripted portal: each handler answers one path; calls are recorded in order. */
function fakePortal(
  handlers: Record<string, (call: FetchCall) => { status: number; body: unknown }>,
) {
  const calls: FetchCall[] = [];
  const fetch = vi.fn(async (url: string, init: RequestInit = {}) => {
    const call: FetchCall = {
      url,
      method: init.method ?? "GET",
      headers: (init.headers ?? {}) as Record<string, string>,
      body: init.body ? JSON.parse(String(init.body)) : undefined,
    };
    calls.push(call);
    const path = new URL(url).pathname;
    const handler = handlers[path];
    if (!handler) throw new Error(`unexpected request ${path}`);
    const { status, body } = handler(call);
    return new Response(JSON.stringify(body), { status });
  });
  return { fetch, calls };
}

function savedStore(home: string, profiles: unknown[]) {
  const storePath = defaultPsuConnectionStorePath(home);
  savePsuConnectionStore(
    { version: PSU_CONNECTION_STORE_VERSION, profiles },
    storePath,
  );
  return storePath;
}

const WORKSPACES = {
  "/api/hosted/cli/workspaces": () => ({
    status: 200,
    body: {
      ok: true,
      workspaces: [
        { id: "ws-live", displayName: "avi-test", state: "active", reachable: true },
        { id: "ws-stopped", displayName: "old", state: "stopped", reachable: false },
      ],
    },
  }),
};

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

describe("psu Papercusp cloud connections (WI-10002874)", () => {
  it("parses sign-in, sign-out and workspace selection without claiming remote psu flags", () => {
    expect(parsePsuConnectionArgs(["--connect-login", "--role=su"])).toMatchObject({
      transport: { login: true, loginOrigin: null },
      forwardedArgv: ["--role=su"],
    });
    expect(
      parsePsuConnectionArgs([`--connect-login=${PORTAL}`]).transport.loginOrigin,
    ).toBe(PORTAL);
    expect(parsePsuConnectionArgs(["--connect-logout"]).transport).toMatchObject({
      logout: true,
      logoutName: null,
    });
    expect(
      parsePsuConnectionArgs([
        "--connect=portal.example.test/ws-live",
        "--connect-session",
        "abc_1",
        "--resume",
      ]),
    ).toMatchObject({
      transport: {
        explicitConnect: true,
        selection: "portal.example.test/ws-live",
        sessionKey: "abc_1",
      },
      forwardedArgv: ["--resume"],
    });
    expect(() => parsePsuConnectionArgs(["--connect-login", "--connect=x"])).toThrow(
      "cannot also use --connect",
    );
    expect(() => parsePsuConnectionArgs(["--connect-session=bad key"])).toThrow(
      "--connect-session",
    );
  });

  it("stores a cloud sign-in privately and refuses a non-https or credential-bearing portal", () => {
    const path = savedStore(tempHome(), [gcpProfile(), hostedProfile()]);
    expect(loadPsuConnectionStore(path).profiles).toEqual([gcpProfile(), hostedProfile()]);
    if (process.platform !== "win32")
      expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(hostedProfile()).toMatchObject({
      name: "portal.example.test",
      kind: "papercusp-hosted",
      features: { pty: true, tcpForward: false },
    });
    expect(normalizeHostedPortalOrigin("http://127.0.0.1:3880/x")).toBe(
      "http://127.0.0.1:3880",
    );
    expect(() => normalizeHostedPortalOrigin("http://portal.example.test")).toThrow(
      "https://",
    );
    expect(() =>
      normalizeHostedPortalOrigin("https://portal.example.test@evil.example"),
    ).toThrow("credentials");
    expect(() => hostedProfile("pct_short")).toThrow("Papercusp CLI token");
  });

  it("signs in with a device code, honours pending and slow_down, and saves the token", async () => {
    const home = tempHome();
    const storePath = defaultPsuConnectionStorePath(home);
    const polls = ["authorization_pending", "slow_down"];
    const portal = fakePortal({
      "/api/hosted/cli/device/code": () => ({
        status: 200,
        body: {
          ok: true,
          deviceCode: `pdc_${"d".repeat(43)}`,
          userCode: "BCDF-GHJK",
          verificationUri: `${PORTAL}/api/hosted/cli/device`,
          verificationUriComplete: `${PORTAL}/api/hosted/cli/device?user_code=BCDF-GHJK`,
          expiresIn: 600,
          interval: 5,
        },
      }),
      "/api/hosted/cli/device/token": () => {
        const next = polls.shift();
        if (next) return { status: 400, body: { ok: false, error: next } };
        return {
          status: 200,
          body: {
            ok: true,
            accessToken: NEW_TOKEN,
            tokenId: "hct_new",
            organizationId: "org-1",
            userId: "user_01",
            expiresAt: "2026-10-24T00:00:00.000Z",
          },
        };
      },
    });
    const sleeps: number[] = [];
    const notices: string[] = [];
    const openBrowser = vi.fn();

    const result = await runPsuConnectionFrontController([`--connect-login=${PORTAL}`], {
      home,
      storePath,
      interactive: true,
      hostname: "laptop",
      fetch: portal.fetch,
      sleep: async (ms: number) => {
        sleeps.push(ms);
      },
      openBrowser,
      notice: (line: string) => notices.push(line),
      output: vi.fn(),
    });

    expect(result).toEqual({ handled: true, argv: [], exitCode: 0 });
    expect(portal.calls[0]?.body).toEqual({ clientLabel: "laptop" });
    expect(sleeps).toEqual([5_000, 5_000, 10_000]);
    expect(openBrowser).toHaveBeenCalledWith(
      `${PORTAL}/api/hosted/cli/device?user_code=BCDF-GHJK`,
    );
    expect(notices.join("\n")).toContain("BCDF-GHJK");
    expect(loadPsuConnectionStore(storePath).profiles).toEqual([
      normalizeHostedProfile({
        origin: PORTAL,
        accessToken: NEW_TOKEN,
        tokenId: "hct_new",
        organizationId: "org-1",
        userId: "user_01",
        expiresAt: "2026-10-24T00:00:00.000Z",
      }),
    ]);
  });

  it("reports a denied sign-in without saving anything", async () => {
    const home = tempHome();
    const storePath = defaultPsuConnectionStorePath(home);
    const portal = fakePortal({
      "/api/hosted/cli/device/code": () => ({
        status: 200,
        body: {
          ok: true,
          deviceCode: `pdc_${"d".repeat(43)}`,
          userCode: "BCDF-GHJK",
          verificationUriComplete: `${PORTAL}/api/hosted/cli/device?user_code=BCDF-GHJK`,
          expiresIn: 600,
          interval: 5,
        },
      }),
      "/api/hosted/cli/device/token": () => ({
        status: 400,
        body: { ok: false, error: "access_denied" },
      }),
    });
    await expect(
      runPsuConnectionFrontController([`--connect-login=${PORTAL}`], {
        home,
        storePath,
        interactive: false,
        fetch: portal.fetch,
        sleep: async () => {},
        notice: vi.fn(),
      }),
    ).rejects.toThrow("denied");
    expect(loadPsuConnectionStore(storePath).profiles).toEqual([]);
  });

  it("opens psu on a cloud workspace through the relay at the trusted portal, forwarding every argv cell", async () => {
    const home = tempHome();
    const storePath = savedStore(home, [hostedProfile()]);
    const portal = fakePortal({
      ...WORKSPACES,
      "/api/hosted/cli/workspaces/ws-live/terminal": ({ body }) => ({
        status: 200,
        body: {
          ok: true,
          // A reply naming a different host must not redirect the terminal there.
          socketUrl: `wss://elsewhere.example/api/hosted/connectors/socket?ticket=${TICKET}`,
          session: (body as { session: string }).session,
          expiresAt: "2026-09-24T05:00:00.000Z",
        },
      }),
    });
    const terminals: Array<{ socketUrl: string; initialInput: string }> = [];
    const run = () =>
      runPsuConnectionFrontController(
        ["--connect=portal.example.test", "--role=su", "--label=it's mine"],
        {
          home,
          storePath,
          interactive: false,
          fetch: portal.fetch,
          notice: vi.fn(),
          async openHostedTerminal(input: { socketUrl: string; initialInput: string }) {
            terminals.push(input);
            return { exit: { code: 0, signal: 0 }, resumed: false };
          },
        },
      );

    await expect(run()).resolves.toEqual({
      handled: true,
      argv: ["--role=su", "--label=it's mine"],
      exitCode: 0,
    });
    await run();

    expect(portal.calls[0]?.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(terminals[0]?.socketUrl).toBe(
      `wss://portal.example.test/api/hosted/connectors/socket?ticket=${TICKET}`,
    );
    expect(terminals[0]?.initialInput).toBe(
      `exec env PAPERCUSP_PSU_CONNECTION_FORWARDED=1 psu '--role=su' '--label=it'\\''s mine'\r`,
    );
    const sessions = portal.calls
      .filter((call) => call.url.endsWith("/terminal"))
      .map((call) => (call.body as { session: string }).session);
    // Same command, same shell: a rerun reattaches instead of starting over.
    expect(sessions).toHaveLength(2);
    expect(sessions[0]).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(sessions[1]).toBe(sessions[0]);
  });

  it("names the resume command when the relay drops before the remote shell exits", async () => {
    const home = tempHome();
    const storePath = savedStore(home, [hostedProfile()]);
    const portal = fakePortal({
      ...WORKSPACES,
      "/api/hosted/cli/workspaces/ws-live/terminal": () => ({
        status: 200,
        body: {
          ok: true,
          socketUrl: `wss://portal.example.test/api/hosted/connectors/socket?ticket=${TICKET}`,
          session: "sess_1",
        },
      }),
    });
    await expect(
      runPsuConnectionFrontController(["--connect=portal.example.test/ws-live"], {
        home,
        storePath,
        interactive: false,
        fetch: portal.fetch,
        notice: vi.fn(),
        openHostedTerminal: async () => ({ exit: null, closeReason: "connector_lost" }),
      }),
    ).rejects.toThrow(
      "psu --connect=portal.example.test/ws-live --connect-session=sess_1",
    );
  });

  it("turns an expired sign-in and a stopped workspace into actionable errors", async () => {
    const home = tempHome();
    const storePath = savedStore(home, [hostedProfile()]);
    const expired = fakePortal({
      "/api/hosted/cli/workspaces": () => ({
        status: 401,
        body: { ok: false, error: { code: "cli_token_invalid" } },
      }),
    });
    await expect(
      runPsuConnectionFrontController(["--connect=portal.example.test"], {
        home,
        storePath,
        interactive: false,
        fetch: expired.fetch,
        notice: vi.fn(),
      }),
    ).rejects.toThrow(`psu --connect-login=${PORTAL}`);

    const stopped = fakePortal(WORKSPACES);
    await expect(
      runPsuConnectionFrontController(["--connect=portal.example.test/ws-stopped"], {
        home,
        storePath,
        interactive: false,
        fetch: stopped.fetch,
        notice: vi.fn(),
        openHostedTerminal: vi.fn(),
      }),
    ).rejects.toThrow("'ws-stopped' is not connected right now (stopped)");
    expect(stopped.calls.map((call) => new URL(call.url).pathname)).toEqual([
      "/api/hosted/cli/workspaces",
    ]);
  });

  it("offers cloud sign-in from a plain interactive psu and lists workspaces once signed in", async () => {
    const home = tempHome();
    const storePath = savedStore(home, []);
    const seen: Array<Array<{ value: string; disabled?: string }>> = [];
    await runPsuConnectionFrontController([], {
      home,
      storePath,
      interactive: true,
      pickConnection: async (choices: Array<{ value: string }>) => {
        seen.push(choices);
        return "local";
      },
    });
    expect(seen[0]?.map((choice) => choice.value)).toEqual(["local", HOSTED_LOGIN_CHOICE]);

    savedStore(home, [hostedProfile()]);
    const portal = fakePortal(WORKSPACES);
    await runPsuConnectionFrontController([], {
      home,
      storePath,
      interactive: true,
      fetch: portal.fetch,
      pickConnection: async (choices: Array<{ value: string }>) => {
        seen.push(choices);
        return "local";
      },
    });
    expect(seen[1]).toEqual([
      expect.objectContaining({ value: "local" }),
      expect.objectContaining({ value: "portal.example.test/ws-live" }),
      expect.objectContaining({
        value: "portal.example.test/ws-stopped",
        disabled: "not connected",
      }),
    ]);
  });

  it("signs out by revoking the token and forgetting the profile", async () => {
    const home = tempHome();
    const storePath = savedStore(home, [gcpProfile(), hostedProfile()]);
    const portal = fakePortal({
      "/api/hosted/cli/logout": () => ({ status: 200, body: { ok: true } }),
    });
    await expect(
      runPsuConnectionFrontController(["--connect-logout"], {
        home,
        storePath,
        fetch: portal.fetch,
        output: vi.fn(),
      }),
    ).resolves.toEqual({ handled: true, argv: [], exitCode: 0 });
    expect(portal.calls[0]?.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(loadPsuConnectionStore(storePath).profiles).toEqual([gcpProfile()]);
  });
});
