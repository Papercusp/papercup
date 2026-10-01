/**
 * Jev on the memory push path (plan jev-decision-model-integration-2026-09-29,
 * P-007 Log only; P-008 On). The owner's switch lives in jev-settings.ts (D-008).
 *
 * Decision D-012 measured this filter with the memory text in `state` and did
 * NOT adopt it: about 1 in 10 answers flipped when the candidate order was
 * reversed. D-013 re-measured it with the memory text inside each question
 * (`instructions`) and it met the full D-007 bar: order flip 1.9%, 0 to 1 of 30
 * hard-negative queries admitting anything vs 8 of 30 for the floor alone, no
 * measurable recall loss. The mode stays the owner's choice (default Off). The
 * contract:
 *
 *  - effective `off` (mode off, OR no key stored) makes ZERO decision calls and
 *    returns before building anything, so the injection block is byte-identical
 *    to the pre-Jev system (D-009, pinned in jev-memory-gate.test.ts).
 *  - `shadow` (Log only) fires ONE request per turn and does not wait for it.
 *    Injection is never delayed or changed; the decision client's ledger hook
 *    records the call, including every P(yes), in decision_model_calls
 *    (consumer `memory-injection`). A would-drop is any P(yes) below the threshold.
 *  - `on` waits for the answer under the client's hard bound (400 ms) and returns
 *    which candidates to keep. Any inconclusive outcome (timeout, error, no key,
 *    malformed answer) fails OPEN: the caller keeps every candidate (D-002).
 *
 * Jev only filters; it never reorders and never authorizes anything (D-001).
 */
import { createHash } from 'node:crypto';

import type { Cache } from '@papercusp/cache';
import { JEV_PINNED_MODEL, type DecisionClient } from '@papercusp/decision-model';

import { getOperatorCache } from '../cache/instance';
import { activeWorkspaceId } from '../workspace-registry';
import { judgeAdmission, type AdmissionDecide, type AdmissionEncoding, type AdmissionVariant } from './jev-admission-request';
import { ensureJevDecisionClient, getJevMode, resolveJevMemoryInjection, type JevMemoryInjectionResolution } from './jev-settings';

/** The ledger consumer label for push-path calls (the bench uses `memory-bench`). */
export const JEV_MEMORY_CONSUMER = 'memory-injection';

/**
 * The operating point production runs: the production floor, then keep a candidate
 * when Jev's P(yes) >= 0.35, with the memory text inside each yes-no question.
 * D-013 (plan jev-decision-model-integration-2026-09-29) adopted v1 at 0.3; D-004
 * (plan jev-performance-improvements-2026-09-30) replaced it with v2-content at
 * 0.35, the threshold v2-content's own admission run selected. Changing any of
 * threshold, encoding or variant invalidates those measurements; re-run
 * bench/jev-admission-cli and bench/jev-robustness-cli before keeping a new one.
 */
export const JEV_MEMORY_ADMIT_THRESHOLD = 0.35;
export const JEV_MEMORY_ENCODING: AdmissionEncoding = 'instructions';
/**
 * The question variant production asks: v2-content, which judges the facts in the
 * memory rather than its claims about itself (D-004: self-promoting memories got
 * through 1.8% of the time against v1's 31.4%, with recall and cost unchanged).
 */
export const JEV_MEMORY_VARIANT: AdmissionVariant = 'v2-content';

/**
 * Ports where the owner's On does NOT wait for Jev: the gate runs Log only there
 * (WI-10004485). The mid-turn hook gives the whole recall 1,500 ms
 * (apps/operator/scripts/hooks/inject/ports.mjs) and live mid-turn recalls already
 * ran past that wall about a quarter of the time before any Jev wait; an awaited
 * call adds ~200 ms in series. Turn-start (2,500 ms) and initialize keep On.
 * Measured 2026-10-01 on live Log-only traffic: Jev's mid-turn drops were ~99%
 * correct, so this is a latency call, not a quality one; revisit once the
 * in-process timeouts (EI-24748208098755918) are fixed.
 */
export const JEV_MEMORY_NO_WAIT_PORTS: ReadonlySet<string> = new Set(['mid-turn']);

