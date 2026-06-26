/**
 * Operator LLM transport — the concrete `LlmCallFn` (+ `isLlmAvailable`) seam
 * the generic `@papercusp/testing-shell/llm` runner is injected with via
 * `RunnerDeps` (Phase 7 P-073).
 *
 * Routes through the shared `runAgentChat` with `backend: 'anthropic-direct'`
 * — a stateless Anthropic-format round-trip DIRECT to api.anthropic.com with
 * the Claude OAuth session (~/.claude/.credentials.json). (The omp-era leg
 * via the local Meridian router at :3456 was retired 2026-06-12, EI-399.)
 *
 * Pricing + retry + auth + temperature-incompat all live in
 * `libs/papercusp-shared/src/agent/chat-stream.ts`'s `anthropic-direct` branch
 * so every consumer of the shared lib gets the same hardened path.
 *
 * The host-agnostic pieces — `MODEL_PRICES` / `estimateCost`, `tryParseJson`,
 * the `LlmCallOpts`/`LlmCallResult` shapes, and the typed `LlmCallError` — live
 * in `@papercusp/testing-shell/llm`. This module keeps only the operator-coupled
 * transport (`llmCall`, which imports the operator's agent-chat-stream) and the
 * operator-credentials availability check (`isLlmAvailable`).
 */

import {
  LlmCallError,
  tryParseJson,
  type LlmCallOpts,
  type LlmCallResult,
} from '@papercusp/testing-shell/llm';

import {
  runAgentChat,
  classifyHttpError,
  probeStatelessTransport,
  type AgentBackend,
  type TurnError,
  type TurnProvider,
} from '../agent-chat-stream';
import { readCredentials } from '../credentials';

/** Provider label for classifying a backend's error message (labeling only — rate detection is
    status/regex-based, so this never changes the class). */
function providerForBackend(backend: AgentBackend): TurnProvider {
  return backend === 'codex' ? 'openai' : backend === 'omp' ? 'unknown' : 'anthropic';
}

/**
 * Backend for the sim-user + judge calls. Defaults to `anthropic-direct`
 * (Claude Max OAuth session, stateless HTTP) but is overridable to any agent
 * backend — set `LLM_TEST_BACKEND=claude-code` to route through the claude
 * CLI instead (e.g. to draw from the CLI's separate rate bucket, paired with
 * a lighter model via LLM_TEST_SIM_MODEL / LLM_TEST_JUDGE_MODEL).
 */
const TEST_BACKEND = process.env.LLM_TEST_BACKEND as AgentBackend | undefined;
const CODEX_GATEWAY_AUTH = 'papercusp-gateway';

function isCodexModel(model: string | undefined): boolean {
  const m = model?.trim().toLowerCase() ?? '';
  return /^(chatgpt:|gpt-|openai-codex\/)/.test(m);
}

export function backendForLlmCall(model: string | undefined, explicitBackend: AgentBackend | undefined = TEST_BACKEND): AgentBackend {
  if (explicitBackend) return explicitBackend;
  return isCodexModel(model) ? 'codex' : 'anthropic-direct';
}

/** Map Papercusp's Codex-facing aliases to the bare ids the Codex CLI accepts. */
export function modelForLlmCall(model: string | undefined, backend: AgentBackend): string | undefined {
  if (backend !== 'codex') return model;
  const trimmed = model?.trim();
  if (!trimmed) return model;
  const chatgpt = /^chatgpt:(.+)$/i.exec(trimmed);
  if (chatgpt) return `gpt-${chatgpt[1]}`;
  const prefix = 'openai-codex/';
  if (trimmed.toLowerCase().startsWith(prefix)) return trimmed.slice(prefix.length);
  return trimmed;
}

function codexGatewayUrl(): string {
  const port = Number(process.env.PAPERCUSP_GATEWAY_PORT);
  const p = Number.isFinite(port) && port > 0 ? port : 8788;
  return `http://127.0.0.1:${p}/v1/responses`;
}

