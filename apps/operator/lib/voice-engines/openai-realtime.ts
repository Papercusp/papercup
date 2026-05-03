/**
 * OpenAI Realtime — full-agent engine.
 *
 * One WebRTC connection that handles STT + LLM + TTS + turn-taking +
 * interruption + tool calling. Replaces the entire `voice-mode.ts`
 * pipeline (STT engine + intent parser + TTS engine) with a single
 * conversational session.
 *
 * Intents — operator open / scan / approve / across-workspaces — become
 * function tools the model invokes naturally. No regex matching, no
 * wake-word listener, no leader election (single connection per tab;
 * leader still gates which tab opens the session).
 *
 * Pricing (May 2026): ~$0.06/min audio in + ~$0.24/min audio out.
 * Cap-trip lives in stt-spend / tts-spend infrastructure.
 */

import { RealtimeAgent, RealtimeSession, tool } from '@openai/agents-realtime';
import { z } from 'zod';

export interface RealtimeEngineCallbacks {
  onTranscript?: (text: string) => void;
  onAssistantText?: (text: string) => void;
  onError?: (err: Error) => void;
  /** Fired when the model invokes the `open_operator` tool. */
  onIntentOpen?: () => void;
  /** Fired when the model invokes the `scan` tool. */
  onIntentScan?: (query?: string) => void;
  /** Fired when the model invokes the `approve` tool. */
  onIntentApprove?: (slug: string, capability?: string) => void;
  /** Fired when the model invokes the `across_workspaces` tool. */
  onIntentAcrossWorkspaces?: () => void;
}

export interface RealtimeEngineHandle {
  /** Tear down the session. Idempotent. */
  stop(): Promise<void>;
  /** Inject a system message mid-session (e.g. context update). */
  sendSystem(text: string): void;
}

const INSTRUCTIONS = `You are the Operator voice assistant for Papercusp — a coding-harness control plane.
The user is busy and direct. Keep responses short (one or two sentences).
When the user asks you to take an action that maps to one of your tools, call the tool. Don't narrate.
When the user asks a question that doesn't map to a tool, answer concisely.
The user may say a wake word ("hey operator") followed by a command — strip the wake word and act on the command.`;

export async function startRealtimeSession(
  apiKey: string,
  callbacks: RealtimeEngineCallbacks = {},
): Promise<RealtimeEngineHandle> {
  const openTool = tool({
    name: 'open_operator',
    description: 'Open the Operator panel in the UI.',
    parameters: z.object({}).strict(),
    execute: async () => {
      callbacks.onIntentOpen?.();
      return { ok: true };
    },
  });

  const scanTool = tool({
    name: 'scan',
    description: 'Open the Operator panel and trigger a scan with an optional query.',
    parameters: z.object({
      query: z.string().nullable().describe('Optional natural-language query to seed the scan.'),
    }).strict(),
    execute: async ({ query }) => {
      callbacks.onIntentScan?.(query ?? undefined);
      return { ok: true };
    },
  });

  const approveTool = tool({
    name: 'approve',
    description: 'Approve a pending capability for a harness slug.',
    parameters: z.object({
      slug: z.string().describe('Harness slug, e.g. "sheets" or "forms".'),
      capability: z.string().nullable().describe('Optional capability id, e.g. "tasks-write". Omit if there is exactly one pending.'),
    }).strict(),
    execute: async ({ slug, capability }) => {
      callbacks.onIntentApprove?.(slug, capability ?? undefined);
      return { ok: true };
    },
  });

  const acrossTool = tool({
    name: 'across_workspaces',
    description: 'Read out a summary of pending suggestions across all workspaces.',
    parameters: z.object({}).strict(),
    execute: async () => {
      callbacks.onIntentAcrossWorkspaces?.();
      return { ok: true };
    },
  });

  const agent = new RealtimeAgent({
    name: 'Operator',
    instructions: INSTRUCTIONS,
    tools: [openTool, scanTool, approveTool, acrossTool],
  });

  const session = new RealtimeSession(agent);

  // Wire transcripts so the panel UI can show what's being heard.
  session.on('history_updated', (history) => {
    const last = history[history.length - 1];
    if (!last) return;
    if (last.type === 'message' && last.role === 'user') {
      const txt = (last.content ?? [])
        .map((c: any) => c?.transcript ?? c?.text ?? '')
        .join(' ')
        .trim();
      if (txt) callbacks.onTranscript?.(txt);
    } else if (last.type === 'message' && last.role === 'assistant') {
      const txt = (last.content ?? [])
        .map((c: any) => c?.transcript ?? c?.text ?? '')
        .join(' ')
        .trim();
      if (txt) callbacks.onAssistantText?.(txt);
    }
  });

  session.on('error', (err) => {
    callbacks.onError?.(err instanceof Error ? err : new Error(String(err)));
  });

  await session.connect({ apiKey });

  return {
    async stop(): Promise<void> {
      try { await session.close(); } catch { /* ignore */ }
    },
    sendSystem(text: string): void {
      try { session.sendMessage(text); } catch { /* ignore */ }
    },
  };
}

/**
 * Connection test for /settings/voice. Hits the OpenAI sessions endpoint
 * to mint an ephemeral key — confirms the API key is valid + has Realtime
 * access without holding open a WebRTC connection.
 */
export async function testRealtimeConnection(apiKey: string): Promise<
  | { ok: true }
  | { ok: false; error: string }
> {
  try {
    const r = await fetch('https://api.openai.com/v1/realtime/sessions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'content-type': 'application/json',
        'OpenAI-Beta': 'realtime=v1',
      },
      body: JSON.stringify({ model: 'gpt-4o-realtime-preview' }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!r.ok) {
      const body = await r.text();
      return { ok: false, error: `HTTP ${r.status}: ${body.slice(0, 200)}` };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
