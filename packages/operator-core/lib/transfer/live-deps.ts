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

/** P-010 (blender-loop-repair-and-opus5-xhigh-2026-08-16): distiller + transferability
 *  judge run on opus-5 at max effort [owner 2026-08-16]. `max` is the current
 *  Anthropic API vocabulary for the highest effort; the former `xhigh` value is
 *  rejected by claude-opus-5. Thinking is ON by default
 *  on opus-5 and shares max_tokens with the response text, so callers' maxTokens carry
 *  thinking headroom (see TRANSFERABILITY_MAX_TOKENS / DISTILL_MAX_TOKENS) and the
 *  timeout allows for max-depth thinking. */
const DISTILL_MODEL = 'claude-opus-5';
const DISTILL_EFFORT = 'max';
const DISTILL_TIMEOUT_MS = 180_000;
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

/** The unkeyed-and-gatewayless no-op sentinel. Exported so judge-side callers
 *  (candidate-review) can NAME this condition in their error reason instead of
 *  reporting a bare "no usable verdict" — that anonymity is how the
 *  transferability judge sat dead for 28 days (EI-20597533361555377). */
export const DISTILLER_NOOP_SENTINEL = '[]';

/** Anthropic-backed distiller. Resolution order (P-001
 *  blender-loop-repair-and-opus5-xhigh-2026-08-16 — the old order no-op'd
 *  BEFORE considering the gateway, silently killing the transferability judge
 *  in every process whose env carries no key, i.e. all of them here):
 *    1. an explicit/env API key → real call (direct, or via gateway baseURL);
 *    2. no key but the inference gateway is reachable (env URL or flag) →
 *       real call THROUGH the gateway with the placeholder bearer — the
 *       gateway strips + reinjects the routed account's real OAuth, same as
 *       every claude-CLI spawn (spawn-env.ts GATEWAY_CLIENT_AUTH_TOKEN);
 *    3. neither → distills nothing at zero cost (the action's flag + governor
 *       gates are the real guards) — returns DISTILLER_NOOP_SENTINEL. */
export function anthropicDistillerLlm(opts?: { apiKey?: string; model?: string }): LessonDistillerLlm {
  const apiKey = opts?.apiKey ?? process.env.ANTHROPIC_API_KEY ?? '';
  const model = opts?.model ?? DISTILL_MODEL;

  return async ({ system, user, maxTokens }) => {
    // Route through the inference gateway when it's pointing us at the localhost pacing
    // pool (gateway sets PAPERCUSP_ANTHROPIC_URL / ANTHROPIC_BASE_URL) so this in-process
    // distiller load-balances across the account pool instead of egressing direct to one
    // account on its API key. Absent the env (gateway off) → direct egress on the key.
    let baseURL = process.env.PAPERCUSP_ANTHROPIC_URL ?? process.env.ANTHROPIC_BASE_URL;
    // su-5e6cc (2026-06-30): SELF-ROUTE through the gateway when the INFERENCE_GATEWAY flag
    // is on, instead of only inheriting the env another in-process caller set — so the
    // distiller routes through the Anthropic pool even outside bg-host. Best-effort.
    if (!baseURL) {
      try {
        const { getFlag } = await import('@papercusp/flags/server');
        const { FLAGS } = await import('@papercusp/flags');
        if (await getFlag(FLAGS.INFERENCE_GATEWAY, 'system')) {
          const { gatewayLlmEnv } = await import('../inference-gateway/spawn-env');
          baseURL = gatewayLlmEnv(true).PAPERCUSP_ANTHROPIC_URL;
        }
      } catch {
        /* best-effort — gateway resolution must never break the distiller */
      }
    }
    if (!apiKey && !baseURL) return { text: DISTILLER_NOOP_SENTINEL, costUsd: 0 };
    const mod = (await import('@anthropic-ai/sdk')) as unknown as {
      default: new (o: {
        apiKey?: string;
        authToken?: string;
        timeout?: number;
        baseURL?: string;
      }) => {
        messages: { create: (...args: unknown[]) => Promise<unknown> };
      };
    };
    // Unkeyed-through-gateway: present the same placeholder bearer the claude CLI
    // spawns use — the gateway replaces inbound auth with the routed account's real
    // OAuth, so the placeholder's only job is to make the SDK send at all.
    const auth = apiKey
      ? { apiKey }
      : { authToken: (await import('../inference-gateway/spawn-env')).GATEWAY_CLIENT_AUTH_TOKEN };
    const client = new mod.default({ ...auth, timeout: DISTILL_TIMEOUT_MS, ...(baseURL ? { baseURL } : {}) });
    const response = (await client.messages.create({
      model,
      max_tokens: maxTokens,
      output_config: { effort: DISTILL_EFFORT },
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
