/**
 * Real, non-interactive readiness probes for the three agents a workspace host must be able to
 * execute (P-046 / WI-41711 / D-230).
 *
 * THE GAP THIS CLOSES. `WorkspaceHostInitializationCanaryEvidence.agents` carries
 * `{ claude: { ready: true, verificationKind: … }, … }`, and
 * `validateWorkspaceHostInitializationCanary` checks that readiness. Nothing originally derived
 * the old authenticated booleans from anything. The type makes `false` unrepresentable, so the validator's agent
 * check could only ever fail if a caller went out of its way to construct invalid evidence —
 * i.e. a green canary verdict proved nothing at all about whether Claude, Codex or OMP had
 * actually authenticated. This module makes readiness the OUTPUT of a probe that has to succeed,
 * and records whether the proof was an authenticated account or real local inference, so the
 * verdict becomes falsifiable without claiming that a no-auth local model is "authenticated".
 *
 * WHAT A PROBE MAY EMIT. Only the four discriminators the receipt contract allows: which
 * account/subject answered, which endpoint was reached, the exit status, and when. Raw stdout
 * NEVER escapes this module — the extraction regex runs in-process and only its captured group
 * is considered, and even that is emitted as a digest unless the probe declares its own output
 * already redacted. That ordering matters: a probe that emitted stdout and redacted afterwards
 * would leak on every path that logged the intermediate value.
 *
 * WHY THESE COMMANDS. Each default is a documented non-interactive status verb of the agent's
 * OWN CLI, read from its `--help` rather than assumed:
 *   claude → `auth status`      ("Show authentication status")
 *   codex  → `login status`     ("Show login status")
 *   omp    → first `usage --json --redact` for a hosted account; if no account answers, invoke
 *            OMP itself non-interactively against loopback Ollama and require a model-produced
 *            marker. A version check, model listing, or broker registration is not inference.
 * A probe reaches the agent's real authenticated surface; it is not a version check. `--version`
 * would pass on a host where nobody had ever signed in, which is the precise failure the canary
 * exists to catch.
 */
import { spawn as nodeSpawn } from "node:child_process";
import { createHash } from "node:crypto";

import { assertWorkspaceHostSecretIsolation } from "./workspace-host-test-harness";

export const WORKSPACE_HOST_AGENT_VERIFICATION_CONTRACT_VERSION =
  "papercusp-workspace-host-agent-verification-v2";

export const WORKSPACE_HOST_CANARY_AGENTS = ["claude", "codex", "omp"] as const;
export type WorkspaceHostCanaryAgent =
  (typeof WORKSPACE_HOST_CANARY_AGENTS)[number];

export type WorkspaceHostAgentVerificationKind =
  | "authenticated-account"
  | "local-inference";

/**
 * How a probe's extracted subject may be published.
 *
 * `redacted` is reserved for output the TOOL ITSELF redacted (OMP's `--redact`); it is not a
 * promise the caller can make on a tool's behalf. Everything else digests, because we cannot
 * know whether an arbitrary agent CLI prints a full email, an org name, or a key prefix.
 */
export type WorkspaceHostAgentSubjectDisclosure = "redacted" | "digest";

export interface WorkspaceHostAgentVerificationProbeSpec {
  readonly agent: WorkspaceHostCanaryAgent;
  readonly verificationKind: WorkspaceHostAgentVerificationKind;
  /** Absolute path (or PATH-resolvable name) of the agent CLI on the host. */
  readonly command: string;
  readonly args: readonly string[];
  /** The authenticated surface this probe reaches; recorded as evidence, never derived. */
  readonly endpoint: string;
  /**
   * Extracts the account/subject discriminator from stdout. The FIRST capture group is the
   * subject. A probe whose pattern does not match is a FAILED probe, not an authenticated one
   * with an unknown subject — "exit 0 but unparseable" is the shape a broken or reworded CLI
   * takes, and treating it as success is how an unbacked boolean comes back.
   */
  readonly proofPattern: RegExp;
  readonly subjectDisclosure: WorkspaceHostAgentSubjectDisclosure;
  readonly timeoutMs?: number;
}

