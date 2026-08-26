/**
 * Canonical per-session task engine.
 *
 * The model sends one small operation; Papercusp owns the complete list in PG.
 * Callers execute mutations on a transaction-bound Sql handle. A
 * transaction-scoped advisory lock serializes two task calls for the same
 * session, while migration 981's partial unique index is the structural
 * guarantee that at most one task is in_progress.
 */
import type { Sql, TransactionSql } from 'postgres';

export const SESSION_TASK_STATUSES = [
  'pending',
  'in_progress',
  'blocked',
  'completed',
  'dropped',
] as const;

export const SESSION_TASK_OPS = [
  'init',
  'start',
  'done',
  'drop',
  'block',
  'unblock',
  'append',
  'view',
] as const;

export type SessionTaskStatus = (typeof SESSION_TASK_STATUSES)[number];
export type SessionTaskOp = (typeof SESSION_TASK_OPS)[number];

export interface SessionTask {
  id: string;
  content: string;
  activeForm: string;
  status: SessionTaskStatus;
  blockerRef: string | null;
  explanation: string | null;
  position: number;
  createdAt: string;
  updatedAt: string;
}

export interface SessionTaskSeed {
  id?: string;
  content: string;
  activeForm?: string;
  status?: SessionTaskStatus;
  blockerRef?: string;
}

export interface SessionTaskOpArgs {
  op?: SessionTaskOp;
  tasks?: SessionTaskSeed[];
  taskId?: string;
  content?: string;
  activeForm?: string;
  blockerRef?: string;
  explanation?: string;
}

export interface SessionTaskStoreArgs extends SessionTaskOpArgs {
  workspaceId: string;
  sessionId: string;
  idFactory: () => string;
  now?: string;
}

export interface SessionTaskResult {
  op: SessionTaskOp;
  changedTaskId: string | null;
  tasks: SessionTask[];
}

type SqlLike = Sql | TransactionSql;

interface SessionTaskRow {
  task_id: string;
  content: string;
  active_form: string;
  status: SessionTaskStatus;
  blocker_ref: string | null;
  last_explanation: string | null;
  position: number;
  created_at: Date | string;
  updated_at: Date | string;
}

export class SessionTaskValidationError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'SessionTaskValidationError';
    this.code = code;
  }
}

function fail(code: string, message: string): never {
  throw new SessionTaskValidationError(code, message);
}

function present(value: string | undefined, field: string, max: number): string {
  const trimmed = value?.trim() ?? '';
  if (!trimmed) fail(field + '_required', 'tasks:ops — `' + field + '` must be a non-empty string.');
  if (trimmed.length > max) {
    fail(field + '_too_long', 'tasks:ops — `' + field + '` exceeds the ' + max + '-character limit.');
  }
  return trimmed;
}

function optionalText(value: string | undefined, field: string, max: number): string | null {
  if (value === undefined) return null;
  return present(value, field, max);
}

const MUTATION_FIELDS = [
  'tasks',
  'taskId',
  'content',
  'activeForm',
  'blockerRef',
  'explanation',
] as const satisfies readonly (keyof SessionTaskOpArgs)[];

