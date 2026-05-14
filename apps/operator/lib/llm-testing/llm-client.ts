/**
 * Direct Anthropic SDK wrapper for the sim-user and judge.
 *
 * The framework's hot path makes many small LLM calls (sim-user once
 * per turn, judge once at end). `runAgentChat` (subprocess spawn) is
 * too heavyweight — we go straight to `@anthropic-ai/sdk`.
 *
 * Reads `ANTHROPIC_API_KEY` from the environment. Caller threads in
 * the model id and optional system prompt; we return the assistant
 * text and per-call cost.
 *
 * Pricing source: 2026-05 reference prices baked in for cost-tracking
 * (anthropic doesn't return $ on the response). Update `MODEL_PRICES`
 * when prices change.
 */

import Anthropic from '@anthropic-ai/sdk';
import { readCredentials } from '../credentials';

let _client: Anthropic | undefined;

async function resolveKey(): Promise<string | undefined> {
  const env = process.env.ANTHROPIC_API_KEY;
  if (env && env.trim()) return env.trim();
  try {
    const creds = await readCredentials();
    return creds.anthropic_api_key?.trim() || undefined;
  } catch {
    return undefined;
  }
}

async function getClient(): Promise<Anthropic> {
  if (_client) return _client;
  const key = await resolveKey();
  if (!key) {
    throw new Error(
      'ANTHROPIC_API_KEY required for llm-testing framework. Set it in env, or enter it at /admin/testing → LLM testing.',
    );
  }
  _client = new Anthropic({ apiKey: key });
  return _client;
}

// =============================================================================
// Pricing (USD per 1M tokens) — keep in sync with anthropic.com/pricing.
// =============================================================================

interface ModelPrice { in: number; out: number }

const MODEL_PRICES: Record<string, ModelPrice> = {
  'claude-haiku-4-5':  { in: 0.80, out: 4.00 },
  'claude-sonnet-4-6': { in: 3.00, out: 15.00 },
  'claude-opus-4-7':   { in: 15.00, out: 75.00 },
};

function priceFor(model: string): ModelPrice {
  // exact match first; otherwise prefix match (e.g. claude-haiku-4-5-20251001 → claude-haiku-4-5).
  if (MODEL_PRICES[model]) return MODEL_PRICES[model];
  const prefix = Object.keys(MODEL_PRICES).find((m) => model.startsWith(m));
  return prefix ? MODEL_PRICES[prefix] : { in: 0, out: 0 };
}

export function estimateCost(model: string, inputTokens: number, outputTokens: number): number {
  const p = priceFor(model);
  return (inputTokens * p.in + outputTokens * p.out) / 1_000_000;
}

// =============================================================================
// One-shot completion
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
  json?: unknown;            // populated when responseFormat='json' and parse succeeds
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  raw: unknown;              // the SDK response — for telemetry/debugging
}

export async function llmCall(opts: LlmCallOpts): Promise<LlmCallResult> {
  const client = await getClient();

  const messages = opts.messages.map((m) => ({
    role: m.role,
    content: m.content,
  }));

  const resp = await client.messages.create({
    model: opts.model,
    max_tokens: opts.maxTokens ?? 1024,
    temperature: opts.temperature ?? 0.7,
    ...(opts.system ? { system: opts.system } : {}),
    messages,
  });

  // Extract text from the response content blocks.
  let text = '';
  for (const block of resp.content) {
    if (block.type === 'text') text += block.text;
  }

  const inputTokens = resp.usage.input_tokens ?? 0;
  const outputTokens = resp.usage.output_tokens ?? 0;
  const costUsd = estimateCost(opts.model, inputTokens, outputTokens);

  let json: unknown;
  if (opts.responseFormat === 'json') {
    json = tryParseJson(text);
  }

  return { text, json, inputTokens, outputTokens, costUsd, raw: resp };
}

function tryParseJson(text: string): unknown {
  // Allow either bare JSON or JSON wrapped in ```json fences.
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  const candidate = fenced ? fenced[1] : trimmed;
  try {
    return JSON.parse(candidate);
  } catch {
    return null;
  }
}

/** True when an Anthropic key is resolvable (env or PG credentials). */
export async function isLlmAvailable(): Promise<boolean> {
  return !!(await resolveKey());
}