/**
 * Matches "<label><separator><subject>" in a status line, where the subject is an email or a
 * bare account identifier.
 *
 * The separator class is `[^A-Za-z0-9]`, NOT `\D`. `\D` means "not a digit", so it matches
 * letters — a greedy run of it consumes the subject and backtracks to capture only the tail
 * ("ai" of "canary@papercup.ai"), producing a stable-looking digest of the wrong string. A class
 * that cannot consume the capture's own first character makes that failure impossible rather
 * than merely unlikely.
 */
const SUBJECT_PATTERN =
  /(?:account|email|organi[sz]ation|org|logged in as|signed in as)\b[^A-Za-z0-9]{0,24}([A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}|[A-Za-z0-9][A-Za-z0-9._-]{2,63})/i;

/**
 * The defaults, grounded in each CLI's own documented help output.
 *
 * `proofPattern` is deliberately permissive about surrounding prose and strict about the shape
 * of the thing it captures, because the prose is what churns between CLI releases.
 */
export const WORKSPACE_HOST_OMP_LOCAL_MODEL = "qwen2.5-coder:0.5b";
export const WORKSPACE_HOST_OMP_LOCAL_INFERENCE_MARKER =
  "P046_OMP_LOCAL_INFERENCE_OK";

export const DEFAULT_WORKSPACE_HOST_AGENT_VERIFICATION_PROBES: Readonly<
  Record<
    WorkspaceHostCanaryAgent,
    readonly WorkspaceHostAgentVerificationProbeSpec[]
  >
> = {
  claude: [
    {
      agent: "claude",
      verificationKind: "authenticated-account",
      command: "claude",
      args: ["auth", "status"],
      endpoint: "https://api.anthropic.com",
      // An email, or an account/organization identifier, whichever the status line reports.
      // The separator class deliberately EXCLUDES alphanumerics: a `\D`-style separator matches
      // letters, so a greedy run would swallow the subject itself and capture only its tail.
      proofPattern: SUBJECT_PATTERN,
      subjectDisclosure: "digest",
    },
  ],
  codex: [
    {
      agent: "codex",
      verificationKind: "authenticated-account",
      command: "codex",
      args: ["login", "status"],
      endpoint: "https://api.openai.com",
      proofPattern: SUBJECT_PATTERN,
      subjectDisclosure: "digest",
    },
  ],
  omp: [
    {
      agent: "omp",
      verificationKind: "authenticated-account",
      command: "omp",
      args: ["usage", "--json", "--redact"],
      endpoint: "papercusp-omp-broker",
      // `--redact` already reduces account ids to a shortest-unique prefix, so the captured value
      // is publishable as-is; this reads the first account id out of the JSON report.
      proofPattern:
        /"(?:account|accountId|account_id)"\s*:\s*"([^"\\]{1,120})"/,
      subjectDisclosure: "redacted",
    },
    {
      agent: "omp",
      verificationKind: "local-inference",
      command: "omp",
      args: [
        "--model",
        `ollama/${WORKSPACE_HOST_OMP_LOCAL_MODEL}`,
        "--print",
        "--no-tools",
        "--no-session",
        "--no-extensions",
        "--no-skills",
        "--no-rules",
        "--mode",
        "text",
        `Reply with exactly ${WORKSPACE_HOST_OMP_LOCAL_INFERENCE_MARKER} and nothing else.`,
      ],
      endpoint: "http://127.0.0.1:11434",
      proofPattern: new RegExp(
        `^\\s*(${WORKSPACE_HOST_OMP_LOCAL_INFERENCE_MARKER})\\s*$`,
      ),
      subjectDisclosure: "digest",
      timeoutMs: 180_000,
    },
  ],
};

const DEFAULT_PROBE_TIMEOUT_MS = 60_000;
const MAX_PROBE_OUTPUT_BYTES = 512 * 1024;

