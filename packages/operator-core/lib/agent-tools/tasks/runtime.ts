/** Shared scoping, identity, response, and event helpers for task tools. */
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  SESSION_TASK_OPS,
  SESSION_TASK_STATUSES,
  SessionTaskValidationError,
  type SessionTaskResult,
} from '../../session-tasks';
import { resolveAgentIdentity } from '../coordination/identity';
import type { PapercuspUnifiedToolContext } from '../_tool-context';

export const sessionTaskStatusSchema = z.enum(SESSION_TASK_STATUSES);
export const sessionTaskOpSchema = z.enum(SESSION_TASK_OPS);

export function taskToolText(value: unknown, isError = false) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(value) }],
    ...(isError ? { isError: true } : {}),
  };
}

export function resolveSessionTaskRuntime(ctx: PapercuspUnifiedToolContext) {
  const identity = resolveAgentIdentity(ctx);
  const workspaceId = (ctx.workspaceId ?? identity.workspaceId ?? '').trim();
  if (!workspaceId || workspaceId === '*' || !ctx.tx) return null;

  const runId = typeof ctx.runId === 'string' ? ctx.runId.trim() : '';
  const spawnId = typeof ctx.spawnId === 'string' ? ctx.spawnId.trim() : '';
  const sessionId = runId && spawnId === `agent-loop-${runId}` ? runId : identity.ownerId;
  return {
    workspaceId,
    sessionId,
    tx: ctx.tx,
    idFactory: () => `task-${randomUUID()}`,
  };
}

export function workspaceRequiredResponse(toolName: string) {
  return taskToolText({
    ok: false,
    error: {
      code: 'workspace_required',
      message: `${toolName} requires a concrete workspace-scoped session.`,
    },
  }, true);
}

export function validationErrorResponse(error: unknown) {
  if (!(error instanceof SessionTaskValidationError)) return null;
  return taskToolText({
    ok: false,
    error: { code: error.code, message: error.message },
  }, true);
}

export function emitSessionTaskChanges(
  ctx: PapercuspUnifiedToolContext,
  sessionId: string,
  mutations: readonly SessionTaskResult[],
): void {
  for (const mutation of mutations) {
    ctx.emit('tasks_changed', {
      sessionId,
      op: mutation.op,
      changedTaskId: mutation.changedTaskId,
    });
  }
}
