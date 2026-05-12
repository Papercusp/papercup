/**
 * operator:scan — the operator workspace scanner core.
 *
 * Streaming-chat-and-parser tool extracted from the legacy
 * /api/agent-mcp/operator-scan route as Pilot 1 of the typed-event
 * channel migration (Phase 3). The route still owns the pre/post
 * bookkeeping (rate limit, scan-lock, budget, idle-cache
 * short-circuit, scan-history row, plugin-suggestion gathering,
 * writeLastScan, writeSnapshot, recordSuccess, markFirstRunShown,
 * session bumping). It dispatches into this tool via
 * `dispatchProjectedToolStream` for the actual LLM streaming +
 * suggestion parsing.
 *
 * What this tool does:
 *   1. Spawn the scanner LLM via `runAgentChat` with the caller-built
 *      prompt + the route-resolved superuser MCP config + the
 *      scanner-session resume params.
 *   2. Emit `delta` / `tool_call` events live.
 *   3. On the model's terminal result, run `parseSuggestions` over the
 *      full assistant text, emit each parsed block as a `suggestion`
 *      event, and return the totals.
 *
 * The route picks up the returned text JSON, gathers + emits plugin
 * suggestions, persists the combined card list, and emits the final
 * `done` itself.
 */

import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { runAgentChat } from '@/lib/agent-chat-stream';
import { parseSuggestions } from '@/lib/operator-suggestion-parser';
import type { OperatorPreferences } from '@/lib/operator-preferences';
import { NON_INTERACTIVE_AGENT_MCP_TOOLS } from '@/lib/operator-mcp-tools';

const ArgsSchema = z.object({
  /** Pre-composed prompt (bootstrap + base operator prompt + request). */
  promptText: z.string(),
  /** Superuser bearer token from ~/.papercusp/superuser-token; null = no MCP tools. */
  superuserToken: z.string().nullable(),
  /** Persistent scanner session id (Phase 3 resume); null = fresh session. */
  scannerSessionId: z.string().nullable(),
  /** Operator preferences, serialized so the tool args remain JSON-friendly. */
  preferencesJson: z.string(),
});

type Args = z.infer<typeof ArgsSchema>;

/**
 * Per-block payload emitted as a `suggestion` event AND returned in
 * the tool result so the route can write the combined card list to
 * scan history.
 */
interface SuggestionPayload {
  [k: string]: unknown;
  actualTier: unknown;
  auto_dispatch: unknown;
  provenanceFlags: unknown;
}

export default defineTool({
  name: 'operator:scan',
  description:
    'Operator workspace scanner core: stream a one-shot scanner LLM and parse <suggestion> blocks. Owned by the operator role; not user-callable from spawned agents.',
  capability: 'operator:scan',
  requirePrincipal: false,
  roles: ['operator'],
  // Wall-clock cap — scanner turns are usually 10-30s; 10min is room for
  // pathological cases without leaving wedged children running for hours.
  timeoutSec: 600,
  // Abort if the scanner stops emitting for 2min. Catches deadlocked or
  // crashed-but-not-exited child processes that wall-clock can't see.
  idleTimeoutSec: 120,
  args: ArgsSchema,
  events: {
    // delta: JSON-wrapped — the operator panel consumer at
    // OperatorPanel.tsx:722 does `JSON.parse(data).text`, so this stays
    // an object schema (NOT z.string()) to preserve consumer wire compat.
    delta: z.object({ text: z.string() }),
    tool_call: z.object({ name: z.string(), input: z.unknown() }),
    // Suggestion payload shape comes from operator-suggestion-parser's
    // enrichment; expressed as a passthrough record so we don't need to
    // mirror the full ParsedSuggestion schema here.
    suggestion: z.record(z.unknown()),
  },
  handler: async (input: Args, ctx) => {
    const preferences = JSON.parse(input.preferencesJson) as OperatorPreferences;

    let costUsd = 0;
    let assistantText = '';
    const llmBlocks: SuggestionPayload[] = [];
    let parseErrors = 0;

    for await (const ev of runAgentChat({
      promptText: input.promptText,
      mcpConfig: input.superuserToken
        ? {
            mcpServers: {
              agentmcp: {
                // omp silently drops type:'http' MCP servers — bridge
                // through mcp-remote (stdio→HTTP).
                type: 'stdio',
                command: 'npx',
                args: [
                  '-y',
                  'mcp-remote@latest',
                  'http://127.0.0.1:3055/api/mcp?superuser=1',
                  '--header',
                  `Authorization:Bearer ${input.superuserToken}`,
                ],
              },
            },
          }
        : undefined,
      // Scanner is one-shot — emits suggestions, doesn't have a
      // user-facing chat session to wait on. Excludes chat:* tools
      // that require an interactive responder (e.g. chat:ask_choice).
      allowedTools: input.superuserToken ? [...NON_INTERACTIVE_AGENT_MCP_TOOLS] : [],
      toolEventFilter: (raw) =>
        raw.startsWith('mcp__agentmcp__') ? raw.replace(/^mcp__agentmcp__/, '') : null,
      permissionMode: 'bypassPermissions',
      sessionId: input.scannerSessionId ?? undefined,
      sessionMode: input.scannerSessionId ? 'force' : undefined,
      // Caller-side cancellation: forward the dispatcher's signal so
      // client disconnect or idle/wall-clock timeout actually stops the
      // subprocess instead of letting it run to completion.
      signal: ctx.signal,
    })) {
      if (ev.type === 'delta') {
        assistantText += ev.text;
        ctx.emit('delta', { text: ev.text });
      } else if (ev.type === 'tool_call') {
        ctx.emit('tool_call', { name: ev.name, input: ev.input });
      } else if (ev.type === 'result') {
        costUsd = ev.costUsd;
        const parsed = await parseSuggestions(ev.finalText || assistantText, preferences);
        parseErrors = parsed.parseErrors;
        for (const block of parsed.blocks) {
          const payload: SuggestionPayload = {
            ...block.suggestion.raw,
            actualTier: block.suggestion.actualTier,
            auto_dispatch: block.suggestion.auto_dispatch,
            provenanceFlags: block.suggestion.provenanceFlags,
          };
          llmBlocks.push(payload);
          ctx.emit('suggestion', payload);
        }
      } else if (ev.type === 'error') {
        ctx.emit('error', { message: ev.message });
      }
    }

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({ costUsd, assistantText, llmBlocks, parseErrors }),
        },
      ],
    };
  },
});