export interface WorkspaceHostAgentProbeInvocation {
  readonly command: string;
  readonly args: readonly string[];
  readonly timeoutMs: number;
  /** When supplied, this is the COMPLETE child environment, not an overlay on the parent. */
  readonly env?: Readonly<Record<string, string>>;
  /** Execute the probe as this real non-root account, not merely with identity-shaped env vars. */
  readonly runAsUser?: string;
}

export interface WorkspaceHostAgentProbeOutcome {
  readonly exitCode: number;
  /** Consumed in-process only. It is never copied into evidence. */
  readonly stdout: string;
}

export interface WorkspaceHostAgentProbeRunner {
  run(
    invocation: WorkspaceHostAgentProbeInvocation,
  ): Promise<WorkspaceHostAgentProbeOutcome>;
}

export interface WorkspaceHostAgentProbeProcess {
  readonly command: string;
  readonly args: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
}

const WORKSPACE_HOST_PROBE_RUNUSER = "/usr/sbin/runuser";
const WORKSPACE_HOST_PROBE_ENV = "/usr/bin/env";
const WORKSPACE_HOST_PROBE_LAUNCH_PATH = "/usr/sbin:/usr/bin:/sbin:/bin";
const WORKSPACE_HOST_PROBE_ACCOUNT = /^[a-z_][a-z0-9_-]{0,30}$/;
const WORKSPACE_HOST_PROBE_ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Build the exact process boundary for a probe.
 *
 * `HOME`/`USER` alone do not change a Unix identity. Production probes enter through a root-owned
 * initializer, so the runner must drop to the workspace account before the CLI reads its 0600
 * files. `env -i` then gives that account the caller's complete allowlisted environment and makes
 * ambient controller/service credentials unavailable even if PAM or runuser would preserve them.
 */
export function buildWorkspaceHostAgentProbeProcess(
  invocation: WorkspaceHostAgentProbeInvocation,
): WorkspaceHostAgentProbeProcess {
  if (!invocation.runAsUser) {
    return {
      command: invocation.command,
      args: invocation.args,
      ...(invocation.env ? { env: invocation.env } : {}),
    };
  }
  if (
    !WORKSPACE_HOST_PROBE_ACCOUNT.test(invocation.runAsUser) ||
    invocation.runAsUser === "root"
  ) {
    throw new Error(
      "agent authentication probe runAsUser must be a non-root Linux account",
    );
  }
  if (!invocation.env) {
    throw new Error(
      "agent authentication probe runAsUser requires a complete environment",
    );
  }
  const environment = Object.entries(invocation.env).map(([key, value]) => {
    if (!WORKSPACE_HOST_PROBE_ENV_NAME.test(key) || /\0/.test(value)) {
      throw new Error(
        "agent authentication probe environment is not safe for env -i",
      );
    }
    return `${key}=${value}`;
  });
  return {
    command: WORKSPACE_HOST_PROBE_RUNUSER,
    args: [
      "--user",
      invocation.runAsUser,
      "--",
      WORKSPACE_HOST_PROBE_ENV,
      "-i",
      "--",
      ...environment,
      invocation.command,
      ...invocation.args,
    ],
    // This environment belongs only to the trusted runuser launcher. The target receives the
    // exact allowlist above after env -i; nothing from the initializer process is inherited.
    env: { PATH: WORKSPACE_HOST_PROBE_LAUNCH_PATH },
  };
}

/** Public, secret-isolated evidence for one agent. */
export interface WorkspaceHostAgentVerificationEvidence {
  readonly contractVersion: typeof WORKSPACE_HOST_AGENT_VERIFICATION_CONTRACT_VERSION;
  readonly agent: WorkspaceHostCanaryAgent;
  readonly ready: boolean;
  readonly verificationKind: WorkspaceHostAgentVerificationKind;
  readonly endpoint: string;
  readonly exitStatus: number;
  readonly observedAt: string;
  /** Present only for a `redacted` probe; the tool produced the redaction, not us. */
  readonly subject?: string;
  /** Always present on a successful probe: a stable digest of the parsed proof value. */
  readonly proofDigest?: string;
  readonly subjectDisclosure: WorkspaceHostAgentSubjectDisclosure;
  /** Populated only on failure, and only with a fixed reason code — never CLI output. */
  readonly failure?: WorkspaceHostAgentProbeFailureReason;
}

