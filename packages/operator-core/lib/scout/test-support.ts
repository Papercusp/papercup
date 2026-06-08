/**
 * Scout loop — shared TEST HARNESS (hive-creative-ideation-2026-06-08).
 *
 * Owned by the verification lane (su-b6c3f, plan items P-009 + P-014). Every
 * Scout step (ideators / critics / recombine / loop) is built to take an
 * injected {@link ScoutLlmCall} (the gym `JudgeLlmCall` pattern) so it is
 * unit-tested with a FAKE call — no network, deterministic, zero LLM spend.
 * This module provides that fake plus grounded corpus fixtures, so the step
 * builders AND the P-009 invariants suite + P-014 E2E share one harness instead
 * of each re-rolling fakes.
 *
 * SCOPE DISCIPLINE: this file imports ONLY the *stable* contract from
 * `./types` (`CorpusDigest` / `MetaPattern` / `Idea` / `CreativeLens` /
 * `ScoutLlmCall`). It deliberately does NOT bake in `Critique` / `Proposal`
 * fixtures yet — those types are still being added by P-005/P-006 (su-d1170);
 * fixtures for them land here once their shape is settled, so this harness can
 * never drift ahead of the contract.
 *
 * Mirrors the convention of `coord-ops/test-support.ts` (a `*-support.ts`
 * helper, not a `*.test.ts`).
 */
import type {
  CorpusDigest,
  CreativeLens,
  Idea,
  MetaPattern,
  ScoutLlmCall,
} from './types';
import { CREATIVE_LENSES } from './types';

/* ────────────────────────────────────────────────────────────────────────
 * Fake ScoutLlmCall
 * ──────────────────────────────────────────────────────────────────────── */

/** The exact options bag a {@link ScoutLlmCall} is invoked with. */
export type ScoutLlmCallOpts = Parameters<ScoutLlmCall>[0];

/** The exact result a {@link ScoutLlmCall} resolves to. */
export type ScoutLlmCallResult = Awaited<ReturnType<ScoutLlmCall>>;

/**
 * A responder decides what a fake call returns for a given invocation. Return
 * `undefined` to "not match" (fall through to the next responder / the
 * default). Token + cost accounting is filled in automatically if omitted, so
 * a responder usually returns just `{ text }` or `{ json }`.
 */
export type ScoutLlmResponder = (
  opts: ScoutLlmCallOpts,
  index: number,
) =>
  | { text?: string; json?: unknown; costUsd?: number; inputTokens?: number; outputTokens?: number }
  | undefined;

export interface MakeFakeScoutLlmOptions {
  /**
   * Ordered responders consulted (in order) on EACH call. The first that
   * returns a non-undefined value wins. Use for scripting a specific sequence
   * (e.g. ideator → critic → recombine) or matching on prompt content.
   */
  responders?: ScoutLlmResponder[];
  /**
   * Fallback when no responder matches. Defaults to {@link defaultJsonResponder}
   * for `responseFormat: 'json'` and an echo for text — so a step under test
   * always gets a well-formed structured reply without bespoke scripting.
   */
  fallback?: ScoutLlmResponder;
  /** Per-call synthetic cost (USD), default 0. */
  costUsd?: number;
}

/** A recorded invocation, for assertions (e.g. "no step called the model with a human-authored prompt"). */
export interface RecordedScoutCall {
  opts: ScoutLlmCallOpts;
  result: ScoutLlmCallResult;
}

export interface FakeScoutLlm {
  /** The injectable call — satisfies {@link ScoutLlmCall}. */
  readonly call: ScoutLlmCall;
  /** Every invocation, in order. */
  readonly calls: RecordedScoutCall[];
  /** Convenience: number of invocations. */
  count(): number;
}

/**
 * The default fallback: for `responseFormat: 'json'` return a minimal valid
 * envelope `{ items: [] }` (a step's parser should treat this as "no output"
 * gracefully); for text, echo the last user message. Steps under test that
 * need real content should pass their own `responders`.
 */
export const defaultJsonResponder: ScoutLlmResponder = (opts) => {
  if (opts.responseFormat === 'json') return { json: { items: [] }, text: '{"items":[]}' };
  const lastUser = [...opts.messages].reverse().find((m) => m.role === 'user');
  return { text: lastUser?.content ?? '' };
};

/**
 * Build a fake {@link ScoutLlmCall}. Deterministic, no network. Records every
 * call. Token counts are derived from string lengths so cost-accounting code
 * paths still exercise non-zero token math while spending $0.
 */
export function makeFakeScoutLlm(options: MakeFakeScoutLlmOptions = {}): FakeScoutLlm {
  const responders = options.responders ?? [];
  const fallback = options.fallback ?? defaultJsonResponder;
  const perCallCost = options.costUsd ?? 0;
  const calls: RecordedScoutCall[] = [];

  const call: ScoutLlmCall = async (opts) => {
    const index = calls.length;
    let picked: ReturnType<ScoutLlmResponder> | undefined;
    for (const r of responders) {
      picked = r(opts, index);
      if (picked !== undefined) break;
    }
    if (picked === undefined) picked = fallback(opts, index);
    const partial = picked ?? {};
    const text = partial.text ?? (partial.json !== undefined ? JSON.stringify(partial.json) : '');
    const inputTokens =
      partial.inputTokens ??
      Math.ceil(
        (opts.system?.length ?? 0) / 4 +
          opts.messages.reduce((n, m) => n + m.content.length, 0) / 4,
      );
    const outputTokens = partial.outputTokens ?? Math.ceil(text.length / 4);
    const result: ScoutLlmCallResult = {
      text,
      json: partial.json,
      costUsd: partial.costUsd ?? perCallCost,
      inputTokens,
      outputTokens,
    };
    calls.push({ opts, result });
    return result;
  };

  return {
    call,
    calls,
    count: () => calls.length,
  };
}

