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
 *   - replay: the governed replay battery (replay-adapter.ts) with an
 *     Anthropic continuation student and the house frozen judge
 *     (lib/llm-testing/llm-client — the gym's judge path). Double-gated at
 *     run time: the transfer action's own flag+governor AND the replay
 *     substrate's flag+budget (both P-001 arming acts).
 */
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { Sql } from 'postgres';
import { costFromTokens } from '@papercusp/model-pricing';
import type { JudgeLlmCall } from '@papercusp/eval-battery';
import { recordLearningSpend } from '../learning-governor/store';
import { getMemoryBackend } from '../memory/backend';
import { harnessDir } from '../harness-core';
import { loadHarnessRegistry } from '../harness-registry';
import { fsTranscriptSource } from '../replay/transcript';
import type { ReplayRunner } from '../replay/types';
import { transferReplayPort } from './replay-adapter';
import {
  admitTransferLesson,
  listLessonsForTesting,
  markTransferError,
  recordTransferOutcome,
  setLessonMemoryId,
} from './store';
import type { TransferStorePort, TransferTickDeps } from './tick';
import {
  TRANSFER_LOOP_ID,
  TRANSFER_ORIGIN,
  type LessonDistillerLlm,
  type TranscriptRefLister,
  type TransferReplayPort,
} from './types';

const DISTILL_MODEL = 'claude-haiku-4-5';
const DISTILL_TIMEOUT_MS = 60_000;
const STUDENT_MODEL = process.env.PAPERCUSP_TRANSFER_STUDENT_MODEL || 'claude-haiku-4-5';
const STUDENT_MAX_TOKENS = 2_048;
const STUDENT_TIMEOUT_MS = 120_000;

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
      default: new (o: { apiKey: string; timeout?: number; baseURL?: string }) => {
        messages: { create: (...args: unknown[]) => Promise<unknown> };
      };
    };
    // Route through the inference gateway when it's pointing us at the localhost pacing
    // pool (gateway sets PAPERCUSP_ANTHROPIC_URL / ANTHROPIC_BASE_URL) so this in-process
    // distiller load-balances across the account pool instead of egressing direct to one
    // account on its API key. Absent the env (gateway off) → unchanged direct egress.
    const baseURL = process.env.PAPERCUSP_ANTHROPIC_URL ?? process.env.ANTHROPIC_BASE_URL;
    const client = new mod.default({ apiKey, timeout: DISTILL_TIMEOUT_MS, ...(baseURL ? { baseURL } : {}) });
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

/** The Anthropic continuation student — lib/replay's ReplayRunner shape: the
 *  variant's system prompt (base + lesson overlay) over the rendered case
 *  context. No API key ⇒ throws (the cell records 'errored', never silent). */
export function anthropicStudentRunner(opts?: { apiKey?: string; model?: string }): ReplayRunner {
  const apiKey = opts?.apiKey ?? process.env.ANTHROPIC_API_KEY ?? '';
  const model = opts?.model ?? STUDENT_MODEL;
  return async ({ systemPrompt, contextText }) => {
    if (!apiKey) throw new Error('anthropicStudentRunner: no ANTHROPIC_API_KEY — student replay unavailable');
    const mod = (await import('@anthropic-ai/sdk')) as unknown as {
      default: new (o: { apiKey: string; timeout?: number; baseURL?: string }) => {
        messages: { create: (...args: unknown[]) => Promise<unknown> };
      };
    };
    // Route through the inference gateway when present (PAPERCUSP_ANTHROPIC_URL /
    // ANTHROPIC_BASE_URL) so the replay student is pool-paced, not direct on its API key.
    const baseURL = process.env.PAPERCUSP_ANTHROPIC_URL ?? process.env.ANTHROPIC_BASE_URL;
    const client = new mod.default({ apiKey, timeout: STUDENT_TIMEOUT_MS, ...(baseURL ? { baseURL } : {}) });
    const response = (await client.messages.create({
      model,
      max_tokens: STUDENT_MAX_TOKENS,
      system: systemPrompt,
      messages: [{ role: 'user', content: contextText }],
    })) as {
      content?: Array<{ type: string; text?: string }>;
      usage?: { input_tokens?: number; output_tokens?: number };
    };
    const outputText = (response.content ?? [])
      .filter((c) => c.type === 'text')
      .map((c) => c.text ?? '')
      .join('');
    const inputTokens = response.usage?.input_tokens ?? 0;
    const outputTokens = response.usage?.output_tokens ?? 0;
    return {
      outputText,
      costUsd: costFromTokens(model, { inputTokens, outputTokens }).usd,
      inputTokens,
      outputTokens,
      replayed: true,
    };
  };
}

/** The live student-transfer port: governed replay battery + house judge.
 *  Lazy judge import — the llm-client graph loads only when a test runs. */
export function liveTransferReplayPort(workspaceId: string): TransferReplayPort {
  return async (input) => {
    const { llmCall } = (await import('../llm-testing/llm-client')) as { llmCall: JudgeLlmCall };
    const port = transferReplayPort({ workspaceId, runner: anthropicStudentRunner(), llmCall });
    return port(input);
  };
}

/** store.ts bound to the live pool — the TransferStorePort the tick consumes. */
export function pgTransferStorePort(sql: Sql): TransferStorePort {
  return {
    admit: (input) => admitTransferLesson(sql, input),
    listForTesting: (q) => listLessonsForTesting(sql, q),
    recordOutcome: (q) => recordTransferOutcome(sql, q),
    markError: (q) => markTransferError(sql, q),
    setMemoryId: (q) => setLessonMemoryId(sql, q),
  };
}

/** The live tick deps. Memory degrades to null when the backend is
 *  unavailable (lessons still tracked in PG). */
export function defaultTransferTickDeps(sql: Sql, workspaceId: string): TransferTickDeps {
  return {
    store: pgTransferStorePort(sql),
    recordSpend: async ({ costUsd, note, runRef }) => {
      await recordLearningSpend(sql, {
        workspaceId,
        loopId: TRANSFER_LOOP_ID,
        costUsd,
        signalOrigin: TRANSFER_ORIGIN,
        runRef: runRef ?? null,
        note,
        accumulate: true,
      });
    },
    lister: fsTranscriptRefLister(workspaceId),
    source: fsTranscriptSource(),
    llm: anthropicDistillerLlm(),
    replay: liveTransferReplayPort(workspaceId),
    memory: getMemoryBackend(),
    log: (m) => console.log(`[transfer-distill] ${m}`),
  };
}
