/**
 * Delta replay/eval harness — the measurement instrument Lane A owes Phase 4+
 * (agent-tool-delta-protocol-2026-06-22, P-003; gates the exemplar P-014 and the
 * rollout/flag-flip P-016).
 *
 * WHY THIS EXISTS. `harness_shared.tool_invocations` stores arg SHAPE (≤32KB) +
 * result SIZE only — NEVER result bodies (`dispatch-stack.ts`). So a replay that
 * wants to know "what would a delta have cost, and would the merge be correct?"
 * cannot read historical bodies back; it must RE-EXECUTE the tool to obtain real
 * `next`/`base` snapshots, then run them through this engine. This module is the
 * pure, deterministic core of that loop:
 *
 *   1. `computeListDelta(base, next)` — a provably-correct, agent-facing list
 *      delta (D-003 semantic shape) over canonical state, NOT a server-side
 *      projection diff. (`projection-index`'s `computeDelta` is the store's
 *      internal put/delete index maintenance keyed by `sourceId|key|entryId`;
 *      D-002 is explicit that it is "not a consumer cursor" — so this is a new,
 *      justified surface, not a fork of it.)
 *   2. `applyListDelta(base, delta)` — the MERGE. `apply(base, compute(base,next))`
 *      deep-equals `next` for every transition (add / update / remove / reorder /
 *      identical). This round-trip IS the de-risk oracle the owner BUILD decision
 *      (D-007/D-008) rests on: a "silently wrong merge" becomes a failing assert.
 *   3. `evalSnapshotTransition(base, next)` — token-measures the four modes a real
 *      BPE tokenizer (`o200k_base`, the `result-format-benchmark` proxy) sees:
 *      full-JSON / full-TOON-compact / `not_modified` / semantic-delta — and
 *      reports the winner + the merge-correctness verdict.
 *
 * Reuses, never reinvents: `@papercusp/result-encoding` (`encode`/TOON), Lane B's
 * `@papercusp/tooldef` delta-protocol (`encodeDeltaCursor`, the small-response
 * bypass threshold), and `js-tiktoken`. Pure + side-effect-free → unit tier; the
 * real-tool re-execution that feeds it lives in the integration test alongside.
 */
/** Token count of a string under the frontier-proxy tokenizer. Async: the tokenizer is lazy-loaded (see above). */
export declare function tokens(s: string): Promise<number>;
export type Row = Record<string, unknown>;
export interface DeltaEvalOpts {
    /** Stable identity field on each row. Default `'id'`; `plans:list` rows use `'slug'`. */
    itemKey?: string;
}
/** Why a transition degrades to a full re-send instead of a delta (telemetry + the harness signal). */
export type FullReason = 'base_absent' | 'no_item_key' | 'duplicate_key';
/**
 * The agent-facing read-delta. Correctness-complete by construction: `put` carries
 * the full body of every added/updated row, `remove` the dropped ids, and `order`
 * the EXACT id sequence of `next` — so `applyListDelta` reconstructs `next` byte-for
 * -byte regardless of reorder/insert complexity (cheap: `order` is ids only, the
 * expensive bodies ride only on changed rows). `put` with id∈base ⇒ "updated";
 * id∉base ⇒ "added" (the D-003 `change` discriminator is derivable, kept off the
 * wire to save tokens).
 */
export type ListDelta = {
    mode: 'not_modified';
    counts: {
        total: number;
    };
} | {
    mode: 'full';
    reason: FullReason;
} | {
    mode: 'delta';
    put: Array<{
        id: string;
        data: Row;
    }>;
    remove: string[];
    order: string[];
    counts: {
        added: number;
        updated: number;
        removed: number;
        total: number;
    };
    /** Hash of `next` — the client verifies its merged result against this (D-002). */
    checksum: string;
};
/** Deterministic FNV-1a over the canonical JSON of `next` — the merge-verification checksum. */
export declare function checksumRows(rows: Row[], itemKey: string): string;
/**
 * Compute the semantic list delta from `base` → `next`. `base === null` means the
 * model/client has NO base in context (post-compaction / fresh turn) → `full`
 * (D-004/D-006: a delta against an absent base is unmergeable). Returns `full`
 * with a reason for any condition that makes a safe delta impossible (missing or
 * duplicate identity keys — D-002: "must not claim safe removed deltas" without
 * stable identity).
 */
export declare function computeListDelta(base: Row[] | null, next: Row[], opts?: DeltaEvalOpts): ListDelta;
/**
 * Apply a delta to a base, reconstructing `next` EXACTLY. The merge-correctness
 * oracle: `applyListDelta(base, computeListDelta(base, next))` deep-equals `next`.
 * Throws on a `full` delta (nothing to merge — the caller must use the full body)
 * or on an inconsistent delta (an `order` id with no source row).
 */
export declare function applyListDelta(base: Row[], delta: ListDelta, opts?: DeltaEvalOpts): Row[];
export interface ModeTokens {
    /** Full body as compact JSON. */
    fullJson: number;
    /** Full body as TOON-compact (the current default for array results). */
    fullToon: number;
    /** `not_modified` — counts + cursor only, body suppressed. Present only when the view is unchanged. */
    notModified: number | null;
    /** Semantic delta — changed bodies + id order + cursor. Present only when a delta is possible. */
    delta: number | null;
}
export interface SnapshotEval {
    mode: ListDelta['mode'];
    reason?: FullReason;
    tokens: ModeTokens;
    /** Smallest applicable mode. */
    winner: 'not_modified' | 'delta' | 'full_toon' | 'full_json';
    /**
     * delta/not_modified tokens as a % saving vs the BEST full encoding
     * (`min(fullJson, fullToon)`) — the honest baseline, since TOON-compact is not
     * universally smaller than JSON (it loses on nested-object row shapes like
     * `plans:list`, where the delta/not_modified path is the only real win).
     */
    savedVsFullPct: number | null;
    /** The merge round-trips: applyListDelta(base, delta) deep-equals next. `null` when mode==='full'. */
    correct: boolean | null;
}
/**
 * Evaluate one snapshot transition `base → next`: token-cost every applicable mode,
 * pick the winner, and verify the delta merge. `base === null` models a missing
 * base (post-compaction) → the only correct answer is a full re-send.
 */
export declare function evalSnapshotTransition(base: Row[] | null, next: Row[], opts?: DeltaEvalOpts): Promise<SnapshotEval>;
