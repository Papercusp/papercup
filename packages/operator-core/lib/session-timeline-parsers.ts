/**
 * session-timeline-parsers — codex + omp transcript-line parsers for the
 * agents-roster thinking pane (agents-roster "every agent has a history").
 *
 * The pane's timeline contract is `AgentTimelineEntry` (defined with the claude
 * parser in endpoint-route/routes/harness/streams.ts). Claude interactive
 * sessions and spawned bees already stream; codex sessions (rollout jsonl under
 * the per-session CODEX_HOME) and omp sessions (jsonl under
 * ~/.omp/agent/sessions) had NO parser, so the roster could only show a
 * "Live thinking unavailable" note for them. These parsers close that gap: both
 * formats are append-only JSONL, so the session-thinking endpoint reuses its
 * tail-backfill + poll-follow machinery unchanged — only the line→entries
 * transform differs per backend.
 *
 * Both parsers share the claude parser's contract: `parseLine(line) →
 * entries[]` + `flush() → entries[]` (these two are stateless per line, so
 * flush is always empty — kept for interface parity).
 */

import type { AgentTimelineEntry } from './endpoint-route/routes/harness/streams';

export interface TimelineLineParser {
  parseLine(line: string): AgentTimelineEntry[];
  flush(): AgentTimelineEntry[];
}

function compactToolArgs(args: unknown): unknown {
  if (typeof args !== 'string') return args;
  try {
    return JSON.parse(args);
  } catch {
    return args;
  }
}

/**
 * Codex rollout jsonl → timeline entries. Wire shape per line:
 *   { timestamp: ISO, type: 'session_meta'|'event_msg'|'response_item'|
 *     'turn_context'|'compacted', payload: {...} }
 *
 * Mapping (the pane's vocabulary):
 *  - event_msg/user_message            → prompt (turn boundary)
 *  - event_msg/agent_message           → text
 *  - response_item/function_call,
 *    custom_tool_call, tool_search_call → tool_use
 *  - response_item/function_call_output,
 *    custom_tool_call_output           → tool_result
 *  - response_item/reasoning           → status '[thinking] …' when a readable
 *    summary exists (the content itself ships encrypted — skipped otherwise)
 *  - compacted                         → status
 *  - everything else (session_meta, token_count, turn_context,
 *    response_item/message duplicates of agent_message, …) → skipped
 */
export function createCodexTimelineParser(): TimelineLineParser {
  return {
    parseLine(line: string): AgentTimelineEntry[] {
      let rec: {
        timestamp?: string;
        type?: string;
        payload?: Record<string, unknown>;
      };
      try {
        rec = JSON.parse(line);
      } catch {
        return [];
      }
      const ts = typeof rec.timestamp === 'string' ? rec.timestamp : undefined;
      const p = (rec.payload ?? {}) as Record<string, unknown>;
      const pt = typeof p.type === 'string' ? p.type : '';

      if (rec.type === 'event_msg') {
        if (pt === 'user_message' && typeof p.message === 'string') {
          return [{ kind: 'prompt', text: p.message, ts }];
        }
        if (pt === 'agent_message' && typeof p.message === 'string') {
          return [{ kind: 'text', text: p.message, ts }];
        }
        return [];
      }
      if (rec.type === 'response_item') {
        if (pt === 'function_call' || pt === 'custom_tool_call' || pt === 'tool_search_call') {
          const ns = typeof p.namespace === 'string' ? `${p.namespace}.` : '';
          const name = typeof p.name === 'string' ? p.name : pt;
          return [{
            kind: 'tool_use',
            toolName: `${ns}${name}`,
            toolInput: compactToolArgs(p.arguments),
            toolId: typeof p.call_id === 'string' ? p.call_id : undefined,
            ts,
          }];
        }
        if (pt === 'function_call_output' || pt === 'custom_tool_call_output') {
          return [{
            kind: 'tool_result',
            text: typeof p.output === 'string' ? p.output : JSON.stringify(p.output ?? ''),
            toolId: typeof p.call_id === 'string' ? p.call_id : undefined,
            ts,
          }];
        }
        if (pt === 'reasoning') {
          const summary = Array.isArray(p.summary)
            ? (p.summary as Array<{ text?: string } | string>)
              .map((s) => (typeof s === 'string' ? s : s?.text ?? ''))
              .filter(Boolean)
              .join(' ')
            : '';
          return summary ? [{ kind: 'status', text: `[thinking] ${summary}`, ts }] : [];
        }
        return [];
      }
      if (rec.type === 'compacted') {
        return [{ kind: 'status', text: 'context compacted', ts }];
      }
      return [];
    },
    flush(): AgentTimelineEntry[] {
      return [];
    },
  };
}

/**
 * omp session jsonl → timeline entries. Wire shape per line:
 *   { type: 'message'|'session'|'title'|…, timestamp: ISO,
 *     message?: { role: 'user'|'assistant'|'toolResult', content: blocks[] } }
 * with content blocks { type: 'text'|'thinking'|'toolCall', … }.
 *
 * Mapping: user text → prompt · assistant text → text · assistant thinking →
 * status '[thinking] …' · assistant toolCall → tool_use · toolResult-role text
 * → tool_result. Non-message records (session/title/model_change/…) → skipped.
 */
export function createOmpTimelineParser(): TimelineLineParser {
  return {
    parseLine(line: string): AgentTimelineEntry[] {
      let rec: {
        type?: string;
        timestamp?: string;
        message?: { role?: string; content?: unknown };
      };
      try {
        rec = JSON.parse(line);
      } catch {
        return [];
      }
      if (rec.type !== 'message' || !rec.message) return [];
      const ts = typeof rec.timestamp === 'string' ? rec.timestamp : undefined;
      const { role } = rec.message;
      const content = Array.isArray(rec.message.content)
        ? (rec.message.content as Array<Record<string, unknown>>)
        : typeof rec.message.content === 'string'
          ? [{ type: 'text', text: rec.message.content }]
          : [];

      const out: AgentTimelineEntry[] = [];
      for (const block of content) {
        const bt = typeof block.type === 'string' ? block.type : '';
        if (bt === 'text' && typeof block.text === 'string') {
          if (role === 'user') out.push({ kind: 'prompt', text: block.text, ts });
          else if (role === 'toolResult') out.push({ kind: 'tool_result', text: block.text, ts });
          else out.push({ kind: 'text', text: block.text, ts });
        } else if (bt === 'thinking' && typeof block.thinking === 'string') {
          out.push({ kind: 'status', text: `[thinking] ${block.thinking}`, ts });
        } else if (bt === 'toolCall') {
          out.push({
            kind: 'tool_use',
            toolName: typeof block.name === 'string' ? block.name : 'tool',
            toolInput: block.arguments,
            toolId: typeof block.id === 'string' ? block.id : undefined,
            ts,
          });
        }
      }
      return out;
    },
    flush(): AgentTimelineEntry[] {
      return [];
    },
  };
}
