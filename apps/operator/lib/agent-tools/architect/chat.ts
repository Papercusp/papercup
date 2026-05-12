/**
 * architect:chat — Architect-mode chat turn.
 *
 * Streams a single turn via runAgentChat (backend-aware: `omp -p` by
 * default, `claude -p` when AGENT_BACKEND=claude-code). Pilot 2 of the
 * typed-event channel migration (Phase 3).
 *
 * The Hono route at /:slug/architect/chat is a thin shim: it composes
 * the prompt (loads SPEC.md, validation-contract.md, features list,
 * issues tail, optional review context) and dispatches into this tool
 * via dispatchProjectedToolStream. The tool itself is prompt-agnostic
 * so the shim retains the "Architect-specific prompt-assembly" code
 * without making the tool import from the route.
 *
 * Wire format:
 *   event: delta   data: <raw text>           ← z.string() → raw on wire
 *   event: tool_call data: { name, input }    ← object → JSON
 *   event: cost    data: { usd, input, output } ← object → JSON
 *   event: error   data: <raw text>           ← z.string() → raw on wire
 *   event: done    data: <ToolResult.content as JSON>  ← framework auto-emit
 *
 * The submodule consumer at libs/agent-chat's useHarnessChatRuntime.ts
 * only handles `delta` (accum += data) and `error` (accum += data) —
 * it ignores `done` and `cost` and closes on stream-end. Raw-text wire
 * for delta + error preserves bit-exact compat with the pre-migration
 * sink.eventRaw('delta', text) / sink.eventRaw('error', msg) shape.
 */

import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { runAgentChat } from '@/lib/agent-chat-stream';

const ArgsSchema = z.object({
  /** Fully-composed prompt: system instructions + history + current message. */
  promptText: z.string(),
  /** Project working directory (cwd for the agent process). */
  cwd: z.string(),
});

type Args = z.infer<typeof ArgsSchema>;

defineTool({
  name: 'architect:chat',
  description:
    'Architect-mode chat turn: clarify spec, propose patches. Streams deltas; returns the assembled final text.',
  capability: 'harness:write',
  requirePrincipal: false,
  roles: ['operator'],
  timeoutSec: 600,
  idleTimeoutSec: 120,
  args: ArgsSchema,
  events: {
    // z.string() → raw text on the SSE wire (matches pre-migration
    // sink.eventRaw('delta', text); the submodule consumer does
    // accum += ev.data and expects no JSON wrapping).
    delta: z.string(),
    tool_call: z.object({ name: z.string(), input: z.unknown() }),
    cost: z.object({
      usd: z.number(),
      input: z.number().optional(),
      output: z.number().optional(),
    }),
    // Same wire-compat reason as delta: consumer does accum += ev.data
    // for error events.
    error: z.string(),
  },
  handler: async (input: Args, ctx) => {
    let finalText = '';
    try {
      for await (const ev of runAgentChat({
        promptText: input.promptText,
        cwd: input.cwd,
      })) {
        if (ev.type === 'delta') {
          ctx.emit('delta', ev.text);
          finalText += ev.text;
        } else if (ev.type === 'tool_call') {
          ctx.emit('tool_call', { name: ev.name, input: ev.input });
        } else if (ev.type === 'result') {
          ctx.emit('cost', {
            usd: ev.costUsd,
            input: ev.tokensIn,
            output: ev.tokensOut,
          });
        } else if (ev.type === 'error') {
          // Non-fatal mid-stream error (runAgentChat may yield error
          // events that don't end the stream — e.g. tool-call errors
          // that the model retries).
          ctx.emit(
            'error',
            `${ev.message}${ev.stderr ? `: ${ev.stderr.slice(0, 500)}` : ''}`,
          );
        }
      }
    } catch (err) {
      // Fatal: rethrow so the dispatcher records status=error and the
      // framework auto-emits event: error.
      throw new Error(
        `architect chat failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    return { content: [{ type: 'text', text: finalText }] };
  },
});
