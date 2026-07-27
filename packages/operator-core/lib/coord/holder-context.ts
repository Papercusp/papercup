/**
 * holder-context.ts — P-026's SHARED `HolderContext` PROJECTION: the ONE resolver
 * every friction-point enrichment in D-055 consumes, so that eight injection
 * points do not invent eight shapes.
 *
 * Plan: unified-agent-state-plane-2026-07-27, P-026. Scoping ruling: **D-083**.
 *
 * THE QUESTION IT ANSWERS. A reader who is BLOCKED BY a specific holder (a lock
 * they cannot take, an item they cannot claim, a release they are waiting on)
 * wants two things about that holder: what are they trying to DO, and what are
 * they ASSUMING while they do it. Every D-055 Tier-A surface asks the same two
 * questions, so they resolve them here once rather than each reaching for its own
 * columns.
 *
 * ⚠ BUILT BEFORE ANY CONSUMER, ON PURPOSE (the item's own ordering rule). With
 * the shape fixed first, each injection point is a few lines; with the first
 * consumer shipping first, the other seven inherit its accidents.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * RULE (a) — ONE derivation, and why it is NOT `getCell` here.
 *
 * The item says the resolver "resolves through `getCell(cell, reader)`". Measured
 * against the registry before building (D-083 §2): **no goal cell and no
 * assumption cell exist** — only five infrastructure cells are registered, and
 * their producers (P-016 goal-as-ref, P-009 assumption stamping, P-011
 * conflicting-assumption cells) are all still `todo`. Building against a cell
 * that does not exist would satisfy the sentence and derive NOTHING — the exact
 * failure this plan has now hit three times (D-082, and the `currentFiles`
 * near-miss before it).
 *
 * So D-083 (i) rules: honour the rule's INTENT — one audience oracle, no consumer
 * re-implementing the check — via the boundary each source's data actually has:
 *   · the goal → `plan_item_claims.intent`, whose audience boundary is the claim
 *     read itself (it is already disclosed unconditionally to anyone who collides
 *     with the claim — see `plan-items/claim-holder.ts`);
 *   · assumptions → `agent_facts`' own `audience_scope`, applied IN SQL by
 *     `foldFacts` (the store's conservative default folds only unrestricted
 *     facts, so a reader whose audience context is unknown receives none).
 * When P-016/P-009 land their cells they swap in behind {@link HolderContextSources}
 * with NO consumer change — which is precisely the "build it before any consumer"
 * rationale. A cell read added here MUST use `getCell(cell, reader)` /
 * `listCells(reader)` and NEVER the `*Unchecked` accessors (D-042 / D-078 (c),
 * mechanically gated by `cell-access-parity.test.ts`).
 *
 * ⚠ RULE (b) — UNREADABLE == ABSENT, never a partial. A reader who may not see a
 * holder's assumptions gets `{ count: 0, keys: [] }` — the SAME answer as a holder
 * who has none, and never a locally-assembled approximation of the ones they may
 * not see. That indistinguishability is deliberate (it is why the item notes a
 * refusal is not a probe oracle): a reader must not be able to infer the EXISTENCE
 * of state it may not read by observing a refusal that looks different from empty.
 *
 * ⚠ RULE (e) — `stale` IS THE GOAL'S AGE, AND THAT DIFFERS FROM `ClaimHolder.stale`.
 * Read this before assuming the two are the same number:
 *   · `ClaimHolder.stale` (claim-holder.ts) is derived from `last_activity_ts` —
 *     "is this AGENT still moving?"
 *   · `HolderContext.stale` is derived from `declaredAt` — "is this GOAL still
 *     current, or is it a declaration from three hours ago?"
 * Both are correct for their question, and rule (e) binds this one to `declaredAt`
 * because an undated goal is exactly how a stale value reads as current — the
 * defect P-017 (c)'s detector exists to catch, which shipping this without it
 * would reintroduce one layer up. An agent can be busily active (fresh
 * `ClaimHolder.stale`) on a goal it declared long ago and never updated, and a
 * blocked peer needs to see THAT. Both reuse the ONE `computeIntentStale` /
 * `INTENT_STALE_SEC` derivation — no second staleness rule.
 *
 * ⚠ RULE (f) — PURE AND TOTAL. Every consumer is on a hot path (a lock acquire, a
 * claim, a presence read), so an enrichment must never be able to fail the
 * operation it decorates: the core takes plain data and cannot throw, every IO leg
 * is injected and fail-soft, and a dead source degrades ONE field rather than
 * taking down the read that called it.
 */
