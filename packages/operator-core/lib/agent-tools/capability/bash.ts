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
import { defineTool, AGENT_ROLES } from '@papercusp/agent-mcp';
import {
  DEFAULT_BACKGROUND_TIMEOUT_MS,
  DEFAULT_TIMEOUT_MS,
  detectBufferingLastStage,
  formatBufferingPipelineAdvice,
  MAX_BACKGROUND_TIMEOUT_MS,
  MAX_TIMEOUT_MS,
  runForeground,
  startBackground,
} from './bash-jobs';
import { typecheckHeapLaunchWarning } from './background-typecheck-verdict';
import { capabilityExecSandboxEnabled } from './exec-sandbox';
import { displayForHive } from '../computer/desktop-lease';
import { resolveConcreteHarnessSlug } from '../_harness-scope';
import { resolveCapabilityBaseDir } from './base-dir';

export default defineTool({
  name: 'capability:bash',
  description:
    'Run a shell command (bash -c) server-side in the project dir. Streams combined output; large output spills to a log file. Set run_in_background for long jobs (build/test/dev-server) and poll with capability:bash_output.',
  guidance: {
    when: 'Run any shell command — build, test, git status, file inspection, scripts. For literal backticks, dollar signs, or other shell metacharacters in search patterns, prefer fixed-string `rg -F` with a shell-safe single-quoted argument; an unmatched backtick inside a double-quoted pattern fails before `rg` runs. For a command that runs longer than ~1–2 min (build, test suite, dev server), pass run_in_background:true and poll capability:bash_output. A background job still has a wall-clock deadline (4h default, 12h max) and is SIGTERMed then SIGKILLed at it — the launch result names the deadline; raise `timeout` for a longer job.',
    notWhen:
      'To read/write/edit a single file, prefer capability:read / capability:write / capability:edit (they coordinate the file lock and mirror the native editors). For read-only queries against the operator PostgreSQL database, use dev:pg_query { sql | describe } instead of psql: capability:bash intentionally strips database credential environment variables. For git, prefer capability:git.',
    chaining:
      'run_in_background:true → returns a bash_id plus durable task_id → preserve task_id across carry and read with capability:bash_output { task_id } (bash_id also works in the launching context) → processes:kill { taskId } to stop. Never push (git push is refused).',
    seeAlso: [
      "capability:bash_output (read a backgrounded run's output)",
      'capability:bash_kill (kill a backgrounded run)',
      'capability:git (git actions, gated as git not shell)',
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
      .positive()
      .max(MAX_BACKGROUND_TIMEOUT_MS)
      .optional()
      .describe(
        `Wall-clock timeout in ms. FOREGROUND: default ${DEFAULT_TIMEOUT_MS}, clamped to ${MAX_TIMEOUT_MS}. ` +
          `BACKGROUND (run_in_background): default ${DEFAULT_BACKGROUND_TIMEOUT_MS}, max ${MAX_BACKGROUND_TIMEOUT_MS} — ` +
          `the job IS terminated at its deadline (SIGTERM, then SIGKILL), so raise this for a job that legitimately runs longer.`,
      ),
    run_in_background: z
      .boolean()
      .optional()
      .describe('Run detached; returns a bash_id immediately. Read output via capability:bash_output.'),
    cwd: z
      .string()
      .optional()
      .describe('Working dir (absolute, or relative to the project dir). Defaults to the project dir.'),
  }),
  async handler(args, ctx) {
    const baseDir = resolveCapabilityBaseDir(ctx);
    const cwd = args.cwd ? (isAbsolute(args.cwd) ? args.cwd : resolve(baseDir, args.cwd)) : baseDir;
    // WI-6677: the default depends on the MODE. A background job is contractually
    // meant to outlive this call, so it must not inherit the short foreground
    // default — that made the tool SIGKILL exactly the long jobs it exists for.
    const timeoutMs = args.timeout ?? (args.run_in_background ? DEFAULT_BACKGROUND_TIMEOUT_MS : DEFAULT_TIMEOUT_MS);
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

    if (args.run_in_background) {
      const job = startBackground(
        {
          command: args.command,
          cwd,
          stateDir: ctx.stateDir,
          sandboxEnabled,
          ...(desktopEnv ? { env: desktopEnv } : {}),
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
              advice:
                `Background shell started. Preserve durable task_id "${job.taskId}" across carry. ` +
                `Read output: capability:bash_output { task_id: "${job.taskId}" } ` +
                `(or { bash_id: "${job.id}" } in this launching context). ` +
                `Stop: processes:kill { taskId: "${job.taskId}" }. ` +
                `It is terminated at ${job.deadlineAt ? new Date(job.deadlineAt).toISOString() : 'its deadline'} — ` +
                `re-launch with a larger \`timeout\` (max ${MAX_BACKGROUND_TIMEOUT_MS}ms) if it needs longer.` +
                bufferingNote +
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
        ...(desktopEnv ? { env: desktopEnv } : {}),
      },
      ctx.signal,
      timeoutMs,
    );

    const header =
      `exit ${r.exitCode ?? 'null'}` +
      (r.status !== 'completed' ? ` (${r.status})` : '') +
      ` · ${(r.durationMs / 1000).toFixed(1)}s · cwd ${cwd}` +
      (r.truncated ? ` · output spilled (${r.totalBytes} bytes) → ${r.logPath}` : '');

    const isError = r.status === 'failed' && r.exitCode === null;

    return {
      content: [{ type: 'text' as const, text: `${header}\n${r.output || '(no output)'}` }],
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
              ...(r.truncated ? { total_bytes: r.totalBytes, log_path: r.logPath } : {}),
            },
          }
        : {}),
    };
  },
});
