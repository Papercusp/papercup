#!/usr/bin/env node
/**
 * Stagehand runner — spawned by /api/admin/testing/ai-explore.
 *
 * Reads a JSON config from stdin:
 *   { goal, startUrl, model, apiKey, maxSteps, maxCostUsd, headless }
 *
 * Emits NDJSON events on stdout (one event per line, parsed by the SSE route):
 *   {type:"start", goal, model}
 *   {type:"step", n, action, ok, durationMs, result?}
 *   {type:"log", level, line}
 *   {type:"metrics", inputTokens, outputTokens, totalTokens, costUsd}
 *   {type:"done", totalMs, steps, costUsd}
 *   {type:"error", message}
 *
 * Reads chunked stdin to get the config in case the parent writes
 * incrementally. Exits 0 on success, non-zero on fatal error.
 */

import { setTimeout as sleep } from 'node:timers/promises';

// AI SDK emits a "System messages in the prompt or messages fields can
// be a security risk…" warning via console.warn whenever a system-role
// entry is present in the messages array. Stagehand uses that pattern
// intentionally, so the warning is noise; suppress it before it reaches
// stderr (which the parent ships to the user-facing log).
const SDK_WARNING_PATTERN = 'AI SDK Warning: System messages in the prompt';
{
  const realWarn = console.warn;
  console.warn = (...args) => {
    const first = args[0];
    if (typeof first === 'string' && first.includes(SDK_WARNING_PATTERN)) return;
    realWarn.apply(console, args);
  };
  const realWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk, ...rest) => {
    if (typeof chunk === 'string' && chunk.includes(SDK_WARNING_PATTERN)) return true;
    if (chunk instanceof Buffer && chunk.includes(SDK_WARNING_PATTERN)) return true;
    return realWrite(chunk, ...rest);
  };
}

const ANTHROPIC_PRICING = {
  // input / output per 1M tokens (rough; refine when needed)
  'anthropic/claude-sonnet-4-6': { in: 3.0, out: 15.0 },
  'anthropic/claude-opus-4-7':   { in: 15.0, out: 75.0 },
  'anthropic/claude-haiku-4-5':  { in: 1.0, out: 5.0 },
};
const PRICING_FALLBACK = { in: 3.0, out: 15.0 };

function emit(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

async function readStdinJson() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

async function main() {
  let cfg;
  try {
    cfg = await readStdinJson();
  } catch (err) {
    emit({ type: 'error', message: `bad config: ${err.message}` });
    process.exit(2);
  }

  const goal = String(cfg.goal ?? '').trim();
  const startUrl = String(cfg.startUrl ?? 'http://127.0.0.1:3055/');
  const modelName = String(cfg.model ?? 'anthropic/claude-sonnet-4-6');
  const apiKey = String(cfg.apiKey ?? '');
  const maxSteps = Number(cfg.maxSteps ?? 20);
  const maxCostUsd = Number(cfg.maxCostUsd ?? 1.0);
  const headless = cfg.headless !== false;

  if (!goal) { emit({ type: 'error', message: 'goal is required' }); process.exit(2); }
  if (!apiKey) { emit({ type: 'error', message: 'apiKey is required' }); process.exit(2); }

  const t0 = Date.now();
  emit({ type: 'start', goal, startUrl, model: modelName });

  let Stagehand;
  try {
    const mod = await import('@browserbasehq/stagehand');
    Stagehand = mod.Stagehand ?? mod.default?.Stagehand ?? mod.default;
  } catch (err) {
    emit({ type: 'error', message: `failed to import @browserbasehq/stagehand: ${err.message}` });
    process.exit(3);
  }

  const stagehand = new Stagehand({
    env: 'LOCAL',
    model: { modelName, apiKey },
    verbose: 0,
    localBrowserLaunchOptions: { headless },
    logger: (entry) => {
      const line = typeof entry === 'string' ? entry : (entry?.message ?? JSON.stringify(entry));
      const s = String(line);
      // Suppress the AI SDK's "System messages in the prompt or messages
      // fields…" warning — Stagehand intentionally puts a system entry in
      // its messages array; the warning is informational and just noise
      // in the user-facing chat log.
      if (s.includes('AI SDK Warning: System messages in the prompt')) return;
      emit({ type: 'log', level: entry?.level ?? 'info', line: s.slice(0, 500) });
    },
  });

  let steps = 0;
  let costUsd = 0;
  let aborted = false;

  // Watchdog: every 2s, check cost cap. If exceeded, mark aborted and close.
  const watchdog = setInterval(async () => {
    try {
      const m = await stagehand.metrics;
      const pricing = ANTHROPIC_PRICING[modelName] ?? PRICING_FALLBACK;
      costUsd = (((m?.totalPromptTokens ?? 0) / 1e6) * pricing.in) + (((m?.totalCompletionTokens ?? 0) / 1e6) * pricing.out);
      if (costUsd >= maxCostUsd && !aborted) {
        aborted = true;
        emit({ type: 'log', level: 'warn', line: `cost cap $${maxCostUsd.toFixed(2)} reached at $${costUsd.toFixed(4)} — aborting` });
      }
    } catch { /* metrics unavailable mid-flight is fine */ }
  }, 2_000);

  try {
    await stagehand.init();
    // Stagehand v3: pages live on the underlying CDP context. `stagehand.page`
    // was removed in favor of `stagehand.context.pages()[0]`.
    const page = stagehand.page ?? stagehand.context?.pages?.()?.[0];
    if (!page) throw new Error('no page available after stagehand.init()');
    emit({ type: 'log', level: 'info', line: `navigating to ${startUrl}` });
    await page.goto(startUrl, { waitUntil: 'domcontentloaded' });

    // Use agent() for multi-step plans, with a step cap.
    const agent = stagehand.agent();
    const stepT0 = Date.now();
    emit({ type: 'log', level: 'info', line: `executing agent goal: ${goal}` });

    // Stream per-step progress by tapping into the agent's events if available;
    // otherwise call execute() which returns the full result.
    const result = await agent.execute({ instruction: goal, maxSteps });
    const stepMs = Date.now() - stepT0;
    steps = (result?.actions?.length ?? result?.steps?.length ?? 0);

    emit({ type: 'step', n: steps, action: 'agent.execute', ok: result?.success !== false, durationMs: stepMs, result: result?.message ?? null });

    // Final metrics
    const m = await stagehand.metrics;
    const pricing = ANTHROPIC_PRICING[modelName] ?? PRICING_FALLBACK;
    const inputTokens = m?.totalPromptTokens ?? 0;
    const outputTokens = m?.totalCompletionTokens ?? 0;
    costUsd = ((inputTokens / 1e6) * pricing.in) + ((outputTokens / 1e6) * pricing.out);
    emit({ type: 'metrics', inputTokens, outputTokens, totalTokens: inputTokens + outputTokens, costUsd });
  } catch (err) {
    emit({ type: 'error', message: err?.message ?? String(err) });
  } finally {
    clearInterval(watchdog);
    try { await stagehand.close(); } catch { /* ignore close errors */ }
    emit({ type: 'done', totalMs: Date.now() - t0, steps, costUsd });
    // Give the SSE pipe a moment to flush before exit.
    await sleep(50);
    process.exit(aborted ? 4 : 0);
  }
}

main().catch((err) => {
  emit({ type: 'error', message: err?.message ?? String(err) });
  process.exit(1);
});
