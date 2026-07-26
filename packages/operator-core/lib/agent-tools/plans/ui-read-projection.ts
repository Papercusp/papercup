/**
 * UI-path display projection for the plans:* READ payloads
 * (whole-app-sync-payload-audit-2026-07-19 P-005).
 *
 * `callPlansReadRaw` (read-dispatch.ts) is the SINGLE in-process dispatch that
 * feeds BOTH UI surfaces — the `/api/admin/plans/*` REST routes and the
 * `@papercusp/sync` `plans.*` live-query resolvers — and it always requests
 * `payloadTier:'full'` (WI-5078: the payload-tier HARD CEILING must NOT trim the
 * UI's reads, or plans:attention comes back as item-less group summaries and the
 * Queue/Overview/Inbox blank out). Agent/MCP sessions never reach this function
 * (they hit the tool via the MCP endpoint directly), so a projection here is
 * UI-only and cannot regress the agent-facing shapers.
 *
 * The `full` UI payloads measured (2026-07-19, :3170 sync path) were dominated
 * by two things the LIST/QUEUE scan views never render at full length:
 *   - plans:items ~2.9MB  — `item.text` 1.6MB, `coverage` 181KB (no UI consumer),
 *     `item.rawLine`/`item.unresolvedBlockers` ~20KB (not in the PlanItem UI type)
 *   - plans:list  ~910KB  — `nextAction` 221KB (the full `## Now` next line;
 *     PlanRail shows it CSS-clamped + a tooltip)
 * Both feeds are pure SCAN surfaces: the cross-plan `plans:items` list drives
 * counts + a clamped item list, and the DETAIL pane (PlanItemPreview) fetches
 * the full item body separately via `plans:get` (usePlan live). So we clip the
 * displayed text to a generous preview and drop the true non-display blobs.
 *
 * plans:attention IS now projected too (slim-plans-attention-sync-payload-2026-07-26
 * P-003) — it was the fattest UI read left at 1490KB (152 groups / 1096 items,
 * 97.9% of it the nested `items[]`). It gets a LIST/DETAIL split rather than a
 * blanket slim, because only part of the per-item payload is detail-tier. The
 * split was drawn by auditing every consumer, and TWO fields that look
 * detail-tier are not:
 *   - `ref` — read by a LIST-LEVEL filter (SessionChatModal's
 *     `isEscalationWithOptions` narrows the whole feed by `ref.options`), so
 *     dropping it silently empties the session-chat escalation cards. KEPT.
 *   - `report` — read by InboxPane's `buildDiscussDraft`, and it measured 0
 *     bytes in practice (no live item carries one). KEPT: no win, real risk.
 * So only `actions` is dropped (88KB, read solely by attention-card.ts at
 * detail time) and `body` is clipped (609KB → ~256KB; median 336B, p90 1282B,
 * max 6431B over 1097 items). `body` is CLIPPED rather than dropped because it
 * is not purely detail-tier either — InboxPane's client-side search haystack,
 * AdvOverviewTab's row tooltip and attention-card's question fallback all read
 * it, and dropping it would silently degrade inbox search to title-only.
 * The full `body` + `actions` come back on selection via the `plans.attentionItem`
 * resolver, which bypasses this projection (`uiProjection: false`).
 *
 * plans:get and every other verb pass through unchanged — plans:get IS the
 * full-fidelity detail read.
 */

/** Preview cap for the scan-list text fields — matches the standard agent tier's
 *  text cap so the tooltip preview length is consistent across surfaces. */
export const UI_TEXT_PREVIEW_MAX = 280;

/** True non-display fields carried on the FULL plans:items row (top-level) that
 *  no UI consumer reads (verified: PlanItemRow = { plan, archived, item }). */
const ITEMS_ROW_DROP = ['coverage', 'blockedByIssues'] as const;

/** Parse-internal fields on the nested `item` the PlanItem UI type omits. */
const ITEM_DROP = ['rawLine', 'unresolvedBlockers'] as const;