/**
 * How long a Jev answer is reused for an exact repeat (WI-10004485). Measured on
 * live Log-only traffic 2026-10-01 01:49-04:07Z: 13.7% of answered calls asked
 * about a (message, candidate set) Jev had already answered, and most repeats came
 * long after the first answer (118 of 1,097 within 10 minutes, 628 within an hour),
 * so a short TTL would catch almost none. The answer to a fixed message, memory
 * text, question wording and model does not change, so the bound is memory, not
 * staleness. The cache is the operator's per-process L1 (../cache/instance); with
 * the six :3070 workers serving requests at random it recovers an estimated 10% of
 * calls, against 13.7% for a shared cache. Only answered results are cached: a
 * timeout or error is asked again next time.
 */
export const JEV_MEMORY_CACHE_TTL_MS = 6 * 60 * 60 * 1000;

export interface JevGateCandidate {
  readonly id: string;
  readonly text: string;
}

/**
 * The cache key for one Jev question set: everything that determines the answer
 * (model pin, question variant, encoding, message, and each memory's id AND text)
 * and nothing else. Candidates are sorted by id, so the same set in a different
 * retrieval order is a hit; the reused scores are per memory, and D-013 measured
 * the instructions encoding's order sensitivity at 1.9%.
 */
export function jevMemoryCacheKey(message: string, candidates: readonly JevGateCandidate[]): string {
  const pairs = candidates.map((c) => [c.id, c.text] as const).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const digest = createHash('sha256')
    .update(JSON.stringify([JEV_PINNED_MODEL, JEV_MEMORY_VARIANT, JEV_MEMORY_ENCODING, message, pairs]))
    .digest('hex');
  return `jev-memory:${digest}`;
}

/** A cached answer: P(yes) per memory id, and the model that gave it. */
interface JevCachedAnswer {
  readonly scores: readonly (readonly [string, number])[];
  readonly model: string;
}

/** Thrown inside the cache factory so an inconclusive answer is never cached. */
class JevInconclusive extends Error {
  constructor(readonly reason: string) {
    super(reason);
  }
}

export type JevMemoryGateResult =
  /** No call was made. */
  | { readonly effective: 'off' }
  /**
   * Log only: nothing waits. `fired` is whether a request went out; a repeat the
   * cache already answered (`cached`) sends none.
   */
  | { readonly effective: 'shadow'; readonly fired: boolean; readonly cached?: true }
  /**
   * On, answered: `keep` is index-aligned with the candidates. `model` is the id
   * the provider says answered (not the pin we asked for), so a served-model
   * change is visible wherever the verdict is recorded (P-008). `cached` marks an
   * answer reused from an earlier identical call (no request, no wait).
   */
  | {
      readonly effective: 'on';
      readonly outcome: 'answered';
      readonly keep: readonly boolean[];
      readonly scores: readonly number[];
      readonly model: string;
      readonly cached?: true;
    }
  /** On, no verdict: the caller keeps every candidate (fail open). */
  | { readonly effective: 'on'; readonly outcome: 'inconclusive'; readonly reason: string };

export interface JevMemoryGateDeps {
  readonly resolve: (workspaceId: string) => Promise<Pick<JevMemoryInjectionResolution, 'effective'>>;
  readonly client: () => DecisionClient;
  /** Where repeat answers are reused ({@link JEV_MEMORY_CACHE_TTL_MS}). Absent: every call asks Jev. */
  readonly cache?: () => Cache;
}

const defaultDeps: JevMemoryGateDeps = {
  // Hot path: every injection passes here, so Off (the default) costs one cached
  // mode read and never touches the key store.
  resolve: async (workspaceId) => ((await getJevMode(workspaceId)) === 'off' ? { effective: 'off' } : resolveJevMemoryInjection(workspaceId)),
  client: ensureJevDecisionClient,
  cache: getOperatorCache,
};

