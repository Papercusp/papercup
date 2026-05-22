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

/**
 * Models known to reject the `temperature` parameter. Opus 4.7 (as of
 * 2026-05) errors with a 400 "temperature is deprecated for this model"
 * on any value. Listed models skip the field pre-emptively.
 */
const TEMPERATURE_INCOMPATIBLE = /opus/i;

/**
 * True when an SDK error is the API rejecting `temperature`. Used to
 * retry-without-temperature so a model that *newly* deprecates the
 * field self-heals instead of hard-failing the run.
 */
export function isTemperatureDeprecatedError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /temperature.{0,40}(deprecat|not supported|unsupported|no longer)/i.test(msg);
}

/**
 * True when an error is a transient API condition worth retrying:
 * 529 overloaded, 429 rate-limit, 5xx, or a network blip. The
 * Anthropic SDK's built-in retries (default 2) are too few + too
 * impatient to outlast a multi-minute capacity overload, which
 * otherwise hard-fails a whole scenario run (2026-05-22: op-M3 died
 * twice on raw 529s).
 */
function isTransientApiError(err: unknown): boolean {
  if (err instanceof Anthropic.APIError && typeof err.status === 'number') {
    if (err.status === 429 || err.status >= 500) return true;
  }
  const msg = err instanceof Error ? err.message : String(err);
  return /(\b529\b|overloaded|rate.?limit|service unavailable|\b50[02-4]\b|ETIMEDOUT|ECONNRESET|ECONNREFUSED|socket hang up)/i.test(
    msg,
  );
}

const TRANSIENT_RETRY_MAX = 5;

/**
 * `client.messages.create` with a patient outer retry for transient
 * API errors. Exponential backoff (2s/4s/8s/16s, capped 30s) on top
 * of the SDK's own retries — outlasts a ~1–2 min overload window.
 */
async function createWithTransientRetry(
  client: Anthropic,
  params: Anthropic.MessageCreateParamsNonStreaming,
): Promise<Anthropic.Message> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= TRANSIENT_RETRY_MAX; attempt++) {
    try {
      return await client.messages.create(params);
    } catch (err) {
      lastErr = err;
      if (!isTransientApiError(err) || attempt === TRANSIENT_RETRY_MAX) throw err;
      const backoffMs = Math.min(30_000, 1000 * 2 ** attempt) + Math.random() * 500;
      console.warn(
        `[llm-testing] transient API error (attempt ${attempt}/${TRANSIENT_RETRY_MAX}), ` +
          `retrying in ${Math.round(backoffMs)}ms: ` +
          `${err instanceof Error ? err.message.slice(0, 140) : String(err)}`,
      );
      await new Promise((r) => setTimeout(r, backoffMs));
    }
  }
  throw lastErr;
}

export async function llmCall(opts: LlmCallOpts): Promise<LlmCallResult> {
  const client = await getClient();

  const messages = opts.messages.map((m) => ({
    role: m.role,
    content: m.content,
  }));

  const baseParams = {
    model: opts.model,
    max_tokens: opts.maxTokens ?? 1024,
    ...(opts.system ? { system: opts.system } : {}),
    messages,
  };
  const sendsTemperature = !TEMPERATURE_INCOMPATIBLE.test(opts.model);

  let resp;
  try {
    resp = await createWithTransientRetry(client, {
      ...baseParams,
      ...(sendsTemperature ? { temperature: opts.temperature ?? 0.7 } : {}),
    });
  } catch (err) {
    // Self-heal: a model we believed accepted `temperature` now rejects
    // it. Retry once without the field rather than failing the run.
    if (sendsTemperature && isTemperatureDeprecatedError(err)) {
      console.warn(
        `[llm-testing] ${opts.model} rejected 'temperature' — retrying without it. ` +
          `Add it to TEMPERATURE_INCOMPATIBLE in llm-client.ts to skip the failed first call.`,
      );
      resp = await createWithTransientRetry(client, baseParams);
    } else {
      throw err;
    }
  }

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

export function tryParseJson(text: string): unknown {
  const trimmed = text.trim();
  // 1. Bare JSON, or JSON wrapped in ```json fences.
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  const candidate = fenced ? fenced[1] : trimmed;
  try {
    return JSON.parse(candidate);
  } catch {
    // fall through to brace-span extraction
  }
  // 2. Prose-wrapped JSON: take the outermost {...} span. Judges and
  //    sim-users occasionally prepend "Here is the JSON:" or trail a
  //    sentence after the object.
  const first = trimmed.indexOf('{');
  const last = trimmed.lastIndexOf('}');
  if (first >= 0 && last > first) {
    try {
      return JSON.parse(trimmed.slice(first, last + 1));
    } catch {
      // unrecoverable
    }
  }
  return null;
}

/** True when an Anthropic key is resolvable (env or PG credentials). */
export async function isLlmAvailable(): Promise<boolean> {
  return !!(await resolveKey());
}
