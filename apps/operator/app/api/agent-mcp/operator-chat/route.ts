/**
 * GET /api/agent-mcp/operator-chat?request=<text>&sessionId=<uuid>
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
import { runAgentChat } from '@/lib/agent-chat-stream';
import { papercuspPath } from '@/lib/papercusp-root';
import { activeWorkspaceId } from '@/lib/workspace-registry';
import {
  bumpClaudeSession,
  createClaudeSession,
  getClaudeSession,
  autoArchiveIdleSessions,
} from '@/lib/claude-sessions';
import { generateSessionTitle } from '@/lib/claude-session-summary';
import { ALL_AGENT_MCP_TOOLS } from '@/lib/operator-mcp-tools';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

interface SystemPrincipalConfig {
  bearer: string;
  workspaceId: string;
}

function loadOperatorBearer(): SystemPrincipalConfig | null {
  const path = papercuspPath('system', 'operator', 'config.json');
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as SystemPrincipalConfig;
  } catch { return null; }
}

// Tool list moved to `@/lib/operator-mcp-tools` so it stays in lockstep
// with operator-converse / operator-scan / delegate-chat. Adding a new
// MCP tool there exposes it to every chat surface that uses this import.

const SYSTEM_PROMPT = `You are an agent serving the Operator voice assistant for Papercusp — a coding-harness control plane.

The user just said something the voice assistant decided needed real reasoning. Use your MCP tools to answer their request fully. Be thorough — your response will be shown to the user in a panel; you don't need to abbreviate for voice. The voice layer will summarize a one-sentence gist and announce "details in the panel."

If the request is ambiguous, prefer answering with the most likely interpretation rather than asking for clarification. Voice users get poor at multi-turn back-and-forth; stay action-oriented.

When you take an action via tools, briefly explain what you did and why. When you can't take an action you'd like to (no auth, no MCP tool for it, etc.), say so plainly.`;

export async function GET(req: NextRequest): Promise<Response> {
  const url = new URL(req.url);
  const requestText = url.searchParams.get('request')?.trim();
  if (!requestText) {
    return new Response('missing required param: request', { status: 400 });
  }
  const requestedSessionId = url.searchParams.get('sessionId')?.trim() || null;
  const newSession = url.searchParams.get('newSession') === '1';

  const principal = loadOperatorBearer();
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
  let claudeSessionId: string;
  let sessionCreated = false;
  if (newSession || !requestedSessionId) {
    claudeSessionId = randomUUID();
    sessionCreated = true;
  } else {
    const existing = await getClaudeSession(workspaceId, requestedSessionId).catch(() => null);
    if (existing && existing.status === 'open') {
      claudeSessionId = existing.claudeSessionId;
    } else {
      // Requested session unknown or archived → start fresh.
      claudeSessionId = randomUUID();
      sessionCreated = true;
    }
  }

  // Side-effect maintenance: archive idle sessions for this workspace.
  // Runs once per delegation; cheap.
  void autoArchiveIdleSessions(workspaceId).catch(() => {});

  if (sessionCreated) {
    await createClaudeSession({
      workspace: workspaceId,
      claudeSessionId,
      origin: 'voice',
      initiatorMsg: requestText.slice(0, 500),
    }).catch(() => { /* table missing → degraded mode, no PG persistence */ });
  } else {
    void bumpClaudeSession(workspaceId, claudeSessionId).catch(() => {});
  }

  // Build the conversational prompt. Single-turn shape — claude --session-id
  // resumes any prior turns via its own session store.
  const promptText = sessionCreated
    ? `${SYSTEM_PROMPT}\n\nUser request: ${requestText}`
    : `User: ${requestText}`;

  const enc = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: string, data: Record<string, unknown>) => {
        try {
          controller.enqueue(enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
        } catch { /* writer closed */ }
      };
      send('session', { claudeSessionId, created: sessionCreated });

      let assistantText = '';
      try {
        const events = runAgentChat({
          promptText,
          sessionId: claudeSessionId,
          sessionMode: 'force',
          // HTTP MCP via mcp-remote stdio bridge (same shape as
          // operator-converse). Switched from the standalone stdio
          // agent-mcp server because that one's bootstrap.ts catalog
          // misses the operator-side tools (agent_tools:list, ui:*,
          // autoloop:*, etc.) — those live in apps/operator/lib/agent-tools
          // and are only reachable via the operator's projected /api/mcp
          // dispatcher.
          mcpConfig: (() => {
            const superuserToken = (() => {
              try {
                return require('node:fs').readFileSync(
                  require('node:path').join(require('node:os').homedir(), '.papercusp', 'superuser-token'),
                  'utf8',
                ).trim();
              } catch { return ''; }
            })();
            if (!superuserToken) return undefined;
            return {
              mcpServers: {
                agentmcp: {
                  type: 'stdio',
                  command: 'npx',
                  args: [
                    '-y',
                    'mcp-remote@latest',
                    'http://127.0.0.1:3055/api/mcp?superuser=1',
                    '--header',
                    `Authorization:Bearer ${superuserToken}`,
                  ],
                },
              },
            };
          })(),
          allowedTools: [...ALL_AGENT_MCP_TOOLS],
          toolEventFilter: (raw) =>
            raw.startsWith('mcp__agentmcp__') ? raw.replace(/^mcp__agentmcp__/, '') : null,
          permissionMode: 'bypassPermissions',
          signal: req.signal,
        });

        for await (const ev of events) {
          if (ev.type === 'delta') {
            assistantText += ev.text;
            send('delta', { text: ev.text });
          } else if (ev.type === 'tool_call') {
            send('tool_call', { name: ev.name, input: ev.input });
          } else if (ev.type === 'result') {
            send('done', {
              claudeSessionId,
              costUsd: ev.costUsd,
              tokensIn: ev.tokensIn,
              tokensOut: ev.tokensOut,
              fullText: ev.finalText || assistantText,
            });
            // Background title generation on first turn (non-blocking).
            if (sessionCreated) {
              void generateSessionTitle({
                workspace: workspaceId,
                claudeSessionId,
                initiatorMsg: requestText,
                firstResponse: ev.finalText || assistantText,
              }).catch(() => { /* best-effort */ });
            }
          } else if (ev.type === 'error') {
            send('error', { message: ev.message, stderr: ev.stderr });
          }
        }
      } catch (e: unknown) {
        send('error', { message: (e as Error)?.message ?? String(e) });
      } finally {
        try { controller.close(); } catch { /* already closed */ }
      }
    },
  });

  return new Response(stream, {
    headers: {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      'connection': 'keep-alive',
    },
  });
}
