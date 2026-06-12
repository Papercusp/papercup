/**
 * Operator LLM transport — the concrete `LlmCallFn` (+ `isLlmAvailable`) seam
 * the generic `@papercusp/testing-shell/llm` runner is injected with via
 * `RunnerDeps` (Phase 7 P-073).
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
 *
 * The host-agnostic pieces — `MODEL_PRICES` / `estimateCost`, `tryParseJson`,
 * the `LlmCallOpts`/`LlmCallResult` shapes, and the typed `LlmCallError` — live
 * in `@papercusp/testing-shell/llm`. This module keeps only the operator-coupled
 * transport (`llmCall`, which imports the operator's agent-chat-stream) and the
 * operator-credentials availability check (`isLlmAvailable`).
 */

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import {
  LlmCallError,
  tryParseJson,
  type LlmCallOpts,
  type LlmCallResult,
} from '@papercusp/testing-shell/llm';

import {
  runAgentChat,
  classifyHttpError,
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
 * Backend for the sim-user + judge calls. Defaults to `meridian` (Claude Max
 * via the local router) but is overridable to any agent backend — set
 * `LLM_TEST_BACKEND=claude-code` to route through the claude CLI instead (e.g.
 * to dodge a Meridian rate-limit window, paired with a lighter model via
 * LLM_TEST_SIM_MODEL / LLM_TEST_JUDGE_MODEL).
 */
const TEST_BACKEND: AgentBackend =
  (process.env.LLM_TEST_BACKEND as AgentBackend | undefined) ?? 'meridian';

/**
 * One-shot completion via the `meridian` backend — the operator's concrete
 * implementation of the lib's injected `LlmCallFn` seam.
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
  // ONLY `promptText` as the user turn, whereas `meridian` uses `messages`. To
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
    // the host ~/.claude. No-op for the default `meridian` backend (HTTP, no
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
  if (!sawResult) throw new Error('llmCall: meridian backend produced no result event');

  let json: unknown;
  if (opts.responseFormat === 'json') {
    json = tryParseJson(finalText);
  }

  return { text: finalText, json, inputTokens, outputTokens, costUsd, raw: null };
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
