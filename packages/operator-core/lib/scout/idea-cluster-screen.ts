/**
 * Cluster-aware screening pass over untriaged Scout ideas.
 *
 * ## Why the output unit is a CLUSTER, not an item
 *
 * The 07-04→07-15 backlog is not 179 independent ideas. su-b9269a31 measured it
 * (msg msdmnzir) as roughly **14 duplicate clusters covering 139 of 178 items**:
 * ten separate filings routinely describe ONE condition. A per-item screen
 * therefore reports the same finding ten times, and — worse — ten filings read to
 * an implementer as 10× the evidence for a scope that is actually narrow.
 *
 * So this module emits **one row per cluster**, and adds the third verdict that a
 * per-item screen structurally cannot produce: `COLLAPSE-AND-RESCOPE` — neither
 * DROP nor GREENLIGHT, but "one rescoped item plus N-1 merged".
 *
 * ## Report-only — this closes NOTHING
 *
 * Mirrors the contract of `code-existence-probe` and of the parent item's explicit
 * constraint (EI-19458723447066799): *do not bulk-CLOSE on a shared premise*.
 * A verdict here is a RECOMMENDATION carrying its evidence, for a human or agent
 * to weigh. Nothing in this module mutates a work-item.
 *
 * The peer's constraint is load-bearing and restated here because it is easy to
 * lose: **co-clustering proves the members are ABOUT one condition. It never
 * proves that condition is dead.** A large cluster is a scoping signal, not a
 * death certificate.
 */

import {
  probeCodeExistence,
  type CodeExistenceMatch,
  type CodeExistenceReport,
  type CodeSearchDeps,
  type CodeExistenceOptions,
  type SemanticPriorArtMatch,
} from './code-existence-probe';
import type { PlanSlugMatch } from './plan-slug-leg';

/**
 * Cosine-DISTANCE threshold for single-linkage clustering.
 *
 * STATED CONSTANT, not a discovered one — and the distinction matters, because a
 * reader who assumes it was tuned will over-trust it.
 *
 * Provenance (su-b9269a31, msg msdmnzir — measured on 179 open Scout rows,
 * 07-04→07-15, gemma 768-dim embeddings, all 179 present):
 *   - hand-labelled validation: within-cluster max 0.1298 < between-cluster min
 *     0.1329, i.e. a genuine separation exists in that window;
 *   - 0.13 collapses 154 of 178 items into ONE blob — useless;
 *   - the edge-distance distribution has **no knee**, so nothing here is
 *     discoverable by elbow-finding. The value is a judgment call sitting below
 *     the observed separation, not an optimum.
 *
 * ⚠ SCOPE LIMIT — do not launder into confidence. The measurement covers
 * 07-04→07-15 ONLY. The 07-15→07-18 tail is UNMEASURED and 0.09 is **not known to
 * transfer** to it. Re-measure rather than extend.
 *
 * ## ⚠⚠ THE HARD BOUNDARY: distance is reliable on the CONDITION, unreliable on
 * the PROPOSAL
 *
 * A cluster can justify "these filings DESCRIBE the same thing". It can NEVER
 * justify "these filings WANT the same thing". Embedding distance is computed over
 * text that is dominated by the problem statement, so items proposing OPPOSITE
 * mechanisms sit close together.
 *
 * Measured by su-b9269a31 across three clusters (3/3), the decisive case being a
 * 19-item cluster whose members all reported one condition ("a rubric emits
 * `unknown` because its subject was never exercised") but resolved into THREE
 * partly-contradictory mechanisms: suppress-when-blind, amplify-when-chronic, and
 * diagnose-idle-as-signal. Merging them into a single item would have destroyed a
 * real design decision — the outcome was 3 canonical items, not 1.
 *
 * So `COLLAPSE-AND-RESCOPE` means "triage these together", never "merge these".
 */
export const CLUSTER_DISTANCE_THRESHOLD = 0.09;

