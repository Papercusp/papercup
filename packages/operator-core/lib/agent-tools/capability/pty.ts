/**
 * Interactive PTY capability family (orchestration runtime unification P-011).
 *
 * The model-facing handle is always the durable task-ledger id. The node-pty id
 * stays process-local, and every follow-up call re-authorizes the ledger row
 * against the caller's current workspace, harness, and owner identity before it
 * resolves the in-memory handle. This preserves carry-resume without turning a
 * leaked process id into an ambient terminal capability.
 */
import { isAbsolute, resolve } from 'node:path';
import { z } from 'zod';
import { AGENT_ROLES, defineTool } from '@papercusp/agent-mcp';
import {
  getPtyByTaskId,
  getScreenSerialization,
  killPty,
  resizePty,
  spawnGovernedPty,
  writePty,
  type PtyHandle,
} from '../../pty-bridge';
import { localPtyHostId, type PtyAccessScope } from '../../pty-ticket';
import {
  beginSyncEnrolment,
  completeSyncEnrolment,
  finishSyncEnrolment,
  syncEnrolmentScopePath,
} from '../../task-manager/enroll-sync';
import { getTask } from '../../task-manager/store';
import { isTerminalState, type TaskRow } from '../../task-manager/types';
import { resolveConcreteHarnessSlug } from '../_harness-scope';
import { resolveAgentIdentity, type ResolveIdentityCtx } from '../coordination/identity';
import { resolveCapabilityBaseDir } from './base-dir';
import { scrubExecEnv } from './exec-sandbox';

const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;
const MAX_STDIN_CHARS = 1_000_000;
const PTY_TASK_ID_ENV = 'PAPERCUSP_PTY_TASK_ID';

/**
 * `defineTool`'s legacy compatibility overload can supply either context shape.
 * Keep the PTY helpers structural: these are the only optional fields they read,
 * and both the principal-gated and unified contexts satisfy this contract.
 */
type PtyToolContext = ResolveIdentityCtx & { projectDir?: string };

type CallerScope = {
  ownerId: string;
  workspaceId: string;
  harnessSlug: string;
  accessScope: PtyAccessScope;
};

type Attachment = {
  task: TaskRow;
  handle: PtyHandle;
  caller: CallerScope;
};

function errorResult(reason: string, extra: Record<string, unknown> = {}) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, reason, ...extra }) }],
    isError: true,
  };
}

function callerScope(ctx: PtyToolContext): CallerScope | null {
  const identity = resolveAgentIdentity(ctx);
  const workspaceId = identity.workspaceId?.trim();
  const harnessSlug = resolveConcreteHarnessSlug(undefined, ctx);
  if (!workspaceId || workspaceId === '*' || !harnessSlug) return null;
  return {
    ownerId: identity.ownerId,
    workspaceId,
    harnessSlug,
    accessScope: {
      tenantId: workspaceId,
      workspaceId,
      harnessSlug,
      hostId: localPtyHostId(),
      principalId: identity.ownerId,
    },
  };
}

function unknownTask(taskId: string) {
  return errorResult('unknown_task_id', { task_id: taskId });
}

function taskBelongsToCaller(task: TaskRow, taskId: string, caller: CallerScope): boolean {
  const detail = task.detail ?? {};
  return (
    task.taskId === taskId &&
    task.class === 'pty' &&
    task.workspaceId === caller.workspaceId &&
    task.harnessSlug === caller.harnessSlug &&
    task.launchedBy === caller.ownerId &&
    detail.capabilityPty === true &&
    detail.principalId === caller.ownerId &&
    typeof detail.ptyHandleId === 'string' &&
    detail.ptyHandleId.length > 0
  );
}

async function attachTask(taskId: string, ctx: PtyToolContext): Promise<
  | { ok: true; attachment: Attachment }
  | { ok: false; result: ReturnType<typeof errorResult> }