export type WorkspaceHostAgentProbeFailureReason =
  | "non-zero-exit"
  | "no-verification-proof"
  | "probe-error";

export function workspaceHostAgentSubjectDigest(subject: string): string {
  return createHash("sha256").update(subject).digest("hex").slice(0, 16);
}

/**
 * Node runner: closes stdin so an interactive prompt cannot block, bounds the output, and kills
 * the tree on timeout.
 *
 * Closing stdin is the load-bearing part. A CLI that decides to prompt for a login finds EOF and
 * exits non-zero instead of hanging until the timeout, so "nobody is signed in" is reported as a
 * clean failure rather than as a probe that mysteriously took a minute.
 */
export class NodeWorkspaceHostAgentProbeRunner implements WorkspaceHostAgentProbeRunner {
  constructor(private readonly spawnImpl: typeof nodeSpawn = nodeSpawn) {}

  run(
    invocation: WorkspaceHostAgentProbeInvocation,
  ): Promise<WorkspaceHostAgentProbeOutcome> {
    return new Promise((resolve, reject) => {
      let processInput: WorkspaceHostAgentProbeProcess;
      try {
        processInput = buildWorkspaceHostAgentProbeProcess(invocation);
      } catch (error) {
        reject(error);
        return;
      }
      const child = this.spawnImpl(
        processInput.command,
        [...processInput.args],
        {
          stdio: ["ignore", "pipe", "pipe"],
          ...(processInput.env ? { env: { ...processInput.env } } : {}),
        },
      );
      let stdout = "";
      let bytes = 0;
      let settled = false;

      const finish = (fn: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        fn();
      };

      const timer = setTimeout(() => {
        finish(() => {
          child.kill("SIGKILL");
          reject(
            new Error(
              `agent authentication probe timed out after ${invocation.timeoutMs}ms`,
            ),
          );
        });
      }, invocation.timeoutMs);

      child.stdout?.on("data", (chunk: Buffer | string) => {
        const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
        bytes += Buffer.byteLength(text);
        if (bytes > MAX_PROBE_OUTPUT_BYTES) {
          finish(() => {
            child.kill("SIGKILL");
            reject(
              new Error("agent authentication probe produced too much output"),
            );
          });
          return;
        }
        stdout += text;
      });
      // stderr is drained so the child never blocks on a full pipe, and discarded so it cannot
      // reach evidence by any route.
      child.stderr?.resume();
      child.on("error", (error) => finish(() => reject(error)));
      child.on("close", (code) =>
        finish(() =>
          resolve({ exitCode: typeof code === "number" ? code : 1, stdout }),
        ),
      );
    });
  }
}

export interface ProbeWorkspaceHostAgentInput {
  readonly spec: WorkspaceHostAgentVerificationProbeSpec;
  readonly runner: WorkspaceHostAgentProbeRunner;
  readonly now: () => Date;
  readonly env?: Readonly<Record<string, string>>;
  readonly runAsUser?: string;
}

