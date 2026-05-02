/**
 * GET /api/agent-mcp/operator-scan?request=<text>
 *
 * Server-Sent Events stream of Operator's reasoning + suggestions.
 *
 * Events:
 *   - delta:        { text }                 — Operator text streamed live
 *   - tool_call:    { name, input }          — Operator invoked an MCP tool
 *   - suggestion:   ParsedSuggestion         — emitted as Operator finalizes
 *   - first_run:    {}                       — emitted once on the first scan
 *   - done:         { costUsd, suggestions } — Operator finished
 *   - error:        { message }              — fatal
 *
 * The actual MCP server spawned for this request is `agent-mcp`'s
 * standalone entrypoint, with the calling principal's bearer wired in
 * via env. The principal is `system:operator` for the active workspace,
 * loaded from the operator's per-workspace config file.
 */

import { NextRequest } from 'next/server';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runClaudeChat } from '@/lib/claude-chat-stream';
import { papercuspPath } from '@/lib/papercusp-root';
import { activeWorkspaceId } from '@/lib/workspace-registry';
import {
  buildOperatorPrompt,
  markFirstRunShown,
} from '@/lib/operator-prompt';
import { parseSuggestions } from '@/lib/operator-suggestion-parser';

export const dynamic = 'force-dynamic';

interface SystemPrincipalConfig {
  bearer: string;
  name: string;
  workspaceId: string;
  capabilities: string[];
}

function loadOperatorBearer(): SystemPrincipalConfig | null {
  const path = papercuspPath('system', 'operator', 'config.json');
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as SystemPrincipalConfig;
  } catch {
    return null;
  }
}

const ALL_AGENT_MCP_TOOLS = [
  'mcp__agentmcp__harness:list',
  'mcp__agentmcp__harness:get',
  'mcp__agentmcp__harness:status',
  'mcp__agentmcp__tasks:list',
  'mcp__agentmcp__tasks:get',
  'mcp__agentmcp__tasks:create',
  'mcp__agentmcp__tasks:update',
  'mcp__agentmcp__tasks:close',
  'mcp__agentmcp__goals:list',
  'mcp__agentmcp__goals:get',
  'mcp__agentmcp__issues:list',
  'mcp__agentmcp__messages:inbox',
  'mcp__agentmcp__messages:outbox',
  'mcp__agentmcp__messages:send',
  'mcp__agentmcp__audit:list',
  'mcp__agentmcp__pending_events:list',
  'mcp__agentmcp__hindsight:recall',
  'mcp__agentmcp__search:query',
];

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const requestText = url.searchParams.get('request') ?? 'Scan the workspace and surface up to 5 next-action suggestions.';

  const principal = loadOperatorBearer();
  if (!principal) {
    return new Response('Operator principal not provisioned. POST /api/agent-mcp/provision first.', {
      status: 503,
    });
  }
  const workspaceId = activeWorkspaceId();
  if (principal.workspaceId !== workspaceId) {
    return new Response(
      `Operator principal workspace mismatch (file=${principal.workspaceId} active=${workspaceId}).`,
      { status: 503 },
    );
  }

  const { promptText, isFirstRun } = buildOperatorPrompt({ request: requestText });

  const stream = new ReadableStream({
    async start(controller) {
      const enc = new TextEncoder();
      const send = (event: string, data: Record<string, unknown>) => {
        controller.enqueue(enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      };

      let costUsd = 0;
      let assistantText = '';

      if (isFirstRun) {
        send('first_run', {});
      }

      try {
        const events = runClaudeChat({
          promptText,
          mcpConfig: {
            mcpServers: {
              agentmcp: {
                command: './node_modules/.bin/tsx',
                args: [join(process.cwd(), 'packages/agent-mcp/src/server-entry.ts')],
                env: {
                  AGENT_MCP_BEARER: principal.bearer,
                  OPERATOR_BASE_URL: 'http://localhost:3055',
                },
              },
            },
          },
          allowedTools: ALL_AGENT_MCP_TOOLS,
          toolEventFilter: (raw) =>
            raw.startsWith('mcp__agentmcp__') ? raw.replace(/^mcp__agentmcp__/, '') : null,
          permissionMode: 'bypassPermissions',
        });

        for await (const ev of events) {
          if (ev.type === 'delta') {
            assistantText += ev.text;
            send('delta', { text: ev.text });
          } else if (ev.type === 'tool_call') {
            send('tool_call', { name: ev.name, input: ev.input });
          } else if (ev.type === 'result') {
            costUsd = ev.costUsd;
            const parsed = parseSuggestions(ev.finalText || assistantText);
            for (const s of parsed.suggestions) {
              send('suggestion', s as unknown as Record<string, unknown>);
            }
            send('done', {
              costUsd,
              suggestions: parsed.suggestions.length,
              parseErrors: parsed.parseErrors,
            });
          } else if (ev.type === 'error') {
            send('error', { message: ev.message });
          }
        }
        if (isFirstRun) markFirstRunShown();
      } catch (err) {
        send('error', { message: err instanceof Error ? err.message : String(err) });
      } finally {
        controller.close();
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
