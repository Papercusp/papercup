/**
 * plans:items payload-tier shapers (context-trimming-tiers-2026-07-01 P-021).
 *
 * plans:items averages 38KB/call (7d MCP telemetry): each row nests the full
 * ResolvedItem (text, rawLine, decisionRefs, unresolvedBlockers) plus a
 * coverage subtree. A trimmed/standard session flattens each row to a
 * TOON-tabular scalar record — the pick-an-item essentials — and caps rows.
 * The handler already sorts by importance, so a head slice keeps the most
 * urgent rows.
 *
 * Contract (D-004, no silent caps): uniform key set per tier (null over
 * absent); arrays are joined to comma strings (an array cell defeats TOON's
 * tabular form); an over-cap list appends a visible `(truncated)` notice row
 * with the escape hatches.
 */

export const PLANS_ITEMS_TIER_CAPS = {
  trimmed: { rows: 60, text: 120, phase: 48 },
  standard: { rows: 150, text: 280, phase: 80 },
} as const;

type ItemsTier = keyof typeof PLANS_ITEMS_TIER_CAPS;

const clip = (s: unknown, n: number): string | null =>
  typeof s === "string" ? (s.length > n ? `${s.slice(0, n - 1)}…` : s) : null;

const joined = (v: unknown): string | null =>
  Array.isArray(v) && v.length > 0 ? v.map(String).join(",") : null;

export function shapePlansItems(data: unknown, tier: ItemsTier): unknown {
  const items = (data as { items?: unknown[] } | null | undefined)?.items;
  if (!Array.isArray(items)) return data;
  const c = PLANS_ITEMS_TIER_CAPS[tier];

  const project = (row: unknown): Record<string, unknown> => {
    const r = (row ?? {}) as Record<string, unknown>;
    const item = (r.item ?? {}) as Record<string, unknown>;
    const coverage = r.coverage as
      | { level?: unknown; workers?: unknown }
      | null
      | undefined;
    const unresolved = Array.isArray(item.unresolvedBlockers)
      ? item.unresolvedBlockers.length
      : 0;
    const issueBlocks = Array.isArray(r.blockedByIssues)
      ? r.blockedByIssues.length
      : 0;
    const base = {
      plan: r.plan ?? null,
      id: item.id ?? null,
      status: item.effectiveStatus ?? null,
      importance: item.importance ?? null,
      needsHuman: item.needsHuman === true,
      text: clip(item.text, c.text),
      phase: clip(item.phase, c.phase),
      /** Count of live blockers (unresolved P-refs + open issue-blocks). */
      blockers: unresolved + issueBlocks,
      /** Coverage level ("is anyone working this") — full/partial/none-ish. */
      working: typeof coverage?.level === "string" ? coverage.level : null,
    };
    if (tier === "trimmed") return base;
    return {
      ...base,
      blockedBy: joined(item.blockedBy),
      blockedByIssues: joined(r.blockedByIssues),
      workers: joined(coverage?.workers),
      archived: r.archived === true,
    };
  };

  const rows = items.slice(0, c.rows).map(project);
  if (items.length > c.rows) {
    rows.push({
      ...project({}),
      plan: "(truncated)",
      text: `showing top ${c.rows} of ${items.length} by importance — narrow with status/actionable/slug, plans:get-item for detail, or payloadTier:"full"`,
    });
  }
  return { ...(data as Record<string, unknown>), items: rows };
}
