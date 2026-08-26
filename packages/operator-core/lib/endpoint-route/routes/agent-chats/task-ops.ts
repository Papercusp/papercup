import { randomUUID } from 'node:crypto';
import { defineTool } from '@papercusp/agent-mcp';
import { withWorkspace } from '@papercusp/db-org';
import { activeWorkspaceId } from '../../../workspace-registry';
import {
  readConversationContextProjection,
  type ConversationContextProjection,
} from '../../../conversation-context-projection';
import {
  applySessionTaskOp,
  SessionTaskValidationError,
  type SessionTask,
  type SessionTaskOp,
  type SessionTaskResult,
} from '../../../session-tasks';

export const AGENT_CHAT_TASK_ACTIONS = [
  'add',
  'edit',
  'check',
  'drop',
  'clear_blocker',
] as const;

export type AgentChatTaskAction = (typeof AGENT_CHAT_TASK_ACTIONS)[number];

export interface AgentChatTaskMutationInput {
  workspaceId: string;
  harness: string;
  sessionId: string;
  action: AgentChatTaskAction;
  taskId?: string;
  content?: string;
  activeForm?: string;
  explanation?: string;
}

interface AgentChatTaskMutationDeps {
  readProjection: (args: {
    workspaceId: string;
    sourceKind: string;
    sessionId: string;
    harness?: string;
  }) => Promise<ConversationContextProjection | null>;
  withWorkspace: <T>(workspaceId: string, run: (sql: any) => Promise<T>) => Promise<T>;
  applyOp: typeof applySessionTaskOp;
  idFactory: () => string;
}

const DEFAULT_DEPS: AgentChatTaskMutationDeps = {
  readProjection: readConversationContextProjection,
  withWorkspace,
  applyOp: applySessionTaskOp,
  idFactory: () => `task-${randomUUID()}`,
};

export class AgentChatTaskMutationError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'AgentChatTaskMutationError';
  }
}

function requiredText(value: unknown, field: string, max: number): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new AgentChatTaskMutationError(`${field}_required`, `\`${field}\` is required.`, 400);
  }
  const text = value.trim();
  if (text.length > max) {
    throw new AgentChatTaskMutationError(`${field}_too_long`, `\`${field}\` exceeds ${max} characters.`, 400);
  }
  return text;
}

function optionalText(value: unknown, field: string, max: number): string | undefined {
  if (value === undefined) return undefined;
  return requiredText(value, field, max);
}

function parseMutationBody(body: unknown): Omit<AgentChatTaskMutationInput, 'workspaceId' | 'harness' | 'sessionId'> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new AgentChatTaskMutationError('body_invalid', 'A JSON object body is required.', 400);
  }
  const raw = body as Record<string, unknown>;
  const action = raw.action;
  if (typeof action !== 'string' || !(AGENT_CHAT_TASK_ACTIONS as readonly string[]).includes(action)) {
    throw new AgentChatTaskMutationError(
      'action_invalid',
      `\`action\` must be one of ${AGENT_CHAT_TASK_ACTIONS.join('|')}.`,
      400,
    );
  }
  const parsed: Omit<AgentChatTaskMutationInput, 'workspaceId' | 'harness' | 'sessionId'> = {
    action: action as AgentChatTaskAction,
    explanation: optionalText(raw.explanation, 'explanation', 2_000),
  };
  if (action === 'add' || action === 'edit') {
    parsed.content = requiredText(raw.content, 'content', 4_000);
    parsed.activeForm = optionalText(raw.activeForm, 'activeForm', 500);
  }
  if (action !== 'add') parsed.taskId = requiredText(raw.taskId, 'taskId', 160);
  return parsed;
}

function taskById(tasks: SessionTask[], taskId: string): SessionTask {
  const task = tasks.find((candidate) => candidate.id === taskId);
  if (!task) {
    throw new AgentChatTaskMutationError(
      'task_not_found',
      `Task \`${taskId}\` does not exist in this session.`,
      404,
    );
  }
  return task;
}

function isTypedBlocker(ref: string): boolean {
  return /^(lock|event|wi|plan):/.test(ref);
}

function canonicalOpFor(action: Exclude<AgentChatTaskAction, 'edit'>): SessionTaskOp {
  switch (action) {
    case 'add': return 'append';
    case 'check': return 'done';
    case 'drop': return 'drop';
    case 'clear_blocker': return 'unblock';
  }
}

