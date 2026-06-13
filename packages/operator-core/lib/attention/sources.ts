/**
 * Pure source transforms for plans:attention (P-011).
 *
 * The tool fetches raw records (I/O) and hands them to these pure
 * mappers — split out so the composition (filter + adapt) is unit-
 * testable against the real parser without a ctx, PG, or coord log.
 */

import { resolveEffectiveStatus, type ParsedPlan } from '@papercusp/plan-parser';
import { parseReportBlock } from '@papercusp/chat-protocol';
import { operatorReportToAttention, planItemToAttention } from './adapters';
import { planItemRef } from '../issue-blocks-merge';
import type { OperatorReportTurnRow } from './operator-report-source';
import type { AttentionItem } from './types';

/**
 * Map the non-terminal items of already-parsed plans to AttentionItems —
 * the plan-item source of plans:attention. Skips legacy plans and any
 * item that is `done`/`dropped` by stored OR effective status (a
 * blocker dropped upstream un-gates its dependents, which then surface).
 */
export function planItemsToAttention(
  plans: readonly { parsed: ParsedPlan }[],
  harnessSlug: string | null,
): AttentionItem[] {
  const out: AttentionItem[] = [];
  for (const { parsed } of plans) {
    if (parsed.isLegacy) continue;
    const slug = parsed.frontmatter.slug ?? parsed.slug;
    const resolved = resolveEffectiveStatus(parsed);
    for (const it of resolved.items) {
      if (it.storedStatus === 'done' || it.storedStatus === 'dropped') continue;
      if (it.effectiveStatus === 'done' || it.effectiveStatus === 'dropped') continue;
      out.push(
        planItemToAttention({
          slug,
          harnessSlug,
          id: it.id,
          text: it.text,
          storedStatus: it.storedStatus,
          effectiveStatus: it.effectiveStatus,
          importance: it.importance,
        }),
      );
    }
  }
  return out;
}

/**
 * The decision↔execution dedup guard (queen-autonomy-policy B-14 / P-104 · D-013):
 * drop plan-item Queue items that have been CONVERTED to a work_item. `plan_items:
 * convert` is the boundary — pre-convert the item is an awaiting-decision Queue
 * row; post-convert it executes and shows in the Working tab (its work_item). It
 * must never show in BOTH. `convertedRefs` is the set of '<plan>#<item>' refs with
 * an `implements` edge ({@link listConvertedPlanItemRefs}).
 *
 * A needs-human DECISION (`tier === 'decision'`) ALWAYS stays — you resolve a
 * decision, you don't convert it, and a decision must never be silently hidden.
 * Only executing items (todo/wip/blocked, the activity/alert tiers) carrying an
 * edge are dropped. Non-plan-item kinds pass through untouched. PURE.
 */
export function dropConvertedPlanItems(
  items: readonly AttentionItem[],
  convertedRefs: ReadonlySet<string>,
): AttentionItem[] {
  if (convertedRefs.size === 0) return [...items];
  return items.filter((it) => {
    if (it.kind !== 'plan-item') return true;
    if (it.tier === 'decision') return true; // a needs-human decision always shows
    const ref = it.ref as { kind: 'plan-item'; slug: string; itemId: string };
    return !convertedRefs.has(planItemRef(ref.slug, ref.itemId));
  });
}

/**
 * Map recent report-carrying operator turns to AttentionItems — the
 * operator-report source (report-cards-inbox-reconciliation-2026-06-05,
 * P-003 / D-003). The stored jsonb is re-validated through the shared
 * `parseReportBlock` (defensive — a row written by an older/foreign client
 * may not match the schema); invalid payloads are skipped, never thrown.
 * Rows arrive newest-first from the source query and order is preserved.
 */
export function reportTurnsToAttention(rows: readonly OperatorReportTurnRow[]): AttentionItem[] {
  const out: AttentionItem[] = [];
  for (const row of rows) {
    // jsonb arrives pre-parsed or as a raw string depending on the postgres
    // client's type config — normalize before validating.
    let raw = row.report;
    if (typeof raw === 'string') {
      try {
        raw = JSON.parse(raw);
      } catch {
        continue;
      }
    }
    const report = parseReportBlock(raw);
    if (!report) continue;
    out.push(
      operatorReportToAttention({
        turnId: row.turnId,
        conversationId: row.conversationId,
        report,
        sayText: row.text,
      }),
    );
  }
  return out;
}