function extractResponsesText(value: unknown): string {
  if (!value || typeof value !== 'object') return '';
  const root = value as { output_text?: unknown; output?: unknown; content?: unknown };
  if (typeof root.output_text === 'string') return root.output_text;
  const parts: string[] = [];
  const visit = (node: unknown) => {
    if (!node) return;
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    if (typeof node !== 'object') return;
    const obj = node as { type?: unknown; text?: unknown; content?: unknown; output_text?: unknown };
    if (typeof obj.output_text === 'string') parts.push(obj.output_text);
    if ((obj.type === 'output_text' || obj.type === 'text') && typeof obj.text === 'string') parts.push(obj.text);
    if (obj.content !== undefined) visit(obj.content);
  };
  visit(root.output);
  visit(root.content);
  return parts.join('\n');
}

function codexCostUsd(model: string | undefined, inputTokens: number, outputTokens: number): number {
  const m = model?.trim().toLowerCase();
  const price =
    m === 'gpt-5.5'
      ? { in: 2.5, out: 20 }
      : m === 'gpt-5'
        ? { in: 1.25, out: 10 }
        : { in: 0, out: 0 };
  return (inputTokens * price.in + outputTokens * price.out) / 1_000_000;
}

async function llmCallViaCodexGateway(opts: LlmCallOpts, model: string | undefined, promptText: string): Promise<LlmCallResult> {
  const input =
    opts.responseFormat === 'json' && !/\bjson\b/i.test(promptText)
      ? `${promptText}\n\nRespond with valid json.`
      : promptText;
  const body: Record<string, unknown> = {
    model: model ?? 'gpt-5.5',
    input,
    stream: false,
  };
  if (opts.system?.trim()) body.instructions = opts.system;
  if (opts.maxTokens !== undefined) body.max_output_tokens = opts.maxTokens;
  if (opts.temperature !== undefined) body.temperature = opts.temperature;
  if (opts.responseFormat === 'json') body.text = { format: { type: 'json_object' } };

  const res = await fetch(codexGatewayUrl(), {
    method: 'POST',
    headers: {
      authorization: `Bearer ${CODEX_GATEWAY_AUTH}`,
      'content-type': 'application/json',
      'x-papercusp-priority': opts.priority ?? 'scout',
    },
    body: JSON.stringify(body),
    signal: opts.signal,
  });
  const text = await res.text();
  let raw: unknown = null;
  try {
    raw = text ? JSON.parse(text) : null;
  } catch {
    raw = text;
  }
  if (!res.ok) {
    const message =
      raw && typeof raw === 'object'
        ? ((raw as { error?: { message?: string } }).error?.message ?? text)
        : text;
    throw new LlmCallError(classifyHttpError({ status: res.status, message }, providerForBackend('codex')));
  }

  const finalText = extractResponsesText(raw);
  const usage =
    raw && typeof raw === 'object'
      ? (raw as { usage?: { input_tokens?: number; output_tokens?: number } }).usage
      : undefined;
  const inputTokens = usage?.input_tokens ?? 0;
  const outputTokens = usage?.output_tokens ?? 0;
  const costUsd = codexCostUsd(model, inputTokens, outputTokens);
  const json = opts.responseFormat === 'json' ? tryParseJson(finalText) : undefined;

  return { text: finalText, json, inputTokens, outputTokens, costUsd, raw };
}

/**
 * One-shot completion via the `anthropic-direct` backend — the operator's
 * concrete implementation of the lib's injected `LlmCallFn` seam.
 */
