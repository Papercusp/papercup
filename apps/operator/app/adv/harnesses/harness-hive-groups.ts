/**
 * Pure hive-grouping logic for the all-mode (`?scope=all`) workspace view of
 * the Harnesses tab (harnesses-tab-hive-model-2026-06-07 P-003 / D-003).
 *
 * Phase 1 infers the hive purely from the registry's `parent_slug` edge
 * (D-002 — no schema work): a "hive" is a root harness plus the subtree that
 * hangs off it. `groupByHive` buckets every project under its top-most
 * ancestor so the all-mode view can render one card group per hive.
 *
 * Kept pure + standalone (no React, no fetch) so the grouping precedence is
 * unit-tested without the AdvShell component tree — same discipline as the
 * sibling `adv-harness-selection.ts` axis resolver. The member-rail axis
 * helpers (`hiveMembers` / `resolveFocusedMember`) live in `harness-axis.ts`;
 * this module owns only the workspace-wide grouping the cards need.
 */

/**
 * The `GET /api/harness/projects/lite` entry fields this module groups over —
 * a structural subset of the full payload (the grouping only needs the
 * membership edge + the card-facing metadata).
 */
export interface HiveGroupProject {
  slug: string;
  parent_slug?: string | null;
  harness_kind?: string | null;
  is_shared?: boolean;
  /** Whether the harness has been set up (has harness state) — the rail/cards' zero-new-poller liveness hint. */
  hasState?: boolean;
}

export interface HiveGroup {
  /** The hive root entry — a real registry harness (or the bucket's first member if the root row is missing). */
  root: HiveGroupProject;
  /** Root first, then the remaining members sorted by slug. */
  members: HiveGroupProject[];
}

/**
 * Walk `parent_slug` up to the top-most ancestor present in the registry — the
 * hive root for `slug`. Cycle-safe; returns `slug` itself when it has no
 * parent, an orphan parent (parent_slug set but the parent is not in the
 * registry — mirrors `buildHarnessSelectOptions`' orphans-render-as-roots),
 * or sits on a malformed back-edge cycle.
 */
export function hiveRootOf(
  slug: string,
  bySlug: ReadonlyMap<string, HiveGroupProject>,
): string {
  if (!slug) return '';
  let cur = slug;
  const seen = new Set<string>([cur]);
  for (;;) {
    const node = bySlug.get(cur);
    const parent = node?.parent_slug?.trim() || null;
    if (!parent) return cur; // a real root (or an unknown slug → itself)
    if (!bySlug.has(parent)) return cur; // orphan parent → cur is the effective root
    if (seen.has(parent)) return cur; // cycle guard
    seen.add(parent);
    cur = parent;
  }
}

/**
 * Group every project under its hive root (the top-most `parent_slug`
 * ancestor) for the all-mode workspace view. Every project lands under
 * exactly one root; a deep tree collapses to its top root so a grandchild
 * still groups with its hive. Roots are sorted by slug; members are
 * root-first then slug-sorted.
 */
export function groupByHive(projects: readonly HiveGroupProject[]): HiveGroup[] {
  const bySlug = new Map<string, HiveGroupProject>();
  for (const p of projects) bySlug.set(p.slug, p);

  const byRoot = new Map<string, HiveGroupProject[]>();
  for (const p of projects) {
    const root = hiveRootOf(p.slug, bySlug);
    let bucket = byRoot.get(root);
    if (!bucket) {
      bucket = [];
      byRoot.set(root, bucket);
    }
    bucket.push(p);
  }

  const groups: HiveGroup[] = [];
  for (const [rootSlug, members] of byRoot) {
    const rootEntry = bySlug.get(rootSlug) ?? members[0];
    const sorted = [...members].sort((a, b) => {
      if (a.slug === rootSlug) return -1;
      if (b.slug === rootSlug) return 1;
      return a.slug.localeCompare(b.slug);
    });
    groups.push({ root: rootEntry, members: sorted });
  }
  groups.sort((a, b) => a.root.slug.localeCompare(b.root.slug));
  return groups;
}
