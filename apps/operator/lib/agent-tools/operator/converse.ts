/**
 * operator:converse — Operator brain streaming-chat core.
 *
 * Phase 3 fold-in. The /api/agent-mcp/operator-converse route owns
 * principal load, MCP-URL composition, message-history assembly,
 * post-turn mem0 fact extraction, and server-side <spawn> dispatch.
 * This tool handles the LLM streaming + tool-call event forwarding
 * and returns `{ totalCost, assembled }` so the route can run its
 * post-stream side effects.
 *
 * Wire format:
 *   event: delta   data: { text }   ← object → JSON (elevenlabs-conv consumer at
 *                                       :545 does JSON.parse(line.slice(6)).text)
 *   event: tool_call data: { name, input }   ← object → JSON
 *   event: done    data: <ToolResult.content as JSON>  ← framework auto-emit
 *                                                       (route emits its own
 *                                                        sink.done with cost
 *                                                        outside this tool)
 */

import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { runAgentChat } from '@/lib/agent-chat-stream';

const ArgsSchema = z.object({
  promptText: z.string(),
  /** Stringified mcpConfig (omp/claude-code transport); empty when principal unavailable. */
  mcpConfigJson: z.string(),
  /** Allowed-tools list; empty array when running tool-less. */
  allowedTools: z.array(z.string()),
});

type Args = z.infer<typeof ArgsSchema>;

export default defineTool({
  name: 'operator:converse',
  description:
    'Operator brain conversation turn. Streams deltas + tool_calls; returns { totalCost, assembled } for the route to use in post-turn dispatch (spawn parsing, mem0 fact extraction, etc.).',
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
    const mcpConfig = input.mcpConfigJson ? JSON.parse(input.mcpConfigJson) : undefined;

    let totalCost = 0;
    let assembled = '';
    try {
      for await (const ev of runAgentChat({
        promptText: input.promptText,
        mcpConfig,
        allowedTools: input.allowedTools,
        permissionMode: 'bypassPermissions',
        signal: ctx.signal,
      })) {
        if (ctx.signal.aborted) break;
        if (ev.type === 'delta') {
          ctx.emit('delta', { text: ev.text });
          assembled += ev.text;
        } else if (ev.type === 'tool_call') {
          // Strip the mcp__agentmcp__ prefix so the wire matches the
          // operator-scan tool_call shape; sidebar renders both identically.
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
    return {
      content: [{ type: 'text', text: JSON.stringify({ totalCost, assembled }) }],
    };
  },
});