export async function mutateAgentChatTask(
  input: AgentChatTaskMutationInput,
  deps: AgentChatTaskMutationDeps = DEFAULT_DEPS,
): Promise<{
  action: AgentChatTaskAction;
  op: SessionTaskOp;
  changedTaskId: string | null;
  tasks: SessionTask[];
  projection: ConversationContextProjection;
}> {
  const before = await deps.readProjection({
    workspaceId: input.workspaceId,
    sourceKind: 'agent_chat',
    sessionId: input.sessionId,
    harness: input.harness,
  });
  if (!before) {
    throw new AgentChatTaskMutationError('session_not_found', 'Agent chat session not found.', 404);
  }
  if (!before.capabilities.taskWrite) {
    throw new AgentChatTaskMutationError(
      'task_write_unavailable',
      `Task writes are unavailable for capability tier ${before.session.capabilityTier}.`,
      409,
    );
  }

  const result = await deps.withWorkspace(input.workspaceId, async (sql) => {
    if (input.action === 'edit') {
      const current = await deps.applyOp(sql, {
        workspaceId: input.workspaceId,
        sessionId: input.sessionId,
        op: 'view',
        idFactory: deps.idFactory,
      });
      taskById(current.tasks, input.taskId!);
      return deps.applyOp(sql, {
        workspaceId: input.workspaceId,
        sessionId: input.sessionId,
        op: 'init',
        tasks: current.tasks.map((task) => task.id === input.taskId
          ? {
              id: task.id,
              content: input.content!,
              activeForm: input.activeForm ?? input.content!,
              status: task.status,
              ...(task.blockerRef ? { blockerRef: task.blockerRef } : {}),
            }
          : {
              id: task.id,
              content: task.content,
              activeForm: task.activeForm,
              status: task.status,
              ...(task.blockerRef ? { blockerRef: task.blockerRef } : {}),
            }),
        explanation: input.explanation,
        idFactory: deps.idFactory,
      });
    }

    if (input.action === 'clear_blocker') {
      const current = await deps.applyOp(sql, {
        workspaceId: input.workspaceId,
        sessionId: input.sessionId,
        op: 'view',
        idFactory: deps.idFactory,
      });
      const task = taskById(current.tasks, input.taskId!);
      if (!task.blockerRef) {
        throw new AgentChatTaskMutationError('task_not_blocked', 'The task has no blocker to clear.', 409);
      }
      if (isTypedBlocker(task.blockerRef)) {
        throw new AgentChatTaskMutationError(
          'typed_blocker_live',
          'Typed blockers clear from their source primitive; only free-text blockers can be cleared manually.',
          409,
        );
      }
    }

    return deps.applyOp(sql, {
      workspaceId: input.workspaceId,
      sessionId: input.sessionId,
      op: canonicalOpFor(input.action),
      ...(input.taskId ? { taskId: input.taskId } : {}),
      ...(input.content ? { content: input.content } : {}),
      ...(input.activeForm ? { activeForm: input.activeForm } : {}),
      ...(input.explanation ? { explanation: input.explanation } : {}),
      idFactory: deps.idFactory,
    });
  });

  // session_tasks is a declared backing table for conversations.contextProjection;
  // its PG change trigger invalidates both GUI and pui subscribers. Re-read the
  // same projection so the initiating renderer can update immediately as well.
  const projection = await deps.readProjection({
    workspaceId: input.workspaceId,
    sourceKind: 'agent_chat',
    sessionId: input.sessionId,
    harness: input.harness,
  });
  if (!projection) {
    throw new AgentChatTaskMutationError(
      'projection_unavailable',
      'Task mutation succeeded but its conversation projection is unavailable.',
      500,
    );
  }
  return {
    action: input.action,
    op: result.op,
    changedTaskId: input.action === 'edit' ? input.taskId! : result.changedTaskId,
    tasks: result.tasks,
    projection,
  };
}

export const taskOpsRoute = defineTool({
  method: 'POST',
  path: '/harness/:slug/agent-chats/:chatId/tasks',
  auth: 'loopback',
  async handler(req, ctx) {
    try {
      let raw: unknown;
      try {
        raw = await req.json();
      } catch {
        throw new AgentChatTaskMutationError('body_invalid', 'A valid JSON object body is required.', 400);
      }
      const body = parseMutationBody(raw);
      const result = await mutateAgentChatTask({
        workspaceId: activeWorkspaceId(),
        harness: ctx.params.slug,
        sessionId: ctx.params.chatId,
        ...body,
      });
      return Response.json({ ok: true, ...result });
    } catch (error) {
      if (error instanceof AgentChatTaskMutationError || error instanceof SessionTaskValidationError) {
        return Response.json(
          { error: { code: error.code, message: error.message } },
          { status: error instanceof AgentChatTaskMutationError ? error.status : 400 },
        );
      }
      throw error;
    }
  },
});