/**
 * At or above this size a cluster is reported `needs-manual-split` rather than
 * trusted as one condition.
 *
 * Single-linkage chains: A near B near C merges A with C even when A and C are
 * far apart. With no knee in the edge distribution (above) there is no principled
 * cut, so cluster SIZE is used as a **chaining proxy** — the honest framing of
 * "trust small, distrust large".
 *
 * The boundary is a judgment call, and here is the whole basis so it can be
 * argued with: the largest cluster anyone has hand-checked is cluster A at size
 * 10 (and only 4 of its 10 summaries were actually read), while the 35-item blob
 * in the same run is explicitly NOT verified to split cleanly. 12 sits above the
 * former and far below the latter. It is not a measured cut-point.
 */
export const MANUAL_SPLIT_MIN_SIZE = 12;

/** An idea to screen. `embedding` is optional — without it the idea is a singleton. */
export interface ScreenableIdea {
  /** Work-item id, e.g. "EI-7303". */
  id: string;
  /** Title + summary/body — the text both clustering and probing read. */
  text: string;
  /** ISO timestamp the idea was filed, for premise age. */
  createdAt: string;
  /**
   * Embedding vector. Absent, empty, or dimension-mismatched ⇒ the idea never
   * merges with anything and is emitted as its own cluster. That is the
   * fail-open direction: a missing embedding must never silently merge an idea
   * into a cluster it was never compared against.
   */
  embedding?: number[];
}

/** Size-derived trust in the GROUPING (not in the verdict). */
export type ClusterConfidence = 'high' | 'needs-manual-split';

export type ClusterVerdict =
  /** Prior art found and the cluster is a single item — recommend retiring it. */
  | 'DROP'
  /**
   * >1 member: the filings share a CONDITION and should be triaged together.
   *
   * ⚠ This is NOT an instruction to merge them into one item. Distance is
   * reliable on the condition and unreliable on the PROPOSAL — see
   * `CLUSTER_DISTANCE_THRESHOLD`.
   */
  | 'COLLAPSE-AND-RESCOPE'
  /** No prior-art evidence, and retrieval actually ran — proceed to normal triage. */
  | 'GREENLIGHT'
  /** Retrieval did not run, so "no prior art found" carries NO information. */
  | 'INCONCLUSIVE';

/** A lexical hit, aggregated across a cluster's members. */
export interface AggregatedLexicalHit {
  term: string;
  source: CodeExistenceMatch['source'];
  /** Highest file count seen for this term across members. */
  fileCount: number;
  examples: string[];
  strength: CodeExistenceMatch['strength'];
}

/** One row of the screening report — the unit a reader acts on. */
export interface ClusterScreenRow {
  /** Members, in input order. */
  memberIds: string[];
  size: number;
  confidence: ClusterConfidence;
  verdict: ClusterVerdict;

  /**
   * REAL prior art: refs the filings name that resolve to a TERMINAL item
   * (done/resolved/closed/dropped/deprecated). Only these drive DROP.
   *
   * ⚠ `kind: 'work-item-id'` ONLY. The "existing <X>" PHRASE half is deliberately
   * excluded from anything that drives a verdict — authors routinely open with
   * "existing X is inadequate", which is MOTIVATION, the opposite of conceding
   * prior art. Phrases are still surfaced, in `assertedPhrases`, for a reader.
   * (This precision split is enforced by a regression test in the probe module,
   * and was confirmed against a live mislabel by su-b9269a31 within the hour.)
   */
  assertedPriorArtIds: string[];

  /**
   * Refs that resolve to a STILL-OPEN item — a duplication signal, NOT prior art.
   *
   * Measured on the real backlog: EI-7654 and EI-7663 each cite EI-7650 and
   * EI-7652 as "existing", and all four are open, untriaged members of the SAME
   * 07-04→07-15 cohort. Counting those as prior art recommends DROP for an idea
   * whose only crime is pointing at its own siblings.
   *
   * This is also how the collapse verdict works WITHOUT embeddings: an idea
   * citing a live sibling is a merge candidate on the strength of its own text.
   */
  assertedOpenSiblingIds: string[];

  /**
   * Refs to items that were ABANDONED (dropped/deprecated) — terminal, but NOT
   * built. Surfaced because a re-filing of previously-abandoned work deserves a
   * triager's attention, but never grounds to drop. See `ABANDONED_STATES`.
   */
  assertedAbandonedIds: string[];

