/**
 * Harnesses-tab member axis — the pure logic behind the `?harness=` param
 * (harnesses-tab-hive-model-2026-06-07 Phase 1, P-001).
 *
 * The /adv shell selector owns `?slug=` — the HIVE / root scope. The
 * Harnesses tab adds an orthogonal `?harness=` axis: which MEMBER harness of
 * that hive is focused in the dock. A single param can't express "hive X,
 * member Y", which is why the tab had no place to select among a hive's
 * members (the plan's root cause).
 *
 * Phase 1 infers the hive grouping from `parent_slug` only — no schema work
 * (D-002). Phase 3 (D-004) swaps the source for a registry-native grouping
 * without changing these signatures; keep this module the single seam so the
 * member rail (P-002), the dock keying (P-001), and the unit tests (P-005)
 * all agree.
 *
 * Pure + standalone (no React) so the precedence is unit-tested without
 * mounting the tab — mirrors the sibling `adv-harness-selection.ts` seam.
 */

/** The slice of a projects/lite entry the member axis needs. */
export interface HarnessProjectLite {
  slug: string;
  parent_slug?: string | null;
  harness_kind?: string | null;
  is_shared?: boolean;
}

/** One member of a hive, as the rail + dock keying consume it. */
export interface HiveMember {
  slug: string;
  harness_kind: string | null;
  is_shared: boolean;
  /** True for the hive's root harness (the `?slug=` scope itself). */
  isRoot: boolean;
}

/** Normalize a possibly-blank parent_slug to a real slug or null. */
function parentOf(p: HarnessProjectLite): string | null {
  return p.parent_slug?.trim() || null;
}

function toMember(p: HarnessProjectLite, isRoot: boolean): HiveMember {
  return {
    slug: p.slug,
    harness_kind: p.harness_kind ?? null,
    is_shared: !!p.is_shared,
    isRoot,
  };
}

/**
 * The members of the hive rooted at `hiveSlug`, inferred from `parent_slug`
 * (Phase 1 / D-002): the root harness itself FIRST (only when it is a real
 * harness present in the registry), then its direct children
 * (`parent_slug === hiveSlug`) sorted by slug.
 *
 * A solo harness (no children) yields a single-member list `[root]` — the
 * rail renders collapsed and the dock is unchanged (zero regression).
 *
 * Returns `[]` when there is no hive selected.
 */
export function hiveMembers(
  projects: readonly HarnessProjectLite[],
  hiveSlug: string | null,
): HiveMember[] {
  if (!hiveSlug) return [];
  const members: HiveMember[] = [];
  const seen = new Set<string>();

  const root = projects.find((p) => p.slug === hiveSlug);
  if (root) {
    members.push(toMember(root, true));
    seen.add(root.slug);
  }

  const children = projects
    .filter((p) => p.slug !== hiveSlug && parentOf(p) === hiveSlug)
    .sort((a, b) => a.slug.localeCompare(b.slug));
  for (const child of children) {
    if (seen.has(child.slug)) continue;
    seen.add(child.slug);
    members.push(toMember(child, false));
  }

  return members;
}

/**
 * Resolve which member dock is focused, given the URL `?harness=` value.
 *
 * Precedence (D-001):
 *   1. An explicit, valid `?harness=` that names a current member wins —
 *      a deep link / refresh restores exactly (`?slug=X&harness=Y`).
 *   2. Else the hive root, if it is a real harness.
 *   3. Else the first member.
 *   4. Else `null` — nothing to show (no hive / empty registry).
 *
 * Because `hiveMembers` lists the root first, (2) and (3) collapse to
 * "members[0]"; the explicit checks keep the precedence legible if the
 * ordering ever changes.
 */
export function resolveFocusedMember(opts: {
  members: readonly HiveMember[];
  urlHarness: string | null;
}): string | null {
  const { members, urlHarness } = opts;
  if (members.length === 0) return null;
  if (urlHarness && members.some((m) => m.slug === urlHarness)) return urlHarness;
  const root = members.find((m) => m.isRoot);
  if (root) return root.slug;
  return members[0]?.slug ?? null;
}

/**
 * Whether a URL `?harness=` value is stale for the current hive — set but
 * not a member (e.g. the shell selector just switched `?slug=` to a
 * different hive). The tab drops it so the dock falls back to the new
 * hive's default member. Guarded on `members.length > 0` by the caller so a
 * valid deep-link value isn't cleared before projects/lite has loaded.
 */
export function isHarnessParamStale(
  members: readonly HiveMember[],
  urlHarness: string | null,
): boolean {
  if (!urlHarness) return false;
  if (members.length === 0) return false;
  return !members.some((m) => m.slug === urlHarness);
}
