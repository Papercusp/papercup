/**
 * delegate_to_claude — voice's deep-work escape hatch.
 *
 * Plus the claude-sessions list/get queries voice uses to pick which
 * session a delegation lands in. See /docs/agents/action-registry §5
 * + the session-management decisions in §10 (#17).
 */
import { z } from 'zod';
import { register } from '../registry';
import type { CommandDef, QueryDef } from '../types';

function baseUrl(): string {
  if (typeof window !== 'undefined') return '';
  const port = process.env.PORT ?? process.env.NEXT_PUBLIC_PORT ?? '3155';
  return `http://127.0.0.1:${port}`;
}

// ─── Queries: claude-sessions.list / claude-sessions.get ─────────────

const ListSessionsArgs = z.object({
  status: z.enum(['open', 'archived', 'all']).default('open').optional()
    .describe('Filter by status. Default: open.'),
  limit: z.number().int().min(1).max(50).default(20).optional()
    .describe('Max sessions to return (default 20, cap 50).'),
});

const claudeSessionsList: QueryDef<z.infer<typeof ListSessionsArgs>> = {
  id: 'claude-sessions.list',
  kind: 'query',
  description: 'List Claude conversation sessions for the workspace.',
  promptDescription:
    'Returns currently-open Claude conversations as ' +
    '[{id, title, summary, lastActiveAt, turnCount, claudeSessionId}, ...]. ' +
    'Use to pick which session to pass to delegate_to_claude — match the ' +
    'user\'s request to a session by title/topic.',
  schema: ListSessionsArgs,
  agents: ['oracle', 'operator'],
  audit: 'sample',
  tier: 'fast-query',
  handler: async ({ status, limit }, ctx) => {
    if (typeof window !== 'undefined') {
      // Browser-side: fetch via API endpoint to avoid pulling PG into the bundle.
      const params = new URLSearchParams();
      if (status) params.set('status', status);
      if (limit) params.set('limit', String(limit));
      const r = await fetch(`/api/agent-mcp/claude-sessions?${params}`);
      if (!r.ok) throw new Error(`claude-sessions.list failed: HTTP ${r.status}`);
      return await r.json();
    }
    const { listClaudeSessions } = await import('../../claude-sessions');
    const rows = await listClaudeSessions({ workspace: ctx.workspace, status, limit });
    return { sessions: rows };
  },
};

const GetSessionArgs = z.object({
  id: z.string().min(1).describe('Session id (numeric or claude_session_id UUID).'),
});

const claudeSessionsGet: QueryDef<z.infer<typeof GetSessionArgs>> = {
  id: 'claude-sessions.get',
  kind: 'query',
  description: 'Get full metadata for a single Claude conversation session.',
  promptDescription:
    'Returns the long-form summary + last-activity for a given session. ' +
    'Use when picking via title alone is ambiguous and you want to read the ' +
    'session\'s actual recent context before deciding to delegate to it.',
  schema: GetSessionArgs,
  agents: ['oracle', 'operator'],
  audit: 'sample',
  tier: 'fast-query',
  handler: async ({ id }, ctx) => {
    if (typeof window !== 'undefined') {
      const r = await fetch(`/api/agent-mcp/claude-sessions?id=${encodeURIComponent(id)}`);
      if (!r.ok) throw new Error(`claude-sessions.get failed: HTTP ${r.status}`);
      return await r.json();
    }
    const { getClaudeSession } = await import('../../claude-sessions');
    const row = await getClaudeSession(ctx.workspace, id);
    return { session: row };
  },
};

// ─── Command: delegate_to_claude ─────────────────────────────────────

const DelegateArgs = z.object({
  task: z.string().min(1).describe('The user\'s request, paraphrased if helpful.'),
  context: z.string().optional()
    .describe('Optional extra context the model wants to attach (e.g. "feature: auth").'),
  sessionId: z.string().optional()
    .describe('Existing claude-session id to continue. Omit + set newSession:true for a fresh conversation.'),
  newSession: z.boolean().default(false).optional()
    .describe('Set true to start a fresh conversation regardless of sessionId.'),
});