> {
  const caller = callerScope(ctx);
  if (!caller) return { ok: false, result: errorResult('concrete_scope_required') };

  let task: TaskRow | null;
  try {
    task = await getTask(taskId);
  } catch (error) {
    return {
      ok: false,
      result: errorResult('task_ledger_unavailable', {
        task_id: taskId,
        message: error instanceof Error ? error.message : String(error),
      }),
    };
  }

  // Deliberately collapse missing, malformed, and foreign rows. A caller must
  // not be able to enumerate another principal's live terminal sessions.
  if (!task || !taskBelongsToCaller(task, taskId, caller)) {
    return { ok: false, result: unknownTask(taskId) };
  }

  const handle = getPtyByTaskId(taskId, caller.accessScope);
  if (!handle || handle.id !== task.detail.ptyHandleId) {
    if (isTerminalState(task.state)) {
      return {
        ok: false,
        result: errorResult('pty_session_ended', {
          task_id: taskId,
          state: task.state,
          exit_code: task.exitCode,
          exit_reason: task.exitReason,
          reattachment: 'not_applicable',
          replacement_started: false,
          advice: 'The PTY has ended. Inspect the terminal outcome above; open a new PTY only if more interactive work is required.',
        }),
      };
    }
    return {
      ok: false,
      result: errorResult('pty_session_unavailable', {
        task_id: taskId,
        state: task.state,
        reattachment: 'unrecoverable',
        restart_required: true,
        replacement_started: false,
        advice:
          'The authorized ledger row is still live, but its process-local PTY handle was lost (for example by an operator restart). This session cannot be reattached; open a new capability:pty_open session. No replacement was started automatically.',
      }),
    };
  }

  return { ok: true, attachment: { task, handle, caller } };
}

const commonTool = {
  capability: 'capability:bash',
  requirePrincipal: false,
  skipWorkspaceTx: true,
  agentRoles: [...AGENT_ROLES],
} as const;

export const ptyOpenTool = defineTool({
  name: 'capability:pty_open',
  description:
    'Open a persistent interactive PTY session in the project directory. Returns only a durable task_id; use the PTY follow-up tools to write, resize, read the bounded screen state, or kill it.',
  guidance: {
    when: 'Run an interactive shell, REPL, debugger, or TUI that needs stdin and repeated screen reads.',
    notWhen: 'Use capability:bash for a non-interactive command or a background job whose append-only output is sufficient.',
    chaining:
      'capability:pty_open { command } → capability:pty_write_stdin { task_id, data } / capability:pty_resize { task_id, cols, rows } → capability:pty_read_screen { task_id } → capability:pty_kill { task_id }.',
    seeAlso: ['capability:bash (non-interactive shell execution)'],
  },
  ...commonTool,
  args: z.object({
    command: z.string().min(1).describe('Interactive command to run through `bash -lc`.'),
    cwd: z
      .string()
      .optional()
      .describe('Working directory (absolute, or relative to the project directory). Defaults to the project directory.'),
    cols: z.number().int().min(2).max(400).optional().describe(`Initial terminal columns (default ${DEFAULT_COLS}).`),
    rows: z.number().int().min(1).max(200).optional().describe(`Initial terminal rows (default ${DEFAULT_ROWS}).`),
  }),
  async handler(args, ctx: PtyToolContext) {
    const caller = callerScope(ctx);
    if (!caller) return errorResult('concrete_scope_required');

    const baseDir = resolveCapabilityBaseDir(ctx);
    const cwd = args.cwd ? (isAbsolute(args.cwd) ? args.cwd : resolve(baseDir, args.cwd)) : baseDir;
    const childEnv = scrubExecEnv(process.env);
    const enrolment = beginSyncEnrolment({ class: 'pty' });

    // The ledger + cgroup boundary is the security/replayability contract for
    // this capability. Unlike legacy best-effort spawn seams, PTY open fails
    // closed when either half is unavailable.
    if (!enrolment.enrolled) {
      return errorResult('task_manager_required', {
        advice: 'Interactive capability sessions require task-ledger enrolment.',
      });
    }
    if (!enrolment.confined) {
      return errorResult('pty_confinement_unavailable', {
        unconfined_reason: enrolment.unconfinedReason,
        advice: 'Retry after task-manager scope support is ready; no PTY was spawned.',
      });
    }

    childEnv[PTY_TASK_ID_ENV] = enrolment.taskId;
    const wrapped = enrolment.wrap('bash', ['-lc', args.command], childEnv);
    const scopeCgroupPath = syncEnrolmentScopePath(enrolment, 'pty');

    let handle: PtyHandle;
    try {
      handle = await spawnGovernedPty({
        accessScope: caller.accessScope,
        command: wrapped.binary,
        args: wrapped.argv,
        cwd,
        env: childEnv,
        inheritEnv: false,
        taskId: enrolment.taskId,
        cols: args.cols ?? DEFAULT_COLS,
        rows: args.rows ?? DEFAULT_ROWS,
      }, {
        workspaceId: caller.workspaceId,
        idempotencyKey: `capability-pty:${enrolment.taskId}`,
        owner: caller.ownerId,
        payloadRef: `task:${enrolment.taskId}`,
      });
    } catch (error) {
      return errorResult('pty_spawn_failed', {
        message: error instanceof Error ? error.message : String(error),
      });
    }

    completeSyncEnrolment(
      enrolment,
      {
        class: 'pty',
        title: args.command.slice(0, 300),
        argv: ['bash', '-lc', args.command],
        cwd,
        launchedBy: caller.ownerId,
        harnessSlug: caller.harnessSlug,
        sessionId: caller.ownerId,
        detail: {
          capabilityPty: true,
          ptyHandleId: handle.id,
          principalId: caller.ownerId,
          cols: args.cols ?? DEFAULT_COLS,
          rows: args.rows ?? DEFAULT_ROWS,
        },
      },
      handle.pty.pid ?? null,
      { workspaceId: caller.workspaceId },
    );

    let finished = false;
    const finish = (exitCode: number | null, signal: number): void => {
      if (finished) return;
      finished = true;
      finishSyncEnrolment(
        enrolment,
        {
          state: signal > 0 ? 'killed' : 'exited',
          exitCode,
          exitReason: signal > 0 ? `pty exited on signal ${signal}` : null,
        },
        { scopeCgroupPath },
      );
    };
    handle.onExit.add((code, signal) => finish(code, signal));
    if (handle.killed) finish(handle.exitCode, 0);

    // The sync spawn seam writes asynchronously, but this model-facing open
    // must not return a durable id before its authorization row exists. That
    // prevents an immediate write/read call from racing registration.
    try {
      await enrolment.registrationReady;
    } catch (error) {
      killPty(handle.id, caller.accessScope);
      return errorResult('task_enrollment_failed', {
        message: error instanceof Error ? error.message : String(error),
      });
    }

    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({
            ok: true,
            task_id: enrolment.taskId,
            confined: true,
            cols: args.cols ?? DEFAULT_COLS,
            rows: args.rows ?? DEFAULT_ROWS,
          }),
        },
      ],
    };
  },
});

