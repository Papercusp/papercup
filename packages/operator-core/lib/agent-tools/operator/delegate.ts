/**
 * operator:delegate — Delegate-claude streaming-chat core.
 *
 * Self-contained as of the IPC-allowlist migration (2026-05-12). As of
 * collapse-delegate-into-workitems-2026-06-04 (D-004) it is THIN SUGAR over
 * work_items: the durable record of a delegated task is a work_item (issue-family
 * kind=task, see delegated-tasks.ts), not a bespoke `delegates` row. The tool owns:
 *   - principal load + workspace check
 *   - session-id pick / resume (delegated-tasks.findOpenDelegatedTask by payload)
 *   - the delegated-task work_item create/resume (createDelegatedTask)
 *   - system-prompt composition
 *   - mcpConfig assembly (delegate stdio + agentmcp HTTP via
 *     mcp-remote bridge; reads ~/.papercusp/superuser-token directly)
 *   - LLM streaming via runAgentChat
 *   - post-stream side-effects: recordDelegateTurn (thread comment → subscribe→inject
 *     to the operator) + generateTaskTitle
 *
 * The /api/agent-mcp/delegate-chat route is now a thin shim that parses
 * `?request=...&sessionId=...&newSession=1` and forwards into the tool.
 *
 * Wire format:
 *   event: session  data: { agentSessionId, created }   ← object → JSON
 *   event: delta    data: { text }                       ← object → JSON
 *                   (consumer at delegation.ts:179 does JSON.parse)
 *   event: tool_call data: { name, input }
 *   event: error    data: { message, stderr? }          ← object → JSON
 *   event: done     data: <ToolResult.content as JSON>  ← framework auto-emit
 */

import { z } from 'zod';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { defineTool } from '@papercusp/agent-mcp';
import { runAgentChat } from '../../agent-chat-stream';
import { surfaceBackend, surfaceModel } from '../../agent-config';
import { activeWorkspaceId } from '../../workspace-registry';
import { readSystemPrincipal } from '../../system-principal';
import {
  createDelegatedTask,
  findOpenDelegatedTask,
  recordDelegateTurn,
  type DelegateBackend,
} from '../../delegated-tasks';
import { generateTaskTitle } from '../../delegate-summary';
import { ALL_AGENT_MCP_TOOLS } from '../../operator-mcp-tools';
import { resolveDelegateSession } from './delegate-session';
import { buildMemoryContextBlock } from '../../memory/injection';
import { loadHarnessRegistry } from '../../harness-registry';

const ArgsSchema = z.object({
  requestText: z.string().min(1),
  /** Optional claude-session id to resume. The tool resolves
   *  via resolveDelegateSession internally; if you pre-resolved
   *  (e.g. the Hono route does, to keep ctx.runId == agentSessionId),
   *  pass the already-resolved id here. */
  sessionId: z.string().optional(),
  /** Force a fresh session even if sessionId points at an open one. */
  newSession: z.boolean().optional(),
  /** When the caller has pre-resolved the session (HTTP route does),
   *  this skips the internal resolve and uses sessionId as-is.
   *  IPC callers leave both this and sessionId empty for a fresh
   *  session, or pass sessionId only for resume.
   *
   *  Set sessionCreated to match: true when this is a new session
   *  the caller wants the tool to record (createDelegatedTask), false
   *  when resuming. */
  preResolved: z.boolean().optional(),
  sessionCreated: z.boolean().optional(),
});

type Args = z.infer<typeof ArgsSchema>;

const DELEGATE_EXTRA_TOOLS = [
  'mcp__delegate__listHarnesses',
  'mcp__delegate__listAgents',
  'mcp__delegate__getHarnessStatus',
  'mcp__delegate__listChats',
  'mcp__delegate__dispatchToAgent',
  'mcp__delegate__followUpInChat',
] as const;
const ALL_DELEGATE_TOOLS: readonly string[] = [...ALL_AGENT_MCP_TOOLS, ...DELEGATE_EXTRA_TOOLS];

const SYSTEM_PROMPT = `You are a Delegate — a Claude process the Operator voice assistant spawned to handle work that needs real reasoning. The user just spoke a request the Operator decided to route to you. Papercusp is a coding-harness control plane.

You have two MCP tool surfaces:
  - 'agentmcp' — read/write across the workspace: tasks, goals, issues, messages, audit, hindsight, search. Use these for research and bookkeeping.
  - 'delegate' — agent dispatch: listHarnesses, listAgents, getHarnessStatus, listChats, dispatchToAgent, followUpInChat. Use these when the user asks you to ask, tell, or wake another agent (architect, orchestrator, scoper, worker, etc.).

The "wake" semantic: dispatchToAgent creates a chat record AND sends the first message — the harness spawns the role-scoped Claude on demand even if its pty isn't running. You don't need to start anything separately. followUpInChat continues an existing thread by id.

Before dispatching: if the user names an agent loosely ("the architect", "the marketplace researcher"), use listAgents to find which harness has the most-active matching role. If they name a harness loosely, use listHarnesses to resolve the slug.

Be thorough — your response is shown in the operator panel, not spoken aloud. The voice layer will summarize a one-sentence gist and announce "details in the panel." Don't abbreviate for voice.

If a request is ambiguous, prefer answering with the most likely interpretation rather than asking for clarification — voice users get poor at multi-turn back-and-forth.

When you take an action via tools, briefly explain what you did and why. When you can't take an action (no auth, no MCP tool for it, etc.), say so plainly.`;