export async function llmCall(opts: LlmCallOpts): Promise<LlmCallResult> {
  const backend = backendForLlmCall(opts.model);
  const model = modelForLlmCall(opts.model, backend);
  let finalText = '';
  let inputTokens = 0;
  let outputTokens = 0;
  let costUsd = 0;
  let lastErrMsg: string | undefined;
  let lastErrTurn: TurnError | undefined;
  let sawResult = false;

  // Subprocess backends (claude-code / omp / codex) ignore `messages` and use
  // ONLY `promptText` as the user turn, whereas `anthropic-direct` uses `messages`. To
  // work under either, flatten the (usually single-user) message list into a
  // promptText too — a lone user message passes through verbatim; a multi-turn
  // list is role-labelled.
  const promptText =
    opts.messages.length === 1 && opts.messages[0].role === 'user'
      ? opts.messages[0].content
      : opts.messages
          .map((m) => `${m.role === 'assistant' ? 'Assistant' : 'User'}: ${m.content}`)
          .join('\n\n');

  if (backend === 'codex' && TEST_BACKEND === undefined) {
    return llmCallViaCodexGateway(opts, model, promptText);
  }

  for await (const ev of runAgentChat({
    backend,
    model,
    systemPromptText: opts.system,
    messages: opts.messages,
    promptText,
    maxTokens: opts.maxTokens,
    temperature: opts.temperature,
    thinkingBudgetTokens: opts.thinkingBudgetTokens,
    signal: opts.signal,
    // Inference-gateway admission-tier label (gateway-priority-tiers): attached as
    // the `x-papercusp-priority` header on the in-process anthropic-direct call so
    // the pacing gateway tiers this caller (e.g. 'scout' → tier 1) instead of the
    // first-shed default band. No-op for the subprocess backends.
    priority: opts.priority,
    // Isolate subprocess-backend spawns (LLM_TEST_BACKEND=claude-code) from
    // the host ~/.claude. No-op for the default `anthropic-direct` backend (HTTP, no
    // subprocess). Without this, each sim-user/judge `claude` spawn does a
    // 13-server MCP init (context7/github/cloudflare plugins via npx +
    // papercusp-su + connectors) and runs the host SessionStart/PreToolUse
    // hooks — under a real run, sim + judge + brain spawn `claude`
    // concurrently and those heavy inits flake/exit-1, so the sim-user emits
    // unparseable output and gives up at turn 0 (turns=0). The clean config
    // dir cuts the init to 4 servers and drops the hooks → reliable JSON.
    isolateConfig: true,
  })) {
    if (ev.type === 'delta') {
      // The anthropic-direct backend yields a single delta with the full final
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
      // Fold the subprocess stderr tail into the message: the un-governed CLI path attaches
      // no classified turn, so a bare `<backend> exited 1` is undiagnosable — and the
      // fallback classifier below only sees the message string.
      lastErrMsg = ev.stderr?.trim() ? `${ev.message} — stderr: ${ev.stderr.trim()}` : ev.message;
      // Prefer the structured turn the governed path attaches; else classify the message so a
      // rate-limit is still detected on the un-governed path (RB-006).
      lastErrTurn = ev.turn;
    }
  }

  if (lastErrMsg !== undefined) {
    const turn = lastErrTurn ?? classifyHttpError({ message: lastErrMsg }, providerForBackend(backend));
    throw new LlmCallError(turn);
  }
  if (!sawResult) throw new Error(`llmCall: ${backend} backend produced no result event`);

  let json: unknown;
  if (opts.responseFormat === 'json') {
    json = tryParseJson(finalText);
  }

  return { text: finalText, json, inputTokens, outputTokens, costUsd, raw: null };
}

/**
 * True when the framework can make LLM calls — rides the SAME transport
 * resolution the stateless call path uses (`probeStatelessTransport`: a live
 * Claude OAuth session → anthropic-direct), so availability can never
 * disagree with an actual call. Keeps the legacy ANTHROPIC_API_KEY / PG
 * credentials check as a fall-through so older deploys still work. (The
 * omp-token check this replaced probed a credential the stateless path no
 * longer uses — EI-399.)
 */
export async function isLlmAvailable(): Promise<boolean> {
  if (probeStatelessTransport().ok) return true;
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