function assertAllowedFields(
  args: SessionTaskOpArgs,
  op: SessionTaskOp,
  allowed: readonly (keyof SessionTaskOpArgs)[],
): void {
  const allowedSet = new Set<keyof SessionTaskOpArgs>(allowed);
  const unexpected = MUTATION_FIELDS.filter(
    (field) => args[field] !== undefined && !allowedSet.has(field),
  );
  if (unexpected.length > 0) {
    fail(
      op + '_fields_unexpected',
      'tasks:ops — op=' + op + ' does not accept: ' + unexpected.join(', ') + '.',
    );
  }
}

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function mapRow(row: SessionTaskRow): SessionTask {
  return {
    id: row.task_id,
    content: row.content,
    activeForm: row.active_form,
    status: row.status,
    blockerRef: row.blocker_ref,
    explanation: row.last_explanation,
    position: Number(row.position),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

/** Infer only unambiguous shapes. A lone task id cannot reveal a transition. */
export function inferSessionTaskOp(args: SessionTaskOpArgs): SessionTaskOp {
  if (args.op) return args.op;
  if (args.tasks !== undefined) return 'init';
  if (args.taskId && args.blockerRef !== undefined) return 'block';
  if (args.content !== undefined) return 'append';
  if (
    args.taskId !== undefined ||
    args.activeForm !== undefined ||
    args.blockerRef !== undefined ||
    args.explanation !== undefined
  ) {
    fail(
      'op_ambiguous',
      'tasks:ops — cannot infer `op` from these fields. Pass one of start|done|drop|block|unblock explicitly.',
    );
  }
  return 'view';
}

function taskById(tasks: SessionTask[], id: string): SessionTask {
  const task = tasks.find((candidate) => candidate.id === id);
  if (!task) {
    fail(
      'task_not_found',
      'tasks:ops — task `' + id + '` does not exist in this session. Call with op=view for current ids.',
    );
  }
  return task;
}

function validateSeed(seed: SessionTaskSeed, position: number, now: string, idFactory: () => string): SessionTask {
  const status = seed.status ?? 'pending';
  if (!(SESSION_TASK_STATUSES as readonly string[]).includes(status)) {
    fail('status_invalid', 'tasks:ops — invalid task status `' + String(status) + '`.');
  }
  const content = present(seed.content, 'content', 4_000);
  const activeForm = seed.activeForm === undefined
    ? content
    : present(seed.activeForm, 'activeForm', 500);
  const blockerRef = optionalText(seed.blockerRef, 'blocker_ref', 2_000);
  if (status === 'blocked' && !blockerRef) {
    fail('blocker_ref_required', 'tasks:ops — an initialized blocked task requires `blocker_ref`.');
  }
  if (status !== 'blocked' && blockerRef) {
    fail('blocker_ref_unexpected', 'tasks:ops — `blocker_ref` is valid only when status is blocked.');
  }
  const id = seed.id === undefined ? idFactory() : present(seed.id, 'id', 160);
  return {
    id,
    content,
    activeForm,
    status,
    blockerRef,
    explanation: null,
    position,
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * Pure reducer used by both the PG store and focused tests.
 * It never mutates the caller's array or task objects.
 */
export function reduceSessionTasks(
  current: readonly SessionTask[],
  args: SessionTaskOpArgs,
  options: { now: string; idFactory: () => string },
): SessionTaskResult {
  const op = inferSessionTaskOp(args);
  const now = options.now;
  const tasks = current.map((task) => ({ ...task }));
  const explanation = optionalText(args.explanation, 'explanation', 2_000);

  if (op === 'view') {
    assertAllowedFields(args, op, []);
    return { op, changedTaskId: null, tasks };
  }

  if (op === 'init') {
    assertAllowedFields(args, op, ['tasks', 'explanation']);
    if (args.tasks === undefined) {
      fail('tasks_required', 'tasks:ops — op=init requires `tasks` (use [] to clear the list).');
    }
    if (args.tasks.length > 100) {
      fail('too_many_tasks', 'tasks:ops — op=init accepts at most 100 tasks.');
    }
    const next = args.tasks.map((seed, index) => ({
      ...validateSeed(seed, index, now, options.idFactory),
      explanation,
    }));
    const ids = new Set<string>();
    for (const task of next) {
      if (ids.has(task.id)) fail('duplicate_task_id', 'tasks:ops — duplicate task id `' + task.id + '`.');
      ids.add(task.id);
    }
    if (next.filter((task) => task.status === 'in_progress').length > 1) {
      fail('multiple_in_progress', 'tasks:ops — op=init permits at most one in_progress task.');
    }
    return { op, changedTaskId: null, tasks: next };
  }

  if (op === 'append') {
    assertAllowedFields(args, op, ['content', 'activeForm', 'explanation']);
    const content = present(args.content, 'content', 4_000);
    const activeForm = args.activeForm === undefined
      ? content
      : present(args.activeForm, 'activeForm', 500);
    const id = options.idFactory();
    const task: SessionTask = {
      id,
      content,
      activeForm,
      status: 'pending',
      blockerRef: null,
      explanation,
      position: tasks.length,
      createdAt: now,
      updatedAt: now,
    };
    return { op, changedTaskId: id, tasks: [...tasks, task] };
  }

  const taskId = present(args.taskId, 'task_id', 160);
  const target = taskById(tasks, taskId);
  const targetIndex = tasks.findIndex((task) => task.id === taskId);

  if (op === 'start') {
    assertAllowedFields(args, op, ['taskId', 'activeForm', 'explanation']);
    if (target.status === 'completed' || target.status === 'dropped') {
      fail('task_terminal', 'tasks:ops — cannot start terminal task `' + taskId + '` (' + target.status + ').');
    }
    const activeForm = args.activeForm === undefined
      ? target.activeForm
      : present(args.activeForm, 'activeForm', 500);
    const next = tasks.map((task) => {
      if (task.id === taskId) {
        return {
          ...task,
          activeForm,
          status: 'in_progress' as const,
          blockerRef: null,
          explanation,
          updatedAt: now,
        };
      }
      if (task.status === 'in_progress') {
        return { ...task, status: 'pending' as const, explanation, updatedAt: now };
      }
      return task;
    });
    return { op, changedTaskId: taskId, tasks: next };
  }

  if (op === 'done') {
    assertAllowedFields(args, op, ['taskId', 'explanation']);
    if (target.status === 'dropped') {
      fail('task_dropped', 'tasks:ops — dropped task `' + taskId + '` cannot be completed.');
    }
    tasks[targetIndex] = {
      ...target,
      status: 'completed',
      blockerRef: null,
      explanation,
      updatedAt: now,
    };
    return { op, changedTaskId: taskId, tasks };
  }

  if (op === 'drop') {
    assertAllowedFields(args, op, ['taskId', 'explanation']);
    tasks[targetIndex] = {
      ...target,
      status: 'dropped',
      blockerRef: null,
      explanation,
      updatedAt: now,
    };
    return { op, changedTaskId: taskId, tasks };
  }

  if (op === 'block') {
    assertAllowedFields(args, op, ['taskId', 'blockerRef', 'explanation']);
    if (target.status === 'completed' || target.status === 'dropped') {
      fail('task_terminal', 'tasks:ops — cannot block terminal task `' + taskId + '` (' + target.status + ').');
    }
    const blockerRef = present(args.blockerRef, 'blocker_ref', 2_000);
    tasks[targetIndex] = {
      ...target,
      status: 'blocked',
      blockerRef,
      explanation,
      updatedAt: now,
    };
    return { op, changedTaskId: taskId, tasks };
  }

  if (op === 'unblock') {
    assertAllowedFields(args, op, ['taskId', 'explanation']);
    if (target.status !== 'blocked') {
      fail(
        'task_not_blocked',
        'tasks:ops — task `' + taskId + '` is ' + target.status + ', not blocked; unblock would be a no-op.',
      );
    }
    tasks[targetIndex] = {
      ...target,
      status: 'pending',
      blockerRef: null,
      explanation,
      updatedAt: now,
    };
    return { op, changedTaskId: taskId, tasks };
  }

  return fail('op_invalid', 'tasks:ops — unsupported op `' + String(op) + '`.');
}

async function readSessionTasks(
  sql: SqlLike,
  workspaceId: string,
  sessionId: string,
  forUpdate: boolean,
): Promise<SessionTask[]> {
  const rows = forUpdate
    ? await sql<SessionTaskRow[]>`
        SELECT task_id, content, active_form, status, blocker_ref,
               last_explanation, position, created_at, updated_at
          FROM harness_shared.session_tasks
         WHERE workspace_id = ${workspaceId} AND session_id = ${sessionId}
         ORDER BY position, created_at, task_id
         FOR UPDATE`
    : await sql<SessionTaskRow[]>`
        SELECT task_id, content, active_form, status, blocker_ref,
               last_explanation, position, created_at, updated_at
          FROM harness_shared.session_tasks
         WHERE workspace_id = ${workspaceId} AND session_id = ${sessionId}
         ORDER BY position, created_at, task_id`;
  return rows.map(mapRow);
}

export async function applySessionTaskOp(sql: SqlLike, args: SessionTaskStoreArgs): Promise<SessionTaskResult> {
  const workspaceId = present(args.workspaceId, 'workspace_id', 240);
  const sessionId = present(args.sessionId, 'session_id', 240);
  const op = inferSessionTaskOp(args);

  if (op === 'view') {
    return {
      op,
      changedTaskId: null,
      tasks: await readSessionTasks(sql, workspaceId, sessionId, false),
    };
  }

  await sql`SELECT pg_advisory_xact_lock(hashtextextended(${workspaceId + '\u0000' + sessionId}, 981))`;
  const current = await readSessionTasks(sql, workspaceId, sessionId, true);
  const reduced = reduceSessionTasks(current, { ...args, op }, {
    now: args.now ?? new Date().toISOString(),
    idFactory: args.idFactory,
  });

  await sql`
    DELETE FROM harness_shared.session_tasks
     WHERE workspace_id = ${workspaceId} AND session_id = ${sessionId}`;

  for (const task of reduced.tasks) {
    await sql`
      INSERT INTO harness_shared.session_tasks
        (workspace_id, session_id, task_id, position, content, active_form,
         status, blocker_ref, last_explanation, created_at, updated_at)
      VALUES
        (${workspaceId}, ${sessionId}, ${task.id}, ${task.position}, ${task.content},
         ${task.activeForm}, ${task.status}, ${task.blockerRef}, ${task.explanation},
         ${task.createdAt}, ${task.updatedAt})`;
  }

  return reduced;
}
