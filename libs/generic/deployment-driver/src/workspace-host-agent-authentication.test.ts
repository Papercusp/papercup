import { homedir } from "node:os";

import { describe, expect, it } from "vitest";

import {
  DEFAULT_WORKSPACE_HOST_AGENT_VERIFICATION_PROBES,
  NodeWorkspaceHostAgentProbeRunner,
  WORKSPACE_HOST_OMP_LOCAL_INFERENCE_MARKER,
  WORKSPACE_HOST_CANARY_AGENTS,
  applyWorkspaceHostAgentRuntimePath,
  buildWorkspaceHostAgentProbeProcess,
  probeWorkspaceHostAgentVerification,
  probeWorkspaceHostAgents,
  workspaceHostAgentSubjectDigest,
  type WorkspaceHostAgentProbeInvocation,
  type WorkspaceHostAgentProbeOutcome,
  type WorkspaceHostAgentProbeRunner,
  type WorkspaceHostCanaryAgent,
} from "./workspace-host-agent-authentication";

const NOW = () => new Date("2026-08-25T22:30:00.000Z");

class ScriptedRunner implements WorkspaceHostAgentProbeRunner {
  readonly invocations: WorkspaceHostAgentProbeInvocation[] = [];

  constructor(
    private readonly script: Record<
      string,
      WorkspaceHostAgentProbeOutcome | Error
    >,
  ) {}

  run(
    invocation: WorkspaceHostAgentProbeInvocation,
  ): Promise<WorkspaceHostAgentProbeOutcome> {
    this.invocations.push(invocation);
    const scripted = this.script[invocation.command];
    if (!scripted)
      return Promise.reject(new Error(`no script for ${invocation.command}`));
    if (scripted instanceof Error) return Promise.reject(scripted);
    return Promise.resolve(scripted);
  }
}

const AUTHENTICATED = {
  claude: {
    exitCode: 0,
    stdout: "Authentication status: logged in as canary@papercup.ai\n",
  },
  codex: {
    exitCode: 0,
    stdout: "Login status: signed in as canary@papercup.ai (Team)\n",
  },
  omp: {
    exitCode: 0,
    stdout: JSON.stringify({
      providers: [{ id: "anthropic", accounts: [{ account: "can…4f2" }] }],
    }),
  },
} satisfies Record<WorkspaceHostCanaryAgent, WorkspaceHostAgentProbeOutcome>;