function readSuperuserToken(): string {
  try {
    return readFileSync(join(homedir(), '.papercusp', 'superuser-token'), 'utf8').trim();
  } catch {
    return '';
  }
}

function buildMcpConfig(workspaceId: string): { mcpServers: Record<string, unknown> } {
  const superuserToken = readSuperuserToken();
  const opBase = process.env.PAPERCUSP_OPERATOR_BASE ?? 'http://127.0.0.1:3055';
  const servers: Record<string, unknown> = {
    delegate: {
      command: 'node',
      args: [join(process.cwd(), 'apps/operator/lib/delegate-mcp-server.mjs')],
      env: { DELEGATE_BASE: opBase },
    },
  };
  if (superuserToken) {
    servers.agentmcp = {
      type: 'stdio',
      command: 'npx',
      args: [
        '-y',
        'mcp-remote@latest',
        // workspace= required for state-channel scoping —
        // see operator/converse.ts audit4 comment.
        `${opBase}/api/mcp?superuser=1&workspace=${encodeURIComponent(workspaceId)}`,
        '--header',
        `Authorization:Bearer ${superuserToken}`,
      ],
    };
  }
  return { mcpServers: servers };
}

export default defineTool({
  name: 'operator:delegate',
  expose: { ipc: true },
  profile: 'engineer',
  description:
    'Delegate-to-claude streaming chat. Records the task as a work_item (kind=task), resolves session, builds MCP config, spawns claude with session resume + MCP tools; emits session→deltas→tool_calls→done. Thin sugar over work_items: writes the turn as a work_item thread comment (→ subscribe→inject to the operator) + a generated title.',
  capability: 'operator:delegate',
  requirePrincipal: false,
  agentRoles: ['operator'],
  timeoutSec: 600,
  idleTimeoutSec: 120,
  // Phase 4 T2.2 — opt into replay buffer. 5000 events is a
  // generous soft cap; eviction warn-logs let us tune down once
  // migration 066's event_count column has p99 data.
  replayBufferSize: 5000,
  args: ArgsSchema,
  events: {
    session: z.object({ agentSessionId: z.string(), created: z.boolean() }),
    delta: z.object({ text: z.string() }),
    tool_call: z.object({ name: z.string(), input: z.unknown() }),
    error: z.object({ message: z.string(), stderr: z.string().optional() }),
  },
  handler: async (input: Args, ctx) => {
    // Principal + workspace check. The synthetic operator principal
    // for IPC and the cookie-resolved principal for HTTP both go
    // through the same readSystemPrincipal path, so the gate is
    // transport-agnostic.
    const principal = await readSystemPrincipal('operator');
    if (!principal) {
      throw new Error('Papercup principal not provisioned. POST /api/agent-mcp/provision first.');
    }
    const workspaceId = activeWorkspaceId();
    if (principal.workspaceId !== workspaceId) {
      throw new Error(
        `Papercup principal workspace mismatch (file=${principal.workspaceId} active=${workspaceId}).`,
      );
    }

    // Session resolution. If the caller pre-resolved (Hono route does
    // so it can set ctx.runId/spawnId == agentSessionId, preserving
    // /dev → Sessions audit grouping), trust their id+created flag.
    // Otherwise resolve via the shared helper.
    let agentSessionId: string;
    let sessionCreated: boolean;
    if (input.preResolved && input.sessionId) {
      agentSessionId = input.sessionId;
      sessionCreated = !!input.sessionCreated;
    } else {
      const r = await resolveDelegateSession(workspaceId, input.sessionId, !!input.newSession);
      agentSessionId = r.agentSessionId;
      sessionCreated = r.sessionCreated;
    }

    // per-surface backend override (/settings/agent); undefined → global default.
    // Resolved up front so the delegated-task payload records the backend.
    const delegateBackend = await surfaceBackend('delegate');
    const delegateModel = await surfaceModel('delegate'); // OQ3: undefined → backend default
    const taskBackend: DelegateBackend = delegateBackend === 'omp' ? 'omp' : 'claude-code';

    // The delegated task IS a work_item (collapse-delegate D-001) — the durable,
    // fleet-visible, subscribe→inject record that replaced the `delegates` registry.
    // New session → create it (operator-scope, assigned to this delegate session,
    // assigned_by the operator who auto-subscribes); resume → re-attach to the open one.
    let workItemId: string | null = null;
    if (sessionCreated) {
      const task = await createDelegatedTask({
        title: input.requestText.split(/\s+/).slice(0, 8).join(' ').slice(0, 200) || 'delegated task',
        summary: input.requestText.slice(0, 2000),
        agentSessionId,
        origin: 'voice',
        backend: taskBackend,
      }).catch(() => null); // degraded mode if the coord substrate is unreachable
      workItemId = task?.id ?? null;
    } else {
      const task = await findOpenDelegatedTask(agentSessionId).catch(() => null);
      workItemId = task?.id ?? null;
    }

    // Surface the session id to the consumer up front so the chat UI
    // can store it for the next turn (resume flow). Voice and text
    // both depend on this event.
    ctx.emit('session', { agentSessionId, created: sessionCreated });

    // Workspace-scope memory injection (delegate is bearer-authed with
    // no cookie user; workspace shared memory is the right grain).
    // ONLY inject on session creation — claude --session-id resumes
    // with its prior turn-context intact, so re-injecting workspace
    // memory each turn is wasteful and could confuse the model
    // mid-conversation. Matches main's pre-merge operator-chat shape.
    let memoryBlock: string | null = null;
    if (sessionCreated) {
      // Delegate has no specific harness in scope — fan out across
      // every harness in the workspace (matches operator chat shape).
      let delegateHarnessSlugs: string[] = [];
      try {
        const reg = await loadHarnessRegistry(workspaceId);
        delegateHarnessSlugs = reg.projects.map((p) => p.slug);
      } catch { /* leave empty */ }
      memoryBlock = await buildMemoryContextBlock({
        userId: null,
        workspaceId,
        harnessSlugs: delegateHarnessSlugs,
        queryContext: input.requestText,
        heading: 'Workspace memory (relevant entries)',
      });
    }

    const promptText = sessionCreated
      ? [SYSTEM_PROMPT, memoryBlock, `User request: ${input.requestText}`].filter(Boolean).join('\n\n')
      : `User: ${input.requestText}`;

    const mcpConfig = buildMcpConfig(workspaceId);

    let assistantText = '';
    let costUsd = 0;
    let tokensIn = 0;
    let tokensOut = 0;

    try {
      for await (const ev of runAgentChat({
        promptText,
        ...(delegateModel ? { model: delegateModel } : {}),
        backend: delegateBackend,
        sessionId: agentSessionId,
        sessionMode: 'force',
        mcpConfig,
        allowedTools: [...ALL_DELEGATE_TOOLS],
        toolEventFilter: (raw) => {
          if (raw.startsWith('mcp__agentmcp__')) return raw.replace(/^mcp__agentmcp__/, '');
          if (raw.startsWith('mcp__delegate__')) return raw.replace(/^mcp__delegate__/, 'delegate:');
          return null;
        },
        permissionMode: 'bypassPermissions',
        signal: ctx.signal,
      })) {
        if (ev.type === 'delta') {
          assistantText += ev.text;
          ctx.emit('delta', { text: ev.text });
        } else if (ev.type === 'tool_call') {
          ctx.emit('tool_call', { name: ev.name, input: ev.input });
        } else if (ev.type === 'result') {
          costUsd = ev.costUsd;
          tokensIn = ev.tokensIn;
          tokensOut = ev.tokensOut;
          assistantText = ev.finalText || assistantText;
        } else if (ev.type === 'error') {
          ctx.emit('error', { message: ev.message, ...(ev.stderr ? { stderr: ev.stderr } : {}) });
        }
      }
    } catch (err) {
      throw new Error(
        `operator delegate failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    // Post-stream writes against the delegated-task work_item. Fire-and-forget so a
    // transient hiccup doesn't fail the user-visible response. The turn-comment is
    // authored AS the delegate, so it fans out (subscribe→inject) to the operator
    // subscriber — the push that replaced the delegate_inbox poll (D-003).
    if (workItemId) {
      void recordDelegateTurn(workItemId, agentSessionId, {
        request: input.requestText,
        response: assistantText,
      }).catch(() => { /* ignore */ });

      if (sessionCreated) {
        void generateTaskTitle({
          workItemId,
          initiatorMsg: input.requestText,
          firstResponse: assistantText,
        }).catch(() => { /* best-effort */ });
      }
    }

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            agentSessionId,
            sessionCreated,
            costUsd,
            tokensIn,
            tokensOut,
            fullText: assistantText,
          }),
        },
      ],
    };
  },
});