/**
 * Responder factory: when a call is JSON-mode, return `producer(opts)` as the
 * parsed `json`. Convenience for scripting a step's structured output without
 * hand-stringifying.
 */
export function jsonResponder(producer: (opts: ScoutLlmCallOpts, index: number) => unknown): ScoutLlmResponder {
  return (opts, index) => {
    if (opts.responseFormat !== 'json') return undefined;
    const json = producer(opts, index);
    return { json, text: JSON.stringify(json) };
  };
}

/* ────────────────────────────────────────────────────────────────────────
 * Grounded corpus fixtures
 * ──────────────────────────────────────────────────────────────────────── */

/**
 * Stable set of corpus-digest pattern refs used across fixtures. An idea is
 * "grounded" iff its `addressesPatternRefs` are a subset of these; the
 * grounding/dedup invariants (P-009) assert against this set.
 */
export const FIXTURE_PATTERN_REFS = [
  'wi:F-101',
  'wi:F-102',
  'plan:flaky-coord-tests-2026-05-30',
  'gym:cand-77',
  'plan:lock-contention-2026-06-01',
] as const;

/** One MetaPattern fixture with a known `ref`. */
export function fixtureMetaPattern(over: Partial<MetaPattern> = {}): MetaPattern {
  return {
    category: 'recurring-friction',
    summary: 'agents repeatedly hand-retry a lock-blocked edit instead of re-queuing',
    detail: 'seen across 9 sessions; ~3% of edit attempts',
    ref: FIXTURE_PATTERN_REFS[4],
    weight: 0.7,
    ...over,
  };
}

/**
 * A grounded "state of the Hive" digest fixture with real-looking meta-patterns
 * across all four lanes, each carrying a `ref` from {@link FIXTURE_PATTERN_REFS}.
 * The ideators read this; their leaps must reference these refs to be grounded.
 */
export function fixtureCorpusDigest(over: Partial<CorpusDigest> = {}): CorpusDigest {
  return {
    headline: 'state of the Hive: lock contention + flaky coord tests dominate friction',
    generatedAt: '2026-06-08T00:00:00.000Z',
    recurringFriction: [
      fixtureMetaPattern({
        category: 'recurring-friction',
        summary: 'lock-blocked edits hand-retried instead of re-queued',
        ref: 'plan:lock-contention-2026-06-01',
        weight: 0.8,
      }),
      fixtureMetaPattern({
        category: 'recurring-friction',
        summary: 'coord-scoped tests flake under parallel load',
        ref: 'plan:flaky-coord-tests-2026-05-30',
        weight: 0.6,
      }),
    ],
    timeTokenSinks: [
      fixtureMetaPattern({
        category: 'time-token-sink',
        summary: 'agents re-read the full docs outline (316KB) every session',
        ref: 'wi:F-101',
        weight: 0.5,
      }),
    ],
    chronicDeferrals: [
      fixtureMetaPattern({
        category: 'chronic-deferral',
        summary: 'gym→Scout wire repeatedly deferred across plans',
        ref: 'wi:F-102',
        weight: 0.4,
      }),
    ],
    capabilityGaps: [
      fixtureMetaPattern({
        category: 'capability-gap',
        summary: 'no idle-capacity trigger primitive for autonomous loops',
        ref: 'gym:cand-77',
        weight: 0.65,
      }),
    ],
    ...over,
  };
}

/** All refs present in a digest (flattened across the four lanes). */
export function digestRefs(digest: CorpusDigest): string[] {
  return [
    ...digest.recurringFriction,
    ...digest.timeTokenSinks,
    ...digest.chronicDeferrals,
    ...digest.capabilityGaps,
  ].map((p) => p.ref);
}

/** A single Idea fixture (grounded by default). */
export function fixtureIdea(over: Partial<Idea> = {}): Idea {
  const lens: CreativeLens = over.lens ?? 'analogical';
  return {
    id: `idea-${lens}-1`,
    lens,
    title: 'borrow the immune system’s "tolerance" model for lock contention',
    body: 'treat a blocked edit like a self-antigen: tolerate (re-queue) rather than attack (retry).',
    mechanism: 'on lock-block, register a wake on grant + yield the turn (events:await), never spin.',
    seedDomain: lens === 'analogical' ? 'immune-systems' : undefined,
    addressesPatternRefs: ['plan:lock-contention-2026-06-01'],
    ...over,
  };
}

/** One grounded Idea per lens (the default ideator roster output). */
export function fixtureIdeasAllLenses(): Idea[] {
  return CREATIVE_LENSES.map((lens, i) =>
    fixtureIdea({
      id: `idea-${lens}-${i + 1}`,
      lens,
      title: `idea via ${lens}`,
      addressesPatternRefs: [FIXTURE_PATTERN_REFS[i % FIXTURE_PATTERN_REFS.length]],
      seedDomain: lens === 'analogical' ? 'immune-systems' : undefined,
    }),
  );
}
