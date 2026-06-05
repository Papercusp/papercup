/**
 * runHaiku — a one-shot completion on the cheap haiku model.
 *
 * A generic, best-effort LLM primitive: feed it a self-contained
 * prompt, get back the text (or `null` on any failure). No MCP, no
 * tools, no session — just a bounded single turn. Used for background
 * summarisation where a full agent spawn would be overkill and a
 * failure must never surface to the user:
 *
 *   - delegate session titles + summaries (`delegate-summary.ts`);
 *   - plan-revision rationale auto-summary (`plans/revision-summary.ts`,
 *     plan-agent-launch P-007).
 *
 * Routes through `runAgentChat` with `backend: 'meridian'` — a stateless
 * Anthropic-format HTTP round-trip, no omp/claude-code subprocess. The
 * transport auto-resolves: claude-code users go DIRECT to Anthropic with
 * their Claude session; omp users route via the local Meridian router.
 * Background summaries never need the agent loop (no MCP, no tools), so a
 * subprocess spawn would be pure overhead.
 */

import { runAgentChat } from './agent-chat-stream';

const HAIKU_MODEL = process.env.PAPERCUSP_HAIKU_MODEL ?? 'claude-haiku-4-5';

/**
 * Run the haiku model on a single prompt via Meridian. Returns the
 * trimmed text, or `null` on any failure — this is best-effort and
 * never throws. Bounded to ~15s: the callers are background
 * summarisers, not interactive turns. The bound is wide enough to
 * absorb the cold-cache first-call cost (~6-7s) plus one 529 retry
 * (2s backoff) without surfacing failure to callers.
 *
 * `maxTokens` flows through to the meridian backend as `max_tokens`
 * (omp/claude-code ignored it; meridian honors it).
 */
export async function runHaiku(
  prompt: string,
  maxTokens = 200,
): Promise<string | null> {
  const ac = new AbortController();
  const killer = setTimeout(() => ac.abort(), 15_000);
  let out = '';
  let failed = false;
  try {
    for await (const ev of runAgentChat({
      backend: 'meridian',
      promptText: prompt,
      model: HAIKU_MODEL,
      maxTokens,
      signal: ac.signal,
    })) {
      // meridian backend emits a single `delta` with the full final
      // text (non-streaming round-trip), then a `result` with the
      // same text. Overwrite — don't accumulate, or you'll double it.
      if (ev.type === 'delta') out = ev.text;
      else if (ev.type === 'result') out = ev.finalText || out;
      else if (ev.type === 'error') {
        failed = true;
        console.warn(
          `[haiku] failed:`,
          (ev.stderr ?? ev.message).slice(0, 300),
        );
      }
    }
  } catch (err) {
    console.warn('[haiku] threw:', (err as Error).message);
    return null;
  } finally {
    clearTimeout(killer);
  }
  if (failed) return null;
  return out.trim() || null;
}
