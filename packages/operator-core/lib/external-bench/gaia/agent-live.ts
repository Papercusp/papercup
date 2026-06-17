/**
 * Live LLM binding for the GAIA agent (plan `benchmark-suite-gaia-2026-06-17`, P-003) — maps the
 * provider-agnostic {@link LlmFn} onto the Anthropic Messages API, routed through OUR inference gateway
 * (claude-opus-4-8, the same fair-routing path the bees + competitor arms use; the gateway paces + injects
 * the bound account's auth, so the request goes out UNAUTHENTICATED and the key need only be SET).
 *
 * The request/response MAPPING is pure + unit-tested ({@link toAnthropicMessages} / {@link toAnthropicTools}
 * / {@link fromAnthropicResponse}); only {@link makeLiveGaiaLlm} touches the SDK. xhigh effort is realized as
 * extended thinking at {@link DEFAULT_THINKING_BUDGET_TOKENS} (the raw-API equivalent of the claude CLI's
 * `--effort xhigh`), matching competitor-live.ts. Thinking blocks (incl. safety-redacted ones) round-trip
 * with their signatures so a thinking→tool_use turn replays correctly.
 */
import Anthropic from '@anthropic-ai/sdk';
import { gatewayBaseUrl } from '../competitor-live';
import type { AssistantBlock, GaiaToolSpec, LlmFn, LlmMessage, LlmTurnRequest, LlmTurnResponse } from './agent';

/** Fairness default: every arm runs claude-opus-4-8 via the gateway (matches DEFAULT_COMPETITOR_MODEL). */
export const DEFAULT_GAIA_MODEL = 'claude-opus-4-8';
/** xhigh-effort realization = extended thinking at this budget (matches competitor-live). */
export const DEFAULT_THINKING_BUDGET_TOKENS = 16000;

/* -------------------------------------------------------------------------- */
/* Pure request mapping (our types → Anthropic params)                         */
/* -------------------------------------------------------------------------- */

/** Map our running conversation → Anthropic `MessageParam[]`. */
export function toAnthropicMessages(messages: LlmMessage[]): Anthropic.MessageParam[] {
  return messages.map((m): Anthropic.MessageParam => {
    if (m.role === 'user') {
      const content = m.content.map((b): Anthropic.ContentBlockParam => {
        if (b.type === 'text') return { type: 'text', text: b.text };
        if (b.type === 'image') {
          return { type: 'image', source: { type: 'base64', media_type: b.mediaType as Anthropic.Base64ImageSource['media_type'], data: b.dataBase64 } };
        }
        // tool_result
        return { type: 'tool_result', tool_use_id: b.toolUseId, content: b.content, ...(b.isError ? { is_error: true } : {}) };
      });
      return { role: 'user', content };
    }
    // assistant
    const content = m.content.map((b): Anthropic.ContentBlockParam => {
      if (b.type === 'text') return { type: 'text', text: b.text };
      if (b.type === 'tool_use') return { type: 'tool_use', id: b.id, name: b.name, input: b.input };
      // thinking — round-trip signature, or a safety-redacted block
      if (b.redactedData) return { type: 'redacted_thinking', data: b.redactedData };
      return { type: 'thinking', thinking: b.thinking, signature: b.signature ?? '' };
    });
    return { role: 'assistant', content };
  });
}

/** Map our tool specs → Anthropic `Tool[]`. */
export function toAnthropicTools(tools: GaiaToolSpec[]): Anthropic.Tool[] {
  return tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.inputSchema as Anthropic.Tool.InputSchema }));
}

/* -------------------------------------------------------------------------- */
/* Pure response mapping (Anthropic response → our types)                      */
/* -------------------------------------------------------------------------- */

/** Map an Anthropic Message response → our {@link LlmTurnResponse}. */
export function fromAnthropicResponse(res: Anthropic.Message): LlmTurnResponse {
  const content: AssistantBlock[] = [];
  for (const b of res.content) {
    if (b.type === 'text') content.push({ type: 'text', text: b.text });
    else if (b.type === 'tool_use') content.push({ type: 'tool_use', id: b.id, name: b.name, input: (b.input ?? {}) as Record<string, unknown> });
    else if (b.type === 'thinking') content.push({ type: 'thinking', thinking: b.thinking, signature: b.signature });
    else if (b.type === 'redacted_thinking') content.push({ type: 'thinking', thinking: '', redactedData: b.data });
  }
  return {
    content,
    stopReason: res.stop_reason ?? null,
    usage: {
      inputTokens: res.usage.input_tokens,
      outputTokens: res.usage.output_tokens,
      cacheReadTokens: res.usage.cache_read_input_tokens ?? 0,
      cacheWriteTokens: res.usage.cache_creation_input_tokens ?? 0,
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Live binding                                                                */
/* -------------------------------------------------------------------------- */

export interface LiveGaiaLlmConfig {
  /** Model id (default {@link DEFAULT_GAIA_MODEL}). */
  model?: string;
  /** Anthropic-compatible base url — default the inference gateway (fair routing). Set null to use the SDK default (direct). */
  baseUrl?: string | null;
  /** Env var the API key is read from (default ANTHROPIC_API_KEY; gateway routes so any value works). */
  apiKeyEnv?: string;
  /** Enable extended thinking (xhigh). Default true. */
  thinking?: boolean;
  /** Thinking budget tokens when enabled (default {@link DEFAULT_THINKING_BUDGET_TOKENS}). */
  thinkingBudgetTokens?: number;
  /** SDK max retries (default 4) — absorbs gateway 429/contention transparently. */
  maxRetries?: number;
  /** Inject a client (tests). */
  client?: Pick<Anthropic, 'messages'>;
}

/**
 * Build the live {@link LlmFn}. Each call is one `messages.create`. `max_tokens` is forced above the thinking
 * budget (the API requires it). On a thrown SDK error the {@link runGaiaAgent} loop catches it and degrades
 * the task to `stopReason:'error'` (an infra exclusion, not a capability fail) — we don't swallow it here.
 */
export function makeLiveGaiaLlm(cfg: LiveGaiaLlmConfig = {}): LlmFn {
  const model = cfg.model ?? DEFAULT_GAIA_MODEL;
  const baseURL = cfg.baseUrl === undefined ? gatewayBaseUrl() : cfg.baseUrl ?? undefined;
  const apiKey = process.env[cfg.apiKeyEnv ?? 'ANTHROPIC_API_KEY'] ?? 'sk-gateway-routed';
  const useThinking = cfg.thinking ?? true;
  const thinkingBudget = cfg.thinkingBudgetTokens ?? DEFAULT_THINKING_BUDGET_TOKENS;
  const client =
    cfg.client ?? new Anthropic({ apiKey, ...(baseURL ? { baseURL } : {}), maxRetries: cfg.maxRetries ?? 4 });

  return async (req: LlmTurnRequest): Promise<LlmTurnResponse> => {
    // Extended thinking requires max_tokens > budget_tokens; honor the caller's floor but guarantee validity.
    const maxTokens = useThinking ? Math.max(req.maxTokens, thinkingBudget + 4096) : req.maxTokens;
    const params: Anthropic.MessageCreateParamsNonStreaming = {
      model,
      max_tokens: maxTokens,
      system: req.system,
      messages: toAnthropicMessages(req.messages),
      tools: toAnthropicTools(req.tools),
      ...(useThinking ? { thinking: { type: 'enabled', budget_tokens: thinkingBudget } } : {}),
    };
    const res = await client.messages.create(params);
    return fromAnthropicResponse(res as Anthropic.Message);
  };
}
