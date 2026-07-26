/**
 * The PLAN-ITEM-LANE readiness guard for self-select claims (WI-3667).
 *
 * A work-item can carry a `payload.plan_item: { plan_slug, item_id }` back-pointer
 * (stamped by plan-workitem-promotion-run.ts when a plan lane is promoted into an
 * execution record). `reservedPlanLaneExclusionSql` (work-items.ts) already excludes
 * such a row from self-select while its PLAN is `active` — but that is a coarse,
 * plan-wide floor. It says nothing about the individual plan ITEM's own resolved
 * status: a plan can be inactive (draft/paused) or its `active` floor can already
 * have lapsed while the SPECIFIC item is explicitly `blocked` (or blocked-by an
 * unresolved dependency, or a cycle) — and a claim-then-inspect self-selector then
 * picks up exactly the kind of mid-flight, human-supervised close-out work that
 * causes damage when run early (WI-3667: a Phase-5 close-out claimed mid-outage-
 * diagnosis, before the diagnosis had settled).
 *
 * ─ THE TWO LINKAGE MECHANISMS (EI-13738) ──────────────────────────────────────
 * `payload.plan_item` is stamped ONLY by the separate, dark-flagged
 * `plan-workitem-promotion-run.ts` path. The path that ACTUALLY promotes plan
 * items in production — `promote.ts` / `POST /features/import`, the tool behind
 * every real `plans:start` / feature-import call — writes a DIFFERENT, DB-column
 * linkage instead: `source_plan_slug` + `source_plan_item_ids` on
 * `harness_features_consolidated`, with NO `payload.plan_item` stamp. Relying on
 * the payload back-pointer alone therefore left every REAL plan-promoted feature
 * invisible to this guard — confirmed by the live incidents this guard's own
 * regression tests reproduce (EI-9107/EI-9108, P-401/P-308 — WI-3503/WI-3502),
 * which in production carried the DB-column linkage, not a payload stamp; two
 * independent agents (EI-13738) each rediscovered the same gap from opposite
 * directions within an hour of each other. `resolvePlanItemStamp` below now
 * resolves via EITHER mechanism, so a claim from either promotion path is
 * covered without a human having to remember which one stamped this row.
 *
 * ─ TERMINAL-lane residue (EI-13337 / EI-13352 / EI-13267 / EI-14693) ──────────
 * The costlier, recurring variant: the linked plan item is already TERMINAL
 * (`done`/`dropped`) yet the work-item is sitting at `state:'todo'` — a stale
 * residue (a completion that never terminalized the WI, a WI reset back to todo
 * after its plan item was already done, or a WI minted after the item completed).
 * `reconcileLinkedWorkItemsForPlanItem` (the reverse mirror, EI-5925/6960) heals
 * this — but ONLY on the plan-item's done TRANSITION; once the item is already
 * done, that reaction never re-fires, so a WI that lands in `todo` afterwards is
 * never reconciled. Nothing then stops the backlog-drain fleet from claiming it,
 * re-verifying "already done, no code needed", and re-closing it by hand — the
 * exact repeated fleet-time cost those four issues each report. This guard closes
 * that gap defensively: a claimed WI whose linked plan item is terminal is treated
 * the same as a blocked one (release + retry, never served), independent of
 * WHATEVER left the WI non-terminal.
 *
 * effectiveStatus resolution (blocked-by graph, cycles, missing refs — see
 * @papercusp/plan-parser's resolveEffectiveStatusForItems) is genuinely a JS-side
 * computation over the plan's JSONB `items` index, not a cheap SQL predicate — so
 * this is a POST-CLAIM guard, not a claimFloorsWhereSql addition: the caller claims
 * atomically as before, then this checks the linked plan item; on a hit the caller
 * releases the row and tries the next one (see getNextForBee's retry loop). The
 * short claim-then-release window is invisible to the outside caller (never
 * returned) and mirrors the existing lease-arbitration-loss retry shape.
 *
 * Fails OPEN (returns null ⇒ not blocked) on any lookup error — a plans read
 * hiccup must never wedge the whole claim path; the coarse plan-wide floor above
 * still applies as a backstop.
 */
import type { WorkItem } from '../work-items';

export interface PlanItemLaneBlock {
  reason: string;
  planSlug: string;
  itemId: string;
  effectiveStatus: string;
}

