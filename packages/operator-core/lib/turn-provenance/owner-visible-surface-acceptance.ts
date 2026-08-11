/**
 * LIVE-DRIVE ACCEPTANCE for the owner-visibility surface.
 *
 * Plan owner-visibility-provenance-2026-08-11, item P-007 (WI-37958).
 *
 * ── WHY THIS EXISTS ────────────────────────────────────────────────────────
 * On 2026-08-11 three separate items on this surface were signed off on green
 * unit tests and all three failed live within hours. That is not carelessness;
 * it is a property of the surface, established by P-001:
 *
 *   A unit test here asserts `ownerVisiblePromptText(X) === ''` for an `X` the
 *   AUTHOR invented, out of the author's own model of what machine text looks
 *   like. When that model has a hole, the CODE and the FIXTURE have the SAME
 *   hole. The test cannot surprise its author, so a green suite carries close
 *   to zero information about owner-visible behaviour.
 *
 * The live drive was the only instrument that detected any of it, because it is
 * the only one whose inputs the author did not choose.
 *
 * ── WHY A REGISTRY AND NOT A CHECKLIST ─────────────────────────────────────
 * P-007 asks for a mechanism rather than an exhortation: "a checklist nobody
 * runs is worth less than a gate that refuses." A checklist depends on the one
 * person least able to see the gap — the author who just wrote the fixture that
 * shares the blind spot. So the acceptance is DECLARED here, as data, and read
 * by the completion path; nobody has to remember it.
 *
 * ── WHAT THIS IS NOT ───────────────────────────────────────────────────────
 * It is NOT a claim that unit tests are worthless here — the over-hiding rails
 * (an owner QUOTING machine text must stay visible) are exactly the kind of
 * property a fixture states well, because their inputs are owner text the
 * author is entitled to invent. It is a claim about the HIDING direction only,
 * where the input space belongs to the machine and not to the author.
 */

/**
 * The files whose behaviour is only observable by driving the live surface.
 *
 * SHRINK-ONLY BY INTENT. Adding a file tightens the acceptance; removing one
 * loosens it and needs a plan decision, because every removal is a claim that
 * the file's owner-visible behaviour became unit-observable — which is exactly
 * the claim that was wrong three times on 2026-08-11.
 *
 * Kept as repo-relative suffixes so a caller's `filesChanged` matches whether
 * it recorded an absolute path, a repo-relative one, or a workspace-relative
 * one — the three shapes real completions actually carry.
 */
export const OWNER_VISIBLE_SURFACE_FILES: readonly string[] = [
  // THE predicate every owner-facing surface asks (fact:
  // owner-visible-turn-filter-is-shared-predicate).
  'packages/operator-core/lib/agent-tools/coordination/owner-chat-turn.ts',
  // The ONE curated machine-surface list the predicate routes through (V-003).
  'packages/operator-core/lib/turn-provenance/machine-surface-catalogue.ts',
  // Turn classification + the recorded-turn verdict readers consume.
  'packages/operator-core/lib/turn-provenance/turn-ref.ts',
  'packages/operator-core/lib/turn-provenance/turn-provenance.ts',
  // The rendering consumers — where a correct predicate can still be bypassed.
  'apps/operator/app/_components/chat/session-transcript-mapping.ts',
  'packages/operator-core/lib/adv-session-search.ts',
  'packages/operator-core/lib/adv-agent-detail.ts',
  'packages/operator-core/lib/memory/human-turn-tail.ts',
];

/**
 * `verifiedHow` values that constitute an actual observation of the surface.
 *
 * `live-drove-ui` is the instrument P-007 names. `integration` qualifies
 * because an integration test on this surface reads REAL recorded turns rather
 * than author-invented fixtures — the input-provenance property that makes the
 * live drive informative in the first place, which is the thing being required
 * here rather than any particular tool.
 */
export const LIVE_DRIVE_ACCEPTED_VERIFICATIONS: readonly string[] = [
  'live-drove-ui',
  'integration',
  'manual',
];

export interface LiveDriveAcceptanceGap {
  /** The registered surface files this completion changed. */
  surfaceFiles: string[];
  /** What the completion claimed instead, for the message. */
  verifiedHow: string | undefined;
}

/** Normalize a recorded path to compare against the registry suffixes. */
function normalizePath(p: string): string {
  return p.trim().replace(/\\/g, '/').replace(/^\.\//, '');
}

/** Which registered surface files does this change touch? */
export function surfaceFilesTouched(filesChanged: readonly string[] | undefined): string[] {
  if (!filesChanged || filesChanged.length === 0) return [];
  const seen = new Set<string>();
  for (const raw of filesChanged) {
    if (typeof raw !== 'string') continue;
    const p = normalizePath(raw);
    for (const surface of OWNER_VISIBLE_SURFACE_FILES) {
      // Suffix match anchored at a path BOUNDARY: `.../repo/<surface>` matches,
      // and a file whose name merely ends the same way (`x-owner-chat-turn.ts`)
      // does not. Deliberately NOT a basename match — two packages may hold a
      // same-named file and only the registered path is the surface.
      if (p === surface || p.endsWith(`/${surface}`)) seen.add(surface);
    }
  }
  return [...seen];
}

/**
 * Does this completion settle a change to the owner-visibility surface WITHOUT
 * having observed the surface?
 *
 * Returns the gap, or null when there is nothing to say — which is the common
 * case, because the registry is small on purpose.
 */
export function liveDriveAcceptanceGap(
  evidence: { verifiedHow?: string; filesChanged?: readonly string[] } | undefined,
): LiveDriveAcceptanceGap | null {
  if (!evidence) return null;
  const surfaceFiles = surfaceFilesTouched(evidence.filesChanged);
  if (surfaceFiles.length === 0) return null;
  const how = evidence.verifiedHow;
  if (how && LIVE_DRIVE_ACCEPTED_VERIFICATIONS.includes(how)) return null;
  return { surfaceFiles, verifiedHow: how };
}

/** The message the completion path attaches. Written once, here, so the
 *  reasoning travels with the finding instead of being re-derived. */
export function liveDriveAcceptanceMessage(id: string, gap: LiveDriveAcceptanceGap): string {
  return (
    `completion for ${id} changed ${gap.surfaceFiles.length} file(s) on the OWNER-VISIBILITY SURFACE ` +
    `(${gap.surfaceFiles.join(', ')}) but reports \`verifiedHow: ${JSON.stringify(gap.verifiedHow)}\` — ` +
    `no observation of the live surface. On THIS surface a green unit suite is close to zero evidence about ` +
    `owner-visible behaviour, and the reason is structural, not sloppiness: a fixture asserts the predicate ` +
    `against text the AUTHOR invented from the author's own model of machine turns, so when that model has a ` +
    `hole the code and the fixture have the SAME hole and the test cannot surprise you. Measured 2026-08-11: ` +
    `THREE items on this surface were signed off green and all three failed live within hours; the live drive ` +
    `was the only instrument that caught any of them. Before settling this, drive the surface and look at what ` +
    `the owner actually sees (/internal/docs/testing/agent-e2e), then re-close with ` +
    `\`verifiedHow: 'live-drove-ui'\` — or, if the change genuinely cannot alter what is rendered (a comment, a ` +
    `rename), say so in \`deferred\` so the next reader knows it was considered rather than missed. ` +
    `The over-hiding direction is the one to look at hardest: hiding a machine row too few is recoverable, ` +
    `hiding the owner's own words is not.`
  );
}