describe("workspace-host agent verification probes", () => {
  it("uses a real account or inference verb for every agent, never a version check", () => {
    for (const agent of WORKSPACE_HOST_CANARY_AGENTS) {
      for (const spec of DEFAULT_WORKSPACE_HOST_AGENT_VERIFICATION_PROBES[
        agent
      ]) {
        expect(spec.agent).toBe(agent);
        expect(spec.args.length).toBeGreaterThan(0);
        expect(spec.args).not.toContain("--version");
        expect(spec.args).not.toContain("-v");
        expect(spec.endpoint.length).toBeGreaterThan(0);
      }
    }
    expect(
      DEFAULT_WORKSPACE_HOST_AGENT_VERIFICATION_PROBES.claude[0].args,
    ).toEqual(["auth", "status"]);
    expect(
      DEFAULT_WORKSPACE_HOST_AGENT_VERIFICATION_PROBES.codex[0].args,
    ).toEqual(["login", "status"]);
    expect(
      DEFAULT_WORKSPACE_HOST_AGENT_VERIFICATION_PROBES.omp[0].args,
    ).toEqual(["usage", "--json", "--redact"]);
    expect(
      DEFAULT_WORKSPACE_HOST_AGENT_VERIFICATION_PROBES.omp[1],
    ).toMatchObject({
      verificationKind: "local-inference",
      command: "omp",
      endpoint: "http://127.0.0.1:11434",
    });
  });

  it("reports authenticated with only the four permitted discriminators", async () => {
    const runner = new ScriptedRunner({ claude: AUTHENTICATED.claude });
    const evidence = await probeWorkspaceHostAgentVerification({
      spec: DEFAULT_WORKSPACE_HOST_AGENT_VERIFICATION_PROBES.claude[0],
      runner,
      now: NOW,
    });

    expect(evidence.ready).toBe(true);
    expect(evidence.verificationKind).toBe("authenticated-account");
    expect(evidence.exitStatus).toBe(0);
    expect(evidence.endpoint).toBe("https://api.anthropic.com");
    expect(evidence.observedAt).toBe("2026-08-25T22:30:00.000Z");
    expect(evidence.proofDigest).toBe(
      workspaceHostAgentSubjectDigest("canary@papercup.ai"),
    );
  });

  it("never lets raw stdout or an un-redacted subject reach the evidence", async () => {
    const runner = new ScriptedRunner({ claude: AUTHENTICATED.claude });
    const evidence = await probeWorkspaceHostAgentVerification({
      spec: DEFAULT_WORKSPACE_HOST_AGENT_VERIFICATION_PROBES.claude[0],
      runner,
      now: NOW,
    });
    const serialized = JSON.stringify(evidence);
    expect(serialized).not.toContain("canary@papercup.ai");
    expect(serialized).not.toContain("Authentication status");
    // claude's disclosure is `digest`, so no plaintext subject is published at all.
    expect(evidence.subject).toBeUndefined();
  });

  it("publishes the subject verbatim only when the tool itself redacted it", async () => {
    const runner = new ScriptedRunner({ omp: AUTHENTICATED.omp });
    const evidence = await probeWorkspaceHostAgentVerification({
      spec: DEFAULT_WORKSPACE_HOST_AGENT_VERIFICATION_PROBES.omp[0],
      runner,
      now: NOW,
    });
    expect(evidence.subjectDisclosure).toBe("redacted");
    expect(evidence.subject).toBe("can…4f2");
    expect(evidence.proofDigest).toBeDefined();
  });

  it("falls back from an empty OMP account report to real loopback local inference", async () => {
    const invocations: WorkspaceHostAgentProbeInvocation[] = [];
    const runner: WorkspaceHostAgentProbeRunner = {
      async run(invocation) {
        invocations.push(invocation);
        if (invocation.command === "claude") return AUTHENTICATED.claude;
        if (invocation.command === "codex") return AUTHENTICATED.codex;
        if (invocation.args[0] === "usage") {
          return { exitCode: 0, stdout: JSON.stringify({ reports: [] }) };
        }
        return {
          exitCode: 0,
          stdout: `${WORKSPACE_HOST_OMP_LOCAL_INFERENCE_MARKER}\n`,
        };
      },
    };

    const report = await probeWorkspaceHostAgents({ runner, now: NOW });

    expect(report.allReady).toBe(true);
    expect(report.agents.omp).toMatchObject({
      ready: true,
      verificationKind: "local-inference",
      endpoint: "http://127.0.0.1:11434",
      proofDigest: workspaceHostAgentSubjectDigest(
        WORKSPACE_HOST_OMP_LOCAL_INFERENCE_MARKER,
      ),
    });
    expect(report.agents.omp.subject).toBeUndefined();
    expect(invocations.filter((entry) => entry.command === "omp")).toHaveLength(
      2,
    );
    expect(
      invocations.find(
        (entry) => entry.command === "omp" && entry.args.includes("--model"),
      )?.args,
    ).toContain("--no-session");
    expect(
      invocations.find(
        (entry) => entry.command === "omp" && entry.args.includes("--model"),
      )?.args,
    ).toEqual(
      expect.arrayContaining(["--no-extensions", "--no-skills", "--no-rules"]),
    );
  });

  it("treats a non-zero exit as unauthenticated and records the status", async () => {
    const runner = new ScriptedRunner({
      claude: {
        exitCode: 1,
        stdout: "Not logged in. Run `claude auth login`.\n",
      },
    });
    const evidence = await probeWorkspaceHostAgentVerification({
      spec: DEFAULT_WORKSPACE_HOST_AGENT_VERIFICATION_PROBES.claude[0],
      runner,
      now: NOW,
    });
    expect(evidence.ready).toBe(false);
    expect(evidence.exitStatus).toBe(1);
    expect(evidence.failure).toBe("non-zero-exit");
    expect(JSON.stringify(evidence)).not.toContain("claude auth login");
  });

  it("treats exit 0 with no parseable subject as a FAILED probe, not a nameless success", async () => {
    // A reworded or broken CLI is the realistic shape of this case; calling it authenticated is
    // how an unbacked boolean comes back.
    const runner = new ScriptedRunner({
      claude: { exitCode: 0, stdout: "OK\n" },
    });
    const evidence = await probeWorkspaceHostAgentVerification({
      spec: DEFAULT_WORKSPACE_HOST_AGENT_VERIFICATION_PROBES.claude[0],
      runner,
      now: NOW,
    });
    expect(evidence.ready).toBe(false);
    expect(evidence.failure).toBe("no-verification-proof");
  });

  it("reduces a thrown probe error to a code, never surfacing the error text", async () => {
    const runner = new ScriptedRunner({
      claude: new Error(
        "spawn /opt/papercusp/current/bin/claude ENOENT --token=abc",
      ),
    });
    const evidence = await probeWorkspaceHostAgentVerification({
      spec: DEFAULT_WORKSPACE_HOST_AGENT_VERIFICATION_PROBES.claude[0],
      runner,
      now: NOW,
    });
    expect(evidence.ready).toBe(false);
    expect(evidence.failure).toBe("probe-error");
    expect(evidence.exitStatus).toBe(-1);
    expect(JSON.stringify(evidence)).not.toContain("ENOENT");
  });

  it("probes all three agents and reports allReady only when every one passed", async () => {
    const allGood = new ScriptedRunner({ ...AUTHENTICATED });
    const report = await probeWorkspaceHostAgents({
      runner: allGood,
      now: NOW,
    });
    expect(report.allReady).toBe(true);
    expect(Object.keys(report.agents).sort()).toEqual([
      "claude",
      "codex",
      "omp",
    ]);
    // Sequential, in the declared order — three CLIs racing one credential store is a source of
    // spurious failures.
    expect(allGood.invocations.map((i) => i.command)).toEqual([
      "claude",
      "codex",
      "omp",
    ]);

    const oneBad = new ScriptedRunner({
      ...AUTHENTICATED,
      codex: { exitCode: 1, stdout: "" },
    });
    const degraded = await probeWorkspaceHostAgents({
      runner: oneBad,
      now: NOW,
    });
    expect(degraded.allReady).toBe(false);
    expect(degraded.agents.codex.ready).toBe(false);
    expect(degraded.agents.claude.ready).toBe(true);
  });

  it("refuses a probe spec whose declared agent does not match its slot", async () => {
    await expect(
      probeWorkspaceHostAgents({
        runner: new ScriptedRunner({ ...AUTHENTICATED }),
        now: NOW,
        probes: {
          claude: [DEFAULT_WORKSPACE_HOST_AGENT_VERIFICATION_PROBES.codex[0]],
        },
      }),
    ).rejects.toThrow(/declares agent 'codex'/);
  });

  it("passes a bounded timeout to the runner so a prompt cannot hang the step", async () => {
    const runner = new ScriptedRunner({ ...AUTHENTICATED });
    await probeWorkspaceHostAgents({ runner, now: NOW });
    for (const invocation of runner.invocations) {
      expect(invocation.timeoutMs).toBeGreaterThan(0);
      expect(Number.isFinite(invocation.timeoutMs)).toBe(true);
    }
  });

  it("uses a supplied probe environment as the complete child environment", async () => {
    const home = homedir();
    const outcome = await new NodeWorkspaceHostAgentProbeRunner().run({
      command: "/usr/bin/env",
      args: [],
      timeoutMs: 5_000,
      env: { HOME: home, USER: "workspace", PROBE_SENTINEL: "present" },
    });
    expect(outcome.exitCode).toBe(0);
    expect(outcome.stdout).toContain("PROBE_SENTINEL=present");
    expect(outcome.stdout).toContain(`HOME=${home}`);
    expect(outcome.stdout).not.toContain("OPENAI_API_KEY=");
    expect(outcome.stdout).not.toContain("ANTHROPIC_API_KEY=");
    expect(outcome.stdout).not.toContain("PATH=");
  });

  it("drops to the real workspace account through runuser and then scrubs the target environment", () => {
    const processInput = buildWorkspaceHostAgentProbeProcess({
      command: "claude",
      args: ["auth", "status"],
      timeoutMs: 5_000,
      runAsUser: "papercusp-workspace",
      env: {
        HOME: "/home/papercusp-workspace",
        USER: "papercusp-workspace",
        LOGNAME: "papercusp-workspace",
        PATH: "/opt/papercusp/current/bin:/usr/bin:/bin",
      },
    });
    expect(processInput).toEqual({
      command: "/usr/sbin/runuser",
      args: [
        "--user",
        "papercusp-workspace",
        "--",
        "/usr/bin/env",
        "-i",
        "--",
        "HOME=/home/papercusp-workspace",
        "USER=papercusp-workspace",
        "LOGNAME=papercusp-workspace",
        "PATH=/opt/papercusp/current/bin:/usr/bin:/bin",
        "claude",
        "auth",
        "status",
      ],
      env: { PATH: "/usr/sbin:/usr/bin:/sbin:/bin" },
    });
    expect(() =>
      buildWorkspaceHostAgentProbeProcess({
        command: "claude",
        args: [],
        timeoutMs: 5_000,
        runAsUser: "root",
        env: { PATH: "/usr/bin" },
      }),
    ).toThrow(/non-root Linux account/);
  });

  it("gives the same account a stable digest and different accounts different digests", () => {
    expect(workspaceHostAgentSubjectDigest("a@b.c")).toBe(
      workspaceHostAgentSubjectDigest("a@b.c"),
    );
    expect(workspaceHostAgentSubjectDigest("a@b.c")).not.toBe(
      workspaceHostAgentSubjectDigest("d@e.f"),
    );
  });
});

