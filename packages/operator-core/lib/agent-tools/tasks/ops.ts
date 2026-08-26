/**
 * tasks:ops — canonical per-chat task list owned by the Papercusp loop.
 *
 * Models submit one compact operation; the harness owns the complete list in
 * PG. Model-family facades (TodoWrite/update_plan) translate into this tool
 * rather than storing parallel task state.
 */
import { z } from 'zod';
import { AGENT_ROLES, defineTool } from '@papercusp/agent-mcp';
import {
  applySessionTaskOp,
} from '../../session-tasks';
import type { PapercuspUnifiedToolContext } from '../_tool-context';
import {
  emitSessionTaskChanges,
  resolveSessionTaskRuntime,
  sessionTaskOpSchema,
  sessionTaskStatusSchema,
  taskToolText,
  validationErrorResponse,
  workspaceRequiredResponse,
} from './runtime';

const seedSchema = z.object({
  id: z.string().min(1).max(160).optional(),
  content: z.string().min(1).max(4_000),
  activeForm: z.string().min(1).max(500).optional(),
  status: sessionTaskStatusSchema.optional(),
  blocker_ref: z.string().min(1).max(2_000).optional(),
}).strict();

const argsSchema = z.object({
  op: sessionTaskOpSchema.optional(),
  tasks: z.array(seedSchema).max(100).optional(),
  task_id: z.string().min(1).max(160).optional(),
  content: z.string().min(1).max(4_000).optional(),
  activeForm: z.string().min(1).max(500).optional(),
  blocker_ref: z.string().min(1).max(2_000).optional(),
  explanation: z.string().min(1).max(2_000).optional(),
}).strict();

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
      op: sessionTaskOpSchema,
      changedTaskId: z.string().nullable(),
    }),
  },
  args: argsSchema,
  async handler(args, ctx: PapercuspUnifiedToolContext) {
    const runtime = resolveSessionTaskRuntime(ctx);
    if (!runtime) return workspaceRequiredResponse('tasks:ops');
    try {
      const result = await applySessionTaskOp(runtime.tx, {
        workspaceId: runtime.workspaceId,
        sessionId: runtime.sessionId,
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
        idFactory: runtime.idFactory,
      });

      if (result.op !== 'view') emitSessionTaskChanges(ctx, runtime.sessionId, [result]);

      return taskToolText({
        ok: true,
        sessionId: runtime.sessionId,
        op: result.op,
        ...(result.changedTaskId ? { changedTaskId: result.changedTaskId } : {}),
        tasks: result.tasks,
      });
    } catch (error) {
      const failure = validationErrorResponse(error);
      if (failure) return failure;
      throw error;
    }
  },
});
