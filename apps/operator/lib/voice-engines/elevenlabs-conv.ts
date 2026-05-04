/**
 * ElevenLabs Conversational AI engine.
 *
 * Primary `fullAgentEngine` for v5+. Replaces the existing stub at
 * lib/voice-engines/elevenlabs-mse.ts (TTS-only) for the conversational path.
 *
 * Architecture (see /docs/agents/action-registry §0, §8):
 *   browser ── WebRTC ──> ElevenLabs Conv AI agent (Claude Haiku via BYO LLM)
 *      ▲                       │
 *      │ clientTools (in-page)  │ webhook tools (server-side)
 *      ▼                       ▼
 *   Action Registry         /api/elevenlabs/webhook/*
 *
 * Reflexive commands (browser:'required') are emitted as **client-side
 * tools** — when the agent calls them, the SDK invokes our handler in
 * the browser, we run runCommand() locally, return the result. Sub-100ms.
 *
 * Server-side commands + delegate_to_claude are configured at agent-creation
 * time on the EL dashboard as **webhook tools** pointing at our public
 * endpoints. Those don't go through this client; the agent talks to our
 * server directly.
 *
 * This module only handles the in-page audio + clientTools loop.
 */

import { Conversation, type VoiceConversation } from '@elevenlabs/client';
import { runCommand, runQuery, list } from '../commands/registry';
import type { CommandContext, Definition } from '../commands/types';
import '../commands/defs';

interface StartArgs {
  agentId: string;
  conversationToken: string;
  workspace: string;
  tabId: string;
  onTranscript?: (text: string) => void;
  onAssistantText?: (text: string) => void;
  onError?: (err: Error) => void;
  onConnect?: () => void;
  onDisconnect?: () => void;
}

export interface ElevenLabsHandle {
  endSession(): Promise<void>;
  getStatus(): 'connecting' | 'connected' | 'disconnected' | 'unknown';
  getConversationId(): string | null;
}

export async function startElevenLabsConv(args: StartArgs): Promise<ElevenLabsHandle> {
  if (typeof window === 'undefined') throw new Error('elevenlabs-conv must run in browser');

  // Build the clientTools map from registry. Only browser:'required' commands
  // and queries are eligible — server-side commands are wired as webhook tools
  // on the EL dashboard.
  const clientTools = buildClientTools({
    workspace: args.workspace,
    tabId: args.tabId,
  });

  // Inject a brief "open Claude conversations" preamble so the voice
  // agent can pick which session to delegate to. Keeps voice's working
  // memory of prior delegations alive across EL session resets.
  const sessionsContext = await fetchClaudeSessionsBlock(args.workspace);

  const conv = await Conversation.startSession({
    conversationToken: args.conversationToken,
    connectionType: 'webrtc',
    textOnly: false,
    clientTools,
    overrides: sessionsContext
      ? {
          agent: {
            prompt: {
              prompt: sessionsContext,
            },
          },
        }
      : undefined,
    onConnect: () => { args.onConnect?.(); },
    onDisconnect: () => { args.onDisconnect?.(); },
    onMessage: ({ message, source }) => {
      if (source === 'user') args.onTranscript?.(message);
      else if (source === 'ai') args.onAssistantText?.(message);
    },
    onError: (msg) => { args.onError?.(new Error(msg)); },
  } as any) as VoiceConversation;

  return {
    async endSession() { await conv.endSession(); },
    getStatus() {
      try {
        return (conv as any).getStatus?.() ?? 'unknown';
      } catch { return 'unknown'; }
    },
    getConversationId() {
      try {
        return (conv as any).getId?.() ?? null;
      } catch { return null; }
    },
  };
}

/**
 * Build the registry-derived clientTools map. EL Conv AI clientTools are
 * in-page: { [name]: (params) => result }. Each entry runs the matching
 * registry command/query and returns the result as a string (EL accepts
 * string | number | void).
 *
 * We expose only browser:'required' commands as client-side tools — the
 * rest were configured as webhook tools on the EL dashboard during agent
 * setup, and the agent calls our server directly for those.
 */
