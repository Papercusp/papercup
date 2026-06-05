/**
 * buildAttentionGroups — group AttentionItems for the Planning tab
 * (planning-attention-importance-2026-05-31, P-011 / D-005, D-008).
 *
 * Items with a `planSlug` group under that plan. Unattached items
 * (`planSlug === null`) — coord escalations/messages, smoke-fails, plan
 * reviews — group under a synthetic "Alerts" bucket per harness
 * (`alerts:<harnessSlug>`, or `alerts:workspace` when harnessSlug is
 * also null). Items are importance-sorted within each group; groups are
 * ordered by their most-important item so the most urgent surfaces
 * float to the top, ties broken by key for determinism. PURE.
 */

import { type Importance } from '@papercusp/plan-parser';
import { type AttentionItem, importanceRank, sortByImportance } from './types';

export interface AttentionGroup {
  /** Stable group key: a plan slug, or `alerts:<harnessSlug|'workspace'>`. */
  key: string;
  kind: 'plan' | 'alerts';
  planSlug: string | null;
  harnessSlug: string | null;
  title: string;
  items: AttentionItem[];
  /** Most-important item's level — drives group ordering. */
  maxImportance: Importance;
}

function maxImportanceOf(items: readonly AttentionItem[]): Importance {
  let best: Importance = 'low';
  for (const it of items) {
    if (importanceRank(it.importance) < importanceRank(best)) best = it.importance;
  }
  return best;
}

export function buildAttentionGroups(items: readonly AttentionItem[]): AttentionGroup[] {
  const byKey = new Map<string, AttentionItem[]>();
  const meta = new Map<
    string,
    { kind: 'plan' | 'alerts'; planSlug: string | null; harnessSlug: string | null; title: string }
  >();

  for (const it of items) {
    let key: string;
    if (it.planSlug) {
      key = it.planSlug;
      if (!meta.has(key)) {
        meta.set(key, { kind: 'plan', planSlug: it.planSlug, harnessSlug: it.harnessSlug, title: it.planSlug });
      }
    } else {
      const h = it.harnessSlug ?? 'workspace';
      key = `alerts:${h}`;
      if (!meta.has(key)) {
        meta.set(key, {
          kind: 'alerts',
          planSlug: null,
          harnessSlug: it.harnessSlug ?? null,
          title: it.harnessSlug ? `Alerts — ${it.harnessSlug}` : 'Alerts',
        });
      }
    }
    const arr = byKey.get(key) ?? [];
    arr.push(it);
    byKey.set(key, arr);
  }

  const groups: AttentionGroup[] = [];
  for (const [key, arr] of byKey) {
    const m = meta.get(key)!;
    groups.push({
      key,
      kind: m.kind,
      planSlug: m.planSlug,
      harnessSlug: m.harnessSlug,
      title: m.title,
      items: sortByImportance(arr),
      maxImportance: maxImportanceOf(arr),
    });
  }

  groups.sort(
    (a, b) =>
      importanceRank(a.maxImportance) - importanceRank(b.maxImportance) || a.key.localeCompare(b.key),
  );
  return groups;
}