export const ptyWriteStdinTool = defineTool({
  name: 'capability:pty_write_stdin',
  description: 'Write UTF-8 input to an interactive PTY session using its durable task_id.',
  guidance: {
    when: 'Send keystrokes, a command, or a control sequence to a session opened by capability:pty_open.',
    notWhen: 'Never pass a process id, PTY id, name, or pattern; this tool accepts only the durable task_id handle.',
    chaining: 'Follow with capability:pty_read_screen { task_id } to observe the resulting terminal state.',
    seeAlso: ['capability:pty_open', 'capability:pty_read_screen'],
  },
  ...commonTool,
  args: z.object({
    task_id: z.string().min(1).describe('Durable task id returned by capability:pty_open.'),
    data: z.string().max(MAX_STDIN_CHARS).describe('UTF-8 data/keystrokes to write. Include `\n` to submit a line.'),
  }),
  async handler(args, ctx: PtyToolContext) {
    const attached = await attachTask(args.task_id, ctx);
    if (!attached.ok) return attached.result;
    const { handle, caller } = attached.attachment;
    if (!writePty(handle.id, Buffer.from(args.data, 'utf8'), caller.accessScope)) {
      return errorResult('pty_session_unavailable', { task_id: args.task_id });
    }
    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({
            ok: true,
            task_id: args.task_id,
            bytes_written: Buffer.byteLength(args.data, 'utf8'),
          }),
        },
      ],
    };
  },
});

