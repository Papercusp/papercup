/**
 * Anthropic-backed `LlmJudge` for conflict-check (P-017).
 *
 * Plan: papercusp-su-memory-2026-05-25 (Phase 4, P-017 wire-up).
 *
 * Wraps `@anthropic-ai/sdk` with the conflict-detection prompt from
 * `conflict-check.buildConflictPrompt` + `parseConflictResponse`.
 * Best-effort: any LLM failure returns `{ conflicts: [] }` so the
 * caller's write proceeds.
 *
 * Model: `claude-haiku-4-5` (same as mem0's fact-extraction LLM).
 * API key resolution: env `ANTHROPIC_API_KEY` first; absent → returns
 * a no-op judge that always reports zero conflicts (defensive — no
 * point throwing when the env isn't set, since callers feature-flag
 * the call anyway).
 */

import {
  type LlmJudge,
  buildConflictPrompt,
  parseConflictResponse,
} from './conflict-check';

const MODEL = 'claude-haiku-4-5';
const MAX_TOKENS = 256;
const TIMEOUT_MS = 5_000;

/**
 * Build the Anthropic-backed judge. Returns a no-op judge when no
 * API key is present (caller still calls it; it just returns empty
 * conflicts).
 */
export function createAnthropicJudge(opts?: {
  apiKey?: string;
  model?: string;
}): LlmJudge {
  const apiKey = opts?.apiKey ?? process.env.ANTHROPIC_API_KEY ?? '';
  const model = opts?.model ?? MODEL;

  if (!apiKey) {
    // Silent no-op: caller's feature flag is the real gate.
    return async () => ({ conflicts: [] });
  }

  return async ({ newText, neighbors }) => {
    let client: { messages: { create: (...args: unknown[]) => Promise<unknown> } };
    try {
      const mod = (await import('@anthropic-ai/sdk')) as unknown as {
        default: new (opts: { apiKey: string; baseURL?: string }) => typeof client;
      };
      const Anthropic = mod.default;
      // Route through the inference gateway when it's pointing us at the localhost
      // pacing pool (gateway sets PAPERCUSP_ANTHROPIC_URL / ANTHROPIC_BASE_URL) — so
      // this in-process best-effort judge load-balances across the account pool and
      // is paced like every other call, instead of egressing DIRECT to one account on
      // its API key. Absent the env (gateway off) → unchanged direct egress.
      const baseURL = process.env.PAPERCUSP_ANTHROPIC_URL ?? process.env.ANTHROPIC_BASE_URL;
      client = new Anthropic({ apiKey, ...(baseURL ? { baseURL } : {}) });
    } catch {
      return { conflicts: [] };
    }

    const prompt = buildConflictPrompt({ newText, neighbors });

    const timeout = new Promise<{ conflicts: never[] }>((resolve) =>
      setTimeout(() => resolve({ conflicts: [] }), TIMEOUT_MS),
    );

    const llmCall = (async () => {
      try {
        const response = (await client.messages.create({
          model,
          max_tokens: MAX_TOKENS,
          messages: [{ role: 'user', content: prompt }],
        })) as { content?: Array<{ type: string; text?: string }> };
        const text = (response.content ?? [])
          .filter((c) => c.type === 'text')
          .map((c) => c.text ?? '')
          .join('');
        return parseConflictResponse(text);
      } catch {
        return { conflicts: [] };
      }
    })();

    return Promise.race([llmCall, timeout]);
  };
}
