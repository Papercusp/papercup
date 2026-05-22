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
 * Extracted from `delegate-summary.ts` so plan code can reuse it
 * without importing the delegate/voice surface (plan-agent-launch
 * D-004 keeps plan tooling free of `lib/delegates` coupling).
 */

import { runAgentChat } from './agent-chat-stream';

const HAIKU_MODEL = process.env.PAPERCUSP_HAIKU_MODEL ?? 'claude-haiku-4-5';

/**
 * Run the haiku model (claude-code or omp, per AGENT_BACKEND) on a
 * single prompt. Returns the trimmed text, or `null` on any failure —
 * this is best-effort and never throws. Bounded to ~5s: the callers
 * are background summarisers, not interactive turns.
 *
 * `maxTokens` is informational; chat-stream exposes no per-spawn cap
 * (the prompt itself bounds the output).
 */
export async function runHaiku(
  prompt: string,
  _maxTokens = 200,
): Promise<string | null> {
  const ac = new AbortController();
  const killer = setTimeout(() => ac.abort(), 5000);
  let out = '';
  let failed = false;
  try {
    for await (const ev of runAgentChat({
      promptText: prompt,
      model: HAIKU_MODEL,
      signal: ac.signal,
    })) {
      if (ev.type === 'delta') out += ev.text;
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