  /**
   * Refs whose state could not be resolved (no resolver supplied, or lookup
   * failed). Fail-open: counted as NEITHER prior art nor duplication, because
   * guessing either way is a verdict the evidence does not support.
   */
  assertedUnresolvedIds: string[];
  /** Captured for the reader; NEVER reaches the verdict. See above. */
  assertedPhrases: string[];

  /** Source files citing a member's own id — near-conclusive when non-empty. */
  selfIdHits: string[];
  /** LEXICAL leg, aggregated. Strongest first. */
  lexicalHits: AggregatedLexicalHit[];
  /**
   * SEMANTIC leg — kept SEPARATE and never unioned into `lexicalHits`, so each
   * leg's precision stays measurable instead of blended.
   */
  semanticHits: SemanticPriorArtMatch[];
  /**
   * PLAN-SLUG leg — plans whose slug overlaps a member's vocabulary. Kept SEPARATE
   * like every other leg, and CONTEXT ONLY: `decideVerdict` does not receive this
   * field, so the leg structurally cannot drive a verdict (see `plan-slug-leg.ts`
   * for why a token-overlap inference must not).
   */
  planSlugHits: PlanSlugMatch[];

  /** Days since filing, across the cluster. */
  premiseAgeDays: { oldest: number; newest: number };

  /**
   * Did ANY retrieval leg actually run for this cluster? When false, an empty
   * `lexicalHits` means "we could not look", never "nothing exists" — which is
   * exactly the false negative this whole pass was built to prevent.
   */
  retrievalRan: boolean;

  /** Human-readable reasons behind `verdict` and `confidence`. */
  notes: string[];
}

/**
 * States meaning the work was actually DONE — the only ones that make a cited
 * reference real prior art.
 */
export const IMPLEMENTED_STATES = new Set(['done', 'resolved', 'closed', 'passed']);

/**
 * States meaning the item was ABANDONED, not built.
 *
 * ⚠ These are terminal but they are NOT prior art, and conflating the two is a
 * mistake I made and had to measure my way out of. Both `dropped` and
 * `deprecated` close an item precisely because nobody implemented it.
 *
 * Measured cost of the conflation: WI-2479 ("Persistent fleet headcount target
 * governor") cited EI-6805 ("Fleet self-healing headcount governor") — nearly the
 * same title, so it looks like a textbook prior-art hit — but EI-6805 is
 * `dropped`. Recommending DROP there retires an idea because an IDENTICAL idea
 * was previously abandoned. EI-7622/EI-7593 is the same shape.
 *
 * The signal is still worth surfacing (a re-filing of abandoned work is worth a
 * triager's attention, in either direction), so it is reported — just never as
 * grounds to drop.
 */
export const ABANDONED_STATES = new Set(['dropped', 'deprecated']);

export interface ScreenOptions extends CodeExistenceOptions {
  /**
   * Resolve referenced work-item ids to their states, so an asserted ref can be
   * classified as real prior art (terminal) vs a live sibling (open).
   *
   * Omit and EVERY asserted ref lands in `assertedUnresolvedIds` — the screen
   * then reports no prior art from this leg rather than assuming it.
   */
  resolveRefStates?: (ids: string[]) => Promise<Map<string, string>>;
  /** Override the clustering threshold (default `CLUSTER_DISTANCE_THRESHOLD`). */
  distanceThreshold?: number;
  /** Override the manual-split size (default `MANUAL_SPLIT_MIN_SIZE`). */
  manualSplitMinSize?: number;
  /** "Now", for deterministic premise-age in tests. Default `Date.now()`. */
  now?: number;
  /** Max semantic hits retained per cluster row (default 5). */
  maxSemanticPerCluster?: number;
}

/**
 * Cosine distance in [0, 2], or `null` when the pair is not comparable
 * (missing/empty/mismatched/zero vectors).
 *
 * `null` — not `Infinity` — so callers must handle "not comparable" explicitly
 * rather than having it silently behave like "very far apart".
 */