describe("attested vendor runtime paths (D-259 Defect 2)", () => {
  const VENDOR = {
    claude: "/home/papercusp-agent/.local/bin/claude",
    codex: "/home/papercusp-agent/.papercusp/runtime/node_modules/.bin/codex",
    omp: "/home/papercusp-agent/.local/bin/omp",
  } satisfies Record<WorkspaceHostCanaryAgent, string>;

  it("execs the attested vendor path instead of the bare name the search path would resolve", async () => {
    // The script is keyed by COMMAND and deliberately holds NO entry for the bare names. A probe
    // that still shelled `claude` therefore rejects, rather than quietly passing against a fixture
    // that answered to both spellings — which is the shape that let this defect hide.
    const runner = new ScriptedRunner({
      [VENDOR.claude]: AUTHENTICATED.claude,
      [VENDOR.codex]: AUTHENTICATED.codex,
      [VENDOR.omp]: AUTHENTICATED.omp,
    });

    const report = await probeWorkspaceHostAgents({
      runner,
      now: NOW,
      runtimePaths: VENDOR,
    });

    expect(report.allReady).toBe(true);
    const commands = runner.invocations.map((invocation) => invocation.command);
    expect(commands).toEqual([VENDOR.claude, VENDOR.codex, VENDOR.omp]);
    for (const agent of WORKSPACE_HOST_CANARY_AGENTS) {
      expect(commands).not.toContain(agent);
    }
  });

  it("substitutes the path into EVERY spec for an agent, not just the first", () => {
    // omp is the only agent with a fallback spec. Were the override applied per-agent-once rather
    // than per-spec, the hosted probe would exec the vendor binary while the local-inference
    // fallback dropped back to the wrapper — green on the happy path, wrong on the path that
    // actually runs when no hosted account answers.
    const specs = DEFAULT_WORKSPACE_HOST_AGENT_VERIFICATION_PROBES.omp;
    expect(specs.length).toBeGreaterThan(1);
    for (const spec of specs) {
      expect(applyWorkspaceHostAgentRuntimePath(spec, VENDOR.omp).command).toBe(
        VENDOR.omp,
      );
    }
  });

  it("changes only the command, leaving the proof rules that make evidence falsifiable intact", () => {
    const spec = DEFAULT_WORKSPACE_HOST_AGENT_VERIFICATION_PROBES.claude[0];
    const resolved = applyWorkspaceHostAgentRuntimePath(spec, VENDOR.claude);
    expect(resolved).toEqual({ ...spec, command: VENDOR.claude });
    expect(resolved.proofPattern).toBe(spec.proofPattern);
    expect(resolved.verificationKind).toBe(spec.verificationKind);
    expect(resolved.endpoint).toBe(spec.endpoint);
  });

  it("falls back to the spec's own command when an agent has no attested path, and still FAILS honestly", async () => {
    // A host provisioned before the vendor installs existed has no attested path for codex. The
    // required behaviour is a probe that RUNS AND FAILS, not a throw: a throw would re-file "this
    // host cannot authenticate codex" — the canary's whole finding — as an infrastructure error.
    const runner = new ScriptedRunner({
      [VENDOR.claude]: AUTHENTICATED.claude,
      codex: { exitCode: 127, stdout: "" },
      [VENDOR.omp]: AUTHENTICATED.omp,
    });

    const report = await probeWorkspaceHostAgents({
      runner,
      now: NOW,
      runtimePaths: { claude: VENDOR.claude, omp: VENDOR.omp },
    });

    expect(runner.invocations.map((invocation) => invocation.command)).toEqual([
      VENDOR.claude,
      "codex",
      VENDOR.omp,
    ]);
    expect(report.agents.codex.ready).toBe(false);
    expect(report.agents.codex.failure).toBe("non-zero-exit");
    expect(report.allReady).toBe(false);
  });

  it("refuses a relative path, an empty path, or one carrying a control character", () => {
    const spec = DEFAULT_WORKSPACE_HOST_AGENT_VERIFICATION_PROBES.claude[0];
    for (const bad of [
      "claude",
      "",
      "/",
      "./bin/claude",
      `/usr/bin/claude${String.fromCharCode(0)}/etc/passwd`,
      `/usr/bin/claude${String.fromCharCode(10)}/usr/bin/whoami`,
    ]) {
      expect(() => applyWorkspaceHostAgentRuntimePath(spec, bad)).toThrow(
        /absolute path free of control characters/,
      );
    }
  });

  it("leaves the spec untouched when no path is attested for that agent", () => {
    const spec = DEFAULT_WORKSPACE_HOST_AGENT_VERIFICATION_PROBES.claude[0];
    expect(applyWorkspaceHostAgentRuntimePath(spec, undefined)).toBe(spec);
  });
});
