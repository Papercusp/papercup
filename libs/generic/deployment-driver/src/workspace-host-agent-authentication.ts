/**
 * Real, non-interactive authenticated-account probes for the three agents a workspace host is
 * required to have signed in (P-046 / WI-41711).
 *
 * THE GAP THIS CLOSES. `WorkspaceHostInitializationCanaryEvidence.agents` carries
 * `{ claude: { authenticated: true }, codex: {…}, omp: {…} }`, and
 * `validateWorkspaceHostInitializationCanary` checks that those booleans are `true`. Nothing
 * derived them from anything. The type makes `false` unrepresentable, so the validator's agent
 * check could only ever fail if a caller went out of its way to construct invalid evidence —
 * i.e. a green canary verdict proved nothing at all about whether Claude, Codex or OMP had
 * actually authenticated. This module makes each boolean the OUTPUT of a probe that has to
 * succeed, so the verdict becomes falsifiable.
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
 *   omp    → `usage --json --redact` ("Show provider usage limits for every authenticated
 *            account"; `--redact` shortens account ids to a unique prefix, which is exactly the
 *            non-secret discriminator this contract wants, produced by the tool itself)
 * A probe reaches the agent's real authenticated surface; it is not a version check. `--version`
 * would pass on a host where nobody had ever signed in, which is the precise failure the canary
 * exists to catch.
 */
import { spawn as nodeSpawn } from 'node:child_process';
import { createHash } from 'node:crypto';

import { assertWorkspaceHostSecretIsolation } from './workspace-host-test-harness';

export const WORKSPACE_HOST_AGENT_AUTHENTICATION_CONTRACT_VERSION =
  'papercusp-workspace-host-agent-authentication-v1';

export const WORKSPACE_HOST_CANARY_AGENTS = ['claude', 'codex', 'omp'] as const;
export type WorkspaceHostCanaryAgent = (typeof WORKSPACE_HOST_CANARY_AGENTS)[number];

/**
 * How a probe's extracted subject may be published.
 *
 * `redacted` is reserved for output the TOOL ITSELF redacted (OMP's `--redact`); it is not a
 * promise the caller can make on a tool's behalf. Everything else digests, because we cannot
 * know whether an arbitrary agent CLI prints a full email, an org name, or a key prefix.
 */
export type WorkspaceHostAgentSubjectDisclosure = 'redacted' | 'digest';

export interface WorkspaceHostAgentAuthenticationProbeSpec {
  readonly agent: WorkspaceHostCanaryAgent;
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
  readonly subjectPattern: RegExp;
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
 * `subjectPattern` is deliberately permissive about surrounding prose and strict about the shape
 * of the thing it captures, because the prose is what churns between CLI releases.
 */
export const DEFAULT_WORKSPACE_HOST_AGENT_AUTHENTICATION_PROBES: Readonly<
  Record<WorkspaceHostCanaryAgent, WorkspaceHostAgentAuthenticationProbeSpec>
> = {
  claude: {
    agent: 'claude',
    command: 'claude',
    args: ['auth', 'status'],
    endpoint: 'https://api.anthropic.com',
    // An email, or an account/organization identifier, whichever the status line reports.
    // The separator class deliberately EXCLUDES alphanumerics: a `\D`-style separator matches
    // letters, so a greedy run would swallow the subject itself and capture only its tail.
    subjectPattern: SUBJECT_PATTERN,
    subjectDisclosure: 'digest',
  },
  codex: {
    agent: 'codex',
    command: 'codex',
    args: ['login', 'status'],
    endpoint: 'https://api.openai.com',
    subjectPattern: SUBJECT_PATTERN,
    subjectDisclosure: 'digest',
  },
  omp: {
    agent: 'omp',
    command: 'omp',
    args: ['usage', '--json', '--redact'],
    endpoint: 'papercusp-omp-broker',
    // `--redact` already reduces account ids to a shortest-unique prefix, so the captured value
    // is publishable as-is; this reads the first account id out of the JSON report.
    subjectPattern: /"(?:account|accountId|account_id)"\s*:\s*"([^"\\]{1,120})"/,
    subjectDisclosure: 'redacted',
  },
};

