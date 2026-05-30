/**
 * LLM client for the sim-user + judge.
 *
 * Routes through the shared `runAgentChat` with `backend: 'meridian'` — a
 * stateless Anthropic-format round-trip whose transport auto-resolves: a
 * claude-code user goes DIRECT to Anthropic with their Claude session; an
 * omp user routes via the local Meridian router at :3456 (per-call
 * `x-meridian-agent` keeps each judge / sim-user call in an isolated
 * context — no cross-contamination).
 *
 * Pricing + retry + auth + temperature-incompat all live in
 * `libs/papercup-shared/src/agent/chat-stream.ts`'s `meridian` branch
 * so every consumer of the shared lib gets the same hardened path.
 */

import { runAgentChat } from '../agent-chat-stream';
import { readCredentials } from '../credentials';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// =============================================================================
// Pricing (USD per 1M tokens) — kept exported for callers that estimate
// cost ahead of a call. The shared `meridian` backend computes per-call
// cost from this same table; keep them in sync.
// =============================================================================

interface ModelPrice { in: number; out: number }
const MODEL_PRICES: Record<string, ModelPrice> = {
  'claude-haiku-4-5':  { in: 0.80, out: 4.00 },
  'claude-sonnet-4-6': { in: 3.00, out: 15.00 },
  'claude-opus-4-7':   { in: 15.00, out: 75.00 },
  'openai-codex/gpt-5':         { in: 1.25, out: 10.00 },
  'openai-codex/gpt-5.5':       { in: 2.50, out: 20.00 },
  'openai-codex/gpt-5.5:xhigh': { in: 2.50, out: 20.00 },
};

function priceFor(model: string): ModelPrice {
  if (MODEL_PRICES[model]) return MODEL_PRICES[model];
  const prefix = Object.keys(MODEL_PRICES).find((m) => model.startsWith(m));
  return prefix ? MODEL_PRICES[prefix] : { in: 0, out: 0 };
}

export function estimateCost(model: string, inputTokens: number, outputTokens: number): number {
  const p = priceFor(model);
  return (inputTokens * p.in + outputTokens * p.out) / 1_000_000;
}

// =============================================================================
// One-shot completion via the `meridian` backend.
// =============================================================================

export interface LlmCallOpts {
  model: string;
  system?: string;
  messages: Array<{ role: 'user' | 'assistant'; content: string }>;
  maxTokens?: number;
  temperature?: number;
  responseFormat?: 'text' | 'json';
}

export interface LlmCallResult {
  text: string;
  json?: unknown;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  raw: unknown;
}

export async function llmCall(opts: LlmCallOpts): Promise<LlmCallResult> {
  let finalText = '';
  let inputTokens = 0;
  let outputTokens = 0;
  let costUsd = 0;
  let lastErr: unknown;
  let sawResult = false;

  for await (const ev of runAgentChat({
    backend: 'meridian',
    model: opts.model,
    systemPromptText: opts.system,
    messages: opts.messages,
    promptText: '', // ignored when `messages` is supplied
    maxTokens: opts.maxTokens,
    temperature: opts.temperature,
  })) {
    if (ev.type === 'delta') {
      // The meridian backend yields a single delta with the full final
      // text (non-streaming round-trip). Don't accumulate twice with
      // the `result` event below — overwrite, don't append.
      finalText = ev.text;
    } else if (ev.type === 'result') {
      sawResult = true;
      if (ev.finalText) finalText = ev.finalText;
      inputTokens = ev.tokensIn;
      outputTokens = ev.tokensOut;
      costUsd = ev.costUsd;
    } else if (ev.type === 'error') {
      lastErr = new Error(ev.message);
    }
  }

  if (lastErr) throw lastErr;
  if (!sawResult) throw new Error('llmCall: meridian backend produced no result event');

  let json: unknown;
  if (opts.responseFormat === 'json') {
    json = tryParseJson(finalText);
  }

  return { text: finalText, json, inputTokens, outputTokens, costUsd, raw: null };
}

export function tryParseJson(text: string): unknown {
  const trimmed = text.trim();
  // 1. Bare JSON, or JSON wrapped in ```json fences.
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  const candidate = fenced ? fenced[1] : trimmed;
  try {
    return JSON.parse(candidate);
  } catch {
    // fall through
  }
  // 2. Prose-wrapped JSON: take the outermost {...} span.
  const first = trimmed.indexOf('{');
  const last = trimmed.lastIndexOf('}');
  if (first >= 0 && last > first) {
    try {
      return JSON.parse(trimmed.slice(first, last + 1));
    } catch {
      /* unrecoverable */
    }
  }
  return null;
}

/**
 * True when the framework can make LLM calls — checks for the
 * Meridian OAuth token. Keeps the legacy ANTHROPIC_API_KEY / PG
 * credentials check as a fall-through so older deploys still work.
 */
export async function isLlmAvailable(): Promise<boolean> {
  // Preferred: Meridian OAuth token at ~/.omp/agent/auth.json
  try {
    const raw = readFileSync(join(homedir(), '.omp', 'agent', 'auth.json'), 'utf8');
    const parsed = JSON.parse(raw) as { anthropic?: { token?: { access?: string } } };
    if (parsed.anthropic?.token?.access) return true;
  } catch {
    /* fall through */
  }
  // Legacy: direct ANTHROPIC_API_KEY env / PG-stored credential
  const env = process.env.ANTHROPIC_API_KEY;
  if (env && env.trim()) return true;
  try {
    const creds = await readCredentials();
    return !!creds.anthropic_api_key?.trim();
  } catch {
    return false;
  }
}

// Legacy helper retained for any external caller that imported it
// directly. The temperature-incompat handling is now inside the
// shared meridian backend; this stays only for back-compat detection.
export function isTemperatureDeprecatedError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /temperature.{0,40}(deprecat|not supported|unsupported|no longer)/i.test(msg);
}