/**
 * EI-13780: a plan's own PROSE can mark a `todo`-status item as owner-gated /
 * hard-deferred without the structural `effectiveStatus`/`needsHuman` fields
 * ever reflecting it — a plan author writes "owner-gated" / "HARD-DEFERRED …
 * never auto-flip" in the item's own text, the plan's `## Now` block, or a
 * Decision, and the scheduler has no notion of that language. Two real
 * near-misses motivated this (both caught + hand-held by a fleet leader,
 * never executed): WI-357 (physical-rename-phase5 P-008 — "Owner-gated: needs
 * a coordinated quiescent window … Not auto-executable", inline on the item)
 * and WI-1774 (backend-reliability-100pct P-003 — the plan's own `## Now`
 * `Next` line: "P-003 … HARD-DEFERRED to an owner-attended session …never
 * auto-flip"). A fixed, deliberately small phrase set — expanding it is a
 * product decision, not a scheduler one.
 */
const OWNER_GATE_MARKERS = [
  'owner-gated',
  'hard-deferred',
  'never auto-flip',
  'needs a coordinated window',
  'owner-attended session',
] as const;

function findOwnerGateMarker(text: string | null | undefined): string | null {
  if (!text) return null;
  const lower = text.toLowerCase();
  for (const marker of OWNER_GATE_MARKERS) {
    if (lower.includes(marker)) return marker;
  }
  return null;
}

/** Escape a plan-item id for use inside a RegExp literal. */
function escapeRegExp(s: string): string {
  return s.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&');
}

/** Whether `itemId` (e.g. "P-003") is mentioned, as a whole token, in `text` —
 *  used to scope a plan-wide Now/Decision marker hit to the item it actually
 *  names, so a marker about ONE gated item in a plan never blanket-excludes
 *  every other unrelated `todo` item in the same plan. */
function itemMentioned(text: string | null | undefined, itemId: string): boolean {
  if (!text) return false;
  return new RegExp(`\\b${escapeRegExp(itemId)}\\b`).test(text);
}

/** Split Now text into the smallest units an owner-gate marker can sensibly be
 *  scoped to: lines first (a `## Now` block is usually bulleted), then sentences
 *  within a line. The sentence split requires WHITESPACE after the terminator so
 *  real plan prose like "discovery.refresh() into ONE loop" or ":3170-only,
 *  high-stakes" is never cut in half mid-clause. */
function markerScopeSegments(text: string): string[] {
  const out: string[] = [];
  for (const line of text.split('\n')) {
    for (const sentence of line.split(/(?<=[.!?;])\s+/)) {
      const s = sentence.trim();
      if (s) out.push(s);
    }
  }
  return out;
}

/**
 * EI-18718822565695446: find an owner-gate marker in the `## Now` block that is
 * actually ABOUT `itemId`.
 *
 * The previous form asked two INDEPENDENT questions of the whole block — "is the
 * item mentioned anywhere?" and "is there a marker anywhere?" — so one genuinely
 * gated item's marker gated every OTHER item the block happened to name. That
 * inverts the Now block's purpose: the more helpfully it enumerates what is
 * actionable, the more items it false-gates. (Real case: a Now block reading
 * "the next actionable block: P-007, P-008, P-009" plus "P-019 remains
 * owner-gated — it needs the live 2-machine Hetzner rig" gated P-007/8/9 on
 * P-019's gate.) This is the same locality `itemMentioned` already established
 * one level up, applied one level down: it narrowed plan-wide → Now-block-wide,
 * and this narrows Now-block-wide → the clause that names the item.
 *
 * Two rules, in order — the second exists so tightening the scope cannot swap a
 * false POSITIVE for a false NEGATIVE, which is the more dangerous direction
 * (it would hand genuinely owner-gated work to a self-selector):
 *   1. DEFINITE — a marker in the same line/sentence as the item's mention.
 *      Where one sentence names several items and carries a marker, it gates all
 *      of them, which is correct and is the WI-1774/P-003 shape (EI-13780).
 *   2. UNAMBIGUOUS — the block carries a marker and names NO OTHER plan item, so
 *      the marker cannot be about anything else. Preserves the pre-fix behaviour
 *      exactly where it was never ambiguous, e.g. a Now block whose mention and
 *      marker sit in separate sentences ("P-019 is the remaining item. It is
 *      owner-gated.").
 * Anything else — a marker elsewhere in a block that names other items too — is
 * genuinely ambiguous and no longer gates.
 */
