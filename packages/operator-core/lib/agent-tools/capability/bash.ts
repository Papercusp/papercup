/**
 * capability:bash — run a shell command. A THIN wrapper over a real `bash -c`
 * (D-004 — wraps real execution, no reimplementation), routed through the
 * shared endpoint dispatch so policy / capability-envelope / telemetry apply
 * (P-010, `agent-capability-confinement-2026-06-13`). It replicates the native
 * Bash tool's ergonomics: combined output streaming (the `output` event),
 * truncation/overflow-to-file, and async/background jobs (`run_in_background`).
 *
 * Foreground: streams output, enforces a wall-clock timeout, returns the
 * (head+tail-trimmed-if-large) combined output + the spill-log path.
 * Background: returns a `bash_id` immediately; read incremental output with
 * `capability:bash_output` and stop it with `capability:bash_kill` — the way a
 * 5-minute build is run without holding one blocking request.
 */

import { isAbsolute, resolve } from 'node:path';
import { z } from 'zod';
import { defineTool, SU_ROLES } from '@papercusp/agent-mcp';
import {
  DEFAULT_TIMEOUT_MS,
  MAX_TIMEOUT_MS,
  runForeground,
  startBackground,
} from './bash-jobs';

export default defineTool({
  name: 'capability:bash',
  description:
    'Run a shell command (bash -c) server-side in the project dir. Streams combined output; large output spills to a log file. Set run_in_background for long jobs (build/test/dev-server) and poll with capability:bash_output.',
  guidance: {
    when: 'Run any shell command — build, test, git status, file inspection, scripts. For a command that runs longer than ~1–2 min (build, test suite, dev server), pass run_in_background:true and poll capability:bash_output.',
    notWhen:
      'To read/write/edit a single file, prefer capability:read / capability:write / capability:edit (they coordinate the file lock and mirror the native editors). For git, prefer capability:git.',
    chaining:
      'run_in_background:true → returns a bash_id → capability:bash_output { bash_id } to read incremental output → capability:bash_kill { bash_id } to stop. Never push (git push is refused).',
  },
  capability: 'capability:bash',
  requirePrincipal: false,
  agentRoles: [...SU_ROLES, 'bee'],
  // Wall-clock dispatch timeout must exceed the max command timeout so a long
  // foreground command can complete (background mode is preferred for those).
  timeoutSec: Math.floor(MAX_TIMEOUT_MS / 1000) + 30,
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
      .max(MAX_TIMEOUT_MS)
      .optional()
      .describe(`Wall-clock timeout in ms (default ${DEFAULT_TIMEOUT_MS}, max ${MAX_TIMEOUT_MS}).`),
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
    const baseDir = ctx.projectDir ?? process.cwd();
    const cwd = args.cwd ? (isAbsolute(args.cwd) ? args.cwd : resolve(baseDir, args.cwd)) : baseDir;
    const timeoutMs = args.timeout ?? DEFAULT_TIMEOUT_MS;

    if (args.run_in_background) {
      const job = startBackground({ command: args.command, cwd, stateDir: ctx.stateDir }, timeoutMs);
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              ok: true,
              bash_id: job.id,
              status: 'running',
              cwd,
              log_path: job.logPath,
              advice: `Background shell started. Read output: capability:bash_output { bash_id: "${job.id}" }. Stop: capability:bash_kill { bash_id: "${job.id}" }.`,
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
      },
      ctx.signal,
      timeoutMs,
    );

    const header =
      `exit ${r.exitCode ?? 'null'}` +
      (r.status !== 'completed' ? ` (${r.status})` : '') +
      ` · ${(r.durationMs / 1000).toFixed(1)}s · cwd ${cwd}` +
      (r.truncated ? ` · output spilled (${r.totalBytes} bytes) → ${r.logPath}` : '');

    return {
      content: [{ type: 'text' as const, text: `${header}\n${r.output || '(no output)'}` }],
      isError: r.status === 'failed' && r.exitCode === null,
    };
  },
});
