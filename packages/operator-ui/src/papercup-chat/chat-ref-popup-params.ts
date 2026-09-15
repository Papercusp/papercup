/**
 * The `wpop` / `wppop` URL grammar — the chat ref-pill popups' shared encoding
 * (chat-ref-pills-2026-07-26 P-008 / D-002 seam; extracted for WI-6601, shared
 * with the portal for WI-10001509).
 *
 * WHY THIS IS A MODULE and not two inline `indexOf('::')` calls: these params
 * are written by SEVERAL surfaces across BOTH hosts (OperatorChat's own ref
 * pills, the sidebar's curator-card drill-in, the portal's PortalPapercupChat)
 * and read by ONE renderer per host (ChatRefPopupHost). A writer and the reader
 * disagreeing about the grammar is an invisible dead click — the param looks
 * right in the URL and nothing opens, which is exactly the WI-6601 failure
 * mode. One encoder + one decoder means they cannot drift.
 *
 * WHY IT LIVES HERE rather than in `apps/operator`: the portal writes these
 * params too (WI-10001509), and it reaches the operator's chat only through
 * this package. A second copy of the grammar on the portal side would be the
 * same drift risk one repo boundary out — so the grammar moved to the shared
 * chat package and the operator keeps a re-export shim at its historical path.
 *
 * GRAMMAR: `<harnessSlug>::<id>`, mirroring `curator-card-drill-in.ts`'s
 * `<planSlug>::<itemId>` `sel` convention. The harness is part of the VALUE
 * rather than read from the surrounding surface because both lookups
 * (`workItems.detail`, `plans:get`) are harness-scoped while the surfaces that
 * open them are not: the persistent chat sidebar is a cross-harness mount with
 * no `?slug` at all. A ref that carries its own harness therefore opens
 * correctly from ANY surface, which a surface-derived harness cannot do.
 *
 * A BARE value (no `::`) is accepted and decodes to `{ harness: null, id }` —
 * both for back-compat with links minted before `wppop` carried a harness, and
 * so a writer with genuinely no harness context can still name the id and let
 * the reader fall back to the resolved surface harness (the same
 * `<ref's own> ?? <surface's>` precedence HudView already applies to `hudwi`).
 */

/** The open work-item popup (`WI-`/`EI-`/`F-`). */
export const CHAT_WORK_ITEM_POPUP_PARAM = 'wpop';
/** The open plan popup. Distinct from PlansPane's own `pplan` so a plan opened
 *  from chat and one opened from the Plans pane don't fight over one key. */
export const CHAT_PLAN_POPUP_PARAM = 'wppop';

const SEP = '::';

/** Build a param value. A null/empty harness yields the bare id rather than a
 *  `"::id"` with an empty scope — the decoder treats those identically, but a
 *  bare value is what every pre-existing link already looks like. */
export function encodeScopedRef(harness: string | null | undefined, id: string): string {
  return harness ? `${harness}${SEP}${id}` : id;
}

/** Split a param value into its harness + id. Never throws; an absent/blank
 *  value decodes to all-null (i.e. "closed"), which is what both popups render
 *  as nothing. */
export function decodeScopedRef(
  raw: string | null | undefined,
): { harness: string | null; id: string | null } {
  if (!raw) return { harness: null, id: null };
  const sep = raw.indexOf(SEP);
  if (sep < 0) return { harness: null, id: raw || null };
  return {
    harness: raw.slice(0, sep) || null,
    id: raw.slice(sep + SEP.length) || null,
  };
}