const DEFAULT_PROBE_TIMEOUT_MS = 60_000;
const MAX_PROBE_OUTPUT_BYTES = 512 * 1024;

export interface WorkspaceHostAgentProbeInvocation {
  readonly command: string;
  readonly args: readonly string[];
  readonly timeoutMs: number;
}

export interface WorkspaceHostAgentProbeOutcome {
  readonly exitCode: number;
  /** Consumed in-process only. It is never copied into evidence. */
  readonly stdout: string;
}

export interface WorkspaceHostAgentProbeRunner {
  run(invocation: WorkspaceHostAgentProbeInvocation): Promise<WorkspaceHostAgentProbeOutcome>;
}

/** Public, secret-isolated evidence for one agent. */
export interface WorkspaceHostAgentAuthenticationEvidence {
  readonly contractVersion: typeof WORKSPACE_HOST_AGENT_AUTHENTICATION_CONTRACT_VERSION;
  readonly agent: WorkspaceHostCanaryAgent;
  readonly authenticated: boolean;
  readonly endpoint: string;
  readonly exitStatus: number;
  readonly observedAt: string;
  /** Present only for a `redacted` probe; the tool produced the redaction, not us. */
  readonly subject?: string;
  /** Always present on a successful probe: a stable, non-reversible account discriminator. */
  readonly subjectDigest?: string;
  readonly subjectDisclosure: WorkspaceHostAgentSubjectDisclosure;
  /** Populated only on failure, and only with a fixed reason code — never CLI output. */
  readonly failure?: WorkspaceHostAgentProbeFailureReason;
}

export type WorkspaceHostAgentProbeFailureReason =
  | 'non-zero-exit'
  | 'no-authenticated-subject'
  | 'probe-error';

export function workspaceHostAgentSubjectDigest(subject: string): string {
  return createHash('sha256').update(subject).digest('hex').slice(0, 16);
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

  run(invocation: WorkspaceHostAgentProbeInvocation): Promise<WorkspaceHostAgentProbeOutcome> {
    return new Promise((resolve, reject) => {
      const child = this.spawnImpl(invocation.command, [...invocation.args], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
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
          child.kill('SIGKILL');
          reject(new Error(`agent authentication probe timed out after ${invocation.timeoutMs}ms`));
        });
      }, invocation.timeoutMs);

      child.stdout?.on('data', (chunk: Buffer | string) => {
        const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
        bytes += Buffer.byteLength(text);
        if (bytes > MAX_PROBE_OUTPUT_BYTES) {
          finish(() => {
            child.kill('SIGKILL');
            reject(new Error('agent authentication probe produced too much output'));
          });
          return;
        }
        stdout += text;
      });
      // stderr is drained so the child never blocks on a full pipe, and discarded so it cannot
      // reach evidence by any route.
      child.stderr?.resume();
      child.on('error', (error) => finish(() => reject(error)));
      child.on('close', (code) =>
        finish(() => resolve({ exitCode: typeof code === 'number' ? code : 1, stdout })),
      );
    });
  }
}

export interface ProbeWorkspaceHostAgentInput {
  readonly spec: WorkspaceHostAgentAuthenticationProbeSpec;
  readonly runner: WorkspaceHostAgentProbeRunner;
  readonly now: () => Date;
}

