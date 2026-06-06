/**
 * Splice the per-client tooling overlay into a base SU playbook at the
 * CLIENT-TOOLING-OVERLAY marker.
 *
 * The base playbook (papercusp-su-<profile>.tools.md) is NOT complete on its
 * own — it carries a `<!-- PAPERCUSP-SU:CLIENT-TOOLING-OVERLAY -->` marker
 * where the client-specific task/workflow tooling section belongs. Shipping
 * the base RAW leaks the literal marker comment with no tooling section (the
 * 2026-05-30 marker-split regression). Every TS path that ships a playbook
 * MUST splice first:
 *   - desktop-install/papercusp-files.ts  → ~/.papercusp/engineer-collaborator.md
 *   - endpoint-route/routes/misc/agent-bundle.ts → the power-user OMP bundle
 * (The bash installer, install-standalone-mcp.sh `render_playbook`, implements
 * the same contract for the shell path.)
 */
export const CLIENT_TOOLING_OVERLAY_MARKER =
  '<!-- PAPERCUSP-SU:CLIENT-TOOLING-OVERLAY -->';

/**
 * Marker for the generated "## Wire schemas" legend (token-efficient-agent-io
 * P-003) — the prompt-declared column schemas for the pre-prompt registry tools.
 * Spliced by `renderSuPlaybook` from `renderWireSchemasSection()`. Same splice
 * contract as the tooling overlay: an absent marker means the section is simply
 * appended; an empty section removes the marker (never shipped literally).
 */
export const WIRE_SCHEMAS_MARKER = '<!-- PAPERCUSP-SU:WIRE-SCHEMAS -->';

/**
 * Marker for the generated coord-injection legend (token-efficient-coord-injection
 * P-007) — the positional `[coord+N]` grammar + glyph key + the relocated footer,
 * declared ONCE per session. Spliced by `renderSuPlaybook` from
 * `renderCoordLegend()`. Same splice contract as the others.
 */
export const COORD_LEGEND_MARKER = '<!-- PAPERCUSP-SU:COORD-LEGEND -->';

/**
 * Marker for the generated "Where to work" workspace map
 * (staging-branch-pipeline-2026-06-06) — the canonical working tree + its
 * branch, and the do-not-touch pipeline-artifact siblings (release/checkpoint
 * checkouts). Rendered by `renderWorkspaceMapSection()` from the SAME env
 * seams as `release-config.ts`/`dev-deploy-state.ts`, so when branches or
 * paths change (it happened 2026-06-06: main→staging) the prompt follows the
 * config instead of drifting hand-written prose. Same splice contract.
 */
export const WORKSPACE_MAP_MARKER = '<!-- PAPERCUSP-SU:WORKSPACE-MAP -->';

/**
 * Splice generated `content` into `base` at `marker`. Replaces ALL marker
 * occurrences; with an absent marker the content is appended (when non-empty);
 * an empty content with a present marker just removes it. Generalizes the
 * tooling-overlay splice so multiple generated sections share one contract.
 */
export function spliceAtMarker(base: string, marker: string, content: string): string {
  if (base.includes(marker)) {
    return base.split(marker).join(content);
  }
  if (content) {
    return base.replace(/\n+$/, '') + '\n\n' + content + '\n';
  }
  return base;
}

/**
 * Splice a GENERATED section ONLY where its marker is present — never append.
 * Unlike `spliceToolingOverlay` (whose append-on-absent is a legacy fallback), a
 * generated section (wire-schemas, coord-legend) belongs strictly at its marker:
 * a base playbook that doesn't carry the marker (a minimal/test base, a future
 * profile that opts out) must NOT get the section dumped at its end. Absent
 * marker → returned unchanged.
 */
export function spliceGeneratedSection(base: string, marker: string, content: string): string {
  return base.includes(marker) ? base.split(marker).join(content) : base;
}

/**
 * @param base    base playbook (may contain the marker).
 * @param overlay client tooling overlay; pass '' if none (the marker is then
 *                removed, never shipped literally).
 * @returns base with the overlay spliced in at the marker. For a pre-marker
 *   base, the overlay is appended; with no overlay, the base is returned
 *   verbatim. Mirrors `render_playbook` in install-standalone-mcp.sh.
 */
export function spliceToolingOverlay(base: string, overlay: string): string {
  if (base.includes(CLIENT_TOOLING_OVERLAY_MARKER)) {
    return base.split(CLIENT_TOOLING_OVERLAY_MARKER).join(overlay); // replace ALL
  }
  if (overlay) {
    return base.replace(/\n+$/, '') + '\n\n' + overlay + '\n';
  }
  return base;
}
