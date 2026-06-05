/**
 * agent_chats:chat — single-turn streaming chat for a role-scoped agent
 * inside a harness (Phase B "Pair" primitive).
 *
 * Thin slice: the tool receives a pre-assembled promptText + cwd and
 * streams the LLM response back as delta/error events. The Hono shim at
 * `_hono/agent-chats.ts` handles the substantial PG-scoped pre/post work
 * — cost-cap reads, feature-lock checks, transcript append, final-turn
 * persistence with token/cost rollup. Splitting it this way keeps the
 * tool transport-agnostic (no harness PG access required) while still
 * collapsing the LLM-stream emission onto the function-as-truth model.
 *
 * Sibling `apps/operator/lib/agent-tools/agent_chats/send_message.ts`
 * is unrelated: that's the fire-and-forget non-streaming message
 * append used by autonomous dispatches; this is the user-driven
 * interactive stream the chat surface drives.
 *
 * Wire format (verified against apps/operator/app/harness/ChatPanel.tsx:216):
 *   event: delta  data: { text: string }    ← JSON; consumer does JSON.parse(data).text
 *   event: error  data: { message: string, stderr?: string }
 *   event: done   data: <ToolResult.content as JSON>  ← framework auto-emit
 *
 * The ToolResult.content carries the rollup the route needs to persist:
 *   [{ type: 'text', text: JSON.stringify({ finalText, tokensIn, tokensOut, costUsd }) }]
 */

import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { runAgentChat } from '../../agent-chat-stream';
import { surfaceBackend, surfaceModel } from '../../agent-config';

const ArgsSchema = z.object({
  promptText: z.string().min(1),
  cwd: z.string().optional(),
});

type Args = z.infer<typeof ArgsSchema>;

const EVENTS = {
  // JSON wire (consumer at ChatPanel.tsx:216 does JSON.parse(data).text).
  delta: z.object({ text: z.string() }),
  error: z.object({ message: z.string(), stderr: z.string().optional() }),
} as const;

interface ChatCtx {
  emit: (n: string, d: unknown) => void;
  signal?: AbortSignal;
}

async function agentChatsHandler(input: Args, ctx: ChatCtx) {
  let assistantText = '';
  let tokensIn = 0;
  let tokensOut = 0;
  let costUsd = 0;
  let lastErrorMessage: string | null = null;
  let lastErrorStderr: string | undefined;

  // per-surface backend override (/settings/agent); undefined → global
  const agentChatsBackend = await surfaceBackend('agent_chats');
  const agentChatsModel = await surfaceModel('agent_chats'); // OQ3: undefined → backend default
  try {
    for await (const ev of runAgentChat({
      promptText: input.promptText,
      cwd: input.cwd,
      ...(agentChatsModel ? { model: agentChatsModel } : {}),
      backend: agentChatsBackend,
      signal: ctx.signal,
    })) {
      if (ev.type === 'delta') {
        assistantText += ev.text;
        ctx.emit('delta', { text: ev.text });
      } else if (ev.type === 'result') {
        tokensIn = ev.tokensIn;
        tokensOut = ev.tokensOut;
        costUsd = ev.costUsd;
        if (ev.finalText && ev.finalText.length > assistantText.length) {
          assistantText = ev.finalText;
        }
      } else if (ev.type === 'error') {
        // Mirror legacy behavior: accumulate the last error and re-emit
        // after the stream ends. agent-chats consumers treat error as
        // terminal even though runAgentChat may continue.
        lastErrorMessage = ev.message;
        lastErrorStderr = ev.stderr;
      }
      // tool_call: role-scoped chat agents don't get an MCP config
      // attached, so no tool_call events are surfaced. Future change-
      // point: forward here if a role gains tools.
    }
  } catch (err) {
    throw new Error(
      `agent_chats chat failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (lastErrorMessage) {
    ctx.emit('error', { message: lastErrorMessage, stderr: lastErrorStderr });
  }

  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify({ finalText: assistantText, tokensIn, tokensOut, costUsd }),
      },
    ],
  };
}

export const agentChatsChat = defineTool({
  name: 'agent_chats:chat',
  // No `expose.ipc` (was the footgun): route-dependent. The Hono shim at
  // _hono/agent-chats.ts does the cost-cap / feature-lock / transcript-persist
  // / prompt-assembly work and passes a pre-assembled `promptText`; a direct
  // IPC `endpoint_invoke('agent_chats:chat')` would bypass all of it (no
  // cost caps, no persistence, raw prompt). Consumers reach it via
  // fetch('/api/…') → sys:http, which runs the route over IPC. See the
  // expose.ipc footgun note in oracle/chat.ts.
  description:
    'Single-turn streaming chat against an already-assembled role prompt. Returns final text + token/cost rollup; the caller is expected to persist the assistant turn.',
  args: ArgsSchema,
  events: EVENTS,
  agentRoles: ['operator'],
  timeoutSec: 600,
  idleTimeoutSec: 120,
  replayBufferSize: 5000,
  capability: 'harness:read',
  requirePrincipal: false,
  handler: agentChatsHandler,
});

export default agentChatsChat;
