/**
 * operator:converse — Operator brain streaming-chat core.
 *
 * Self-contained as of the IPC-allowlist migration (2026-05-12). The
 * tool now owns the full lifecycle:
 *   - buildOperatorPrompt (role files, voice prefs, mem0 pre-turn
 *     injection, history budgeting, trigger/modality sections)
 *   - checkBudget gate
 *   - principal load + workspace check
 *   - mcpConfig assembly (agentmcp via mcp-remote bridge; reads
 *     ~/.papercusp/superuser-token directly)
 *   - LLM streaming via runAgentChat
 *   - post-stream side-effects: recordSpend, mem0 fact extraction
 *     (post-turn .add), and server-side <spawn>-tag dispatch
 *
 * The /api/agent-mcp/operator-converse route is now a thin shim that
 * resolves the session user from cookies (cookies aren't readable from
 * an IPC dispatch path) and forwards everything else through the tool.
 *
 * Wire format:
 *   event: delta    data: { text }                       ← object → JSON
 *                   (elevenlabs-conv consumer at :545 does
 *                    JSON.parse(line.slice(6)).text)
 *   event: tool_call data: { name, input }
 *   event: done     data: <ToolResult.content as JSON>  ← framework auto-emit
 *                                                       (route also emits
 *                                                        sink.done with cost)
 *
 * On the IPC path the route's sink.done re-emit is bypassed; the
 * framework auto-emitted `done` is sufficient (consumer reads from
 * the tool's return value `{ totalCost, assembled }`).
 */

import { z } from 'zod';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { defineTool } from '@papercusp/agent-mcp';
import { runAgentChat } from '@/lib/agent-chat-stream';
import { checkBudget, recordSpend } from '@/lib/operator-budget';
import { parseOperatorTurn } from '@/lib/operator-converse-tags';
import { readSystemPrincipal } from '@/lib/system-principal';
import { activeWorkspaceId } from '@/lib/workspace-registry';
import { ALL_AGENT_MCP_TOOLS } from '@/lib/operator-mcp-tools';
import {
  buildOperatorPrompt,
  type ConverseSessionUser,
  type OperatorConverseInput,
} from './converse-prompt';

const MessageSchema = z.object({
  role: z.union([z.literal('user'), z.literal('assistant'), z.literal('system')]),
  content: z.string(),
});

const SessionUserSchema = z.object({
  id: z.string(),
  username: z.string(),
  display_name: z.string(),
  has_password: z.boolean(),
});

const ArgsSchema = z.object({
  messages: z.array(MessageSchema).default([]),
  trigger: z
    .union([
      z.literal('user_message'),
      z.literal('silence_after_question'),
      z.literal('quiet_wait_resume'),
      z.literal('open_canvas'),
      z.literal('user_says_ready'),
      z.literal('user_welcomed'),
    ])
    .optional(),
  welcomedUser: z.object({ display_name: z.string().optional() }).optional(),
  mayAskActive: z.boolean().optional(),
  modality: z.union([z.literal('voice'), z.literal('text')]).optional(),
  uiClientId: z.string().optional(),
  /** Session user resolved from cookies by the HTTP route; null
   *  acceptable on the IPC path or unauthenticated calls. */
  sessionUser: SessionUserSchema.nullable().optional(),
});

type Args = z.infer<typeof ArgsSchema>;

function readSuperuserToken(): string {
  try {
    const token = readFileSync(join(homedir(), '.papercusp', 'superuser-token'), 'utf8').trim();
    return token.length >= 16 ? token : '';
  } catch {
    return '';
  }
}

