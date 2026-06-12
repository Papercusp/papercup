/**
 * Live ports for the transfer tick (P-022 / FB-08) — the PG/fs/LLM glue
 * behind {@link TransferTickDeps}. Kept out of tick.ts so unit tests import
 * the pure flow without touching pools, the registry, or the Anthropic SDK.
 *
 *   - lister: fs scan of every registry project's `.papercusp/logs/*.jsonl`
 *     (the scanAgentRuns dir convention), mtime-windowed, newest first.
 *     PG-canonical runs write no jsonl (harness-agent-runs.ts note) — those
 *     arrive when lib/replay's TranscriptSource grows a PG leg (FB-06's
 *     port); this lister is deliberately the same corpus replay reads today.
 *   - llm: Anthropic haiku distiller (anthropic-judge.ts pattern: no API key
 *     ⇒ a no-op that distills nothing), cost priced from reported usage.
 *   - replay: NULL until `frontier:replay-landed` — tick.ts skips the testing
 *     leg with an honest count.
 */
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { Sql } from 'postgres';
import { costFromTokens } from '@papercusp/model-pricing';
import { getMemoryBackend } from '../memory/backend';
import { harnessDir } from '../harness-core';
import { loadHarnessRegistry } from '../harness-registry';
import { fsTranscriptSource } from '../replay/transcript';
import type { TransferTickDeps } from './tick';
import type { LessonDistillerLlm, TranscriptRefLister } from './types';

const DISTILL_MODEL = 'claude-haiku-4-5';
const DISTILL_TIMEOUT_MS = 60_000;

/** Recent `.papercusp/logs/*.jsonl` across every registry project. */
export function fsTranscriptRefLister(workspaceId?: string): TranscriptRefLister {
  return async ({ windowMs, cap }) => {
    const registry = await loadHarnessRegistry(workspaceId);
    const cutoff = Date.now() - windowMs;
    const hits: Array<{ ref: string; mtimeMs: number }> = [];
    for (const project of registry.projects) {
      const logDir = join(harnessDir(project), 'logs');
      let files: string[];
      try {
        files = readdirSync(logDir);
      } catch {
        continue; // no logs dir for this project
      }
      for (const f of files) {
        if (!f.endsWith('.jsonl')) continue;
        const ref = join(logDir, f);
        try {
          const { mtimeMs } = statSync(ref);
          if (mtimeMs >= cutoff) hits.push({ ref, mtimeMs });
        } catch {
          /* raced a deletion — skip */
        }
      }
    }
    hits.sort((a, b) => b.mtimeMs - a.mtimeMs);
    return hits.slice(0, cap).map((h) => h.ref);
  };
}

/** Anthropic-backed distiller. No API key ⇒ distills nothing at zero cost
 *  (the action's flag + governor gates are the real guards). */
export function anthropicDistillerLlm(opts?: { apiKey?: string; model?: string }): LessonDistillerLlm {
  const apiKey = opts?.apiKey ?? process.env.ANTHROPIC_API_KEY ?? '';
  const model = opts?.model ?? DISTILL_MODEL;
  if (!apiKey) return async () => ({ text: '[]', costUsd: 0 });

  return async ({ system, user, maxTokens }) => {
    const mod = (await import('@anthropic-ai/sdk')) as unknown as {
      default: new (o: { apiKey: string; timeout?: number }) => {
        messages: { create: (...args: unknown[]) => Promise<unknown> };
      };
    };
    const client = new mod.default({ apiKey, timeout: DISTILL_TIMEOUT_MS });
    const response = (await client.messages.create({
      model,
      max_tokens: maxTokens,
      system,
      messages: [{ role: 'user', content: user }],
    })) as {
      content?: Array<{ type: string; text?: string }>;
      usage?: { input_tokens?: number; output_tokens?: number };
    };
    const text = (response.content ?? [])
      .filter((c) => c.type === 'text')
      .map((c) => c.text ?? '')
      .join('');
    const costUsd = costFromTokens(model, {
      inputTokens: response.usage?.input_tokens ?? 0,
      outputTokens: response.usage?.output_tokens ?? 0,
    }).usd;
    return { text, costUsd };
  };
}

/** The live tick deps. `replay` stays null until the replay battery is wired
 *  (frontier:replay-landed); memory degrades to null when the backend is
 *  unavailable (lessons still tracked in PG). */
export function defaultTransferTickDeps(sql: Sql, workspaceId?: string): TransferTickDeps {
  return {
    sql,
    lister: fsTranscriptRefLister(workspaceId),
    source: fsTranscriptSource(),
    llm: anthropicDistillerLlm(),
    replay: null,
    memory: getMemoryBackend(),
    log: (m) => console.log(`[transfer-distill] ${m}`),
  };
}
