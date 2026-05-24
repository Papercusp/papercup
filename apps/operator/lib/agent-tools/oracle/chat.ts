/**
 * oracle:chat — global Oracle assistant turn.
 *
 * Single-turn streaming chat against the workspace-scoped Oracle persona.
 * Wraps runAgentChat with the ORACLE_ALLOWED_TOOLS surface (ui:* dispatch,
 * harness:*, agent_chats:*, etc.). Self-contained: prompt assembly +
 * MCP config build live in ./prompts; the Hono shim at /api/oracle/chat
 * forwards args verbatim, which lets the IPC fast-path call this tool
 * directly without an HTTP round-trip for prompt composition.
 *
 * Wire format (verified against OracleDock.tsx:840):
 *   event: delta       data: { text: string }                ← JSON
 *   event: tool_call   data: { name: string, input: unknown } ← JSON
 *   event: cost        data: { usd: number }                  ← JSON
 *   event: error       data: { message: string, stderr?: string } ← JSON
 *   event: tutorial_end data: {}                              ← JSON, sent once when final tutorial step reached
 *   event: done        data: <ToolResult.content as JSON>     ← terminal frame (shim dispatch loop / projected adapter emits + closes)
 *
 * Note: delta is z.object (JSON), NOT z.string raw — the consumer
 * does JSON.parse(data).text. Differs from architect:chat which uses
 * raw text for delta.
 */

import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { runAgentChat } from '@/lib/agent-chat-stream';
import {
  composeOraclePrompt,
  buildOracleMcpConfig,
  oracleToolEventFilter,
  ORACLE_ALLOWED_TOOLS,
  type OracleMessage,
} from './prompts';

const MessageSchema = z.object({
  role: z.union([z.literal('user'), z.literal('assistant')]),
  content: z.string(),
});

const ArgsSchema = z.object({
  messages: z.array(MessageSchema).min(1),
  currentPath: z.string().default(''),
  tutorialMode: z.boolean().default(false),
  uiClientId: z.string().optional(),
  /**
   * Session user id, populated by HTTP shims via getSessionUserOrDefault().
   * Optional because the tool can also be reached from MCP/IPC paths that
   * have no Next cookie context. When present, mem0 memory is fetched at
   * both user-scope AND workspace-scope; when absent, workspace-scope only.
   */
  userId: z.string().optional(),
});

type Args = z.infer<typeof ArgsSchema>;

const EVENTS = {
  // JSON wire (consumer at OracleDock.tsx:840 does JSON.parse(data).text).
  delta: z.object({ text: z.string() }),
  tool_call: z.object({ name: z.string(), input: z.unknown() }),
  cost: z.object({ usd: z.number() }),
  error: z.object({ message: z.string(), stderr: z.string().optional() }),
  // Fired once when the user reaches the final tutorial step (or stops).
  tutorial_end: z.object({}),
} as const;

interface ChatCtx {
  emit: (n: string, d: unknown) => void;
  signal?: AbortSignal;
}

async function oracleHandler(input: Args, ctx: ChatCtx) {
  const { promptText, tutorialIsFinalStep } = await composeOraclePrompt(
    input.messages as OracleMessage[],
    {
      currentPath: input.currentPath,
      tutorialMode: input.tutorialMode,
      userId: input.userId,
    },
  );

  if (tutorialIsFinalStep) ctx.emit('tutorial_end', {});

  const mcpConfig = await buildOracleMcpConfig({ uiClientId: input.uiClientId ?? null });
  if (!mcpConfig) {
    throw new Error(
      'Oracle not provisioned: missing system principal or superuser token. ' +
        'POST /api/agent-mcp/provision first and ensure ~/.papercusp/superuser-token exists.',
    );
  }

  let finalText = '';
  try {
    for await (const ev of runAgentChat({
      promptText,
      mcpConfig,
      allowedTools: [...ORACLE_ALLOWED_TOOLS],
      toolEventFilter: oracleToolEventFilter,
      permissionMode: 'bypassPermissions',
      signal: ctx.signal,
    })) {
      if (ev.type === 'delta') {
        ctx.emit('delta', { text: ev.text });
        finalText += ev.text;
      } else if (ev.type === 'tool_call') {
        ctx.emit('tool_call', { name: ev.name, input: ev.input });
      } else if (ev.type === 'result') {
        ctx.emit('cost', { usd: ev.costUsd });
      } else if (ev.type === 'error') {
        ctx.emit('error', { message: ev.message, stderr: ev.stderr });
      }
    }
  } catch (err) {
    throw new Error(
      `oracle chat failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return { content: [{ type: 'text' as const, text: finalText }] };
}

export const oracleChat = defineTool({
  name: 'oracle:chat',
  profile: 'engineer',
  description: 'Single-turn Oracle assistant chat. Streams delta/tool_call/cost events; returns final assistant text.',
  args: ArgsSchema,
  events: EVENTS,
  roles: ['operator'],
  timeoutSec: 600,
  idleTimeoutSec: 120,
  // Phase 4 T2.2 — same replay budget as architect:chat / operator:scan.
  replayBufferSize: 5000,
  capability: 'harness:read',
  requirePrincipal: false,
  handler: oracleHandler,
});

export default oracleChat;
