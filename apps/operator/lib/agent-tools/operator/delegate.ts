/**
 * operator:delegate — Delegate-claude streaming-chat core.
 *
 * Phase 3 fold-in. Backs the /api/agent-mcp/delegate-chat route, which
 * is invoked by the `delegate_to_claude` voice tool (see
 * apps/operator/lib/commands/defs/delegation.ts) — the voice agent's
 * deep-work escape hatch.
 *
 * Route owns session-management (createDelegate / getDelegate /
 * autoArchiveIdleDelegates / bumpDelegate), system-prompt composition,
 * append-delegate-turn (PG write), and session-title generation. This
 * tool handles the LLM streaming + tool-call forwarding and returns
 * the final cost + tokens + fullText so the route can fire its
 * post-stream side-effects with the same data the consumer's
 * sink.done event would have shown.
 *
 * Wire format:
 *   event: delta    data: { text }    ← object → JSON (consumer at
 *                                       delegation.ts:179 does JSON.parse(...))
 *   event: tool_call data: { name, input }
 *   event: done     data: <ToolResult.content as JSON>  ← framework auto-emit
 *                                                       (route emits its own
 *                                                        sink.done with the
 *                                                        full payload outside)
 */

import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { runAgentChat } from '@/lib/agent-chat-stream';

const ArgsSchema = z.object({
  promptText: z.string(),
  agentSessionId: z.string(),
  /** Stringified mcpConfig (delegate + optional agentmcp servers). */
  mcpConfigJson: z.string(),
  allowedTools: z.array(z.string()),
});

type Args = z.infer<typeof ArgsSchema>;

defineTool({
  name: 'operator:delegate',
  description:
    'Delegate-to-claude streaming chat core. Spawns claude with session resume + MCP tools; emits deltas + tool_calls; returns { costUsd, tokensIn, tokensOut, fullText } for the route.',
  capability: 'operator:delegate',
  requirePrincipal: false,
  roles: ['operator'],
  timeoutSec: 600,
  idleTimeoutSec: 120,
  args: ArgsSchema,
  events: {
    delta: z.object({ text: z.string() }),
    tool_call: z.object({ name: z.string(), input: z.unknown() }),
    error: z.object({ message: z.string(), stderr: z.string().optional() }),
  },
  handler: async (input: Args, ctx) => {
    const mcpConfig = input.mcpConfigJson ? JSON.parse(input.mcpConfigJson) : undefined;

    let assistantText = '';
    let costUsd = 0;
    let tokensIn = 0;
    let tokensOut = 0;

    try {
      for await (const ev of runAgentChat({
        promptText: input.promptText,
        sessionId: input.agentSessionId,
        sessionMode: 'force',
        mcpConfig,
        allowedTools: input.allowedTools,
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
          // Non-fatal mid-stream error from runAgentChat. Schema is
          // declared as z.object so the framework JSON-encodes the
          // payload (matches the consumer at delegation.ts:208 doing
          // JSON.parse(ev.data).message).
          ctx.emit('error', { message: ev.message, ...(ev.stderr ? { stderr: ev.stderr } : {}) });
        }
      }
    } catch (err) {
      throw new Error(
        `operator delegate failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({ costUsd, tokensIn, tokensOut, fullText: assistantText }),
        },
      ],
    };
  },
});