function buildClientTools(opts: {
  workspace: string;
  tabId: string;
}): Record<string, (parameters: any) => Promise<string>> {
  const tools: Record<string, (parameters: any) => Promise<string>> = {};
  const ctx = (): CommandContext => ({
    agent: 'operator',
    workspace: opts.workspace,
    sessionId: opts.tabId,
    requestId: `el-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
  });

  // Reflexive commands: browser:'required' tier-reflexive
  const commands = list({ kind: 'command', agent: 'operator', browser: ['required'] });
  for (const def of commands) {
    tools[normalizeToolName(def.id)] = async (params: any) => {
      const result = await runCommand(def.id, params, ctx());
      return JSON.stringify(result);
    };
  }

  // Queries — voice's fast-query surface. Always client-side for speed.
  const queries = list({ kind: 'query', agent: 'operator' });
  for (const def of queries) {
    tools[normalizeToolName(def.id)] = async (params: any) => {
      const result = await runQuery(def.id, params, ctx());
      return JSON.stringify(result);
    };
  }

  return tools;
}

/**
 * EL Conv AI tool names must match the agent's configured tools exactly.
 * Our registry IDs use dotted notation (`panel.toggle`); EL is case
 * sensitive but tolerant of dots. We pass through unchanged for now;
 * if EL refuses dots we'll rewrite to underscores here.
 */
function normalizeToolName(id: string): string {
  return id;
}

/**
 * Build the JSON catalog of clientTools we want to sync to the EL agent.
 * Used by an admin endpoint that PUTs the tool list to the agent platform
 * during PR 1's setup phase. Each entry is the agent-config shape EL expects.
 */
export function buildClientToolCatalog(): Array<{
  name: string;
  description: string;
  parameters: unknown;
  expects_response: boolean;
}> {
  const out: Array<{ name: string; description: string; parameters: unknown; expects_response: boolean }> = [];
  const eligible: Definition[] = [
    ...list({ kind: 'command', agent: 'operator', browser: ['required'] }),
    ...list({ kind: 'query', agent: 'operator' }),
  ];
  for (const def of eligible) {
    out.push({
      name: normalizeToolName(def.id),
      description: def.promptDescription ?? def.description,
      parameters: zodToJsonSchemaFor(def.schema),
      expects_response: true,
    });
  }
  return out;
}

// Lazy import to avoid pulling zod-to-json-schema on the hot voice path.
function zodToJsonSchemaFor(_schema: unknown): unknown {
  // Plumbed via the elevenlabs-shim sync endpoint, not at session start.
  return {};
}

/**
 * Build the "you have these Claude conversations open" context block
 * for voice. Voice picks which session to pass to delegate_to_claude
 * based on title relevance. Refreshed at every EL session-start.
 */
async function fetchClaudeSessionsBlock(workspace: string): Promise<string | null> {
  try {
    const r = await fetch(`/api/agent-mcp/claude-sessions?status=open&limit=10`, {
      headers: { 'x-workspace': workspace },
    });
    if (!r.ok) return null;
    const data = await r.json() as {
      sessions: Array<{ id: number; title: string | null; lastActiveAt: string; turnCount: number; claudeSessionId: string }>;
    };
    if (!data.sessions?.length) {
      return (
        'You have no open Claude conversations in this workspace. ' +
        'When the user delegates a deep-reasoning task to you, call ' +
        '`delegate_to_claude` with newSession:true to start a fresh one.'
      );
    }
    const lines = data.sessions.map((s) => {
      const title = s.title ?? '(untitled)';
      const minsAgo = Math.round((Date.now() - new Date(s.lastActiveAt).getTime()) / 60000);
      return `  - id:${s.claudeSessionId.slice(0, 8)} "${title}" (${s.turnCount} turns, ${minsAgo}m ago)`;
    });
    return [
      'You have access to these ongoing Claude conversations in this workspace:',
      ...lines,
      '',
      'When delegating: pass `sessionId` (the id from the list above) if the user\'s task',
      'relates to one of these conversations; pass `newSession:true` for a clean slate;',
      'pass neither and the server picks (most recent if <5min, else new).',
    ].join('\n');
  } catch {
    return null;
  }
}