function findNowOwnerGateMarker(nowText: string, itemId: string, allItemIds: readonly string[]): string | null {
  if (!nowText || !itemMentioned(nowText, itemId)) return null;
  for (const segment of markerScopeSegments(nowText)) {
    if (!itemMentioned(segment, itemId)) continue;
    const marker = findOwnerGateMarker(segment);
    if (marker) return marker;
  }
  const mentionsAnotherItem = allItemIds.some((id) => id !== itemId && itemMentioned(nowText, id));
  return mentionsAnotherItem ? null : findOwnerGateMarker(nowText);
}

interface PlanItemStamp {
  plan_slug: string;
  /** One or more plan-item ids this work-item implements (source_plan_item_ids
   *  can carry several; the payload.plan_item back-pointer always carries one). */
  item_ids: string[];
}

function extractPlanItemStampFromPayload(payload: unknown): PlanItemStamp | null {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const raw = (payload as Record<string, unknown>).plan_item;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const stamp = raw as Record<string, unknown>;
  const planSlug = typeof stamp.plan_slug === 'string' ? stamp.plan_slug : null;
  const itemId = typeof stamp.item_id === 'string' ? stamp.item_id : null;
  if (!planSlug || !itemId) return null;
  return { plan_slug: planSlug, item_ids: [itemId] };
}

/**
 * EI-13738: resolve via the `source_plan_slug` / `source_plan_item_ids` columns
 * on `harness_features_consolidated` — the linkage the LIVE promotion path
 * (promote.ts / POST /features/import) actually writes. Feature-family only;
 * issue-family rows (engineer_issues) carry no such columns. A missing/partial
 * column pair (no source_plan_slug, or an empty source_plan_item_ids) resolves
 * to null — unplanned/standalone work, not an error.
 */
async function resolvePlanItemStampFromColumns(
  workItem: Partial<Pick<WorkItem, 'id' | 'harness' | 'family'>>,
): Promise<PlanItemStamp | null> {
  // id/family are optional on the wider Pick below (most callers — including
  // every existing test in this file predating EI-13738 — construct a bare
  // `{ payload, harness }` object with no id/family; those legitimately have
  // no DB row to look up, so bail rather than query with an undefined id).
  if (workItem.family !== 'feature' || !workItem.id) return null;
  const [{ getOrgPg }, { activeWorkspaceId }] = await Promise.all([
    import('@papercusp/db-org'),
    import('../workspace-registry'),
  ]);
  const { sql } = getOrgPg();
  const rows = await sql<Array<{ source_plan_slug: string | null; source_plan_item_ids: string[] | null }>>`
    SELECT source_plan_slug, source_plan_item_ids
      FROM harness_shared.harness_features_consolidated
     WHERE feature_id = ${workItem.id}
       AND workspace_id = ${activeWorkspaceId()}
       AND ${workItem.harness ? sql`harness_slug = ${workItem.harness}` : sql`TRUE`}
     LIMIT 1`;
  const row = rows[0];
  if (!row?.source_plan_slug || !row.source_plan_item_ids || row.source_plan_item_ids.length === 0) return null;
  return { plan_slug: row.source_plan_slug, item_ids: row.source_plan_item_ids };
}

/** Resolve a work-item's plan-item linkage via EITHER mechanism (see the module
 *  doc's "THE TWO LINKAGE MECHANISMS" section) — payload back-pointer first
 *  (cheap, no I/O), falling back to the DB-column linkage. Fails OPEN (null) on
 *  any lookup error, same contract as the caller `planItemLaneBlockReason`. */
async function resolvePlanItemStamp(
  workItem: Pick<WorkItem, 'payload' | 'harness'> & Partial<Pick<WorkItem, 'id' | 'family'>>,
): Promise<PlanItemStamp | null> {
  const fromPayload = extractPlanItemStampFromPayload(workItem.payload);
  if (fromPayload) return fromPayload;
  try {
    return await resolvePlanItemStampFromColumns(workItem);
  } catch {
    return null;
  }
}

/**
 * Whether a just-claimed work-item's linked plan-item lane is currently
 * blocked / needs-human / already-terminal — the cases self-select must not
 * silently hand out. Returns null when the item carries no plan-item
 * linkage (neither mechanism), the linked plan/item(s) can't be found, or the
 * lane is clear.
 */