export interface JevMemoryGateInput {
  readonly workspaceId?: string;
  /** The recall query the candidates were retrieved for (the recent user turn text). */
  readonly message: string;
  /** Floor-admitted candidates in retrieval order. */
  readonly candidates: readonly JevGateCandidate[];
  /**
   * Ledger consumer label. Defaults to {@link JEV_MEMORY_CONSUMER}; the weekly
   * precision monitor passes `memory-bench` so its replay calls are never
   * counted as live injection traffic in decision_model_calls.
   */
  readonly consumer?: string;
  /**
   * The injection port asking (`initialize` | `turn-start` | `mid-turn`, or absent
   * for a tool-call surface). On a {@link JEV_MEMORY_NO_WAIT_PORTS} port the
   * owner's On runs as Log only.
   */
  readonly port?: string;
}

export async function runJevMemoryGate(input: JevMemoryGateInput, deps: JevMemoryGateDeps = defaultDeps): Promise<JevMemoryGateResult> {
  let workspaceId: string;
  let effective: JevMemoryInjectionResolution['effective'];
  try {
    workspaceId = input.workspaceId ?? activeWorkspaceId();
    effective = (await deps.resolve(workspaceId)).effective;
  } catch {
    // An unreadable setting is not consent to call out: behave as Off.
    return { effective: 'off' };
  }
  if (effective === 'off') return { effective: 'off' };
  if (effective === 'on' && input.port !== undefined && JEV_MEMORY_NO_WAIT_PORTS.has(input.port)) effective = 'shadow';

  const candidates = input.candidates.filter((c) => c.text.trim().length > 0);
  if (candidates.length === 0 || !input.message.trim()) {
    return effective === 'shadow' ? { effective, fired: false } : { effective, outcome: 'inconclusive', reason: 'no-candidates' };
  }

  const consumer = input.consumer ?? JEV_MEMORY_CONSUMER;
  // Each request is ledgered against the memories it judges (all of them, or one under `pair`).
  const decide: AdmissionDecide = (request, call) =>
    deps.client().decide(request, { consumer, subjectIds: call.candidates.map((ci) => candidates[ci].id) });
  const ask = async (): Promise<JevCachedAnswer> => {
    const judgement = await judgeAdmission(input.message, candidates, JEV_MEMORY_ENCODING, JEV_MEMORY_VARIANT, decide);
    const p = judgement.result;
    if ('failure' in p) throw new JevInconclusive(p.failure);
    // Scores exist only when every request answered, so a model is always named; the fallback is for the type.
    return { scores: candidates.map((c, i) => [c.id, p.scores[i]] as const), model: judgement.model ?? 'unknown' };
  };
  // `cached` is set synchronously by the cache's outcome hook, before getOrSet's
  // first await, so the shadow path below can read it right after starting judge().
  // A caller that joins an in-flight identical call reports 'miss', not a hit.
  let cached = false;
  const cache = deps.cache?.();
  const judge = async (): Promise<JevCachedAnswer> =>
    cache
      ? cache.getOrSet(workspaceId, jevMemoryCacheKey(input.message, candidates), ask, {
          softTtlMs: JEV_MEMORY_CACHE_TTL_MS,
          hardTtlMs: JEV_MEMORY_CACHE_TTL_MS,
          onOutcome: (outcome) => {
            cached = outcome === 'hit';
          },
        })
      : ask();

  if (effective === 'shadow') {
    // Fire and forget. decide() never throws for expected failures; the catch is
    // for the unexpected (and for JevInconclusive), so a shadow fault can never
    // reach the turn. judge() is async, so even a synchronous fault inside it
    // arrives as a rejection here.
    void judge().catch(() => undefined);
    return cached ? { effective, fired: false, cached: true } : { effective, fired: true };
  }

  try {
    const answer = await judge();
    // `candidates` may be shorter than `input.candidates` (empty texts were never
    // asked about); map back so `keep` stays aligned with the caller's list.
    const byId = new Map(answer.scores);
    const scores = input.candidates.map((c) => byId.get(c.id) ?? 1);
    const keep = scores.map((s) => s >= JEV_MEMORY_ADMIT_THRESHOLD);
    return { effective, outcome: 'answered', scores, keep, model: answer.model, ...(cached ? { cached: true as const } : {}) };
  } catch (e) {
    if (e instanceof JevInconclusive) return { effective, outcome: 'inconclusive', reason: e.reason };
    return { effective, outcome: 'inconclusive', reason: `error: ${e instanceof Error ? e.message : String(e)}` };
  }
}