export default defineTool({
  name: 'operator:converse',
  description:
    'Operator brain conversation turn. Self-contained: builds the prompt (role+memory+history+trigger), gates on budget, runs the LLM with agentmcp tools, records spend, post-turn mem0.add, dispatches <spawn> tags. Streams deltas + tool_calls.',
  capability: 'operator:converse',
  requirePrincipal: false,
  roles: ['operator'],
  timeoutSec: 600,
  idleTimeoutSec: 120,
  args: ArgsSchema,
  events: {
    delta: z.object({ text: z.string() }),
    tool_call: z.object({ name: z.string(), input: z.unknown() }),
  },
  handler: async (input: Args, ctx) => {
    const sessionUser: ConverseSessionUser | null = input.sessionUser ?? null;

    // Build the prompt up-front. This dominates wall-clock when mem0
    // is healthy (search hits one or two times). Failures inside
    // buildOperatorPrompt are swallowed best-effort already; an
    // outer throw here would be a real config error worth surfacing.
    const promptText = await buildOperatorPrompt(
      {
        messages: input.messages,
        trigger: input.trigger,
        welcomed_user: input.welcomedUser,
        mayAskActive: input.mayAskActive,
        modality: input.modality,
      } satisfies OperatorConverseInput,
      sessionUser,
    );

    // Budget gate. operator-converse fires on every user turn AND
    // self-fired silence-ladder triggers AND through ask_operator
    // from voice — without a cap this burns through the daily budget.
    const budget = await checkBudget();
    if (budget.state && budget.exceeded) {
      throw new Error(
        `Operator daily budget reached (${budget.todaySpendUsd.toFixed(2)} of ${budget.capUsd}). Raise the cap in /settings/operator or wait until tomorrow.`,
      );
    }

    // Principal + workspace check. Same as operator:scan and
    // operator:delegate — transport-agnostic gate via
    // readSystemPrincipal. Missing principal falls through to a lean
    // tool-less path so conversation still works.
    const principal = await readSystemPrincipal('operator');
    const workspaceId = activeWorkspaceId();
    const principalOk = principal !== null && principal.workspaceId === workspaceId;

    // mcpConfig with agentmcp HTTP via mcp-remote bridge (same pattern
    // as the old route). Reads superuser token from disk.
    const uiClientId =
      typeof input.uiClientId === 'string' && /^[0-9a-fA-F-]{16,128}$/.test(input.uiClientId)
        ? input.uiClientId
        : null;
    const mcpUrl =
      'http://127.0.0.1:3055/api/mcp?superuser=1' +
      (uiClientId ? `&client=${encodeURIComponent(uiClientId)}` : '');
    const superuserToken = readSuperuserToken();
    const mcpConfig =
      principalOk && superuserToken
        ? {
            mcpServers: {
              agentmcp: {
                type: 'stdio',
                command: 'npx',
                args: [
                  '-y',
                  'mcp-remote@latest',
                  mcpUrl,
                  '--header',
                  `Authorization:Bearer ${superuserToken}`,
                ],
              },
            },
          }
        : undefined;
    const allowedTools: readonly string[] =
      principalOk && superuserToken ? ALL_AGENT_MCP_TOOLS : [];

    let totalCost = 0;
    let assembled = '';
    try {
      for await (const ev of runAgentChat({
        promptText,
        mcpConfig,
        allowedTools: [...allowedTools],
        permissionMode: 'bypassPermissions',
        signal: ctx.signal,
      })) {
        if (ctx.signal?.aborted) break;
        if (ev.type === 'delta') {
          ctx.emit('delta', { text: ev.text });
          assembled += ev.text;
        } else if (ev.type === 'tool_call') {
          const name = ev.name.startsWith('mcp__agentmcp__')
            ? ev.name.replace(/^mcp__agentmcp__/, '')
            : ev.name;
          ctx.emit('tool_call', { name, input: ev.input });
        } else if (ev.type === 'result') {
          totalCost = ev.costUsd ?? 0;
        }
      }
    } catch (err) {
      throw new Error(
        `operator converse failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    // Post-stream side-effects. All fire-and-forget so transient
    // failures don't fail the user-visible response.
    void recordSpend(totalCost);

    if (sessionUser) {
      void (async () => {
        try {
          const { getMemoryClient } = await import('@/lib/memory/mem0-client');
          const client = await getMemoryClient();
          if (!client) return;
          const recentWindow = input.messages
            ? [...input.messages.slice(-5), { role: 'assistant' as const, content: assembled }]
            : [{ role: 'assistant' as const, content: assembled }];
          await client.add(recentWindow, {
            userId: sessionUser.id,
            metadata: {
              workspace_id: workspaceId,
              display_name: sessionUser.display_name,
              turn_at: Date.now(),
            },
          });
        } catch (err) {
          console.warn('[operator-converse] post-turn mem0.add failed:', (err as Error).message);
        }
      })();
    }

    // Server-side <spawn> tag dispatch. Same pattern as the old route —
    // parsing the assembled turn server-side ensures voice and text
    // surfaces both trigger spawns. (EL's ask_operator handler doesn't
    // run the client-side parser.)
    try {
      const parsed = parseOperatorTurn(assembled);
      for (const sp of parsed.spawns) {
        const params = new URLSearchParams({
          workspace: workspaceId,
          harness: 'system',
          role: 'operator',
          run: `op-converse-${Date.now()}`,
          spawn: `op-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
        });
        const fetchBody: Record<string, unknown> = { role: sp.role };
        if (sp.featureId) fetchBody.featureId = sp.featureId;
        if (sp.chunkId) fetchBody.chunkId = sp.chunkId;
        if (sp.extras.length > 0) fetchBody.extras = sp.extras;
        void fetch(`http://127.0.0.1:3055/api/plugins/orchestrator/spawn?${params.toString()}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(fetchBody),
        }).catch((err) => {
          console.warn('[operator-converse] spawn dispatch failed', err);
        });
      }
    } catch (err) {
      console.warn('[operator-converse] spawn parse/dispatch error', err);
    }

    return {
      content: [{ type: 'text', text: JSON.stringify({ totalCost, assembled }) }],
    };
  },
});