/** Run one probe and reduce it to publishable evidence. */
export async function probeWorkspaceHostAgentAuthentication(
  input: ProbeWorkspaceHostAgentInput,
): Promise<WorkspaceHostAgentAuthenticationEvidence> {
  const { spec, runner, now } = input;
  const base = {
    contractVersion: WORKSPACE_HOST_AGENT_AUTHENTICATION_CONTRACT_VERSION,
    agent: spec.agent,
    endpoint: spec.endpoint,
    subjectDisclosure: spec.subjectDisclosure,
  } as const;

  let outcome: WorkspaceHostAgentProbeOutcome;
  try {
    outcome = await runner.run({
      command: spec.command,
      args: spec.args,
      timeoutMs: spec.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS,
    });
  } catch {
    // The thrown error may carry a command line or CLI text, so it is reduced to a code here and
    // never surfaced. A caller that needs to debug reads the host's own logs.
    return {
      ...base,
      authenticated: false,
      exitStatus: -1,
      observedAt: now().toISOString(),
      failure: 'probe-error',
    };
  }

  const observedAt = now().toISOString();
  if (outcome.exitCode !== 0) {
    return {
      ...base,
      authenticated: false,
      exitStatus: outcome.exitCode,
      observedAt,
      failure: 'non-zero-exit',
    };
  }

  const match = spec.subjectPattern.exec(outcome.stdout);
  const subject = match?.[1]?.trim();
  if (!subject) {
    return {
      ...base,
      authenticated: false,
      exitStatus: outcome.exitCode,
      observedAt,
      failure: 'no-authenticated-subject',
    };
  }

  const evidence: WorkspaceHostAgentAuthenticationEvidence = {
    ...base,
    authenticated: true,
    exitStatus: outcome.exitCode,
    observedAt,
    subjectDigest: workspaceHostAgentSubjectDigest(subject),
    ...(spec.subjectDisclosure === 'redacted' ? { subject } : {}),
  };
  assertWorkspaceHostSecretIsolation(
    evidence,
    `workspaceHost.agentAuthentication.${spec.agent}`,
  );
  return evidence;
}

export interface WorkspaceHostAgentAuthenticationReport {
  readonly contractVersion: typeof WORKSPACE_HOST_AGENT_AUTHENTICATION_CONTRACT_VERSION;
  readonly observedAt: string;
  readonly allAuthenticated: boolean;
  readonly agents: Readonly<
    Record<WorkspaceHostCanaryAgent, WorkspaceHostAgentAuthenticationEvidence>
  >;
}

export interface ProbeWorkspaceHostAgentsInput {
  readonly runner: WorkspaceHostAgentProbeRunner;
  readonly probes?: Partial<
    Record<WorkspaceHostCanaryAgent, WorkspaceHostAgentAuthenticationProbeSpec>
  >;
  readonly now?: () => Date;
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
): Promise<WorkspaceHostAgentAuthenticationReport> {
  const now = input.now ?? (() => new Date());
  const agents: Partial<
    Record<WorkspaceHostCanaryAgent, WorkspaceHostAgentAuthenticationEvidence>
  > = {};
  for (const agent of WORKSPACE_HOST_CANARY_AGENTS) {
    const spec =
      input.probes?.[agent] ?? DEFAULT_WORKSPACE_HOST_AGENT_AUTHENTICATION_PROBES[agent];
    if (spec.agent !== agent) {
      throw new Error(`agent probe for '${agent}' declares agent '${spec.agent}'`);
    }
    agents[agent] = await probeWorkspaceHostAgentAuthentication({ spec, runner: input.runner, now });
  }
  const complete = agents as Record<
    WorkspaceHostCanaryAgent,
    WorkspaceHostAgentAuthenticationEvidence
  >;
  const report: WorkspaceHostAgentAuthenticationReport = {
    contractVersion: WORKSPACE_HOST_AGENT_AUTHENTICATION_CONTRACT_VERSION,
    observedAt: now().toISOString(),
    allAuthenticated: WORKSPACE_HOST_CANARY_AGENTS.every(
      (agent) => complete[agent].authenticated,
    ),
    agents: complete,
  };
  assertWorkspaceHostSecretIsolation(report, 'workspaceHost.agentAuthentication.report');
  return report;
}