export async function planItemLaneBlockReason(
  workItem: Pick<WorkItem, 'payload' | 'harness'> & Partial<Pick<WorkItem, 'id' | 'family'>>,
): Promise<PlanItemLaneBlock | null> {
  const stamp = await resolvePlanItemStamp(workItem);
  if (!stamp) return null;
  try {
    const [{ getPlanRow, planItemsForRow }, { resolveEffectiveStatusForItems }] = await Promise.all([
      import('../agent-tools/plans/source'),
      import('@papercusp/plan-parser'),
    ]);
    const row = await getPlanRow(stamp.plan_slug, { harnessSlug: workItem.harness ?? undefined });
    if (!row) return null;
    const { items } = resolveEffectiveStatusForItems(planItemsForRow(row));
    const linked = stamp.item_ids
      .map((itemId) => items.find((i) => i.id === itemId))
      .filter((i): i is (typeof items)[number] => Boolean(i));
    if (linked.length === 0) return null;
    // A work-item can implement several plan items (source_plan_item_ids) — ANY
    // one of them being effectively blocked, or needing a human decision, gates
    // the whole work-item (a claimer executing it would be doing that item's
    // work too). Checked before the terminal/stale-residue case below so a
    // mixed set (one done + one blocked) still reports the actionable blocker.
    const blocked = linked.find((i) => i.effectiveStatus === 'blocked');
    if (blocked) {
      const blockers =
        blocked.unresolvedBlockers.length > 0 ? ` (blocked-by: ${blocked.unresolvedBlockers.join(', ')})` : '';
      return {
        reason: `plan-item ${stamp.plan_slug}#${blocked.id} is effectively blocked${blockers}`,
        planSlug: stamp.plan_slug,
        itemId: blocked.id,
        effectiveStatus: blocked.effectiveStatus,
      };
    }
    const needsHuman = linked.find((i) => i.needsHuman);
    if (needsHuman) {
      return {
        reason: `plan-item ${stamp.plan_slug}#${needsHuman.id} needs a human decision`,
        planSlug: stamp.plan_slug,
        itemId: needsHuman.id,
        effectiveStatus: needsHuman.effectiveStatus,
      };
    }
    // Already-terminal lane (EI-13337/13352/13267/14693): the plan item(s) are
    // done/dropped, so this work-item is stale residue — completed/abandoned
    // work, not open work. Never hand it to a self-selector to re-verify +
    // re-close by hand. Only when EVERY linked item is terminal — a work-item
    // covering one done + one still-open item is still real open work.
    if (linked.every((i) => i.effectiveStatus === 'done' || i.effectiveStatus === 'dropped')) {
      const terminal = linked[0];
      return {
        reason: `plan-item ${stamp.plan_slug}#${terminal.id} is already ${terminal.effectiveStatus} — its work-item is stale residue of completed/abandoned work, not open work`,
        planSlug: stamp.plan_slug,
        itemId: terminal.id,
        effectiveStatus: terminal.effectiveStatus,
      };
    }
    // EI-13780: a plan can mark a still-`todo` item owner-gated/hard-deferred
    // purely in PROSE — the item's own line, the plan's `## Now` block, or a
    // Decision scoped to it (via the Decision's own itemRefs) — with no
    // structural effectiveStatus/needsHuman signal at all (see the module-level
    // OWNER_GATE_MARKERS doc comment). Checked last, over the SAME `linked` set,
    // same any-one-gates-the-whole-work-item semantics as blocked/needsHuman above.
    const nowText = [row.nowState, row.nowNext].filter(Boolean).join('\n');
    const allItemIds = items.map((i) => i.id);
    for (const li of linked) {
      const ownMarker = findOwnerGateMarker(li.text);
      const nowMarker = findNowOwnerGateMarker(nowText, li.id, allItemIds);
      const decisionMarker = (row.decisions ?? [])
        .filter((d) => d.itemRefs.includes(li.id))
        .map((d) => findOwnerGateMarker(d.title) ?? findOwnerGateMarker(d.body))
        .find((m): m is string => Boolean(m));
      const hit = ownMarker ?? nowMarker ?? decisionMarker ?? null;
      if (hit) {
        return {
          reason: `plan-item ${stamp.plan_slug}#${li.id}'s plan text marks it owner-gated ("${hit}") — not eligible for self-select`,
          planSlug: stamp.plan_slug,
          itemId: li.id,
          effectiveStatus: li.effectiveStatus,
        };
      }
    }
    return null;
  } catch {
    // Fail OPEN — a plans-read hiccup must never wedge the shared claim path.
    return null;
  }
}
