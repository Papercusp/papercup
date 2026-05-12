/**
 * operator:delegate — Delegate-claude streaming-chat core.
 *
 * Self-contained as of the IPC-allowlist migration (2026-05-12). The
 * tool now owns the full lifecycle:
 *   - principal load + workspace check
 *   - session-id pick / resume / archive (createDelegate, getDelegate,
 *     autoArchiveIdleDelegates, bumpDelegate)
 *   - system-prompt composition
 *   - mcpConfig assembly (delegate stdio + agentmcp HTTP via
 *     mcp-remote bridge; reads ~/.papercusp/superuser-token directly)
 *   - LLM streaming via runAgentChat
 *   - post-stream side-effects: appendDelegateTurn + generateSessionTitle
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
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { defineTool } from '@papercusp/agent-mcp';
import { runAgentChat } from '@/lib/agent-chat-stream';
import { activeWorkspaceId } from '@/lib/workspace-registry';
import { readSystemPrincipal } from '@/lib/system-principal';
import {
  bumpDelegate,
  createDelegate,
  getDelegate,
  autoArchiveIdleDelegates,
  appendDelegateTurn,
} from '@/lib/delegates';
import { generateSessionTitle } from '@/lib/delegate-summary';
import { ALL_AGENT_MCP_TOOLS } from '@/lib/operator-mcp-tools';

const ArgsSchema = z.object({
  requestText: z.string().min(1),
  /** Optional claude-session id to resume. */
  sessionId: z.string().optional(),
  /** Force a fresh session even if sessionId points at an open one. */
  newSession: z.boolean().optional(),
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

function buildMcpConfig(): { mcpServers: Record<string, unknown> } {
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
        `${opBase}/api/mcp?superuser=1`,
        '--header',
        `Authorization:Bearer ${superuserToken}`,
      ],
    };
  }
  return { mcpServers: servers };
}

export default defineTool({
  name: 'operator:delegate',
  description:
    'Delegate-to-claude streaming chat. Resolves session, builds MCP config, spawns claude with session resume + MCP tools; emits session→deltas→tool_calls→done. Self-contained: writes appendDelegateTurn + generateSessionTitle internally.',
  capability: 'operator:delegate',
  requirePrincipal: false,
  roles: ['operator'],
  timeoutSec: 600,
  idleTimeoutSec: 120,
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
      throw new Error('Operator principal not provisioned. POST /api/agent-mcp/provision first.');
    }
    const workspaceId = activeWorkspaceId();
    if (principal.workspaceId !== workspaceId) {
      throw new Error(
        `Operator principal workspace mismatch (file=${principal.workspaceId} active=${workspaceId}).`,
      );
    }

    // Session resolution: resume open session if requested, else fresh UUID.
    let agentSessionId: string;
    let sessionCreated = false;
    if (input.newSession || !input.sessionId) {
      agentSessionId = randomUUID();
      sessionCreated = true;
    } else {
      const existing = await getDelegate(workspaceId, input.sessionId).catch(() => null);
      if (existing && existing.status === 'open') {
        agentSessionId = existing.agentSessionId;
      } else {
        agentSessionId = randomUUID();
        sessionCreated = true;
      }
    }

    // Fire-and-forget cleanup; cheap.
    void autoArchiveIdleDelegates(workspaceId).catch(() => {});

    if (sessionCreated) {
      await createDelegate({
        workspace: workspaceId,
        agentSessionId,
        origin: 'voice',
        initiatorMsg: input.requestText.slice(0, 500),
      }).catch(() => { /* table missing → degraded mode */ });
    } else {
      void bumpDelegate(workspaceId, agentSessionId).catch(() => {});
    }

    // Surface the session id to the consumer up front so the chat UI
    // can store it for the next turn (resume flow). Voice and text
    // both depend on this event.
    ctx.emit('session', { agentSessionId, created: sessionCreated });

    const promptText = sessionCreated
      ? `${SYSTEM_PROMPT}\n\nUser request: ${input.requestText}`
      : `User: ${input.requestText}`;

    const mcpConfig = buildMcpConfig();

    let assistantText = '';
    let costUsd = 0;
    let tokensIn = 0;
    let tokensOut = 0;

    try {
      for await (const ev of runAgentChat({
        promptText,
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

    // Post-stream PG writes. Fire-and-forget so a transient PG hiccup
    // doesn't fail the user-visible response.
    void appendDelegateTurn(workspaceId, agentSessionId, {
      ts: new Date().toISOString(),
      request: input.requestText,
      response: assistantText,
    }).catch(() => { /* ignore */ });

    if (sessionCreated) {
      void generateSessionTitle({
        workspace: workspaceId,
        agentSessionId,
        initiatorMsg: input.requestText,
        firstResponse: assistantText,
      }).catch(() => { /* best-effort */ });
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

// existsSync import kept for tree-shaking guard against bundlers that
// drop unused fs imports — buildMcpConfig may grow into using it later
// for env-var-overridden delegate server paths.
void existsSync;