/** Run one probe and reduce it to publishable evidence. */
export async function probeWorkspaceHostAgentVerification(
  input: ProbeWorkspaceHostAgentInput,
): Promise<WorkspaceHostAgentVerificationEvidence> {
  const { spec, runner, now } = input;
  const base = {
    contractVersion: WORKSPACE_HOST_AGENT_VERIFICATION_CONTRACT_VERSION,
    agent: spec.agent,
    verificationKind: spec.verificationKind,
    endpoint: spec.endpoint,
    subjectDisclosure: spec.subjectDisclosure,
  } as const;

  let outcome: WorkspaceHostAgentProbeOutcome;
  try {
    outcome = await runner.run({
      command: spec.command,
      args: spec.args,
      timeoutMs: spec.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS,
      ...(input.env ? { env: input.env } : {}),
      ...(input.runAsUser ? { runAsUser: input.runAsUser } : {}),
    });
  } catch {
    // The thrown error may carry a command line or CLI text, so it is reduced to a code here and
    // never surfaced. A caller that needs to debug reads the host's own logs.
    return {
      ...base,
      ready: false,
      exitStatus: -1,
      observedAt: now().toISOString(),
      failure: "probe-error",
    };
  }

  const observedAt = now().toISOString();
  if (outcome.exitCode !== 0) {
    return {
      ...base,
      ready: false,
      exitStatus: outcome.exitCode,
      observedAt,
      failure: "non-zero-exit",
    };
  }

  const match = spec.proofPattern.exec(outcome.stdout);
  const proof = match?.[1]?.trim();
  if (!proof) {
    return {
      ...base,
      ready: false,
      exitStatus: outcome.exitCode,
      observedAt,
      failure: "no-verification-proof",
    };
  }

  const evidence: WorkspaceHostAgentVerificationEvidence = {
    ...base,
    ready: true,
    exitStatus: outcome.exitCode,
    observedAt,
    proofDigest: workspaceHostAgentSubjectDigest(proof),
    ...(spec.verificationKind === "authenticated-account" &&
    spec.subjectDisclosure === "redacted"
      ? { subject: proof }
      : {}),
  };
  assertWorkspaceHostSecretIsolation(
    evidence,
    `workspaceHost.agentAuthentication.${spec.agent}`,
  );
  return evidence;
}

export interface WorkspaceHostAgentVerificationReport {
  readonly contractVersion: typeof WORKSPACE_HOST_AGENT_VERIFICATION_CONTRACT_VERSION;
  readonly observedAt: string;
  readonly allReady: boolean;
  readonly agents: Readonly<
    Record<WorkspaceHostCanaryAgent, WorkspaceHostAgentVerificationEvidence>
  >;
}

/**
 * True when any code unit is a C0 control or DEL.
 *
 * A codepoint scan rather than a character-class regex on purpose: the class has to be written
 * with the control characters themselves, and a raw control byte in source makes ripgrep treat the
 * file as binary and skip it — so the one guard nobody can grep for is the guard about ungreppable
 * bytes. This says the same thing in characters that survive a diff.
 */
function containsControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/**
 * Point one probe spec at the vendor runtime path recorded for its agent (D-259 Defect 2).
 *
 * The default specs name each CLI by BARE NAME, which the probe resolves against its search path.
 * On a real workspace host that path leads with the release bundle's own `bin/`, and the files
 * there are launcher WRAPPERS named after the agent CLIs — they do not implement `auth status`, so
 * a probe that found one measured the wrapper and reported a credential fault that no credential
 * could fix. That is D-247, and it read as a probe bug across three sessions precisely because the
 * probe looked correct: it ran the name it meant to run. Provisioning resolves each vendor binary
 * after installing it and records the ABSOLUTE path; substituting that path here is what makes the
 * probe exec the vendor CLI instead of whatever the search path happens to find first.
 *
 * A MISSING path is deliberately not an error. A host provisioned before those installs existed
 * genuinely has no vendor runtime, and the honest outcome there is a probe that runs and FAILS —
 * "this host cannot authenticate an agent" is the finding the canary exists to surface. Throwing
 * instead would re-file that finding as an infrastructure error and hide it.
 */