import type { CellReader } from '../cell-registry';
import { computeIntentStale, INTENT_STALE_SEC } from '../agent-tools/coordination/presence-tier1';
import { declaredGoalOf } from '../plan-items/claim-holder';

/**
 * How many assumption KEYS are named before the projection relies on `count`
 * alone. Rule (d): assumptions render as a count plus an expansion, never inline
 * prose — an unbounded set per holder is a payload defect, measured: `coord:presence`
 * is already 28KB p50 / 66KB p90 against a 6000-token inline budget.
 */
export const HOLDER_ASSUMPTION_KEY_CAP = 12;

/**
 * What a holder is doing and assuming, as EVERY D-055 enrichment point renders it.
 *
 * ⚠ THE SHAPE IS FIXED BY D-055 AND RESTATED BY D-083 (iv) — these five fields,
 * no more. `holder-context.test.ts` gates it, because "one shape for eight
 * consumers" is the entire reason this module exists and a field added for one
 * consumer's convenience is how that erodes.
 */
export interface HolderContext {
  /** The work-item / plan-item / cell ref the goal is ABOUT. Never a raw bigint
   *  (rule c, D-046: a bigint is not a read surface). */
  goalRef: string | null;
  /** The holder's DECLARED goal, or null — an honest unknown, never a fabricated
   *  goal and never a mechanism string dressed up as one (see {@link declaredGoalOf}). */
  goalText: string | null;
  /** Count plus a bounded key expansion — never the assumption BODIES (rule d). */
  assumptions: { count: number; keys: string[] };
  /** When the goal was declared. The input `stale` is derived from. */
  declaredAt: string | null;
  /** Goal older than INTENT_STALE_SEC. null ⇒ undated, so staleness is UNKNOWN —
   *  never `false`, which would read as "freshly declared". */
  stale: boolean | null;
}

/** The goal facts this projection reads — structural, so any producer (today a
 *  `plan_item_claims` row, tomorrow a P-016 goal cell) satisfies it without either
 *  side importing the other. */
export interface HolderGoalRecord {
  /** The claimed item id — becomes {@link HolderContext.goalRef}. */
  itemId: string;
  /** Raw claim intent. Split by {@link declaredGoalOf}, never echoed verbatim. */
  intent?: string | null;
  /** When the claim, and so the goal, was declared. */
  acquiredTs?: string | null;
}

/**
 * The bounded, reader-scoped reads this projection needs. Each is OPTIONAL: an
 * unavailable source degrades that one field, never the whole derivation — and an
 * OMITTED source yields nothing rather than an approximation (rule b).
 */
export interface HolderContextSources {
  /** The holder's current goal record, or null when they have declared none. */
  holderGoal?: (holderOwnerId: string) => Promise<HolderGoalRecord | null>;
  /**
   * The assumption KEYS this READER may see for this holder. Reader-relative by
   * construction: the implementation applies the audience boundary in SQL, and
   * returns only what survives it. It must NEVER return keys the reader may not
   * see for the caller to filter afterwards — that is the partial rule (b) forbids.
   */
  holderAssumptionKeys?: (holderOwnerId: string, reader: CellReader) => Promise<readonly string[]>;
}

/** A bigint id masquerading as a ref. Rejected by rule (c) / D-046: a bigint is
 *  not a read surface — a reader handed `184073` can do nothing with it, whereas
 *  `WI-6389` / `P-026` resolve. */
const BARE_BIGINT = /^\d+$/;

/**
 * Guard {@link HolderContext.goalRef}. Returns null for a blank or bigint-shaped
 * id rather than passing it through: the ref is the field a reader is meant to
 * ACT on, so an unusable one must read as absent, not as present-and-broken.
 */
export function asGoalRef(itemId: string | null | undefined): string | null {
  const s = (itemId ?? '').trim();
  if (!s || BARE_BIGINT.test(s)) return null;
  return s;
}