export function cosineDistance(a?: number[], b?: number[]): number | null {
  if (!a || !b || a.length === 0 || a.length !== b.length) return null;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return null;
  return 1 - dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/**
 * Single-linkage agglomerative clustering by cosine distance.
 *
 * Returns clusters of INDICES into `ideas`, each sorted ascending, and the
 * clusters themselves ordered by size (desc) then first index (asc) — fully
 * deterministic, so a report diff between two runs reflects the data and not the
 * traversal order.
 */
export function clusterIdeas(
  ideas: ScreenableIdea[],
  threshold: number = CLUSTER_DISTANCE_THRESHOLD,
): number[][] {
  const parent = ideas.map((_, i) => i);
  const find = (x: number): number => {
    let r = x;
    while (parent[r] !== r) r = parent[r];
    // Path compression.
    let c = x;
    while (parent[c] !== c) {
      const next = parent[c];
      parent[c] = r;
      c = next;
    }
    return r;
  };
  const union = (x: number, y: number): void => {
    const rx = find(x);
    const ry = find(y);
    if (rx !== ry) parent[Math.max(rx, ry)] = Math.min(rx, ry);
  };

  for (let i = 0; i < ideas.length; i++) {
    for (let j = i + 1; j < ideas.length; j++) {
      const d = cosineDistance(ideas[i].embedding, ideas[j].embedding);
      // A non-comparable pair NEVER merges. Refusing to merge is the safe
      // direction: a wrong merge hides a distinct idea inside another's row.
      if (d !== null && d <= threshold) union(i, j);
    }
  }

  const groups = new Map<number, number[]>();
  for (let i = 0; i < ideas.length; i++) {
    const root = find(i);
    const g = groups.get(root);
    if (g) g.push(i);
    else groups.set(root, [i]);
  }

  return [...groups.values()]
    .map((g) => [...g].sort((a, b) => a - b))
    .sort((a, b) => b.length - a.length || a[0] - b[0]);
}

const DAY_MS = 86_400_000;

function ageDays(iso: string, now: number): number {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return 0;
  return Math.max(0, Math.floor((now - t) / DAY_MS));
}

/**
 * Aggregate per-member probe reports into the cluster's evidence fields.
 *
 * Exported so the aggregation is testable without a search backend.
 */
export function aggregateReports(
  reports: CodeExistenceReport[],
  memberIds: string[],
  maxSemantic = 5,
): Omit<
  Pick<
    ClusterScreenRow,
    | 'assertedPhrases'
    | 'selfIdHits'
    | 'lexicalHits'
    | 'semanticHits'
    | 'planSlugHits'
    | 'retrievalRan'
  >,
  never
> & {
  /** Every external ref named, UNCLASSIFIED — state resolution happens upstream. */
  assertedRefIds: string[];
} {
  const own = new Set(memberIds.map((id) => id.toUpperCase()));
  const assertedIds = new Set<string>();
  const phrases = new Set<string>();
  const selfIdHits = new Set<string>();
  const lexical = new Map<string, AggregatedLexicalHit>();
  const semantic = new Map<string, SemanticPriorArtMatch>();
  const planSlugs = new Map<string, PlanSlugMatch>();
  let retrievalRan = false;

  for (const r of reports) {
    // NOTE: the plan-slug leg deliberately does NOT set `retrievalRan`.
    //
    // `retrievalRan` licenses reading an empty result as "nothing exists", and the
    // plan leg searches plan NAMES, not code — so it cannot support that reading.
    // Letting it flip the flag would let a cluster be GREENLIT (i.e. absence
    // asserted) on the strength of a search that never looked at an implementation.
    // A check that ran over a DIFFERENT corpus must not stand in for the one that
    // did not run at all.
    if (r.searched) retrievalRan = true;

    for (const a of r.assertedPriorArt ?? []) {
      if (a.kind === 'work-item-id') {
        // A cluster member citing a SIBLING member is not external prior art —
        // it is the duplication this pass already reports as the cluster itself.
        if (!own.has(a.ref.toUpperCase())) assertedIds.add(a.ref);
      } else {
        phrases.add(a.ref);
      }
    }

    for (const h of r.selfIdHits ?? []) selfIdHits.add(h);

    for (const m of r.matches) {
      const prev = lexical.get(m.term);
      if (!prev) {
        lexical.set(m.term, {
          term: m.term,
          source: m.source,
          fileCount: m.fileCount,
          examples: [...m.examples],
          strength: m.strength,
        });
      } else {
        prev.fileCount = Math.max(prev.fileCount, m.fileCount);
        // 'strong' wins: a term that is specific in ANY member's reading is
        // worth a reader's attention.
        if (m.strength === 'strong') prev.strength = 'strong';
        for (const ex of m.examples) {
          if (prev.examples.length < 3 && !prev.examples.includes(ex)) prev.examples.push(ex);
        }
      }
    }

    for (const s of r.semantic ?? []) {
      const prev = semantic.get(s.ref);
      if (!prev || s.score > prev.score) semantic.set(s.ref, s);
    }

    for (const p of r.planSlugs?.planMatches ?? []) {
      const prev = planSlugs.get(p.slug);
      if (!prev || p.score > prev.score) planSlugs.set(p.slug, p);
    }
  }

  return {
    assertedRefIds: [...assertedIds].sort(),
    assertedPhrases: [...phrases].sort(),
    selfIdHits: [...selfIdHits].sort(),
    lexicalHits: [...lexical.values()].sort(
      (a, b) =>
        (a.strength === b.strength ? 0 : a.strength === 'strong' ? -1 : 1) ||
        a.fileCount - b.fileCount ||
        a.term.localeCompare(b.term),
    ),
    semanticHits: [...semantic.values()].sort((a, b) => b.score - a.score).slice(0, maxSemantic),
    // Shipped plans first — an in-flight or superseded plan is intent, not code
    // (WI-9476 defect #4, "abandoned is not built", re-applied to plan status).
    planSlugHits: [...planSlugs.values()]
      .sort(
        (a, b) =>
          (a.statusClass === b.statusClass ? 0 : a.statusClass === 'implemented' ? -1 : 1) ||
          b.score - a.score ||
          a.slug.localeCompare(b.slug),
      )
      .slice(0, maxSemantic),
    retrievalRan,
  };
}

/**
 * Decide a cluster's verdict from its aggregated evidence.
 *
 * Precedence, and why each step sits where it does:
 *
 *  1. **size > 1 ⇒ COLLAPSE-AND-RESCOPE**, ahead of everything else. Clustering
 *     does not depend on retrieval, so this survives a total search outage — and
 *     it is right even when prior art IS found. Cluster A is the worked case: a
 *     TRUE premise AND three-week-older prior art (EI-7347), yet the useful
 *     output is one rescoped item plus nine merged, NOT ten drops.
 *  2. **prior art ⇒ DROP** for a singleton. EI-7303 is the worked case: its own
 *     premise experiment PASSED at 21.8×, so a premise-only screen greenlights it
 *     — and the build would have been a fourth duplicate of `watchdogKey`.
 *  3. **no retrieval ⇒ INCONCLUSIVE**, never GREENLIGHT. This is the module's
 *     whole reason for existing: an empty result from a probe that never ran must
 *     not read as "no prior art exists".
 *  4. otherwise **GREENLIGHT** — screened, nothing found, proceed to normal triage.
 *
 * Steps 1 and 2 reproduce both outcomes anyone has established by hand, which is
 * the only calibration this logic has. Two cases is not a validation set.
 */
export function decideVerdict(
  size: number,
  evidence: Pick<
    ClusterScreenRow,
    | 'assertedPriorArtIds'
    | 'assertedOpenSiblingIds'
    | 'assertedAbandonedIds'
    | 'selfIdHits'
    | 'lexicalHits'
    | 'retrievalRan'
  >,
): { verdict: ClusterVerdict; notes: string[] } {
  const notes: string[] = [];
  const strongLexical = evidence.lexicalHits.filter((h) => h.strength === 'strong');

  // HIGH-PRECISION legs only. Lexical is deliberately NOT here — see below.
  const hasPriorArt =
    evidence.assertedPriorArtIds.length > 0 || evidence.selfIdHits.length > 0;

  if (evidence.assertedPriorArtIds.length > 0) {
    notes.push(
      `filings name FINISHED prior art outright: ${evidence.assertedPriorArtIds.join(', ')}`,
    );
  }
  if (evidence.selfIdHits.length > 0) {
    notes.push(`${evidence.selfIdHits.length} source file(s) cite a member's own id`);
  }
  if (evidence.assertedAbandonedIds.length > 0) {
    notes.push(
      `cites ABANDONED (dropped/deprecated) item(s) ${evidence.assertedAbandonedIds.join(', ')} — ` +
        `previously filed and NOT built, so this is a re-filing, not prior art`,
    );
  }
  if (strongLexical.length > 0) {
    // Reported as context for the reader, never as grounds for a verdict.
    //
    // MEASURED on the real backlog, which is why this leg was demoted: the terms
    // graded "strong" included `facts:assert`, `plans:get`, `plans:items`,
    // `release:checkpoint-run` and `test:affected` — tool names the idea MENTIONS.
    // Of course they exist in the tree. Their existence says nothing about
    // whether the idea's proposed MECHANISM exists, and letting them drive DROP
    // turned a screen into a recommendation to retire ideas for naming a tool.
    notes.push(
      `lexical hits (context only, not grounds to drop): ${strongLexical.map((h) => h.term).join(', ')}`,
    );
  }

  if (size > 1 || evidence.assertedOpenSiblingIds.length > 0) {
    if (evidence.assertedOpenSiblingIds.length > 0) {
      notes.push(
        `cites STILL-OPEN sibling(s) ${evidence.assertedOpenSiblingIds.join(', ')} as "existing" — ` +
          `duplication, not prior art`,
      );
    }
    if (size > 1) {
      notes.push(
        `${size} filings co-cluster on ONE CONDITION. ⚠ READ THE PROPOSALS BEFORE MERGING — ` +
          `co-clustering shows they DESCRIBE the same thing, never that they WANT the same thing, ` +
          `and it does NOT show the condition is dead.`,
      );
    }
    return { verdict: 'COLLAPSE-AND-RESCOPE', notes };
  }
  if (hasPriorArt) return { verdict: 'DROP', notes };
  if (!evidence.retrievalRan) {
    notes.push('retrieval did not run — an empty result here carries NO information');
    return { verdict: 'INCONCLUSIVE', notes };
  }
  notes.push('screened, no conclusive prior art — proceed to normal triage');
  return { verdict: 'GREENLIGHT', notes };
}

/**
 * Run the full screening pass.
 *
 * Every member is probed individually (the asserted-prior-art leg is pure and
 * free, and per-member self-id greps are the highest-precision leg), then the
 * evidence is aggregated to one row per cluster. Term repetition within a cluster
 * is expected — `deps.search` implementations should memoise.
 *
 * Fail-open throughout: a throwing probe yields an unsearched report rather than
 * an empty one, and an unsearched cluster can never reach GREENLIGHT.
 */
export async function screenIdeaClusters(
  ideas: ScreenableIdea[],
  deps: CodeSearchDeps,
  opts: ScreenOptions = {},
): Promise<ClusterScreenRow[]> {
  const now = opts.now ?? Date.now();
  const threshold = opts.distanceThreshold ?? CLUSTER_DISTANCE_THRESHOLD;
  const splitAt = opts.manualSplitMinSize ?? MANUAL_SPLIT_MIN_SIZE;
  const clusters = clusterIdeas(ideas, threshold);
  const rows: ClusterScreenRow[] = [];

  for (const idx of clusters) {
    const members = idx.map((i) => ideas[i]);
    const memberIds = members.map((m) => m.id);

    const reports: CodeExistenceReport[] = [];
    for (const m of members) {
      try {
        reports.push(await probeCodeExistence(m.text, deps, { ...opts, selfId: m.id }));
      } catch (err) {
        // The probe is already fail-open internally; this catches a caller-supplied
        // backend that throws in a way it cannot see. Same posture: record that we
        // could NOT look, never that nothing was found.
        reports.push({
          terms: [],
          matches: [],
          searched: false,
          unavailableReason: err instanceof Error ? err.message : String(err),
        });
      }
    }

    const { assertedRefIds, ...evidenceRest } = aggregateReports(
      reports,
      memberIds,
      opts.maxSemanticPerCluster ?? 5,
    );

    // Classify each asserted ref by the STATE of the item it points at. A ref to
    // a finished item is prior art; a ref to a live one is duplication. Fail-open
    // on a resolver error: unresolved refs drive nothing.
    let states = new Map<string, string>();
    if (opts.resolveRefStates && assertedRefIds.length > 0) {
      try {
        states = await opts.resolveRefStates(assertedRefIds);
      } catch {
        states = new Map();
      }
    }
    const assertedPriorArtIds: string[] = [];
    const assertedOpenSiblingIds: string[] = [];
    const assertedAbandonedIds: string[] = [];
    const assertedUnresolvedIds: string[] = [];
    for (const ref of assertedRefIds) {
      const st = states.get(ref);
      if (!st) assertedUnresolvedIds.push(ref);
      else if (IMPLEMENTED_STATES.has(st)) assertedPriorArtIds.push(ref);
      else if (ABANDONED_STATES.has(st)) assertedAbandonedIds.push(ref);
      else assertedOpenSiblingIds.push(ref);
    }

    const evidence = {
      ...evidenceRest,
      assertedPriorArtIds,
      assertedOpenSiblingIds,
      assertedAbandonedIds,
      assertedUnresolvedIds,
    };
    const { verdict, notes } = decideVerdict(members.length, evidence);
    const ages = members.map((m) => ageDays(m.createdAt, now));
    const confidence: ClusterConfidence =
      members.length >= splitAt ? 'needs-manual-split' : 'high';
    if (confidence === 'needs-manual-split') {
      notes.push(
        `cluster of ${members.length} exceeds the size-${splitAt} trust boundary — ` +
          `single-linkage chaining is likely, so SPLIT before acting on this row`,
      );
    }

    rows.push({
      memberIds,
      size: members.length,
      confidence,
      verdict,
      ...evidence,
      premiseAgeDays: { oldest: Math.max(...ages), newest: Math.min(...ages) },
      notes,
    });
  }

  return rows;
}

/** One-line-per-cluster rendering for a report, densest signal first. */
export function summariseClusterRow(row: ClusterScreenRow): string {
  const head = `${row.verdict} [${row.size}] ${row.memberIds.slice(0, 4).join(',')}${
    row.memberIds.length > 4 ? `,+${row.memberIds.length - 4}` : ''
  }`;
  const bits: string[] = [];
  if (row.confidence === 'needs-manual-split') bits.push('⚠ NEEDS-MANUAL-SPLIT');
  if (!row.retrievalRan) bits.push('⚠ retrieval did not run');
  if (row.assertedPriorArtIds.length > 0) {
    bits.push(`DONE prior art: ${row.assertedPriorArtIds.join('/')}`);
  }
  if (row.assertedOpenSiblingIds.length > 0) {
    bits.push(`open siblings: ${row.assertedOpenSiblingIds.join('/')}`);
  }
  if (row.assertedAbandonedIds.length > 0) {
    bits.push(`ABANDONED (not built): ${row.assertedAbandonedIds.join('/')}`);
  }
  if (row.selfIdHits.length > 0) bits.push(`self-id: ${row.selfIdHits.length}`);
  const shippedPlans = row.planSlugHits.filter((p) => p.statusClass === 'implemented');
  if (shippedPlans.length > 0) {
    // Labelled `(ctx)` like the lexical leg, and named as a READ instruction:
    // a shipped plan whose name overlaps is a place to look, not a verdict.
    bits.push(`plan(ctx) READ: ${shippedPlans.map((p) => p.slug).join('/')}`);
  }
  const strong = row.lexicalHits.filter((h) => h.strength === 'strong');
  if (strong.length > 0) bits.push(`lexical(ctx): ${strong.map((h) => h.term).join('/')}`);
  if (row.semanticHits.length > 0) bits.push(`semantic: ${row.semanticHits.length}`);
  bits.push(`age ${row.premiseAgeDays.oldest}d`);
  return `${head} — ${bits.join(' · ')}`;
}
