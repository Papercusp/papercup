/**
 * _holder-lens.ts — P-030's WORK-ITEM LENS onto the shared `HolderContext`
 * projection: who holds this work-item, and what are they trying to DO.
 *
 * Plan: unified-agent-state-plane-2026-07-27, P-030 (leg (b) of D-060). Rulings:
 * D-060 (the owner ask), D-092 + D-093 (disclose `agreement`/`competing`), D-046
 * (a ref, never a bigint), D-051 (assumptions are a count, never inline prose),
 * D-056 (unreadable ⇒ holder ABSENT, row STAYS), P-026 rule (f) (total).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ⚠ A LENS, NOT A DERIVATION. It resolves nothing itself: it calls
 * `resolveHolderContext`, which gates on `getCell(AGENT_GOAL_CELL_ID, reader)`
 * and reads P-016's one resolver. That is D-038 axis 5 — a surface adds a LENS,
 * never a second derivation — and it is why P-030 is a few dozen lines rather
 * than a re-implementation of the precedence rule.
 *
 * ⚠⚠ THE RULE P-030 STATES IN CAPITALS, AND WHY IT IS RIGHT.
 * ⛔ NEVER add an intent column to `work_items`. `harness_shared.work_items`
 * carries `taken_by`/`taken_at`/`expires_at` and NO claim-intent column, so
 * there is nothing on the row to project — and that is the point. A goal column
 * here would be a THIRD place a goal is written (`coord_presence`,
 * `plan_item_claims`, `work_items`), i.e. a transcribed copy that silently rots,
 * which is precisely the defect P-017 (c)'s detector exists to catch. Read the
 * cell; do not copy the value.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ⚠ WHY THIS RUNS OUTSIDE THE TOOL'S CACHE, AND IT IS AN ACCESS BUG IF IT DOES NOT.
 *
 * `work_items:list` and `work_items:get` both wrap their row read in
 * `cachedRead`, whose key is explicitly NON-principal-scoped ("depends only on
 * workspace + the filter args"). Holder context is READER-RELATIVE by
 * construction — the goal passes a P-019 audience check and the assumption keys
 * pass `agent_facts`' own `audience_scope`. Resolving it INSIDE the cached
 * factory would store one reader's answer and serve it to every other reader:
 * a silent cross-reader disclosure that no test asserting on content could
 * catch, because more content still contains the expected content (the exact
 * failure mode `cell-access-parity.test.ts` was written for). So the lens is
 * applied to the rows the cache returns, never to the rows it stores.
 *
 * ⚠ LIVE CLAIMS ONLY. A holder still named on a TERMINAL row is not working
 * toward it, so decorating a `done`/`passed`/`resolved` row with its holder's
 * CURRENT goal would render an unrelated goal beside finished work and read as
 * "this is what they are doing about this item". Same rule the goal resolver
 * applies to its own work-item leg, applied to the display side.
 */
import { z } from 'zod';
import { resolveHolderContext, type HolderContext } from '../../coord/holder-context';
import { holderContextSources } from '../coordination/holder-context-sources';
import { isTerminalStateInput } from '../../work-item-dispatch-states';
import type { CellReader } from '../../cell-registry';

/**
 * The WIRE schema for the shared projection — declared ONCE, here, and imported
 * by every tool that returns a holder.
 *
 * ⚠ IT IS A SECOND PLACE THE SHAPE IS WRITTEN DOWN, AND THAT IS EXACTLY THE RISK.
 * A tool's zod `result` STRIPS undeclared keys (`work_items:list` already carries
 * a comment about a field silently blanked that way), so a schema that drifts
 * behind `HolderContext` does not fail — it quietly deletes the new field from
 * every response. D-093 adding `agreement`/`competing` is precisely such a
 * moment. `_holder-lens.test.ts` therefore asserts this key set EQUALS the
 * projection's, so the two cannot diverge; that assertion is what makes one
 * schema module safer than a literal inlined at each tool.
 */
export const HOLDER_CONTEXT_SCHEMA = z.object({
  goalRef: z.string().nullable(),
  goalText: z.string().nullable(),
  assumptions: z.object({ count: z.number(), keys: z.array(z.string()) }),
  declaredAt: z.string().nullable(),
  stale: z.boolean().nullable(),
  agreement: z.string().nullable(),
  competing: z.array(z.string()),
});

/**
 * Ceiling on DISTINCT holders resolved for one read.
 *
 * Measured live 2026-07-27 (P-030 requires re-measurement before shipping, and
 * this is it): across the WHOLE `work_items` table, **18 rows carry a holder and
 * they belong to 17 distinct holders** — against 18,562 non-terminal rows. So a
 * 500-row list read fans out to ~17 resolutions at the very most, and this cap
 * cannot bite on today's fleet. It exists so a fleet an order of magnitude
 * larger degrades by DISCLOSING less rather than by turning a list read into an
 * unbounded per-holder fan-out.
 *
 * D-060's cost objection re-checked: the claimed population went 4 → 18 rows
 * (4.5×) since the item was written, which is NOT the order of magnitude the
 * item names as the trigger to re-litigate the reversal.
 */
