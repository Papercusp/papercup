/**
 * delegate_to_claude — voice's deep-work escape hatch.
 *
 * Plus the delegates.list/get queries voice uses to pick which
 * session a delegation lands in. See /docs/agents/action-registry §5
 * + the session-management decisions in §10 (#17).
 */
import { z } from 'zod';
import { parseSseStream, type ParsedSseEvent } from '@papercusp/sse';
import { register } from '../registry';
import type { CommandDef, QueryDef } from '../types';

function baseUrl(): string {
  if (typeof window !== 'undefined') return '';
  const port = process.env.PORT ?? process.env.NEXT_PUBLIC_PORT ?? '3155';
  return `http://127.0.0.1:${port}`;
}

// ─── Queries: delegates.list / delegates.get ─────────────

const ListDelegatesArgs = z.object({
  status: z.enum(['open', 'archived', 'all']).default('open').optional()
    .describe('Filter by status. Default: open.'),
  limit: z.number().int().min(1).max(50).default(20).optional()
    .describe('Max sessions to return (default 20, cap 50).'),
});

const claudeSessionsList: QueryDef<z.infer<typeof ListDelegatesArgs>> = {
  id: 'delegates.list',
  kind: 'query',
  description: 'List Claude conversation sessions for the workspace.',
  promptDescription:
    'Returns Claude conversation sessions as ' +
    '[{id, title, summary, lastActiveAt, turnCount, agentSessionId, status}, ...]. ' +
    "Use to pick which session to pass to delegate_to_claude — match the " +
    "user's request to a session by title/topic. " +
    "\n\nIMPORTANT: status='open' means 'available to resume' — NOT 'currently " +
    "running'. Delegates do NOT run in the background; each delegate_to_claude " +
    "call is synchronous and complete by the time you see its return. A delegate " +
    "session listed here is at rest. Never tell the user 'the delegate is still " +
    "running' based on this list — if you want to know how recently a session " +
    "was active, use lastActiveAt. status='archived' means the user explicitly " +
    "dismissed it.",
  schema: ListDelegatesArgs,
  agents: ['oracle', 'operator'],
  audit: 'sample',
  tier: 'fast-query',
  handler: async ({ status, limit }, ctx) => {
    if (typeof window !== 'undefined') {
      // Browser-side: fetch via API endpoint to avoid pulling PG into the bundle.
      const params = new URLSearchParams();
      if (status) params.set('status', status);
      if (limit) params.set('limit', String(limit));
      const r = await fetch(`/api/agent-mcp/delegates?${params}`);
      if (!r.ok) throw new Error(`delegates.list failed: HTTP ${r.status}`);
      return await r.json();
    }
    const { listDelegatedSessions } = await import('../../delegated-tasks');
    const rows = await listDelegatedSessions({ status, limit });
    return { sessions: rows };
  },
};

const GetSessionArgs = z.object({
  id: z.string().min(1).describe('Session id (numeric or agent_session_id UUID).'),
});

const claudeSessionsGet: QueryDef<z.infer<typeof GetSessionArgs>> = {
  id: 'delegates.get',
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
      const r = await fetch(`/api/agent-mcp/delegates?id=${encodeURIComponent(id)}`);
      if (!r.ok) throw new Error(`delegates.get failed: HTTP ${r.status}`);
      return await r.json();
    }
    const { getDelegatedSession } = await import('../../delegated-tasks');
    const row = await getDelegatedSession(id);
    return { session: row };
  },
};

// ─── Query: delegates.search ─────────────────────────────────────────

const SearchDelegatesArgs = z.object({
  query: z.string().min(1).describe('Free-text needle. Matches against title, summary, and the kickoff message.'),
  limit: z.number().int().min(1).max(50).default(10).optional()
    .describe('Max sessions to return (default 10).'),
});

