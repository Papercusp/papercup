/**
 * tasks:ops — canonical per-chat task list owned by the Papercusp loop.
 *
 * Models submit one compact operation; the harness owns the complete list in
 * PG. Model-family facades (TodoWrite/update_plan) translate into this tool
 * rather than storing parallel task state.
 */
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { AGENT_ROLES, defineTool } from '@papercusp/agent-mcp';
import {
  applySessionTaskOp,
  SESSION_TASK_OPS,
  SESSION_TASK_STATUSES,
  SessionTaskValidationError,
} from '../../session-tasks';
import { resolveAgentIdentity } from '../coordination/identity';
import type { PapercuspUnifiedToolContext } from '../_tool-context';

const statusSchema = z.enum(SESSION_TASK_STATUSES);
const opSchema = z.enum(SESSION_TASK_OPS);

const seedSchema = z.object({
  id: z.string().min(1).max(160).optional(),
  content: z.string().min(1).max(4_000),
  activeForm: z.string().min(1).max(500).optional(),
  status: statusSchema.optional(),
  blocker_ref: z.string().min(1).max(2_000).optional(),
}).strict();

const argsSchema = z.object({
  op: opSchema.optional(),
  tasks: z.array(seedSchema).max(100).optional(),
  task_id: z.string().min(1).max(160).optional(),
  content: z.string().min(1).max(4_000).optional(),
  activeForm: z.string().min(1).max(500).optional(),
  blocker_ref: z.string().min(1).max(2_000).optional(),
  explanation: z.string().min(1).max(2_000).optional(),
}).strict();

function text(value: unknown, isError = false) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(value) }],
    ...(isError ? { isError: true } : {}),
  };
}

function concreteWorkspaceId(ctx: PapercuspUnifiedToolContext): string | null {
  const identity = resolveAgentIdentity(ctx);
  const workspaceId = (ctx.workspaceId ?? identity.workspaceId ?? '').trim();
  return workspaceId && workspaceId !== '*' ? workspaceId : null;
}

/**
 * The owned-loop host pins runId to its durable chat id and stamps spawnId as
 * agent-loop-<runId>. External MCP dispatches regenerate runId per call, so
 * they must key by the stable coordination identity instead.
 */
function sessionIdFor(ctx: PapercuspUnifiedToolContext): string {
  const identity = resolveAgentIdentity(ctx);
  const runId = typeof ctx.runId === 'string' ? ctx.runId.trim() : '';
  const spawnId = typeof ctx.spawnId === 'string' ? ctx.spawnId.trim() : '';
  return runId && spawnId === `agent-loop-${runId}` ? runId : identity.ownerId;
}

export default defineTool({
  name: 'tasks:ops',
  profile: 'engineer',
  description:
    'Operate the canonical task list for this chat session. One compact op updates PG-backed state; the response always returns the complete ordered list.',
  capability: 'tasks:write',
  guidance: {
    when: 'Track or update the concrete steps you are executing in this chat. Use init to replace the list, append to add one, start/done/drop/block/unblock for transitions, and view to read it.',
    notWhen: 'Do not use this to create fleet/work coordination items; use work_items:* or plans:* for durable shared work. This list is per chat session.',
    chaining: 'init or append → start → done; block requires blocker_ref. Omit op only for unambiguous init/append/block/view shapes.',
  },
  requirePrincipal: false,
  needsWorkspaceTx: true,
  agentRoles: [...AGENT_ROLES],
  events: {
    tasks_changed: z.object({
      sessionId: z.string(),
      op: opSchema,
      changedTaskId: z.string().nullable(),
    }),
  },
  args: argsSchema,
  async handler(args, ctx: PapercuspUnifiedToolContext) {
    const workspaceId = concreteWorkspaceId(ctx);
    if (!workspaceId || !ctx.tx) {
      return text({
        ok: false,
        error: {
          code: 'workspace_required',
          message: 'tasks:ops requires a concrete workspace-scoped session.',
        },
      }, true);
    }

    const sessionId = sessionIdFor(ctx);
    try {
      const result = await applySessionTaskOp(ctx.tx, {
        workspaceId,
        sessionId,
        op: args.op,
        tasks: args.tasks?.map((task) => ({
          id: task.id,
          content: task.content,
          activeForm: task.activeForm,
          status: task.status,
          blockerRef: task.blocker_ref,
        })),
        taskId: args.task_id,
        content: args.content,
        activeForm: args.activeForm,
        blockerRef: args.blocker_ref,
        explanation: args.explanation,
        idFactory: () => `task-${randomUUID()}`,
      });

      if (result.op !== 'view') {
        ctx.emit('tasks_changed', {
          sessionId,
          op: result.op,
          changedTaskId: result.changedTaskId,
        });
      }

      return text({
        ok: true,
        sessionId,
        op: result.op,
        ...(result.changedTaskId ? { changedTaskId: result.changedTaskId } : {}),
        tasks: result.tasks,
      });
    } catch (error) {
      if (error instanceof SessionTaskValidationError) {
        return text({
          ok: false,
          error: { code: error.code, message: error.message },
        }, true);
      }
      throw error;
    }
  },
});