export function applyWorkspaceHostAgentRuntimePath(
  spec: WorkspaceHostAgentVerificationProbeSpec,
  runtimePath: string | undefined,
): WorkspaceHostAgentVerificationProbeSpec {
  if (runtimePath === undefined) return spec;
  // Control characters are rejected rather than escaped: the path is interpolated into the
  // `env -i --` argv the probe launches with, so a value carrying a NUL or a newline is a
  // truncated or split ARGUMENT, not a path that merely fails to exist.
  if (
    !runtimePath.startsWith("/") ||
    runtimePath.length < 2 ||
    containsControlCharacter(runtimePath)
  ) {
    throw new Error(
      `agent '${spec.agent}' runtime path must be an absolute path free of control characters`,
    );
  }
  return { ...spec, command: runtimePath };
}

export interface ProbeWorkspaceHostAgentsInput {
  readonly runner: WorkspaceHostAgentProbeRunner;
  readonly probes?: Partial<
    Record<
      WorkspaceHostCanaryAgent,
      readonly WorkspaceHostAgentVerificationProbeSpec[]
    >
  >;
  readonly now?: () => Date;
  /** Exact environment shared by all three sequential probes. */
  readonly env?: Readonly<Record<string, string>>;
  /** Real Unix account shared by all three sequential probes. */
  readonly runAsUser?: string;
  /**
   * Absolute path of each agent's VENDOR runtime, as resolved on the host after install.
   *
   * When present for an agent it REPLACES that agent's probe `command` — every spec for that
   * agent, so OMP's hosted-account and local-inference probes both exec the same binary. Absent
   * entries fall back to the spec's own command; see `applyWorkspaceHostAgentRuntimePath` for why
   * that fallback is a fallback and not a failure.
   */
  readonly runtimePaths?: Partial<Record<WorkspaceHostCanaryAgent, string>>;
}

/**
 * Probe all three agents.
 *
 * Sequential, not parallel: three CLIs racing for the same credential store or keychain is a
 * source of spurious failures, and a probe suite that is flaky is worse than no probe suite —
 * it teaches whoever reads the canary to re-run until it passes.
 */
export async function probeWorkspaceHostAgents(
  input: ProbeWorkspaceHostAgentsInput,
): Promise<WorkspaceHostAgentVerificationReport> {
  const now = input.now ?? (() => new Date());
  const agents: Partial<
    Record<WorkspaceHostCanaryAgent, WorkspaceHostAgentVerificationEvidence>
  > = {};
  for (const agent of WORKSPACE_HOST_CANARY_AGENTS) {
    const specs =
      input.probes?.[agent] ??
      DEFAULT_WORKSPACE_HOST_AGENT_VERIFICATION_PROBES[agent];
    if (specs.length === 0) {
      throw new Error(`agent '${agent}' has no verification probes`);
    }
    for (const spec of specs) {
      if (spec.agent !== agent) {
        throw new Error(
          `agent probe for '${agent}' declares agent '${spec.agent}'`,
        );
      }
      agents[agent] = await probeWorkspaceHostAgentVerification({
        // Applied AFTER the agent-mismatch check above, so a mis-declared spec is refused as a
        // mis-declared spec rather than silently rewritten to point at another agent's binary.
        spec: applyWorkspaceHostAgentRuntimePath(
          spec,
          input.runtimePaths?.[agent],
        ),
        runner: input.runner,
        now,
        ...(input.env ? { env: input.env } : {}),
        ...(input.runAsUser ? { runAsUser: input.runAsUser } : {}),
      });
      if (agents[agent]?.ready) break;
    }
  }
  const complete = agents as Record<
    WorkspaceHostCanaryAgent,
    WorkspaceHostAgentVerificationEvidence
  >;
  const report: WorkspaceHostAgentVerificationReport = {
    contractVersion: WORKSPACE_HOST_AGENT_VERIFICATION_CONTRACT_VERSION,
    observedAt: now().toISOString(),
    allReady: WORKSPACE_HOST_CANARY_AGENTS.every(
      (agent) => complete[agent].ready,
    ),
    agents: complete,
  };
  assertWorkspaceHostSecretIsolation(
    report,
    "workspaceHost.agentAuthentication.report",
  );
  return report;
}