const claudeSessionsSearch: QueryDef<z.infer<typeof SearchDelegatesArgs>> = {
  id: 'delegates.search',
  kind: 'query',
  description: 'Search Claude conversation sessions by free-text (title/summary/kickoff).',
  promptDescription:
    'Returns matching sessions as { sessions: [{id, title, summary, lastActiveAt, ...}, ...] }. ' +
    'Use when the user names a topic and you want to find a related past delegate without ' +
    'paging through delegates.list. After picking a hit, pass its agentSessionId to ' +
    'delegate_to_claude to resume the conversation. Always confirm with the user before resuming.',
  schema: SearchDelegatesArgs,
  agents: ['oracle', 'operator'],
  audit: 'sample',
  tier: 'fast-query',
  handler: async ({ query, limit }, ctx) => {
    if (typeof window !== 'undefined') {
      const params = new URLSearchParams({ q: query });
      if (limit) params.set('limit', String(limit));
      const r = await fetch(`/api/agent-mcp/delegates?${params}`);
      if (!r.ok) throw new Error(`delegates.search failed: HTTP ${r.status}`);
      return await r.json();
    }
    const { searchDelegatedSessions } = await import('../../delegated-tasks');
    const rows = await searchDelegatedSessions(query, limit);
    return { sessions: rows };
  },
};