export const ptyResizeTool = defineTool({
  name: 'capability:pty_resize',
  description:
    'Resize a running interactive PTY by its durable task_id. Updates both the child terminal and the bounded headless screen geometry without ending or replacing the session.',
  guidance: {
    when: 'A shell, debugger, or TUI opened by capability:pty_open needs a different terminal width or height.',
    notWhen: 'Do not pass a process id or raw PTY id. A terminal session that ended or lost its server-side handle cannot be revived by resizing it.',
    chaining: 'capability:pty_resize { task_id, cols, rows } → capability:pty_read_screen { task_id }.',
    seeAlso: ['capability:pty_open', 'capability:pty_read_screen'],
  },
  ...commonTool,
  args: z.object({
    task_id: z.string().min(1).describe('Durable task id returned by capability:pty_open.'),
    cols: z.number().int().min(2).max(400).describe('New terminal width in columns.'),
    rows: z.number().int().min(1).max(200).describe('New terminal height in rows.'),
  }),
  async handler(args, ctx: PtyToolContext) {
    const attached = await attachTask(args.task_id, ctx);
    if (!attached.ok) return attached.result;
    const { handle, caller } = attached.attachment;
    if (!resizePty(handle.id, args.cols, args.rows, caller.accessScope)) {
      return errorResult('pty_session_unavailable', { task_id: args.task_id });
    }
    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({
            ok: true,
            task_id: args.task_id,
            cols: args.cols,
            rows: args.rows,
          }),
        },
      ],
    };
  },
});

export const ptyReadScreenTool = defineTool({
  name: 'capability:pty_read_screen',
  description:
    'Read the bounded ANSI screen state of an interactive PTY session using its durable task_id. Returns a standard MCP embedded resource so the shared result-door accounts and envelopes it as non-text content.',
  guidance: {
    when: 'Inspect the current screen of a session opened by capability:pty_open, including TUIs that redraw in place.',
    notWhen: 'Use capability:bash_output for append-only output from a capability:bash background job.',
    chaining:
      'Write more input with capability:pty_write_stdin, change geometry with capability:pty_resize, or stop the session with capability:pty_kill.',
    seeAlso: ['capability:pty_write_stdin', 'capability:pty_resize', 'capability:pty_kill'],
  },
  ...commonTool,
  args: z.object({
    task_id: z.string().min(1).describe('Durable task id returned by capability:pty_open.'),
  }),
  async handler(args, ctx: PtyToolContext) {
    const attached = await attachTask(args.task_id, ctx);
    if (!attached.ok) return attached.result;
    const { handle, caller } = attached.attachment;
    const screen = await getScreenSerialization(handle.id, caller.accessScope);
    if (screen === null) {
      return errorResult('pty_session_unavailable', { task_id: args.task_id });
    }

    const cols = handle.headless.cols;
    const rows = handle.headless.rows;
    return {
      // D-006: screen state remains a distinct, non-text medium without
      // inventing a protocol variant. MCP already provides embedded resources;
      // the URI + metadata carry identity/geometry while resource.text carries
      // the bounded ANSI serialization accepted by every conforming client.
      content: [
        {
          type: 'resource' as const,
          resource: {
            uri: `papercusp://pty/${encodeURIComponent(args.task_id)}/screen?cols=${cols}&rows=${rows}`,
            mimeType: 'application/x-papercusp-pty-screen+ansi',
            text: screen,
          },
        },
      ],
      _meta: {
        pty: {
          task_id: args.task_id,
          encoding: 'utf-8',
          cols,
          rows,
        },
      },
    };
  },
});

export const ptyKillTool = defineTool({
  name: 'capability:pty_kill',
  description: 'Kill an interactive PTY session by its durable task_id. Names, patterns, PIDs, and raw PTY ids are not accepted.',
  guidance: {
    when: 'Stop a session opened by capability:pty_open once it is no longer needed.',
    notWhen: 'Do not kill by process name/pattern. The task_id is the only accepted authority-bearing handle.',
    chaining: 'A successful call ends the task-ledger entry through the PTY exit hook.',
    seeAlso: ['capability:pty_open', 'processes:kill (managed task control)'],
  },
  ...commonTool,
  args: z.object({
    task_id: z.string().min(1).describe('Durable task id returned by capability:pty_open.'),
  }),
  async handler(args, ctx: PtyToolContext) {
    const attached = await attachTask(args.task_id, ctx);
    if (!attached.ok) return attached.result;
    const { handle, caller } = attached.attachment;
    if (!killPty(handle.id, caller.accessScope)) {
      return errorResult('pty_session_unavailable', { task_id: args.task_id });
    }
    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({ ok: true, task_id: args.task_id, killed: true }),
        },
      ],
    };
  },
});
