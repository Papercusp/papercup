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
const TEST_BACKEND: AgentBackend =
  (process.env.LLM_TEST_BACKEND as AgentBackend | undefined) ?? 'anthropic-direct';

/**
 * One-shot completion via the `anthropic-direct` backend — the operator's
 * concrete implementation of the lib's injected `LlmCallFn` seam.
 */
export async function llmCall(opts: LlmCallOpts): Promise<LlmCallResult> {
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

  for await (const ev of runAgentChat({
    backend: TEST_BACKEND,
    model: opts.model,
    systemPromptText: opts.system,
    messages: opts.messages,
    promptText,
    maxTokens: opts.maxTokens,
    temperature: opts.temperature,
    thinkingBudgetTokens: opts.thinkingBudgetTokens,
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
    const turn = lastErrTurn ?? classifyHttpError({ message: lastErrMsg }, providerForBackend(TEST_BACKEND));
    throw new LlmCallError(turn);
  }
  if (!sawResult) throw new Error(`llmCall: ${TEST_BACKEND} backend produced no result event`);

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