export const HOLDER_LENS_DISTINCT_CAP = 40;

/** The row fields this lens needs. Structural, so it never drags a work-item row
 *  type (or its schema) into the shared projection. */
export interface HolderLensRow {
  /** The unified holder field — `taken_by` for the feature family, `assignee` for
   *  the issue family; `work-items.ts` already normalises both onto this key. */
  assignee?: string | null;
  state?: string | null;
}

/** What the lens attaches. Both keys are OPTIONAL on the row: an absent `holder`
 *  is the honest answer for "no goal" AND for "not readable by you", and those
 *  two must stay indistinguishable (D-056). */
export interface HolderLensFields {
  /** P-026's shared projection for this row's holder. */
  holder?: HolderContext;
  /**
   * Set when the lens did not even ATTEMPT this row's holder because the
   * distinct-holder cap bit.
   *
   * ⚠ THIS IS NOT AN ACCESS SIGNAL AND MUST NEVER BECOME ONE. It says "we did not
   * look", which is a fact about the READ. An absence caused by the audience gate
   * carries NO marker at all — marking it would make a refusal distinguishable
   * from an empty, i.e. a probe oracle for state the reader may not see (D-056).
   */
  holderOmitted?: 'cap';
}

/**
 * Should this row's holder be resolved at all?
 *
 * Exported for the suite: "only live claims" is the rule most likely to be
 * quietly relaxed by a later editor who wants the field on every row.
 */
export function rowHasLiveHolder(row: HolderLensRow): boolean {
  const holder = (row?.assignee ?? '').trim();
  if (!holder) return false;
  const state = (row?.state ?? '').trim();
  // An unrecognised/blank state is treated as NON-terminal: this decorates, and
  // failing toward "show the holder" for an unknown state is the harmless
  // direction, while failing toward "hide" would silently blank the field for a
  // whole family the moment its vocabulary widened.
  return state ? !isTerminalStateInput(state) : true;
}

/**
 * Attach each live holder's `HolderContext` to the rows that have one.
 *
 * TOTAL (P-026 rule f): never throws and never rejects — this decorates an
 * ordinary read, so a dead facts store, an unreachable PG or an unregistered
 * cell costs the `holder` field and NOTHING ELSE. Every row is returned either
 * way, in its original order (D-056: the row stays; cell visibility must never
 * leak through the SHAPE of the list).
 *
 * Returns NEW row objects — the inputs may be cache-owned and must not be
 * mutated, or one reader's holder context would be written into the shared
 * cached value and served to the next reader. That is the same disclosure bug
 * the module header describes, reached by a different route.
 */
export async function attachHolderContext<T extends HolderLensRow>(
  rows: readonly T[],
  reader: CellReader | null | undefined,
  opts: { nowMs?: number; distinctCap?: number } = {},
): Promise<(T & HolderLensFields)[]> {
  const out = (rows ?? []).map((r) => ({ ...r })) as (T & HolderLensFields)[];
  // No identified reader ⇒ no reader-relative state, and the rows pass through
  // untouched. `resolveHolderContext` fails closed on this too; short-circuiting
  // here just avoids the fan-out.
  if (!reader?.ownerId?.trim() || out.length === 0) return out;

  const cap = opts.distinctCap ?? HOLDER_LENS_DISTINCT_CAP;
  // First-seen order, so which holders survive the cap is deterministic for a
  // given row order rather than dependent on Map/Set iteration incidentals.
  const wanted: string[] = [];
  for (const row of out) {
    if (!rowHasLiveHolder(row)) continue;
    const owner = row.assignee!.trim();
    if (!wanted.includes(owner)) wanted.push(owner);
  }
  if (wanted.length === 0) return out;

  const resolved = wanted.slice(0, cap);
  const sources = holderContextSources();
  const byOwner = new Map<string, HolderContext | null>();
  await Promise.all(
    resolved.map(async (owner) => {
      byOwner.set(
        owner,
        // Total by contract; caught anyway, because "an enrichment must never be
        // able to fail the operation it decorates" is the one rule here that a
        // future source change could break from a distance.
        await resolveHolderContext(owner, reader, sources, { nowMs: opts.nowMs }).catch(() => null),
      );
    }),
  );

  for (const row of out) {
    if (!rowHasLiveHolder(row)) continue;
    const owner = row.assignee!.trim();
    if (!byOwner.has(owner)) {
      row.holderOmitted = 'cap';
      continue;
    }
    const ctx = byOwner.get(owner);
    // Null ⇒ nothing disclosable to THIS reader: no goal, or a goal they may not
    // read. The field is simply absent, identically in both cases.
    if (ctx) row.holder = ctx;
  }
  return out;
}
