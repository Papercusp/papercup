/**
 * promote.ts — pure SC-NNN allocator + SPEC.md mutator for plans:promote.
 *
 * agent-coordination-architecture-v2 §11.3 / §11.4. SC-NNN is the
 * Papercusp-house-pattern ID for spec acceptance criteria, sibling to
 * F-NNN / D-NNN / P-NNN. The substrate here is pure (no FS, no HTTP) so
 * it's straightforward to unit-test; the plans:promote tool composes
 * this with the operator's HTTP endpoints (PUT /spec, /features/import).
 *
 * v1 deliberate simplifications (notes from the implementation report):
 *   - No optimistic concurrency on SPEC.md (the harness_project_files
 *     row lacks a `version` column; adding it is a separate migration
 *     blocked on the locks-PG test environment).
 *   - The scoper's MODE=replan dedup is unchanged — it does not yet
 *     know about `metadata.covers`. Until that lands, the autonomous
 *     scoper may create a duplicate feature for an SC-NNN already
 *     covered by an SU-promoted feature. Mitigation: the user-facing
 *     symptom is a duplicate, not corruption.
 */

const SC_RE = /\[SC-(\d{3,})\]/g;

/** Parse the set of existing SC-NNN ids out of a SPEC.md body. */
export function parseScIds(spec: string): string[] {
  const out = new Set<string>();
  let m: RegExpExecArray | null;
  // Reset the global regex's lastIndex per call.
  SC_RE.lastIndex = 0;
  while ((m = SC_RE.exec(spec)) != null) {
    out.add(`SC-${m[1]}`);
  }
  return [...out].sort();
}

/** Highest numeric SC-NNN id in `spec`, or 0 if none. */
export function maxScNum(spec: string): number {
  let max = 0;
  for (const id of parseScIds(spec)) {
    const n = parseInt(id.slice(3), 10);
    if (Number.isFinite(n) && n > max) max = n;
  }
  return max;
}

/** Allocate `n` fresh SC-NNN ids starting from max+1 in `spec`. */
export function allocateNextScIds(spec: string, n: number): string[] {
  const start = maxScNum(spec) + 1;
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    out.push(`SC-${(start + i).toString().padStart(3, '0')}`);
  }
  return out;
}

/** A single acceptance criterion to add to SPEC.md. */
export interface PromotedCriterion {
  /** Allocated SC-NNN id. */
  id: string;
  /** Human-facing criterion text. */
  text: string;
  /** The feature id this criterion is covered by (if known). */
  coveredBy?: string;
}

export interface PromoteAppendOpts {
  planSlug: string;
  authorOwnerId: string;
  /** Section heading to nest the added criteria under. Default 'Promoted from `<slug>`'. */
  sectionHeading?: string;
}

/**
 * Build the new SPEC body with one new section that lists the added
 * criteria — preserving every byte of the existing prose. Provenance
 * marker mirrors the proposal-accept handler's style.
 *
 * NOTE: simple textual append at end-of-file. A future improvement is
 * to insert under a "## Acceptance criteria" anchor if present; the
 * append-at-end form is unambiguous and easy to review.
 */
export function appendCriteriaToSpec(
  spec: string,
  criteria: PromotedCriterion[],
  opts: PromoteAppendOpts,
): string {
  if (criteria.length === 0) return spec;
  const heading = opts.sectionHeading ?? `Promoted from \`${opts.planSlug}\``;
  const lines: string[] = [];
  lines.push('');
  lines.push(
    `<!-- promoted from plans/${opts.planSlug} by ${opts.authorOwnerId} at ${new Date().toISOString()} -->`,
  );
  lines.push(`## ${heading}`);
  lines.push('');
  for (const c of criteria) {
    const cov = c.coveredBy ? ` (covered by ${c.coveredBy})` : '';
    lines.push(`- [${c.id}] ${c.text}${cov}`);
  }
  lines.push('');
  const sep = spec.endsWith('\n') ? '' : '\n';
  return `${spec}${sep}${lines.join('\n')}`;
}

/**
 * One promote-input feature with the criteria it will cover. The tool
 * resolves the actual SC-NNN ids (via allocateNextScIds) and feeds
 * appendCriteriaToSpec.
 */
export interface PromoteFeatureInput {
  title: string;
  body?: string;
  acceptance?: string[];
  from_items?: string[];
}

/**
 * Pre-compute the SPEC mutation + the per-feature SC coverage list. No
 * I/O. Pure transform that callers can preview before applying.
 */
export function buildSpecMutation(args: {
  currentSpec: string;
  planSlug: string;
  authorOwnerId: string;
  features: PromoteFeatureInput[];
  /** Optional feature ids the caller pre-allocated (e.g. F-040..F-043).
   *  When omitted, the tool reports covers as null. */
  featureIds?: string[];
}): {
  newSpec: string;
  criteria: PromotedCriterion[];
  perFeatureCovers: Array<{ feature_title: string; feature_id?: string; covers: string[] }>;
} {
  const totalCriteria = args.features.reduce(
    (n, f) => n + (f.acceptance?.length ?? 0),
    0,
  );
  const ids = allocateNextScIds(args.currentSpec, totalCriteria);
  const criteria: PromotedCriterion[] = [];
  const perFeatureCovers: Array<{
    feature_title: string;
    feature_id?: string;
    covers: string[];
  }> = [];
  let cursor = 0;
  for (let i = 0; i < args.features.length; i++) {
    const f = args.features[i]!;
    const fid = args.featureIds?.[i];
    const covers: string[] = [];
    for (const text of f.acceptance ?? []) {
      const id = ids[cursor++]!;
      covers.push(id);
      criteria.push({ id, text, coveredBy: fid });
    }
    const entry: { feature_title: string; feature_id?: string; covers: string[] } = {
      feature_title: f.title,
      covers,
    };
    if (fid) entry.feature_id = fid;
    perFeatureCovers.push(entry);
  }
  const newSpec = appendCriteriaToSpec(args.currentSpec, criteria, {
    planSlug: args.planSlug,
    authorOwnerId: args.authorOwnerId,
  });
  return { newSpec, criteria, perFeatureCovers };
}
