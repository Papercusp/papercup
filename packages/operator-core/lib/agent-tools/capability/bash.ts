/**
 * capability:bash — run a shell command. A THIN wrapper over a real `bash -c`
 * (D-004 — wraps real execution, no reimplementation), routed through the
 * shared endpoint dispatch so policy / capability-envelope / telemetry apply
 * (P-010, `agent-capability-confinement-2026-06-13`). It replicates the native
 * Bash tool's ergonomics: combined output streaming (the `output` event),
 * truncation/overflow-to-file, and async/background jobs (`run_in_background`).
 *
 * Foreground: streams output, enforces a short wall-clock timeout, returns the
 * (head+tail-trimmed-if-large) combined output + the spill-log path.
 * Background: returns a `bash_id` and durable `task_id` immediately; read
 * incremental output with `capability:bash_output` and stop it with
 * `capability:bash_kill` — the way a 5-minute build is run without holding one
 * blocking request. The task id remains observable through the task ledger if
 * the operator restarts and its in-memory bash-job map is lost.
 *
 * BOTH modes have a deadline; they do NOT share one (WI-6677). The background
 * default is hours, not the foreground's two minutes, because a background job
 * is by definition meant to outlive the call — see the constants in
 * `bash-jobs.ts` for why inheriting the foreground pair was a trap.
 */

import { isAbsolute, resolve } from 'node:path';
import { z } from 'zod';
import { defineTool, AGENT_ROLES, isOperatorConfigWriteRole } from '@papercusp/agent-mcp';
import {
  DEFAULT_BACKGROUND_TIMEOUT_MS,
  DEFAULT_TIMEOUT_MS,
  detectBufferingLastStage,
  detectSelfOutputRedirect,
  formatBufferingPipelineAdvice,
  formatSelfRedirectAdvice,
  MAX_BACKGROUND_TIMEOUT_MS,
  MAX_TIMEOUT_MS,
  runForeground,
  startBackground,
} from './bash-jobs';
import {
  FOREGROUND_TIMEOUT_CEILING_MS,
  clampForegroundTimeoutMs,
  foregroundTimeoutHint,
} from './foreground-transport-cap';
import { typecheckHeapLaunchWarning } from './background-typecheck-verdict';
import { capabilityExecSandboxEnabled } from './exec-sandbox';
import { displayForHive } from '../computer/desktop-lease';
import { resolveConcreteHarnessSlug } from '../_harness-scope';
import { resolveCapabilityBaseDir } from './base-dir';
import { maskIntegrationKey, readIntegrationKey } from '../../integration-credentials';
import { RIPGREP_SCOPE_GUIDANCE } from '../../code-intelligence/contracts.ts';
import { resolveAgentIdentity, type ResolveIdentityCtx } from '../coordination/identity';
import { resolveOwnerGoal } from '../coordination/agent-goal-sources';
import { readAgentStateStamp } from '../../agent-state-stamp';

const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const INTEGRATION_KEY_NAME_RE = /^[A-Z][A-Z0-9_]*$/;
const RESERVED_INTEGRATION_ENV_NAMES = new Set([
  'PATH',
  'HOME',
  'TMPDIR',
  'TMP',
  'TEMP',
  'DISPLAY',
  'XAUTHORITY',
  'WAYLAND_DISPLAY',
]);

const MIN_TIMEOUT_MS = 1_000;
const MIN_TIMEOUT_ERROR =
  `timeout must be at least ${MIN_TIMEOUT_MS}ms (1 second); timeout is expressed in milliseconds — ` +
  `for 20 seconds, pass 20000`;

export interface BashTaskProvenance {
  launchedBy: string;
  sessionId: string | null;
  harnessSlug: string | null;
  workItemId: string | null;
  planSlug: string | null;
  goalRef: string | null;
}

interface BashTaskProvenanceDeps {
  resolveIdentity: typeof resolveAgentIdentity;
  readStamp: typeof readAgentStateStamp;
  resolveGoal: typeof resolveOwnerGoal;
}

const DEFAULT_BASH_PROVENANCE_DEPS: BashTaskProvenanceDeps = {
  resolveIdentity: resolveAgentIdentity,
  readStamp: readAgentStateStamp,
  resolveGoal: resolveOwnerGoal,
};

/**
 * Resolve background-task provenance at the launch seam, while the caller's
 * stable identity and live goal are still available.  The task ledger cannot
 * reconstruct either from a child pid later.  Resolution is fail-soft: an
 * unattributable caller still gets a working shell, but never a fabricated
 * work-item association.
 */