register(claudeSessionsSearch);

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
  // Has to be 'required' because EL's clientTool registration is
  // browser-side (the agent's tool list is wired through buildClientTools,
  // which only exposes browser:'required'). With 'optional' the agent
  // would see the tool on the dashboard, call it, and crash with
  // "Client tool with name delegate_to_claude is not defined on client".
  // The actual SSE stream still happens server-side; the browser-side
  // handler just proxies the call to /api/agent-mcp/delegate-chat.
  browser: 'required',
  concurrent: 'queue',
  tier: 'delegation',
  handler: async ({ task, context, sessionId, newSession }, _ctx) => {
    // Race-with-timeout: short delegates (the bell-number kind) finish
    // in 5-15s — return their `fullText` synchronously so the agent
    // can summarize on the same turn. Long delegates (file reads,
    // multi-step planning, asking another agent) blow past EL's 120s
    // tool-call wall — return early with `{ status: 'started', ... }`
    // and let the SSE stream finish in the background. When done, the
    // result hits the panel via operator:delegation-complete (existing)
    // AND the live EL session via sendSystem() so the agent can speak
    // about it on its next turn (new). See docs/design/delegate-async-plan.
    const params = new URLSearchParams({ request: task });
    if (context) params.set('context', context);
    if (sessionId && !newSession) params.set('sessionId', sessionId);
    if (newSession) params.set('newSession', '1');

    const url = `${baseUrl()}/api/agent-mcp/delegate-chat?${params}`;
    const res = await fetch(url, { headers: { accept: 'text/event-stream' } });
    if (!res.ok || !res.body) {
      throw new Error(`delegate_to_claude: HTTP ${res.status}`);
    }

    if (typeof window !== 'undefined') {
      try {
        window.dispatchEvent(new CustomEvent('operator:delegation-start', { detail: { task } }));
      } catch { /* ignore */ }
    }

    const SYNC_DEADLINE_MS = 10_000;
    const deadline = Date.now() + SYNC_DEADLINE_MS;

    const iter = parseSseStream(res.body)[Symbol.asyncIterator]();

    /** State accumulated as the SSE stream progresses. */
    const state = {
      fullText: '',
      cost: 0,
      agentSessionId: null as string | null,
      done: false,
      errored: null as string | null,
    };

    /** Apply one parsed SSE event to `state`. */
    const applyEvent = (ev: ParsedSseEvent) => {
      // parseSseStream gives us spec-compliant events with `data: string`;
      // each producer JSON-encodes the data, so we parse here.
      if (ev.event === 'heartbeat') return;
      let data: any = null;
      try { data = ev.data ? JSON.parse(ev.data) : null; } catch { /* ignore non-JSON */ }
      if (ev.event === 'session') {
        state.agentSessionId = data?.agentSessionId ?? null;
      } else if (ev.event === 'delta') {
        state.fullText += data?.text ?? '';
      } else if (ev.event === 'done') {
        state.fullText = data?.fullText ?? state.fullText;
        state.cost = data?.costUsd ?? 0;
        state.done = true;
      } else if (ev.event === 'error') {
        state.errored = data?.message ?? 'unknown';
      }
    };

    /** Fire the panel + voice notification when the stream finishes. */
    const notifyComplete = () => {
      const result = {
        status: 'complete' as const,
        fullText: state.fullText,
        agentSessionId: state.agentSessionId,
        costUsd: state.cost,
      };
      if (typeof window !== 'undefined') {
        try {
          window.dispatchEvent(
            new CustomEvent('operator:delegation-complete', { detail: result }),
          );
          // New: a separate event the voice-mode listener picks up to
          // sendSystem() into the live EL session. delegation-complete
          // is panel-targeted; this one is voice-targeted. Fired even
          // for sync completions so callers can ignore the sync branch's
          // duplicate (voice-mode listener checks "did we already speak
          // about this turn" — see voice-mode.ts).
          window.dispatchEvent(
            new CustomEvent('operator:delegation-async-complete', {
              detail: { ...result, task },
            }),
          );
        } catch { /* ignore */ }
      }
      return result;
    };

    // ── Sync window: pump events until done OR deadline ──────────────
    while (Date.now() < deadline) {
      const remaining = deadline - Date.now();
      const nextP = iter.next();
      const timeoutP = new Promise<{ timeout: true }>((res) =>
        setTimeout(() => res({ timeout: true }), Math.max(0, remaining)),
      );
      const winner = await Promise.race([nextP, timeoutP]);
      if ('timeout' in winner) break;
      if (winner.done) {
        // Stream closed before a 'done' event — treat as error if we
        // haven't already captured one.
        if (!state.done && !state.errored) state.errored = 'stream closed unexpectedly';
        break;
      }
      applyEvent(winner.value);
      if (state.errored) throw new Error(`Claude error: ${state.errored}`);
      if (state.done) break;
    }

    // Sync win: stream finished within the deadline.
    if (state.done) return notifyComplete();

    // ── Async path: drain in the background, return ack now ───────────
    void (async () => {
      try {
        for (;;) {
          const { value, done } = await iter.next();
          if (done) {
            if (!state.done && !state.errored) state.errored = 'stream closed unexpectedly';
            break;
          }
          applyEvent(value);
          if (state.errored || state.done) break;
        }
        if (state.errored) {
          // Surface the error via the same channel as completion so the
          // panel + voice listener can show "Delegate failed: <msg>".
          if (typeof window !== 'undefined') {
            window.dispatchEvent(new CustomEvent('operator:delegation-async-complete', {
              detail: { status: 'error', message: state.errored, task, agentSessionId: state.agentSessionId },
            }));
          }
          return;
        }
        notifyComplete();
      } catch (e) {
        console.warn('[delegate_to_claude] background drain failed:', e);
      }
    })();

    return {
      status: 'started' as const,
      agentSessionId: state.agentSessionId,
      // Hint for the agent's response — "I'll let you know when it's done"
      // is the right vibe; specific seconds is too precise. Persona will
      // tell it what to say.
      message: 'Delegate is running; result will arrive shortly.',
    };
  },
};

register(claudeSessionsList);
register(claudeSessionsGet);
register(delegateToClaude);

// Backend-neutral alias. Voice agent definitions are migrating from
// `delegate_to_claude` → `delegate_to_agent`; we register both so
// in-flight EL agents keep working while new ones use the neutral name.
// Once el-suite-test confirms all published agents reference the new
// name, the legacy alias above can be retired.
const delegateToAgent: CommandDef<z.infer<typeof DelegateArgs>> = {
  ...delegateToClaude,
  id: 'delegate_to_agent',
  description: delegateToClaude.description.replace(/Claude/g, 'the configured agent'),
};
register(delegateToAgent);
