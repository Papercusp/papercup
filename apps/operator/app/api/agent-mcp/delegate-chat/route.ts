/**
 * GET /api/agent-mcp/delegate-chat?request=<text>&sessionId=<uuid>
 *
 * Conversational sibling of /api/agent-mcp/operator-scan. Same Claude
 * spawn pattern + same agent-mcp tool config + same per-workspace
 * principal, BUT:
 *   - Free-form conversational system prompt (not suggestion-extraction).
 *   - Returns SSE stream of deltas + tool_calls + final result.
 *   - Optional `sessionId` resumes an existing claude-session via
 *     `--session-id <uuid>`. When omitted, a fresh UUID is minted and
 *     a new claude_sessions row is inserted.
 *   - Records the turn in claude_sessions (turn_count++, last_active).
 *   - Auto-archives idle (>24h) sessions on every call.
 *
 * Used by:
 *   - delegate_to_claude tool (voice agent's deep-work escape hatch).
 *
 * See /docs/agents/action-registry §5.
 */

import { NextRequest } from 'next/server';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { sseResponse } from '@restart/sse';
import { runAgentChat } from '@/lib/agent-chat-stream';
import { papercuspPath } from '@/lib/papercusp-root';
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

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

interface SystemPrincipalConfig {
  bearer: string;
  workspaceId: string;
}

async function loadOperatorBearer(): Promise<SystemPrincipalConfig | null> {
  const p = await readSystemPrincipal('operator');
  return p ? { bearer: p.bearer, workspaceId: p.workspaceId } : null;
}

// Delegate-chat's tool surface = the shared operator MCP list + the
// delegate-specific cross-harness dispatch tools.
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

export async function GET(req: NextRequest): Promise<Response> {
  const url = new URL(req.url);
  const requestText = url.searchParams.get('request')?.trim();
  if (!requestText) {
    return new Response('missing required param: request', { status: 400 });
  }
  const requestedSessionId = url.searchParams.get('sessionId')?.trim() || null;
  const newSession = url.searchParams.get('newSession') === '1';

  const principal = await loadOperatorBearer();
  if (!principal) {
    return new Response('Operator principal not provisioned. POST /api/agent-mcp/provision first.', { status: 503 });
  }
  const workspaceId = activeWorkspaceId();
  if (principal.workspaceId !== workspaceId) {
    return new Response(
      `Operator principal workspace mismatch (file=${principal.workspaceId} active=${workspaceId}).`,
      { status: 503 },
    );
  }

  // Choose claude-session id.
  let agentSessionId: string;
  let sessionCreated = false;
  if (newSession || !requestedSessionId) {
    agentSessionId = randomUUID();
    sessionCreated = true;
  } else {
    const existing = await getDelegate(workspaceId, requestedSessionId).catch(() => null);
    if (existing && existing.status === 'open') {
      agentSessionId = existing.agentSessionId;
    } else {
      // Requested session unknown or archived → start fresh.
      agentSessionId = randomUUID();
      sessionCreated = true;
    }
  }

  // Side-effect maintenance: archive idle sessions for this workspace.
  // Runs once per delegation; cheap.
  void autoArchiveIdleDelegates(workspaceId).catch(() => {});

  if (sessionCreated) {
    await createDelegate({
      workspace: workspaceId,
      agentSessionId,
      origin: 'voice',
      initiatorMsg: requestText.slice(0, 500),
    }).catch(() => { /* table missing → degraded mode, no PG persistence */ });
  } else {
    void bumpDelegate(workspaceId, agentSessionId).catch(() => {});
  }

  // Build the conversational prompt. Single-turn shape — claude --session-id
  // resumes any prior turns via its own session store.
  const promptText = sessionCreated
    ? `${SYSTEM_PROMPT}\n\nUser request: ${requestText}`
    : `User: ${requestText}`;

  return sseResponse({
    signal: req.signal,
    setup: async (sink) => {
      sink.event('session', { agentSessionId, created: sessionCreated });

      let assistantText = '';
      try {
        const events = runAgentChat({
          promptText,
          sessionId: agentSessionId,
          sessionMode: 'force',
          // agentmcp: HTTP via mcp-remote bridge (covers the full operator
          // tool catalog including agent_tools:list, ui:*, autoloop:*,
          // not just the standalone bootstrap.ts subset).
          // delegate: stays stdio because it has its own UI-coupled
          // semantics (dispatchToAgent, followUpInChat) not in the
          // projected catalog.
          mcpConfig: (() => {
            const superuserToken = (() => {
              try {
                return require('node:fs').readFileSync(
                  require('node:path').join(require('node:os').homedir(), '.papercusp', 'superuser-token'),
                  'utf8',
                ).trim();
              } catch { return ''; }
            })();
            const opBase = process.env.PAPERCUSP_OPERATOR_BASE ?? 'http://127.0.0.1:3055';
            const servers: Record<string, unknown> = {
              delegate: {
                command: 'node',
                args: [join(process.cwd(), 'apps/operator/lib/delegate-mcp-server.mjs')],
                env: {
                  DELEGATE_BASE: opBase,
                },
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
          })(),
          allowedTools: [...ALL_DELEGATE_TOOLS],
          toolEventFilter: (raw) => {
            if (raw.startsWith('mcp__agentmcp__')) return raw.replace(/^mcp__agentmcp__/, '');
            if (raw.startsWith('mcp__delegate__')) return raw.replace(/^mcp__delegate__/, 'delegate:');
            return null;
          },
          permissionMode: 'bypassPermissions',
          signal: req.signal,
        });

        for await (const ev of events) {
          if (ev.type === 'delta') {
            assistantText += ev.text;
            sink.event('delta', { text: ev.text });
          } else if (ev.type === 'tool_call') {
            sink.event('tool_call', { name: ev.name, input: ev.input });
          } else if (ev.type === 'result') {
            const fullText = ev.finalText || assistantText;
            sink.done({
              agentSessionId,
              costUsd: ev.costUsd,
              tokensIn: ev.tokensIn,
              tokensOut: ev.tokensOut,
              fullText,
            });
            void appendDelegateTurn(workspaceId, agentSessionId, {
              ts: new Date().toISOString(),
              request: requestText,
              response: fullText,
            }).catch(() => { /* ignore */ });
            if (sessionCreated) {
              void generateSessionTitle({
                workspace: workspaceId,
                agentSessionId,
                initiatorMsg: requestText,
                firstResponse: fullText,
              }).catch(() => { /* best-effort */ });
            }
          } else if (ev.type === 'error') {
            sink.event('error', { message: ev.message, stderr: ev.stderr });
          }
        }
      } catch (e: unknown) {
        sink.event('error', { message: (e as Error)?.message ?? String(e) });
      }
    },
  });
}