const delegateToClaude: CommandDef<z.infer<typeof DelegateArgs>> = {
  id: 'delegate_to_claude',
  kind: 'command',
  description: 'Delegate complex reasoning, file reads, code analysis, or multi-step planning to Claude. Returns Claude\'s text response; voice should speak a one-sentence gist and announce "details in the panel".',
  promptDescription:
    'Use for anything requiring file reads, code analysis, planning, or any task ' +
    'you can\'t answer from your fast queries. Pass `sessionId` of an existing ' +
    'conversation if the user\'s task is related to prior work; pass `newSession:true` ' +
    'for a clean slate; pass neither and the server picks (recent if <5min, else new).' +
    '\n\nReturned `fullText` should NOT be read verbatim — speak a one-sentence ' +
    'summary and say "I\'ve put the details in the operator panel."',
  schema: DelegateArgs,
  agents: ['operator'],
  // Server-side delegation; the panel-update side-effect happens via SSE
  // to a separately-subscribed UI listener (see §5 + PR 3 wiring of the
  // panel auto-open hook). Tagged 'optional' because the call works even
  // if the panel isn't visible — server still streams Claude.
  browser: 'optional',
  concurrent: 'queue',
  tier: 'delegation',
  handler: async ({ task, context, sessionId, newSession }, _ctx) => {
    // Accumulate the SSE stream into a single response shape voice consumes.
    const params = new URLSearchParams({ request: task });
    if (context) params.set('context', context);
    if (sessionId && !newSession) params.set('sessionId', sessionId);
    if (newSession) params.set('newSession', '1');

    const url = `${baseUrl()}/api/agent-mcp/operator-chat?${params}`;
    const res = await fetch(url, { headers: { accept: 'text/event-stream' } });
    if (!res.ok || !res.body) {
      throw new Error(`delegate_to_claude: HTTP ${res.status}`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    let fullText = '';
    let cost = 0;
    let resolvedSession: string | null = null;
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const events = buf.split(/\n\n/);
      buf = events.pop() ?? '';
      for (const block of events) {
        const event = parseEventBlock(block);
        if (!event) continue;
        if (event.event === 'session') {
          resolvedSession = (event.data as any)?.claudeSessionId ?? null;
        } else if (event.event === 'delta') {
          fullText += (event.data as any)?.text ?? '';
        } else if (event.event === 'done') {
          fullText = (event.data as any)?.fullText ?? fullText;
          cost = (event.data as any)?.costUsd ?? 0;
        } else if (event.event === 'error') {
          throw new Error(`Claude error: ${(event.data as any)?.message ?? 'unknown'}`);
        }
      }
    }

    const result = {
      status: 'complete' as const,
      fullText,
      claudeSessionId: resolvedSession,
      costUsd: cost,
    };
    // Browser-side: dispatch a delegation-complete event so a) the panel
    // can show the result, b) the panel auto-opens if voicePanelAutoOpen
    // is set, c) the voice layer can be told to speak the gist.
    if (typeof window !== 'undefined') {
      try {
        window.dispatchEvent(
          new CustomEvent('operator:delegation-complete', { detail: result }),
        );
      } catch { /* ignore */ }
    }
    return result;
  },
};

function parseEventBlock(block: string): { event: string; data: unknown } | null {
  let event = 'message';
  let data: unknown = null;
  for (const line of block.split('\n')) {
    if (line.startsWith('event: ')) event = line.slice(7).trim();
    else if (line.startsWith('data: ')) {
      try { data = JSON.parse(line.slice(6)); } catch { /* ignore */ }
    }
  }
  if (data == null) return null;
  return { event, data };
}

register(claudeSessionsList);
register(claudeSessionsGet);
register(delegateToClaude);
