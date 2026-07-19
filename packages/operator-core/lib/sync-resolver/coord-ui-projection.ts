/**
 * UI display-projection for the coord.* sync feeds
 * (whole-app-sync-payload-audit-2026-07-19 P-006).
 *
 * The `coord.inbox` / `coord.plans` sync resolvers return the SHARED
 * loadCoordInbox / loadCoordPlans loader output, which also feeds the
 * `/api/coord/*` HTTP routes (the pui TUI). The ONLY @papercusp/sync consumer
 * is CoordDashboard (app/coord/CoordDashboard.tsx), and it renders a strict
 * subset — so we project the loader rows to that subset at the SYNC RESOLVER
 * boundary only, leaving the HTTP-route loaders (and the pui TUI) untouched.
 *
 * Measured full sync payloads (2026-07-19, :3170):
 *   - coord.inbox 1.75MB — `payload` (the full CoordEnvelope) is 88% (1.55MB)
 *     and is NOT in CoordDashboard's InboxItem type (it renders `summary`).
 *   - coord.plans 1.09MB — `now_state` 655KB (60%) is carried but rendered
 *     NOWHERE in PlansPanel (the full plan body loads on-demand via
 *     /api/coord/plans/:slug); `now_next` 220KB IS rendered, CSS-truncated.
 */

/** Preview cap for the one displayed long-text field (matches the plans P-005 cap). */
export const COORD_TEXT_PREVIEW_MAX = 280;

function clipPreview(v: unknown, n: number): unknown {
  if (typeof v !== 'string') return v;
  return v.length > n ? `${v.slice(0, n - 1)}…` : v;
}

/**
 * Drop the heavy `payload` (full CoordEnvelope) from each inbox row — the
 * CoordDashboard InboxItem type omits it and the panel renders `summary`.
 * Every other (scalar) field is kept verbatim, incl. the `source`+`msg_id`
 * the client keys on. Defensive: a non-array passes through.
 */
export function projectCoordInboxForUi(rows: unknown): unknown {
  if (!Array.isArray(rows)) return rows;
  return rows.map((row) => {
    if (!row || typeof row !== 'object') return row;
    const { payload: _payload, ...rest } = row as Record<string, unknown>;
    return rest;
  });
}

/**
 * Drop `now_state` (carried but never rendered) and clip `now_next` (rendered
 * as a truncated preview) from each coord.plans row. Everything else — slug,
 * title, status, updated, item_count, decision_count — is kept.
 */
export function projectCoordPlansForUi(rows: unknown): unknown {
  if (!Array.isArray(rows)) return rows;
  return rows.map((row) => {
    if (!row || typeof row !== 'object') return row;
    const { now_state: _nowState, ...rest } = row as Record<string, unknown>;
    if ('now_next' in rest) rest.now_next = clipPreview(rest.now_next, COORD_TEXT_PREVIEW_MAX);
    return rest;
  });
}