export async function resolveBashTaskProvenance(
  ctx: ResolveIdentityCtx,
  harnessSlug: string | null,
  deps: BashTaskProvenanceDeps = DEFAULT_BASH_PROVENANCE_DEPS,
): Promise<BashTaskProvenance> {
  let ownerId: string | null = null;
  try {
    ownerId = deps.resolveIdentity(ctx).ownerId;
  } catch {
    ownerId = null;
  }

  let goalRef = ownerId ? deps.readStamp(ownerId).goalRef : null;
  if (ownerId && !goalRef) {
    goalRef = (await deps.resolveGoal(ownerId, 'self'))?.ref ?? null;
  }

  const workItemId = goalRef && /^(?:WI|EI|F)-[A-Za-z0-9._-]+$/.test(goalRef) ? goalRef : null;
  const planMatch = goalRef?.match(/^(?:plan:)?(.+?)#P-\d+$/) ?? null;
  const principalFallback = ctx.principal?.slug?.trim() || 'capability:bash';
  return {
    launchedBy: ownerId ?? principalFallback,
    sessionId: ownerId,
    harnessSlug,
    workItemId,
    planSlug: planMatch?.[1] ?? null,
    goalRef,
  };
}

const integrationEnvSchema = z
  .record(
    z.string().regex(ENV_NAME_RE, 'destination must be a valid environment variable name'),
    z.string().regex(INTEGRATION_KEY_NAME_RE, 'source must be a SCREAMING_SNAKE_CASE integration credential name'),
  )
  .refine((value) => Object.keys(value).length <= 16, 'integration_env accepts at most 16 entries')
  .refine(
    (value) => Object.keys(value).every((name) => !RESERVED_INTEGRATION_ENV_NAMES.has(name)),
    `integration_env cannot replace reserved process variables: ${[...RESERVED_INTEGRATION_ENV_NAMES].join(', ')}`,
  );

export default defineTool({
  name: 'capability:bash',
  description:
    'Run `bash -c` in the project dir; stream and spill large output to a log. Operator callers may bind redacted integration credentials.',
  guidance: {
    when:
      'Run builds, tests, checks, or scripts. For fixed-string searches, prefer `rg -F` when available or fall back to `grep -F`; use a shell-safe single-quoted argument because an unmatched backtick fails before either search tool runs. For repository regex searches, ' +
      `${RIPGREP_SCOPE_GUIDANCE} Do not run an unbounded search from the repository root. For jobs over 1–2 minutes use run_in_background:true → capability:bash_output; defaults are 4h/12h max.`,
    notWhen:
      'Use capability:read/write/edit for one-file operations and capability:git for git. Shell execution strips database credential environment variables, so use dev:pg_query for read-only operator DB queries.',
    chaining:
      'run_in_background:true returns bash_id + durable task_id → capability:bash_output { task_id }; stop with processes:kill { taskId }. Never push.',
    seeAlso: [
      'capability:bash_output (read a backgrounded run)',
      'capability:bash_kill (kill a backgrounded run)',
      'capability:git (git actions, gated as git)',
    ],
  },
  capability: 'capability:bash',
  requirePrincipal: false,
  agentRoles: [...AGENT_ROLES],
  // Wall-clock dispatch timeout must exceed the max command timeout so a long
  // foreground command can complete (background mode is preferred for those).
  timeoutSec: Math.floor(MAX_TIMEOUT_MS / 1000) + 30,
  // EI-18666279107998059: this handler awaits a child process for up to
  // MAX_TIMEOUT_MS (minutes) and never reads ctx.tx — without this, the host's
  // ambient workspace transaction sits idle for the whole exec and gets killed
  // by Postgres's idle_in_transaction_session_timeout (60s), surfacing as a
  // bare "write CONNECTION_CLOSED 127.0.0.1:6432" that correlates with call
  // duration, not the command. See ProjectedTool.skipWorkspaceTx.
  skipWorkspaceTx: true,
  events: { output: z.string().describe('text/plain') },
  args: z.object({
    command: z.string().min(1).describe('The bash command to run (passed to `bash -c`).'),
    description: z
      .string()
      .optional()
      .describe('5–10 word description of what the command does (for telemetry / the agent log).'),
    timeout: z
      .number()
      .int()
      .min(MIN_TIMEOUT_MS, MIN_TIMEOUT_ERROR)
      .max(MAX_BACKGROUND_TIMEOUT_MS)
      .optional()
      .describe(
        `Wall-clock timeout in ms (minimum ${MIN_TIMEOUT_MS}; values below one second are rejected to catch ` +
          `seconds-vs-milliseconds mistakes — 20 seconds = 20000ms). FOREGROUND: default ${DEFAULT_TIMEOUT_MS}, CLAMPED to ${FOREGROUND_TIMEOUT_CEILING_MS} — ` +
          `below the ~55s MCP transport cap, so a slow command returns an actionable timeout instead of an opaque ` +
          `transport failure. Raising it past the clamp does nothing: run anything longer with run_in_background. ` +
          `BACKGROUND (run_in_background): default ${DEFAULT_BACKGROUND_TIMEOUT_MS}, max ${MAX_BACKGROUND_TIMEOUT_MS} — ` +
          `not bound by the transport cap, but the whole confined task subtree IS terminated at its own deadline ` +
          `(systemd RuntimeMaxSec plus the local SIGTERM/SIGKILL path), ` +
          `so raise this for a job that legitimately runs longer. Deliberately daemonized descendants remain tracked ` +
          `inside the same task and share its deadline; use a dedicated service launcher for a different lifetime.`,
      ),
    run_in_background: z
      .boolean()
      .optional()
      .describe('Run detached; returns a bash_id immediately. Read output via capability:bash_output.'),
    cwd: z
      .string()
      .optional()
      .describe('Working dir (absolute, or relative to the project dir). Defaults to the project dir.'),
    integration_env: integrationEnvSchema
      .optional()
      .describe(
        'Operator-authority only. Map child environment variable names to encrypted setup:save_integration_key names, e.g. {"DEEPGRAM_API_KEY":"SIDESTAGE_DEEPGRAM_API_KEY"}. Raw values stay server-side, exist only in this child process, and are exact-value-redacted from events, results, background reads, and spill logs.',
      ),
  }),
  async handler(args, ctx) {
    const baseDir = resolveCapabilityBaseDir(ctx);
    const cwd = args.cwd ? (isAbsolute(args.cwd) ? args.cwd : resolve(baseDir, args.cwd)) : baseDir;
    // WI-6677: the default depends on the MODE. A background job is contractually
    // meant to outlive this call, so it must not inherit the short foreground
    // default — that made the tool SIGKILL exactly the long jobs it exists for.
    const requestedTimeoutMs =
      args.timeout ?? (args.run_in_background ? DEFAULT_BACKGROUND_TIMEOUT_MS : DEFAULT_TIMEOUT_MS);
    // EI-20645849301780712: clamp the FOREGROUND timeout below the ~55s MCP transport cap,
    // exactly as capability:inspect / testing:run / build:typecheck already do. Without it this
    // tool advertised a foreground window (default 120s, arg max 600s) that the transport can
    // never deliver: past ~55s the CLIENT abandons the call and reports a generic failure — the
    // same token a real non-zero exit produces — so the agent cannot tell "my command failed"
    // from "the transport gave up", and (because no abort reaches the child) the command may
    // still have run to completion invisibly. Clamped, the TOOL self-times-out first and returns
    // `status: 'timed_out'` plus the log path and a re-run-detached hint.
    // A BACKGROUND job returns a handle immediately, so the cap does not apply to it.
    const timeoutMs = args.run_in_background ? requestedTimeoutMs : clampForegroundTimeoutMs(requestedTimeoutMs);
    // P-022/D-008: re-apply the OS sandbox to this operator-side shell when the
    // papercusp-capability-exec-sandbox flag is armed (default-OFF, fail-open).
    const sandboxEnabled = await capabilityExecSandboxEnabled();
    // computer-tool-plan Gap C: if the calling bee's hive holds a leased sandbox desktop,
    // run its shell with DISPLAY bound to that desktop so GUI apps it launches (`firefox &`,
    // `soffice --calc &`) appear ON the leased Xvfb — capability:computer then drives them.
    // The handler runs in the OPERATOR process, so resolve per-caller from ctx.harnessSlug
    // (the bee's spawn-env never reaches here). No lease → no DISPLAY → unchanged. The lease
    // is always a sandbox display, never host :0.
    const hive = resolveConcreteHarnessSlug(undefined, ctx);
    const leasedDisplay = hive ? displayForHive(hive) : undefined;
    const desktopEnv = leasedDisplay ? { DISPLAY: leasedDisplay } : undefined;
    const integrationEntries = Object.entries(args.integration_env ?? {}).sort(([a], [b]) => a.localeCompare(b));
    if (integrationEntries.length > 0 && ctx.isSuperuser !== true && !isOperatorConfigWriteRole(ctx.role)) {
      throw new Error('capability:bash integration_env requires superuser or operator, architect, or mug authority');
    }

    const resolvedIntegrationEntries = await Promise.all(
      integrationEntries.map(async ([envName, sourceName]) => ({
        envName,
        sourceName,
        value: await readIntegrationKey(sourceName),
      })),
    );
    const missingIntegrationSources = [
      ...new Set(resolvedIntegrationEntries.filter((entry) => !entry.value).map((entry) => entry.sourceName)),
    ];
    if (missingIntegrationSources.length > 0) {
      throw new Error(
        `capability:bash integration_env references missing saved integration credential(s): ${missingIntegrationSources.join(', ')}`,
      );
    }
    const integrationEnv = Object.fromEntries(resolvedIntegrationEntries.map((entry) => [entry.envName, entry.value!]));
    const integrationEnvView = Object.fromEntries(
      resolvedIntegrationEntries.map((entry) => [
        entry.envName,
        {
          source: entry.sourceName,
          masked: maskIntegrationKey(entry.value),
        },
      ]),
    );
    // The operator process does not run inside the caller's psu shell, so its
    // inherited PAPERCUSP_SID is either absent or belongs to a different
    // session. Resolve the caller through the shared coordination identity
    // seam and explicitly bind that id to every child, including foreground
    // verifier commands. If this context cannot be attributed, clear the
    // inherited value rather than letting a stale operator identity authorize
    // a verifier against the wrong desktop.
    let callerSid = '';
    try {
      callerSid = resolveAgentIdentity(ctx as unknown as ResolveIdentityCtx).ownerId.trim();
    } catch {
      callerSid = '';
    }
    const childEnv = {
      ...(desktopEnv ?? {}),
      ...integrationEnv,
      PAPERCUSP_SID: callerSid,
    };
    const redactValues = resolvedIntegrationEntries.map((entry) => entry.value!);
    const integrationHeader =
      integrationEntries.length > 0 ? ` · integration_env ${JSON.stringify(integrationEnvView)}` : '';

    if (args.run_in_background) {
      const provenance = await resolveBashTaskProvenance(ctx as unknown as ResolveIdentityCtx, hive ?? null);
      const job = startBackground(
        {
          command: args.command,
          cwd,
          stateDir: ctx.stateDir,
          sandboxEnabled,
          ...(Object.keys(childEnv).length > 0 ? { env: childEnv } : {}),
          ...(redactValues.length > 0 ? { redactValues } : {}),
          ...provenance,
        },
        timeoutMs,
      );
      // EI-19915289191989412: a command whose LAST pipeline stage is a buffering
      // filter (`| tail -45`, `| head`, `| sort`, …) does not flush anything to
      // the job's log until the WHOLE pipeline exits — the log stays at exactly
      // 0 bytes for the entire run, then fills all at once at exit. Say so NOW,
      // at launch, rather than leaving the reader to discover it from a string of
      // empty bash_output polls that look identical to "never started".
      const bufferingStage = detectBufferingLastStage(args.command);
      const bufferingNote = bufferingStage ? formatBufferingPipelineAdvice(bufferingStage, 'launch') : '';
      // EI-21301075566136325: same say-it-NOW rationale as the buffering note — a
      // command that redirects its own stdout keeps the capability log empty for
      // its whole run, and a string of empty bash_output polls looks identical to
      // "never started". Name the redirect target at launch so the reader judges
      // progress by THAT file, not by the capability tail.
      const selfRedirectAtLaunch = detectSelfOutputRedirect(args.command);
      const selfRedirectLaunchNote = selfRedirectAtLaunch
        ? ` ${formatSelfRedirectAdvice(selfRedirectAtLaunch, null)}`
        : '';
      // EI-20063051138162607: the sibling typecheck tools spawn tsc themselves and
      // so can pin its heap (tscHeapEnv); this one runs a command the CALLER wrote,
      // and rewriting NODE_OPTIONS underneath it would be the more surprising
      // behavior. So say it instead of fixing it — the caller keeps sovereignty
      // over the command, and stops needing to know the heap requirement by heart.
      const heapNote = typecheckHeapLaunchWarning(args.command) ?? '';
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              ok: true,
              bash_id: job.id,
              task_id: job.taskId,
              status: 'running',
              cwd,
              log_path: job.logPath,
              // WI-6677: state the deadline at LAUNCH. It is enforced by SIGTERM/SIGKILL,
              // so a caller who needs longer must know now — not discover it as an
              // unexplained death two hours in.
              timeout_ms: job.timeoutMs,
              deadline: job.deadlineAt ? new Date(job.deadlineAt).toISOString() : undefined,
              ...(integrationEntries.length > 0 ? { integration_env: integrationEnvView } : {}),
              advice:
                `Background shell started. Preserve durable task_id "${job.taskId}" across carry. ` +
                `Read output: capability:bash_output { task_id: "${job.taskId}" } ` +
                `(or { bash_id: "${job.id}" } in this launching context). ` +
                `Stop: processes:kill { taskId: "${job.taskId}" }. ` +
                `It is terminated at ${job.deadlineAt ? new Date(job.deadlineAt).toISOString() : 'its deadline'} — ` +
                `re-launch with a larger \`timeout\` (max ${MAX_BACKGROUND_TIMEOUT_MS}ms) if the shell job needs longer. ` +
                `All descendants in this task's confined service share that deadline; use a dedicated service launcher ` +
                `when a descendant needs a separate lifetime.` +
                bufferingNote +
                selfRedirectLaunchNote +
                heapNote,
            }),
          },
        ],
      };
    }

    const r = await runForeground(
      {
        command: args.command,
        cwd,
        stateDir: ctx.stateDir,
        onChunk: (chunk) => ctx.emit('output', chunk),
        sandboxEnabled,
        ...(Object.keys(childEnv).length > 0 ? { env: childEnv } : {}),
        ...(redactValues.length > 0 ? { redactValues } : {}),
      },
      ctx.signal,
      timeoutMs,
    );

    const header =
      `exit ${r.exitCode ?? 'null'}` +
      (r.status !== 'completed' ? ` (${r.status})` : '') +
      ` · ${(r.durationMs / 1000).toFixed(1)}s · cwd ${cwd}` +
      (r.truncated ? ` · output spilled (${r.totalBytes} bytes) → ${r.logPath}` : '') +
      integrationHeader;

    const isError = r.status === 'failed' && r.exitCode === null;
    // EI-20645849301780712: on a clamped timeout, say so — and name the spill log, which is
    // where the partial output lives and is otherwise only surfaced when output OVERFLOWED.
    const timeoutHint = foregroundTimeoutHint(
      r.status,
      timeoutMs,
      'capability:bash { …same command…, run_in_background: true }',
    );
    const timeoutLogNote = r.status === 'timed_out' && !r.truncated ? ` Partial output: ${r.logPath}.` : '';

    return {
      content: [
        { type: 'text' as const, text: `${header}\n${r.output || '(no output)'}${timeoutHint}${timeoutLogNote}` },
      ],
      isError,
      // EI-20066912585022608: the text above is the right answer for a MODEL reading
      // this result and the wrong one for a `code:run` script, which gets handed the
      // raw string and whose `result.<field>` then resolves to undefined SILENTLY —
      // indistinguishable from a true empty. Worse, this tool's own background branch
      // returns JSON, so `capability.bash(...)` changed shape depending on an argument.
      // Give code-mode the same data the header renders, and only code-mode: attaching
      // it unconditionally would duplicate every foreground command's output on the
      // wire for direct callers that read the text and never look at this field.
      //
      // `output` is deliberately NOT called `stdout` — bash-jobs pipes stdout and
      // stderr into one buffer, so `stdout` would be a name that reads right and is
      // false, which is the same defect class one level down. A script that guesses
      // `.stdout` now gets a loud fieldMiss naming the real keys instead of ''.
      ...(ctx.codeMode
        ? {
            structuredContent: {
              // `ok` answers the question a script actually asks — "did my command
              // succeed" — NOT the narrower "did the shell manage to run it"
              // (`isError`, reserved for a command that never produced an exit code).
              // `status === 'completed'` is exactly `exitCode === 0` in bash-jobs;
              // 'failed' | 'killed' | 'timed_out' all read as ok:false, and `status`
              // is what distinguishes "it ran and failed" from "it never finished".
              // Defining ok as !isError instead would hand back ok:true for a command
              // that exited 3 — the reads-true-but-false shape this whole item is about.
              ok: r.status === 'completed',
              status: r.status,
              exit_code: r.exitCode,
              duration_ms: r.durationMs,
              cwd,
              output: r.output,
              truncated: r.truncated,
              ...(integrationEntries.length > 0 ? { integration_env: integrationEnvView } : {}),
              ...(r.truncated ? { total_bytes: r.totalBytes, log_path: r.logPath } : {}),
              // A timed_out run's partial output is ONLY on disk unless it also overflowed —
              // a script reading this result needs the path in both cases (EI-20645849301780712).
              ...(r.status === 'timed_out' && !r.truncated ? { log_path: r.logPath } : {}),
            },
          }
        : {}),
    };
  },
});