/**
 * Preview cap for an attention item's `body` in the LIST feed. Larger than
 * UI_TEXT_PREVIEW_MAX has diminishing returns (p90 is 1282B, so most of the
 * saving is already taken at 280) and smaller starts costing inbox search
 * recall; the full body is one `plans.attentionItem` fetch away.
 */
export const UI_ATTENTION_BODY_PREVIEW_MAX = 280;

/**
 * DETAIL-tier fields on an attention item — dropped from the list feed and
 * re-supplied by `plans.attentionItem`. Deliberately short: see the header for
 * why `ref` and `report` are NOT in here despite looking like they belong.
 */
const ATTENTION_ITEM_DROP = ['actions'] as const;

function clipPreview(v: unknown, n: number): unknown {
  if (typeof v !== 'string') return v;
  return v.length > n ? `${v.slice(0, n - 1)}…` : v;
}

function omit(
  obj: Record<string, unknown>,
  keys: readonly string[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, val] of Object.entries(obj)) {
    if (!keys.includes(k)) out[k] = val;
  }
  return out;
}

function projectItems(data: Record<string, unknown>): Record<string, unknown> {
  const items = (data as { items?: unknown }).items;
  if (!Array.isArray(items)) return data;
  const rows = items.map((row) => {
    if (!row || typeof row !== 'object') return row;
    const r = omit(row as Record<string, unknown>, ITEMS_ROW_DROP);
    const item = r.item;
    if (item && typeof item === 'object') {
      const it = omit(item as Record<string, unknown>, ITEM_DROP);
      if ('text' in it) it.text = clipPreview(it.text, UI_TEXT_PREVIEW_MAX);
      r.item = it;
    }
    return r;
  });
  return { ...data, items: rows };
}

function projectList(data: Record<string, unknown>): Record<string, unknown> {
  const plans = (data as { plans?: unknown }).plans;
  if (!Array.isArray(plans)) return data;
  const rows = plans.map((row) => {
    if (!row || typeof row !== 'object') return row;
    const r = { ...(row as Record<string, unknown>) };
    if ('nextAction' in r) r.nextAction = clipPreview(r.nextAction, UI_TEXT_PREVIEW_MAX);
    return r;
  });
  return { ...data, plans: rows };
}

/**
 * Slim the attention feed to its LIST shape: drop the detail-tier fields and
 * clip `body` to a search/tooltip preview. A clipped item is stamped
 * `bodyTruncated: true` so a consumer can tell "short body" from "clipped body"
 * without re-measuring the string.
 */
function projectAttention(data: Record<string, unknown>): Record<string, unknown> {
  const groups = (data as { groups?: unknown }).groups;
  if (!Array.isArray(groups)) return data;
  const projected = groups.map((group) => {
    if (!group || typeof group !== 'object') return group;
    const g = group as Record<string, unknown>;
    if (!Array.isArray(g.items)) return group;
    const items = g.items.map((item) => {
      if (!item || typeof item !== 'object') return item;
      const it = omit(item as Record<string, unknown>, ATTENTION_ITEM_DROP);
      const body = it.body;
      if (typeof body === 'string' && body.length > UI_ATTENTION_BODY_PREVIEW_MAX) {
        it.body = clipPreview(body, UI_ATTENTION_BODY_PREVIEW_MAX);
        it.bodyTruncated = true;
      }
      return it;
    });
    return { ...g, items };
  });
  return { ...data, groups: projected };
}

/**
 * Project a plans:* READ payload down to the UI display shape. `list`, `items`
 * and `attention` are slimmed; every other verb (get/search/revisions/runs/
 * lint/…) passes through byte-identical. `byHive` reuses the `list` read, so it
 * inherits the list slim automatically at its call site.
 *
 * Pure + defensive: a non-object payload, a tool error envelope, or a shape that
 * lacks the expected array passes through unchanged.
 */
export function projectPlansReadForUi(verb: string, data: unknown): unknown {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return data;
  const d = data as Record<string, unknown>;
  if (verb === 'items') return projectItems(d);
  if (verb === 'list') return projectList(d);
  if (verb === 'attention') return projectAttention(d);
  return data;
}
