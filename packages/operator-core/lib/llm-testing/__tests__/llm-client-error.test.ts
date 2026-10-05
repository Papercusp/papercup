/**
 * llmCall error-path: the un-governed CLI path yields `{ type:'error',
 * message:'<backend> exited 1', stderr }` with NO classified turn — the thrown
 * LlmCallError must carry the stderr tail, not just the bare exit line
 * (a bare `claude-code exited 1` is undiagnosable; su-S11's first scored run
 * died exactly this opaquely, coord-system-e2e-testing-2026-06-10 P-011).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { isLlmCallError } from '@papercusp/testing-shell/llm';

const events: unknown[] = [];
const diagnostics: Array<Record<string, unknown>> = [];
// EI-315: captures the opts of the LAST runAgentChat call so a test can assert on the
// priority label threaded through (the anthropic-direct path has no HTTP layer to spy
// on the way the codex-gateway test spies on `fetch`).
let lastRunAgentChatOpts: Record<string, unknown> | undefined;

vi.mock('../../agent-chat-stream', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../agent-chat-stream')>();
  return {
    ...orig,
    runAgentChat: async function* (opts: Record<string, unknown>) {
      lastRunAgentChatOpts = opts;
      for (const diagnostic of diagnostics) {
        (opts.onTransportDiagnostic as ((value: unknown) => void) | undefined)?.(diagnostic);
      }
      yield* events as never[];
    },
  };
});

// These assertions pin the DEFAULT (no explicit-override) backend routing, which
// `backendForLlmCall` derives from `process.env.LLM_TEST_BACKEND` captured at
// llm-client module-init (the module-level `TEST_BACKEND` const). operator-core's
// vitest fork pool reuses a worker across test files, and several gym/ab-run CLI
// entry modules set `LLM_TEST_BACKEND='claude-code'` at module load — so whichever
// sibling file ran first could leak that value into this worker and flip
// `backendForLlmCall` to 'claude-code', reddening these pure routing tests
// ORDER-DEPENDENTLY (the operator-core "flaky gate" class; green-checkpoint
// 2026-07-02). Deleting the env BEFORE the first dynamic import makes llm-client
// capture a clean `TEST_BACKEND`. vitest isolates the module registry per file, so
// no `vi.resetModules()` is needed here — and it WOULD duplicate
// `@papercusp/testing-shell/llm`, breaking the `LlmCallError` class identity the
// subprocess tests below assert via `isLlmCallError` (instanceof).
let savedLlmTestBackend: string | undefined;
beforeAll(() => {
  savedLlmTestBackend = process.env.LLM_TEST_BACKEND;
  delete process.env.LLM_TEST_BACKEND;
});
afterAll(() => {
  if (savedLlmTestBackend === undefined) delete process.env.LLM_TEST_BACKEND;
  else process.env.LLM_TEST_BACKEND = savedLlmTestBackend;
});

describe('llmCall backend selection', () => {
  it('routes OpenAI-family model ids to Codex even when a stale backend override is set', async () => {
    const { backendForLlmCall, modelForLlmCall } = await import('../llm-client');

    expect(backendForLlmCall('chatgpt:5.5')).toBe('codex');
    expect(backendForLlmCall('gpt-5.5')).toBe('codex');
    expect(backendForLlmCall('openai-codex/gpt-5.5')).toBe('codex');
    expect(backendForLlmCall('claude-sonnet-4-6')).toBe('anthropic-direct');
    expect(backendForLlmCall('chatgpt:5.5', 'anthropic-direct')).toBe('codex');

    expect(modelForLlmCall('chatgpt:5.5', 'codex')).toBe('gpt-5.5');
    expect(modelForLlmCall('openai-codex/gpt-5.5', 'codex')).toBe('gpt-5.5');
    expect(modelForLlmCall('gpt-5.5', 'codex')).toBe('gpt-5.5');
    expect(modelForLlmCall('chatgpt:5.5', 'anthropic-direct')).toBe('chatgpt:5.5');
  });

  it('uses the local Codex gateway for OpenAI-family stateless calls', async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      expect(body.model).toBe('gpt-5.5');
      expect(body.input).toBe('give json');
      expect(body.instructions).toBe('system');
      expect(body.text).toEqual({ format: { type: 'json_object' } });
      return new Response(
        JSON.stringify({
          output_text: '{"ok":true}',
          usage: { input_tokens: 10, output_tokens: 4 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });
    vi.stubGlobal('fetch', fetchMock);
    const { llmCall } = await import('../llm-client');

    const res = await llmCall({
      system: 'system',
      messages: [{ role: 'user', content: 'give json' }],
      model: 'chatgpt:5.5',
      maxTokens: 8,
      responseFormat: 'json',
      ownerId: 'system:work-item-admission-bulk-dedup:run-1',
    });

    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:8788/v1/responses',
      expect.objectContaining({
        method: 'POST',
        // OAuth non-stream aggregation intentionally emits no downstream headers
        // until response.completed, so this call must opt out of Undici's default
        // five-minute header cap via loopbackFetch's long-running dispatcher.
        dispatcher: expect.anything(),
        headers: expect.objectContaining({
          authorization: 'Bearer papercusp-gateway',
          'x-papercusp-priority': 'llm-testing',
          'x-papercusp-owner': 'system:work-item-admission-bulk-dedup:run-1',
        }),
      }),
    );
    expect(res.text).toBe('{"ok":true}');
    expect(res.json).toEqual({ ok: true });
    expect(res.inputTokens).toBe(10);
    expect(res.outputTokens).toBe(4);
    expect(res.costUsd).toBeGreaterThan(0);
    // Vite worker evaluation supplies no native original-load receipt. The
    // transport must retain unknown code identity even though source exists.
    expect(res.execution).toMatchObject({ codeHash: null, loadedCode: { llmClient: null } });

    vi.unstubAllGlobals();
  });

  it('makes the Codex JSON-mode input itself JSON-explicit even when only instructions mention JSON', async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      expect(body.instructions).toContain('JSON');
      expect(body.input).toBe('generate one idea\n\nRespond with valid json.');
      expect(body.text).toEqual({ format: { type: 'json_object' } });
      return new Response(JSON.stringify({ output_text: '{"ok":true}', usage: { input_tokens: 10, output_tokens: 4 } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    const { llmCall } = await import('../llm-client');

    await llmCall({
      system: 'Return JSON only.',
      messages: [{ role: 'user', content: 'generate one idea' }],
      model: 'chatgpt:5.5',
      responseFormat: 'json',
    });

    expect(fetchMock).toHaveBeenCalledOnce();
    vi.unstubAllGlobals();
  });

  it.each([
    { model: 'gpt-5.6-sol', temperature: 0 },
    { model: 'gpt-5.6-sol', temperature: 0.4 },
    { model: 'gpt-6-astra', temperature: 0.4 },
  ])('completes $model calls when the caller supplies temperature=$temperature', async ({ model, temperature }) => {
    // Reproduce the gateway refusal that stopped the live SU canary before
    // its first turn (WI-2144435), rather than accepting any request body.
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      if (Object.hasOwn(body, 'temperature')) {
        return new Response(JSON.stringify({ error: { message: 'Unsupported parameter: temperature' } }), {
          status: 400,
          headers: { 'content-type': 'application/json' },
        });
      }
      expect(body).toMatchObject({ model, instructions: 'Return JSON.', text: { format: { type: 'json_object' } } });
      return new Response(JSON.stringify({ output_text: '{"ok":true}', usage: { input_tokens: 10, output_tokens: 4 } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    try {
      const { llmCall } = await import('../llm-client');
      const result = await llmCall({
        model,
        temperature,
        system: 'Return JSON.',
        messages: [{ role: 'user', content: 'give json' }],
        responseFormat: 'json',
      });
      expect(result.json).toEqual({ ok: true });
      expect(result.execution).toMatchObject({ model, codeHash: null,
        loadedCode: { llmClient: null },
        unresolved: expect.arrayContaining(['gateway-runtime']) });
      expect(fetchMock).toHaveBeenCalledOnce();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it.each([
    ['gpt-5.6-luna:medium', (688 * 0.2 + 1922 * 1.2 + 3840 * 0.02) / 1_000_000],
    ['gpt-5.6-sol:xhigh', (688 * 4 + 1922 * 20 + 3840 * 0.4) / 1_000_000],
  ])('accounts for %s nonzero gateway usage through canonical model pricing', async (model, expected) => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ output_text: '{}',
      usage: { input_tokens: 4528, output_tokens: 1922, input_tokens_details: { cached_tokens: 3840 } },
    }), { status: 200 })));
    try {
      const { llmCall } = await import('../llm-client');
      const result = await llmCall({ model, messages: [{ role: 'user', content: 'json' }] });
      expect(result.costUsd).toBeCloseTo(expected, 8);
      expect(result.inputTokens).toBe(4528);
    } finally { vi.unstubAllGlobals(); }
  });

  it('refuses an unpriced model before sending a request', async () => {
    const fetchMock = vi.fn(); vi.stubGlobal('fetch', fetchMock);
    try {
      const { llmCall } = await import('../llm-client');
      await expect(llmCall({ model: 'gpt-99-unknown', messages: [{ role: 'user', content: 'hello' }] })).rejects.toThrow(/no registered usage price/);
      expect(fetchMock).not.toHaveBeenCalled();
    } finally { vi.unstubAllGlobals(); }
  });

  it.each([undefined, { input_tokens: 10 }, { input_tokens: -1, output_tokens: 3 }])('does not turn incomplete usage %j into a free response', async usage => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ output_text: '{}', usage }), { status: 200 })));
    try {
      const { llmCall } = await import('../llm-client');
      await expect(llmCall({ model: 'gpt-5.6-luna', messages: [{ role: 'user', content: 'hello' }] })).rejects.toThrow(/missing or invalid usage/);
    } finally { vi.unstubAllGlobals(); }
  });

  it('preserves caller temperature on the Anthropic transport', async () => {
    events.length = 0;
    events.push({ type: 'result', finalText: 'ok', tokensIn: 1, tokensOut: 1, costUsd: 0 });
    lastRunAgentChatOpts = undefined;
    const { llmCall } = await import('../llm-client');
    await llmCall({
      model: 'claude-haiku-4-5',
      temperature: 0.4,
      messages: [{ role: 'user', content: 'hello' }],
    });
    expect((lastRunAgentChatOpts as Record<string, unknown> | undefined)?.temperature).toBe(0.4);
  });
});

describe('llmCall subprocess error surfacing', () => {
  it('folds the stderr tail into the thrown LlmCallError message (un-governed path)', async () => {
    events.length = 0;
    events.push({
      type: 'error',
      message: 'claude-code exited 1',
      stderr: 'Error: some real diagnostic from the CLI\n  at spawn',
    });
    const { llmCall } = await import('../llm-client');
    const err = await llmCall({
      system: 's',
      messages: [{ role: 'user', content: 'u' }],
      model: 'claude-haiku-4-5-20251001',
      maxTokens: 8,
    }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(isLlmCallError(err)).toBe(true);
    expect((err as Error).message).toContain('claude-code exited 1');
    expect((err as Error).message).toContain('some real diagnostic from the CLI');
  });

  it('still classifies a rate-limit printed only to stderr', async () => {
    events.length = 0;
    events.push({
      type: 'error',
      message: 'claude-code exited 1',
      stderr: 'API Error: 429 rate limit exceeded, try again in 30 seconds',
    });
    const { llmCall } = await import('../llm-client');
    const err = await llmCall({
      system: 's',
      messages: [{ role: 'user', content: 'u' }],
      model: 'claude-haiku-4-5-20251001',
      maxTokens: 8,
    }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(isLlmCallError(err)).toBe(true);
    if (isLlmCallError(err)) expect(err.turn.class).toBe('rate_limited');
  });
});

describe('llmCall transport evidence (WI-10005738)', () => {
  const diagnostic = { callId: 'local-call', attempt: 2, phase: 'response', observedAt: '2026-10-03T01:00:00Z',
    label: 'anthropic-direct', endpointOrigin: 'http://127.0.0.1:8788', loopback: true,
    requestedAccount: null, servedAccount: 'actual-serving-account', providerRequestId: 'req_bound', status: 429 };

  it('keeps resolved egress in the thrown error without changing the classified turn', async () => {
    diagnostics.push(diagnostic);
    const turn = { class: 'rate_limited', message: '429 upstream refusal', retryable: true, retryAfterMs: 12000 };
    events.length = 0;
    events.push({ type: 'error', message: turn.message, turn });
    try {
      const { llmCall } = await import('../llm-client');
      const err = await llmCall({ model: 'claude-sonnet-4-6', messages: [{ role: 'user', content: 'secret-prompt' }] }).catch(e => e);
      expect(isLlmCallError(err)).toBe(true);
      expect(err.turn).toBe(turn);
      expect(err.message).toBe(turn.message);
      expect(err.transportDiagnostics).toEqual([diagnostic]);
      expect(err.promptSha256).toMatch(/^[a-f0-9]{64}$/);
      expect(JSON.stringify(err)).not.toContain('secret-prompt');
    } finally { diagnostics.length = 0; events.length = 0; }
  });

  it('retains sanitized attempts on successful-call receipts', async () => {
    diagnostics.push({ ...diagnostic, phase: 'request', status: null, servedAccount: null, providerRequestId: null },
      { ...diagnostic, status: 200 });
    events.length = 0;
    events.push({ type: 'result', finalText: 'ok', tokensIn: 1, tokensOut: 1, costUsd: 0 });
    try {
      const { llmCall } = await import('../llm-client');
      const result = await llmCall({ model: 'claude-sonnet-4-6', messages: [{ role: 'user', content: 'unchanged prompt' }] });
      expect(result.raw).toMatchObject({ transportDiagnostics: diagnostics, promptSha256: expect.stringMatching(/^[a-f0-9]{64}$/) });
      expect(result.text).toBe('ok');
      expect(result.execution).toMatchObject({ model: 'claude-sonnet-4-6', codeHash: null,
        loadedCode: { llmClient: null },
        unresolved: expect.arrayContaining(['agent-chat-runtime', 'transport-runtime']) });
    } finally { diagnostics.length = 0; events.length = 0; }
  });
});

describe('llmCall priority default (EI-315: llm-testing lane starvation)', () => {
  it('preserves capped generation deltas and surfaces the provider stop reason', async () => {
    events.length = 0;
    events.push(
      { type: 'delta', text: '{"partial":' },
      { type: 'delta', text: 'true' },
      {
        type: 'result',
        finalText: '',
        tokensIn: 12,
        tokensOut: 300,
        costUsd: 0.01,
        stopReason: 'max_tokens',
      },
    );
    const { llmCall } = await import('../llm-client');

    const result = await llmCall({
      system: 's',
      messages: [{ role: 'user', content: 'u' }],
      model: 'claude-haiku-4-5-20251001',
      maxTokens: 300,
      responseFormat: 'json',
    });

    expect(result.text).toBe('{"partial":true');
    expect(result.json).toBeNull();
    expect(result.outputTokens).toBe(300);
    expect(result.stopReason).toBe('max_tokens');
    expect(result.execution).toMatchObject({ codeHash: null, loadedCode: { llmClient: null } });
  });

  it('defaults the anthropic-direct path to the "llm-testing" priority label when the caller sets none', async () => {
    events.length = 0;
    events.push({ type: 'result', finalText: 'ok', tokensIn: 1, tokensOut: 1, costUsd: 0 });
    lastRunAgentChatOpts = undefined;
    const { llmCall } = await import('../llm-client');
    await llmCall({
      system: 's',
      messages: [{ role: 'user', content: 'u' }],
      model: 'claude-haiku-4-5-20251001',
      maxTokens: 8,
    });
    // Before this fix, an unset priority rode `undefined` through to the gateway's
    // `tierOf()`, which falls back to the bottom `default` band (tier 5) — the most
    // aggressively AIMD-shed lane, and the literal root cause of this item's
    // "17/17 attempts 429-capped over 7h". It must now land in the shared gym/benchmark
    // batch band (tier 4) instead.
    // WI-5217: `lastRunAgentChatOpts` is narrowed to the LITERAL `undefined` here (the
    // preceding `= undefined` reset, with no call TS's CFA can see reassigning it before
    // this read — the mock's own reassignment lives in a separately-registered vi.mock
    // factory, invisible to this function's flow analysis) — `?.priority` on a value
    // narrowed to exactly `undefined` then errors TS2339 on the `never` non-nullable arm.
    // Re-assert the declared type to read the real (runtime-populated) value.
    expect((lastRunAgentChatOpts as Record<string, unknown> | undefined)?.priority).toBe('llm-testing');
  });

  it('an explicit caller priority still wins over the llm-testing default', async () => {
    events.length = 0;
    events.push({ type: 'result', finalText: 'ok', tokensIn: 1, tokensOut: 1, costUsd: 0 });
    lastRunAgentChatOpts = undefined;
    const { llmCall } = await import('../llm-client');
    await llmCall({
      system: 's',
      messages: [{ role: 'user', content: 'u' }],
      model: 'claude-haiku-4-5-20251001',
      maxTokens: 8,
      priority: 'gym',
    });
    // WI-5217: see the comment on the sibling assertion above — same narrowed-to-`undefined` quirk.
    expect((lastRunAgentChatOpts as Record<string, unknown> | undefined)?.priority).toBe('gym');
  });

  it('forwards a stable owner id to runAgentChat for gateway attribution', async () => {
    events.length = 0;
    events.push({ type: 'result', finalText: 'ok', tokensIn: 1, tokensOut: 1, costUsd: 0 });
    lastRunAgentChatOpts = undefined;
    const { llmCall } = await import('../llm-client');
    await llmCall({
      system: 's',
      messages: [{ role: 'user', content: 'u' }],
      model: 'claude-haiku-4-5-20251001',
      ownerId: 'system:work-item-admission-bulk-dedup:run-1',
    });
    expect((lastRunAgentChatOpts as Record<string, unknown> | undefined)?.ownerId).toBe(
      'system:work-item-admission-bulk-dedup:run-1',
    );
  });

  // WI-2144763. This is THE chokepoint for headers-source spend attribution: every
  // `source:'headers'` usage row gets its identity from the single `usageAttribution`
  // object built here, so if this forwarding regresses, all 18,228 such rows (~$755)
  // silently go back to harness_slug NULL / '(unattributed)' with nothing failing.
  // Asserted at runAgentChat's boundary for the same reason the priority tests above are:
  // the anthropic-direct path has no HTTP layer to spy on. The `role` half is pinned
  // alongside so a future edit cannot drop one while keeping the other.
  it('WI-2144763: forwards the caller harness into usageAttribution alongside the role label', async () => {
    events.length = 0;
    events.push({ type: 'result', finalText: 'ok', tokensIn: 1, tokensOut: 1, costUsd: 0 });
    lastRunAgentChatOpts = undefined;
    const { llmCall } = await import('../llm-client');
    await llmCall({
      system: 's',
      messages: [{ role: 'user', content: 'u' }],
      model: 'claude-haiku-4-5-20251001',
      priority: 'scout',
      harnessSlug: 'papercusp-public-site-pot',
    });
    expect((lastRunAgentChatOpts as Record<string, unknown> | undefined)?.usageAttribution).toEqual({
      role: 'scout',
      harnessSlug: 'papercusp-public-site-pot',
    });
  });

  // The other side of the contract: a caller that genuinely does not know its harness
  // (workspace-global work) must leave the field undefined so the host records an honest
  // NULL. A fix that fabricated a slug here would be worse than the gap it closed.
  it('WI-2144763: leaves usageAttribution.harnessSlug undefined when the caller does not supply one', async () => {
    events.length = 0;
    events.push({ type: 'result', finalText: 'ok', tokensIn: 1, tokensOut: 1, costUsd: 0 });
    lastRunAgentChatOpts = undefined;
    const { llmCall } = await import('../llm-client');
    await llmCall({
      system: 's',
      messages: [{ role: 'user', content: 'u' }],
      model: 'claude-haiku-4-5-20251001',
    });
    const attribution = (lastRunAgentChatOpts as Record<string, unknown> | undefined)
      ?.usageAttribution as Record<string, unknown> | undefined;
    expect(attribution?.role).toBe('llm-testing');
    expect(attribution?.harnessSlug).toBeUndefined();
  });
});