function cleanKey(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

/** Seconds since a timestamp; null when absent or unparseable (⇒ `stale` unknown,
 *  not `false` — an unreadable stamp must never read as "freshly declared"). */
function secAgo(ts: string | null | undefined, nowMs: number): number | null {
  if (!ts) return null;
  const t = Date.parse(ts);
  if (Number.isNaN(t)) return null;
  return Math.max(0, Math.round((nowMs - t) / 1000));
}

/**
 * THE PURE CORE: a goal record + the assumption keys this reader may see → the
 * one projection.
 *
 * Returns **null when there is nothing disclosable** — no resolvable goal and no
 * visible assumptions. A consumer then omits the field entirely rather than
 * padding its payload with an all-null object, and (per rule b) that null is
 * deliberately the same answer a reader gets for a holder whose state it may not
 * read: absent and unreadable are indistinguishable by design.
 *
 * TOTAL by construction (rule f): no throw, no I/O, and every malformed input —
 * a null record, a bigint id, an unparseable timestamp, a non-string key —
 * degrades one field instead of failing.
 */
export function projectHolderContext(
  goal: HolderGoalRecord | null | undefined,
  assumptionKeys: readonly string[] = [],
  nowMs: number = Date.now(),
): HolderContext | null {
  const rawItemId = cleanKey(goal?.itemId);
  const goalRef = asGoalRef(rawItemId);

  // `declaredGoalOf` needs the RAW id (it detects the auto-convert mechanism
  // string, which embeds it) even when that id is unusable as a ref.
  const { goalText } = rawItemId
    ? declaredGoalOf(goal?.intent, rawItemId)
    : { goalText: null as string | null };

  const keys = [...new Set(assumptionKeys.map(cleanKey).filter(Boolean))].sort();
  // `count` is the TRUE total; `keys` is the bounded expansion. That split is the
  // whole point of rule (d) — a reader learns "11 assumptions" even when only the
  // first few are named, so the cap never silently understates the holder's state.
  const assumptions = { count: keys.length, keys: keys.slice(0, HOLDER_ASSUMPTION_KEY_CAP) };

  if (!goalRef && !goalText && assumptions.count === 0) return null;

  const declaredAt = goal?.acquiredTs ?? null;
  return {
    goalRef,
    goalText,
    assumptions,
    declaredAt,
    stale: computeIntentStale(secAgo(declaredAt, nowMs)),
  };
}

/**
 * THE ORCHESTRATOR: resolve one holder's context for one reader.
 *
 * FAILS CLOSED ON A MISSING READER. `reader` is required rather than optional for
 * the reason `getCell` requires it (cell-registry.ts): an optional audience is a
 * defaulted audience, and a defaulted access check fails OPEN. A caller that
 * cannot identify its reader gets `null` — no context — which is also what makes
 * it safe for a consumer to thread the reader optionally from its own call sites.
 *
 * FAIL-SOFT PER LEG: a thrown or rejected source contributes nothing while the
 * other still lands, so a dead facts store costs the assumptions field and leaves
 * the goal intact.
 */
export async function resolveHolderContext(
  holderOwnerId: string,
  reader: CellReader | null | undefined,
  sources: HolderContextSources = {},
  opts: { nowMs?: number } = {},
): Promise<HolderContext | null> {
  const holder = cleanKey(holderOwnerId);
  if (!holder) return null;
  if (!cleanKey(reader?.ownerId)) return null; // no identified reader ⇒ no reader-relative state

  const settle = async <T>(f: (() => Promise<T>) | undefined, fallback: T): Promise<T> => {
    if (!f) return fallback;
    try {
      return await f();
    } catch {
      return fallback;
    }
  };

  const [goal, keys] = await Promise.all([
    settle(
      sources.holderGoal ? () => sources.holderGoal!(holder) : undefined,
      null as HolderGoalRecord | null,
    ),
    settle(
      sources.holderAssumptionKeys
        ? () => sources.holderAssumptionKeys!(holder, reader as CellReader)
        : undefined,
      [] as readonly string[],
    ),
  ]);

  return projectHolderContext(goal, keys, opts.nowMs ?? Date.now());
}

export { INTENT_STALE_SEC };
