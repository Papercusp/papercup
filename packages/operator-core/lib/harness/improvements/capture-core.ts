/**
 * capture-core.ts — the shared capture verb of the self-improvement loop
 * (papercusp-self-improvement-loop-2026-06-04 D-001 +
 * close-the-self-improvement-loop-2026-06-05 D-002/D-003).
 *
 * ONE implementation of "file a captured papercusp improvement" used by BOTH
 * entry points:
 *   - the agent-facing `improvements:capture` tool (the soft prompt-nudge feed),
 *   - the watchdog's event-driven captures (the hard feed-in, D-003).
 *
 * It owns the capture semantics:
 *   - **search-first dedup** (D-001): surfaces likely-existing items and declines
 *     to create a near-duplicate unless `force` — a nudge + good search, NOT a gate.
 *   - **native `kind`** (close-loop D-002): writes the real `engineer_issues.kind`
 *     column (bug | change). The title-prefix convention is RETIRED. `feature`
 *     captures (net-new, rare) store as kind='change' + `payload.improvementKind:
 *     'feature'` — engineer_issues = work_items[kind ∈ bug|change|task]
 *     (migration 152) and the feature *family* lives in the features base table,
 *     so 'feature' is a display refinement here, not a storage kind.
 *   - **candidate `paths`** (close-loop D-002): stored in `payload.paths` so the
 *     protected-path gate (`classifyImprovement`) actually fires.
 *   - auto-tags the built-in `papercusp-improvement` topic (+ optional sub-topic).
 *
 * Deps are injectable so the core is unit-testable without PG.
 */

import {
  createIssue,
  getIssue,
  searchIssuesForDedup,
  findIssuesByWatchdogKeys,
  updateIssue,
  mergeIssuePayload,
  tagIssue,
  untagIssue,
  type EngineerIssue,
  type IssueSeverity,
  type IssueSource,
  type CreateIssueInput,
} from '../../issues-engineer';
import { findSemanticDupes, type SemanticDupeResult } from '../../agent-tools/work_items/semantic-dupe-guard';
import { IMPROVEMENT_TOPIC, OBSERVATION_TOPIC, issueToCandidate } from './read-items';
import {
  validateObservationRatings,
  validateScorecardCompleteness,
  validateScorecardRatingValues,
  normalizeScorecardRatings,
  type StructuredObservation,
} from './observation-types';
import { getRubric, autoRatifyRubricOnFirstScorecard, type Rubric } from '../../rubrics';
import { titleSimilarity, titleContainment, recallAlreadyDecided, type AlreadyDecidedRecall } from './digest';
import { initializeIdeaLifecycle } from './lifecycle';
import { extractCitedIds } from './triage';
import { DEFAULT_SIGNAL_ORIGIN, effectiveOrigin, type SignalOrigin } from './provenance';
import { isFlakeKey } from '../../calibration/types';

/** The fileable improvement kinds (companion D-001). */
export type ImprovementKind = 'bug' | 'change' | 'feature';

export const DUP_THRESHOLD = 0.6;

/**
 * Fraction of the SHORTER title that must be covered for a candidate to be SURFACED as a
 * containment hit (knowledge-at-symptom-time-2026-08-09 P-007). Advisory-only: a
 * containment hit is never eligible to decline a capture — see `blockEligible` below.
 */
export const CONTAINMENT_THRESHOLD = 0.9;

export interface CaptureImprovementInput {
  /** One-line summary — clean, NO [kind] prefix (kind is a real column now). */
  title: string;
  kind: ImprovementKind;
  body?: string;
  severity?: IssueSeverity;
  /** Optional sub-area topic, e.g. coord-dx, db-tooling. */
  subTopic?: string;
  /** Omit → files under the workspace platform Pot; or 'harness:<slug>' for a specific Pot.
   *  An omitted/'operator'/workspace-global scope auto-homes to the platform Pot in
   *  createIssue (pot-membership-enforcement P-005). Determines per-Hive scope (P-010). */
  scope?: string;
  foundDuring?: string;
  /** Repo-relative paths the improvement touches — feeds the protected-path gate. */
  paths?: string[];
  /** File even if a likely duplicate exists (default false → search-first declines). */
  force?: boolean;
  /** Only run the dedup search, do not create. */
  checkDuplicatesOnly?: boolean;
  /**
   * Which duplicates may DECLINE the create: 'all' (default — agents see every
   * likely dup and decide) or 'open' (only an OPEN dup declines — the watchdog's
   * mode: a RESOLVED duplicate means the problem regressed, so re-file it).
   */
  dedupScope?: 'all' | 'open';
  /**
   * Lowest semantic band eligible to DECLINE this capture. Default `'hard'` —
   * today's behavior, and the right default for a human/agent filing: a soft hit
   * stays advisory because widening the blocking net trades a missed duplicate
   * for a LOST filing, the more expensive failure (see `blockEligible` below).
   *
   * `'soft'` lets a soft-band hit decline too, and is for HIGH-VOLUME MACHINE
   * ideation ONLY — the Scout capture port (`buildCapturePort`), where the
   * trade-off inverts: a declined capture is ATTRIBUTED to the existing sibling
   * (`created:false` + that sibling's id), so nothing is lost, and the generator
   * re-proposes freely. There is no human intent to strand.
   *
   * Measured 2026-08-09 (plan learning-loop-identity-and-consumption-2026-08-08,
   * D-032/D-033): of 507 open Scout-minted items carrying the `improvementBody`
   * template, 407 (80%) had a nearest open sibling in the SOFT band [0.85,0.93)
   * and 64 more in the hard band — only 36 were genuinely novel. The soft band
   * is where this backlog actually comes from.
   *
   * ⚠ Never set this on the agent-facing `improvements:capture` tool: owner
   * constraint D-004 (scorecard-blender-pipeline-fixes-2026-07-11) is that a
   * promotion/dedup gate applies to blender output ONLY, never to direct agent
   * filings.
   */
  semanticBlockBand?: 'hard' | 'soft';
  /**
   * Stable signal identity (`'<source>:<key>'`, or `overwatch:<anomalyKind>` from
   * the Kettle brief — watchdog-audit P-004 / D-001; EI-15448). Stamped into
   * `payload.watchdogKey` so cross-tick dedup is an exact indexed lookup instead
   * of a fuzzy title match. For a NON-observation capture this sharpens the title
   * net: a candidate carrying a DIFFERENT watchdogKey is a different signal and
   * never declines this capture (kills the subset-title false-dedup edge — a
   * nested-path red-test title token-subsetting another).
   *
   * For an `lane:'observation'` capture (EI-15448), this field does something
   * stronger: observations otherwise skip dedup entirely by design (recurrence
   * IS the signal Scout clusters — see `isObservation` below), so a repeat
   * reading of an unresolved condition minted a fresh open row every call,
   * unbounded. Passing `watchdogKey` on an observation capture COALESCES: a
   * still-OPEN prior observation carrying the SAME key is updated in place
   * (`payload.repeatCount` bumped, `lastSeenAt` refreshed, title/body replaced
   * with this call's latest reading) instead of creating a new row. Omit it for
   * a genuinely novel/one-off observation, which still always re-files.
   */
  watchdogKey?: string;
  /**
   * Newest evidence timestamp (ISO) backing this capture (watchdog-audit
   * P-005 / D-002). Under `dedupScope:'open'`, a RESOLVED duplicate normally
   * re-files (regression semantics) — but only when the evidence post-dates the
   * resolution. A resolved dup whose `updatedAt` >= `evidenceAt` declines the
   * capture as 'stale-evidence' (the collector's lookback window still contains
   * pre-fix rows; that is not a regression).
   */
  evidenceAt?: string;
  createdBy?: string;
  /**
   * Atomically CLAIM the created item for this agent id, in the SAME create (WI-5950).
   *
   * The persona tells every agent to file the moment it notices something AND to hold a
   * work-item before it starts editing. Without this, those two instructions conflict:
   * capture could only ever mint an UNCLAIMED row, so filing a bug you were already
   * fixing published your in-progress work to the claimable pool and a peer would
   * duplicate the fix (observed 2026-07-26). Same name/semantics as
   * work_items:create's `assign_to` — the tool layer resolves the literal 'self'
   * before calling, so this is always a concrete ownerId. Omit ⇒ unclaimed (filing
   * stays cheap, which is the common case).
   *
   * Ignored for lane:'observation' — an observation is a sensor reading, not claimable work.
   */
  assignee?: string;
  /**
   * Source role that filed this improvement (P-010 source-tag): 'Queen', 'bee', 'system',
   * 'Scout' (autonomously generated by the Scout loop), or 'human'. Default 'human'.
   * Used to track per-Hive topic lens + who filed it.
   */
  sourceRole?: 'Queen' | 'cup' | 'system' | 'Scout' | 'human';
  /**
   * The filer's resolved fine ROLE (overwatch | queen | scout | bee | worker | su |
   * system | …) for per-role attribution — close-observation-attribution-gap
   * 2026-06-21. Persisted at `payload.filedByRole` so per-role observation analytics
   * (the OverwatchBrief observation panel, Scout's corpus-digest) attribute every
   * observation instead of bucketing ~100% as 'unknown'. Free-form (the fine role),
   * distinct from the narrow `sourceRole` improvement-source enum. The tool handler
   * resolves it from the caller's LIVE coord presence at capture time.
   */
  filedByRole?: string;
  source?: IssueSource;
  /**
   * Learning-signal provenance (frontier P-002/D-002): organic (default) | drill |
   * replay | shadow. Only the frontier loops pass non-organic — a vaccination drill,
   * a replay counterfactual, a shadow ablation. Stored as the real
   * `engineer_issues.signal_origin` column; every learning consumer filters to
   * organic unless explicitly opted in (read-items.ts). Dedup is origin-SCOPED:
   * a candidate with a different origin never declines this capture (a synthetic
   * row must never suppress a real signal, nor a real row a planted drill).
   */
  origin?: SignalOrigin;
  /**
   * Machine-readable finding class (frontier P-044/D-008): a stable
   * `<miner>:<shape>` slug (e.g. `negative-space:resolution-gap`,
   * `regret:process-counterfactual`) identifying WHAT KIND of finding this is,
   * independent of its free-prose title. Stored at `payload.findingClass` and
   * surfaced on ImprovementCandidate so downstream rails can route and count
   * per class — the graduation tracker (P-045/P-046) counts clean passes per
   * findingClass, never per fuzzy title. Automated filers (the miners, the
   * watchdog collectors) should always pass one; interactive captures may omit.
   */
  findingClass?: string;
  /**
   * Capture lane (turn-end-reflection-observations-2026-06-14 D-005). 'improvement'
   * (default) files into the work/triage pipeline. 'observation' files a PRE-IDEA
   * sensor reading into the OBSERVATION_TOPIC lane: it skips blocking dedup
   * (recurrence IS the signal Scout clusters), always stores as a non-bug nit,
   * carries no auto-implement lifecycle, and is read ONLY by Scout's corpus-digest
   * + the Observations pane — it never enters the work queue.
   */
  lane?: 'improvement' | 'observation';
  /**
   * Extra fields merged onto engineer_issues.payload — e.g. an observation's
   * structured { kind, scope, confidence, refs } record (D-005). Generic seam so
   * capture-core stays agnostic to the observation shape.
   */
  payloadExtra?: Record<string, unknown>;
}

export interface PossibleDuplicate {
  id: string;
  title: string;
  state: string;
  severity: string;
  similarity: number;
  /** P-011: present when this candidate arrived via the EMBEDDING net (its
   *  title never crossed the lexical DUP_THRESHOLD — a differently-worded
   *  refile). `similarity` is then the cosine, not titleSimilarity. 'hard'
   *  may decline the capture like a lexical dup; 'soft' is advisory-only. */
  semantic?: 'hard' | 'soft';
  /** P-007 (knowledge-at-symptom-time-2026-08-09): present when this candidate arrived via
   *  the CONTAINMENT net — your (shorter) title is almost entirely covered by this one, but
   *  Jaccard scored below DUP_THRESHOLD because the stored title is much longer. `similarity`
   *  is then the containment coefficient, not titleSimilarity. ALWAYS advisory-only: a
   *  containment hit is surfaced and never declines a capture. */
  lexical?: 'containment';
}

/**
 * What the dedup search actually managed to CHECK (P-007). Without this, an empty
 * `possibleDuplicates` is ambiguous between "checked, nothing similar exists" and
 * "could not check" — and the two demand opposite responses.
 *
 * The embedder-backed leg fails OPEN (returns null on timeout/unavailability), which is
 * correct for availability but silently degrades recall. EI-19502216864373653 measured the
 * cost: an agent read a bare `[]` as "no duplicates", filed, and had to retract minutes
 * later against an open major item filed ~12h earlier.
 */
export interface DedupCoverage {
  /** Token-based title match. Always runs; 'skipped' only for the observation lane. */
  lexical: 'ok' | 'skipped';
  /** Embedding leg. 'unavailable' = it returned no verdict (embedder down / over budget /
   *  disabled), so a differently-worded duplicate would NOT have been found. */
  semantic: 'ok' | 'unavailable' | 'skipped';
  /** True when any leg could not run — i.e. an empty result is NOT a clean bill of health. */
  degraded: boolean;
}

export interface CaptureImprovementResult {
  ok: true;
  created: boolean;
  reason?: 'likely-duplicate' | 'check-only' | 'stale-evidence' | 'coalesced' | 'promoted';
  /** Native engineer_issues storage kind. Always agrees with issue.kind. */
  kind?: 'bug' | 'change';
  /** Caller-facing capture classification; `feature` is stored as kind=`change`. */
  improvementKind?: ImprovementKind;
  issue?: EngineerIssue;
  topics?: string[];
  possibleDuplicates: PossibleDuplicate[];
  /** P-007: what the dedup search could actually check. Read this BEFORE reading an empty
   *  `possibleDuplicates` as "nothing similar exists". */
  dedupCoverage?: DedupCoverage;
  /**
   * "Already decided" recall (self-learning-central P-003): prior RESOLVED/closed
   * items whose STABLE signature matches this capture — so the loop recognises a
   * settled friction before re-proposing it. Distinct from `possibleDuplicates`
   * (raw title-similarity over OPEN+resolved): this is signature-matched and
   * decided-only, and carries the "already decided: <reason>" recall line when one
   * was recorded. Surfaced even when the capture is created (force / genuinely
   * distinct) — it's recall, not a gate.
   */
  alreadyDecided?: AlreadyDecidedRecall[];
  hint?: string;
}

/** Injectable dependency seam (unit tests run without PG). */
export interface CaptureDeps {
  searchIssues: (query: string, limit?: number) => Promise<EngineerIssue[]>;
  createIssue: (input: CreateIssueInput) => Promise<EngineerIssue>;
  /** Load a rubric's criteria for the P-014a scorecard-completeness gate + the P-002
   *  rating-value gate (criterion/rubric ratingScale). OPTIONAL — the gate falls back to
   *  the real getRubric; injectable so tests can stub it (or omit it → PG-free tests skip
   *  the gate via the load-error catch). Returns null for an unknown rubric. */
  loadRubric?: (rubricId: string) => Promise<{
    criteria: { key: string; ratingScale?: readonly string[] }[];
    ratingScale?: readonly string[];
  } | null>;
  /** P-011 semantic-widening seams. OPTIONAL — default to the real P-008 work-item
   *  dupe guard (itself vitest-inert + fail-open) and the real getIssue; injectable
   *  so tests drive the widening without PG or an embedder. */
  findSemanticDupes?: (input: { title: string; summary?: string }) => Promise<SemanticDupeResult | null>;
  getIssue?: (id: string) => Promise<EngineerIssue | null>;
  /** Auto-ratify-on-first-scorecard (WI-5415): OPTIONAL — defaults to the real
   *  rubrics.ts autoRatifyRubricOnFirstScorecard; injectable so tests can assert the
   *  hook fired (and with which args) without touching PG. */
  autoRatifyRubric?: (rubricId: string, graderId: string) => Promise<Rubric | null>;
  /** EI-15448 observation-coalescing seams. OPTIONAL — default to the real
   *  issues-engineer.ts implementations; injectable so tests drive the coalesce
   *  path without PG. */
  findIssuesByWatchdogKeys?: (keys: string[]) => Promise<EngineerIssue[]>;
  updateIssuePatch?: (
    id: string,
    patch: {
      title?: string;
      body?: string;
      severity?: IssueSeverity;
      kind?: 'bug' | 'change';
      silent?: boolean;
      confirmShrink?: boolean;
    },
  ) => Promise<EngineerIssue | null>;
  mergeIssuePayload?: (id: string, patch: Record<string, unknown>) => Promise<EngineerIssue | null>;
  tagIssue?: (id: string, topic: string, by?: string) => Promise<void>;
  untagIssue?: (id: string, topic: string) => Promise<void>;
}

// WI-4308: use the dedup-widened search (also checks the legacy DEFAULT_COORD_WORKSPACE
// for pre-ISSUES_PER_WORKSPACE-flip rows) — see searchIssuesForDedup's doc in issues-engineer.ts.
const defaultDeps: CaptureDeps = {
  searchIssues: searchIssuesForDedup,
  createIssue,
  getIssue,
  loadRubric: getRubric,
  autoRatifyRubric: autoRatifyRubricOnFirstScorecard,
};

/**
 * Capture-time provenance for work-item references in a Scout proposal.
 *
 * This is deliberately metadata rather than a hard capture rejection: a
 * transient resolver outage must not lose a generated signal. Triage performs
 * the authoritative fresh check before admitting `place`; this record makes
 * the capture-time result inspectable and tells downstream readers whether a
 * missing citation was actually checked or merely could not be resolved.
 */
export interface EvidenceIntegrityPayload {
  citedIds: string[];
  resolvedIds: string[];
  unresolvedIds: string[];
  circularIds: string[];
  lookupFailedIds: string[];
  checked: boolean;
}

/** Resolve a Scout proposal's cited work-item ids at capture time (best-effort). */
export async function validateScoutEvidenceCitations(
  text: string,
  resolveIssue?: (id: string) => Promise<EngineerIssue | null>,
): Promise<EvidenceIntegrityPayload | undefined> {
  const citedIds = extractCitedIds(text);
  if (citedIds.length === 0) return undefined;

  const result: EvidenceIntegrityPayload = {
    citedIds,
    resolvedIds: [],
    unresolvedIds: [],
    circularIds: [],
    lookupFailedIds: [],
    checked: Boolean(resolveIssue),
  };
  if (!resolveIssue) return result;

  for (const id of citedIds) {
    try {
      const cited = await resolveIssue(id);
      if (!cited) {
        result.unresolvedIds.push(id);
        continue;
      }
      result.resolvedIds.push(id);
      const payload = cited.payload && typeof cited.payload === 'object' ? (cited.payload as Record<string, unknown>) : {};
      if (payload.sourceRole === 'Scout') result.circularIds.push(id);
    } catch {
      // A resolver outage is recorded for observability but remains fail-open.
      result.lookupFailedIds.push(id);
    }
  }
  return result;
}

/** The native column kind for a capture: feature is a payload refinement of change. */
export function storageKindOf(kind: ImprovementKind): 'bug' | 'change' {
  return kind === 'bug' ? 'bug' : 'change';
}

interface ToolFailureProbationPayload {
  state?: 'probation' | 'promoted';
  reporters?: string[];
  correlationFingerprint?: string;
  intendedKind?: 'bug' | 'change';
  [key: string]: unknown;
}

function toolFailureProbationOf(payload: Record<string, unknown> | null | undefined): ToolFailureProbationPayload | null {
  const candidate = payload?.toolFailureProbation;
  return candidate && typeof candidate === 'object' && !Array.isArray(candidate)
    ? (candidate as ToolFailureProbationPayload)
    : null;
}

/** Promote one exact-key probation row in place, preserving its history/id. */
async function promoteToolFailureProbation(
  prior: EngineerIssue,
  input: CaptureImprovementInput,
  deps: CaptureDeps,
): Promise<EngineerIssue | null> {
  const priorPayload = (prior.payload as Record<string, unknown> | null) ?? {};
  const priorProbation = toolFailureProbationOf(priorPayload) ?? {};
  const incomingProbation = toolFailureProbationOf(input.payloadExtra ?? {}) ?? {};
  const reporters = [...new Set([
    ...(Array.isArray(priorProbation.reporters) ? priorProbation.reporters : []),
    ...(Array.isArray(incomingProbation.reporters) ? incomingProbation.reporters : []),
    ...(input.createdBy ? [input.createdBy] : []),
  ].filter(Boolean))];
  const kind = incomingProbation.intendedKind ?? storageKindOf(input.kind);

  // Change the visible content first while the row is still safely parked. The
  // lane flip is last: if either write fails, a retry cannot expose a half-
  // promoted observation to the scheduler.
  const updatedRaw = await (deps.updateIssuePatch ?? updateIssue)(prior.id, {
    title: input.title,
    body: input.body,
    severity: input.severity ?? (kind === 'bug' ? 'major' : 'minor'),
    kind,
    silent: true,
    confirmShrink: true,
  }).catch(() => null);
  const updated = updatedRaw && 'id' in updatedRaw ? updatedRaw : null;
  if (!updated) return null;
  const promotedAt = new Date().toISOString();
  const merged = await (deps.mergeIssuePayload ?? mergeIssuePayload)(prior.id, {
    lane: null,
    toolFailureProbation: {
      ...priorProbation,
      ...incomingProbation,
      state: 'promoted',
      reporters,
      intendedKind: kind,
      promotedAt,
      promotedBy: input.createdBy ?? 'system:improvement-watchdog',
    },
    ideaLifecycle: initializeIdeaLifecycle(),
  }).catch(() => null);
  if (!merged) return null;
  await (deps.tagIssue ?? tagIssue)(prior.id, IMPROVEMENT_TOPIC, input.createdBy).catch(() => {});
  await (deps.untagIssue ?? untagIssue)(prior.id, OBSERVATION_TOPIC).catch(() => {});
  return merged;
}

export async function captureImprovement(
  input: CaptureImprovementInput,
  deps: CaptureDeps = defaultDeps,
): Promise<CaptureImprovementResult> {
  // Search-first dedup (D-001): full-text search, then a title-similarity pass.
  // Origin-scoped (frontier P-002/D-002): only candidates with the SAME effective
  // origin participate in dedup + decided-recall — a drill row deduping against an
  // organic capture (or vice versa) would let synthetic signals suppress real ones.
  const isObservation = input.lane === 'observation';
  const sourceRole = input.sourceRole ?? 'human';
  // Rubric-grading evidence gate (rubric-driven-observations-2026-06-20 D-002):
  // FAIL FAST — a structured observation whose ratings lack evidence (or whose
  // ratings block names no rubric) is a contract violation, rejected before any
  // dedup/search work. One gate here covers BOTH capture entry points (the
  // improvements:capture tool + the watchdog). Throws ObservationEvidenceError;
  // the tool handler catches it into a clean { ok:false, error } result.
  let observationForGate = input.payloadExtra?.observation as StructuredObservation | undefined;
  validateObservationRatings(observationForGate);
  // P-014a completeness gate (D-005): a rubric-graded scorecard must rate EVERY rubric criterion —
  // an omitted key is a silent truncation, not a pass (D-005 caught 3–4 of 13 keys live). Load the
  // rubric's criterion keys (best-effort: a load error skips the gate, never breaks the capture) +
  // reject on any missing key. validateObservationRatings already enforced per-rating evidence.
  if (
    deps.loadRubric &&
    observationForGate?.rubricRef &&
    observationForGate.ratings &&
    Object.keys(observationForGate.ratings).length > 0
  ) {
    const rubric = await deps.loadRubric(observationForGate.rubricRef).catch(() => null);
    if (rubric) {
      const normalizedRatings = normalizeScorecardRatings(observationForGate.ratings, rubric);
      const rawObservation = input.payloadExtra?.observation as Record<string, unknown>;
      observationForGate = { ...observationForGate, ratings: normalizedRatings };
      input = {
        ...input,
        payloadExtra: {
          ...input.payloadExtra,
          observation: { ...rawObservation, ratings: normalizedRatings },
        },
      };
    }
    validateScorecardCompleteness(observationForGate, rubric ? rubric.criteria.map((c) => c.key) : null);
    // P-002 rating-VALUE gate (rubric-system-improvements-2026-07-12): an off-scale
    // rating ("pas", "helthy") would file fine and be silently excluded from
    // trends/staleness — reject it here with the allowed values instead.
    validateScorecardRatingValues(observationForGate, rubric);
  }
  const origin = input.origin ?? DEFAULT_SIGNAL_ORIGIN;

  // P-013: the invocation-ledger watchdog (or a caller with deterministic
  // reproduction evidence) corroborates an exact-key probation observation.
  // Promote THAT row in place before fuzzy dedup can decline it against itself.
  if (!isObservation && input.watchdogKey) {
    const exact = await (deps.findIssuesByWatchdogKeys ?? findIssuesByWatchdogKeys)([input.watchdogKey]).catch(
      () => [] as EngineerIssue[],
    );
    const probation = exact.find((i) => {
      const payload = (i.payload as Record<string, unknown> | null) ?? {};
      return i.state === 'open' && payload.lane === 'observation' && toolFailureProbationOf(payload)?.state === 'probation';
    });
    if (probation) {
      const promoted = await promoteToolFailureProbation(probation, input, deps);
      if (promoted) {
        return {
          ok: true,
          created: false,
          reason: 'promoted',
          kind: promoted.kind as 'bug' | 'change',
          improvementKind: input.kind,
          issue: promoted,
          topics: [IMPROVEMENT_TOPIC, ...(input.subTopic ? [input.subTopic] : [])],
          possibleDuplicates: [],
          dedupCoverage: { lexical: 'skipped', semantic: 'skipped', degraded: false },
        };
      }
    }
  }
  // Observations skip search-first dedup entirely (D-005): recurrence IS the signal
  // Scout clusters downstream, and the reflecting agent is told not to dedup — so a
  // recurring observation re-files rather than being declined as a duplicate.
  const searched = isObservation
    ? ([] as EngineerIssue[])
    : await deps.searchIssues(input.title, 20).catch(() => [] as EngineerIssue[]);
  const candidates = searched.filter((i) => effectiveOrigin(i.signalOrigin) === origin);

  // P-011 (shared-embedding-sidecar-and-enrichment-2026-07-10): semantic
  // candidate WIDENING. The lexical searchIssues + titleSimilarity net misses
  // a differently-worded refile of the same friction (the P-008 dupe-storm
  // class). Improvements ARE work-items, so the migration-551 vectors already
  // cover them: cosine-band the capture via the shared work-item dupe guard,
  // hydrate the hits into full EngineerIssues, and let them ride the SAME
  // origin / watchdogKey / dedupScope / alreadyDecided rails as lexical
  // candidates. Fail-open (null verdict ⇒ lexical-only) and vitest-inert via
  // the guard itself. A 'hard' hit may DECLINE like a lexical dup; 'soft' is
  // advisory-only (surfaced, never blocks).
  const semanticBand = new Map<string, { similarity: number; band: 'hard' | 'soft' }>();
  // P-007: track whether the embedding leg actually produced a verdict. It fails OPEN
  // (null on timeout / embedder down / disabled), so without this the caller cannot tell
  // a checked-clean [] from a could-not-check [].
  let semanticLeg: DedupCoverage['semantic'] = isObservation ? 'skipped' : 'unavailable';
  if (!isObservation) {
    try {
      const sem = await (deps.findSemanticDupes ?? findSemanticDupes)({
        title: input.title,
        ...(input.body ? { summary: input.body } : {}),
      });
      if (sem) {
        semanticLeg = 'ok';
        for (const band of ['hard', 'soft'] as const) {
          for (const c of sem[band]) if (!semanticBand.has(c.id)) semanticBand.set(c.id, { similarity: c.similarity, band });
        }
        const known = new Set(candidates.map((i) => i.id));
        const fetchIssue = deps.getIssue ?? getIssue;
        for (const id of [...semanticBand.keys()].filter((i) => !known.has(i)).slice(0, 6)) {
          const issue = await fetchIssue(id).catch(() => null);
          if (issue && effectiveOrigin(issue.signalOrigin) === origin) candidates.push(issue);
          else semanticBand.delete(id);
        }
      }
    } catch {
      /* fail-open: the lexical verdict stands */
    }
  }

  const possibleDuplicates: PossibleDuplicate[] = candidates
    .map((i) => {
      const lexical = Math.round(titleSimilarity(input.title, i.title) * 100) / 100;
      const sem = semanticBand.get(i.id);
      // A candidate the lexical net already catches keeps its lexical score and
      // blocking behavior; the semantic flag marks ONLY net-new semantic catches.
      const semanticOnly = sem && lexical < DUP_THRESHOLD;
      // P-007: CONTAINMENT is the third net, and it marks ONLY net-new catches — a
      // candidate already caught lexically or semantically keeps its existing score and
      // behavior, so this can never re-label an existing hit.
      const containment = Math.round(titleContainment(input.title, i.title) * 100) / 100;
      const containmentOnly = !semanticOnly && lexical < DUP_THRESHOLD && containment >= CONTAINMENT_THRESHOLD;
      return {
        id: i.id,
        title: i.title,
        state: i.state,
        severity: i.severity,
        similarity: semanticOnly ? Math.round(sem.similarity * 100) / 100 : containmentOnly ? containment : lexical,
        ...(semanticOnly ? { semantic: sem.band } : {}),
        ...(containmentOnly ? { lexical: 'containment' as const } : {}),
      };
    })
    .filter((d) => d.similarity >= DUP_THRESHOLD || d.semantic !== undefined || d.lexical !== undefined)
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, 5);

  const dedupCoverage: DedupCoverage = {
    lexical: isObservation ? 'skipped' : 'ok',
    semantic: semanticLeg,
    degraded: semanticLeg === 'unavailable',
  };

  // "Already decided" recall (P-003): signature-match this capture against the
  // PRIOR resolved/closed items so a settled friction is recognised before it
  // re-enters the queue. Reads the stable signature (not raw title) via the shared
  // matcher. Recall, not a gate — surfaced even when we create.
  const alreadyDecided = recallAlreadyDecided(input.title, candidates.map(issueToCandidate), {
    excludeId: undefined,
  });

  if (input.checkDuplicatesOnly) {
    return {
      ok: true,
      created: false,
      reason: 'check-only',
      possibleDuplicates,
      dedupCoverage,
      ...(alreadyDecided.length ? { alreadyDecided } : {}),
    };
  }
  // Key-aware title net (watchdog-audit P-004 / D-001): a candidate carrying a
  // DIFFERENT watchdogKey is a different signal — nested-path red-test titles
  // token-subset each other and used to false-decline. A candidate WITHOUT a key
  // stays in the net (legacy items + agent captures).
  const candidateById = new Map(candidates.map((i) => [i.id, i]));
  const candidateKeyOf = (id: string): string | null => {
    const p = candidateById.get(id)?.payload;
    const k = p && typeof p === 'object' ? (p as Record<string, unknown>).watchdogKey : undefined;
    return typeof k === 'string' ? k : null;
  };
  // P-011: a soft semantic hit is advisory-only — visible in possibleDuplicates,
  // never eligible to decline the capture (mirrors the create-time work-item
  // guard's soft band → similarOpen contract).
  // P-007: a CONTAINMENT hit is advisory-only, exactly like a soft semantic hit. Widening
  // the surfacing net is cheap (you see one more candidate); widening the BLOCKING net
  // trades a missed duplicate for a LOST filing, which is the more expensive failure —
  // and containment is asymmetric, so a broad stored title covers many narrow real ones.
  // `semanticBlockBand:'soft'` (Scout's port only — see the option's doc) opts INTO
  // letting a soft hit decline. Containment stays advisory in BOTH modes: it is
  // asymmetric (a broad stored title covers many narrow real ones), so it is not a
  // similarity band and widening it would not be the same trade.
  const softMayBlock = input.semanticBlockBand === 'soft';
  const blockEligible = possibleDuplicates.filter(
    (d) => (softMayBlock || d.semantic !== 'soft') && d.lexical !== 'containment',
  );
  const compatible = input.watchdogKey
    ? blockEligible.filter((d) => {
        const ck = candidateKeyOf(d.id);
        return ck == null || ck === input.watchdogKey;
      })
    : blockEligible;

  let blockingDuplicates: PossibleDuplicate[];
  let declineReason: 'likely-duplicate' | 'stale-evidence' = 'likely-duplicate';
  let declineHint =
    'This looks already filed — comment on / claim the existing item, or re-run with force:true if it is genuinely distinct.';
  if (input.dedupScope === 'open') {
    blockingDuplicates = compatible.filter((d) => d.state === 'open');
    if (blockingDuplicates.length === 0 && input.evidenceAt) {
      // P-005 / D-002: a RESOLVED dup re-files only on evidence NEWER than the
      // resolution. Collector lookback windows still contain pre-fix rows; when
      // the newest evidence pre-dates the dup's resolution, decline — that is
      // stale evidence, not a regression. Unparseable timestamps fail open
      // (re-file): a phantom re-file beats a suppressed real regression.
      const evidenceMs = Date.parse(input.evidenceAt);
      const staleResolved = compatible.filter((d) => {
        if (d.state === 'open') return false;
        const resolvedMs = Date.parse(candidateById.get(d.id)?.updatedAt ?? '');
        return Number.isFinite(evidenceMs) && Number.isFinite(resolvedMs) && resolvedMs >= evidenceMs;
      });
      if (staleResolved.length > 0) {
        blockingDuplicates = staleResolved;
        declineReason = 'stale-evidence';
        declineHint =
          'A resolved duplicate exists and the newest evidence pre-dates its resolution — stale lookback-window evidence, not a regression. Re-file with force:true only if the problem genuinely recurred.';
      }
    }
  } else {
    blockingDuplicates = compatible;
  }
  if (blockingDuplicates.length > 0 && !input.force) {
    return {
      ok: true,
      created: false,
      reason: declineReason,
      possibleDuplicates,
      dedupCoverage,
      ...(alreadyDecided.length ? { alreadyDecided } : {}),
      hint: declineHint,
    };
  }

  // Per-Hive topic lens (P-010): add sourceRole to topics when it differs from default.
  // Observations file the DISTINCT OBSERVATION_TOPIC lane (D-005) so they stay out of
  // the work/triage pipeline by construction — no topic:IMPROVEMENT_TOPIC reader sees them.
  const baseTopic = isObservation ? OBSERVATION_TOPIC : IMPROVEMENT_TOPIC;
  const topics = [baseTopic, ...(input.subTopic ? [input.subTopic] : [])];
  if (sourceRole !== 'human') {
    topics.push(`improvement-source:${sourceRole}`);
  }

  // EI-15448: an observation capture carrying a stable `watchdogKey` COALESCES onto
  // its existing OPEN row (bump repeatCount, refresh lastSeenAt + title/body) instead
  // of minting a fresh row every call — observations otherwise skip dedup entirely by
  // design (recurrence IS the signal Scout clusters, `isObservation` branch below), so
  // a repeat reading of an unresolved condition (e.g. the Kettle's escalation-aging
  // drift) self-inflated the backlog to 7k+ near-identical open items. A caller that
  // omits the key keeps the original always-re-file behavior — correct for a genuinely
  // novel/one-off reading.
  if (isObservation && input.watchdogKey) {
    const priorHits = await (deps.findIssuesByWatchdogKeys ?? findIssuesByWatchdogKeys)([input.watchdogKey]).catch(
      () => [] as EngineerIssue[],
    );
    const prior = priorHits.find(
      (i) => i.state === 'open' && (i.payload as Record<string, unknown> | undefined)?.lane === 'observation',
    );
    if (prior) {
      const priorPayload = (prior.payload as Record<string, unknown>) ?? {};
      const priorProbation = toolFailureProbationOf(priorPayload);
      const incomingProbation = toolFailureProbationOf(input.payloadExtra ?? {});
      const priorReporters = Array.isArray(priorProbation?.reporters) ? priorProbation.reporters : [];
      const incomingReporters = Array.isArray(incomingProbation?.reporters) ? incomingProbation.reporters : [];
      const reporters = [...new Set([...priorReporters, ...incomingReporters, ...(input.createdBy ? [input.createdBy] : [])])];
      const independentReporter = reporters.some((r) => !priorReporters.includes(r));
      if (priorProbation?.state === 'probation' && incomingProbation && priorReporters.length > 0 && independentReporter) {
        const promoted = await promoteToolFailureProbation(prior, input, deps);
        if (promoted) {
          return {
            ok: true,
            created: false,
            reason: 'promoted',
            kind: promoted.kind as 'bug' | 'change',
            improvementKind: input.kind,
            issue: promoted,
            topics: [IMPROVEMENT_TOPIC, ...(input.subTopic ? [input.subTopic] : [])],
            possibleDuplicates,
            dedupCoverage,
            ...(alreadyDecided.length ? { alreadyDecided } : {}),
          };
        }
      }
      const repeatCount = (typeof priorPayload.repeatCount === 'number' ? priorPayload.repeatCount : 1) + 1;
      const mergePatch: Record<string, unknown> = {
        watchdogKey: input.watchdogKey,
        repeatCount,
        lastSeenAt: new Date().toISOString(),
      };
      if (input.payloadExtra) Object.assign(mergePatch, input.payloadExtra);
      if (priorProbation && incomingProbation) {
        mergePatch.toolFailureProbation = {
          ...priorProbation,
          ...incomingProbation,
          reporters,
          lastSeenAt: new Date().toISOString(),
        };
      }
      if (input.filedByRole) mergePatch.filedByRole = input.filedByRole;
      if (sourceRole !== 'human') mergePatch.sourceRole = sourceRole;
      const merged = await (deps.mergeIssuePayload ?? mergeIssuePayload)(prior.id, mergePatch);
      // Best-effort title/body refresh — never blocks the coalesce (a shrink-guard
      // trip or transient error just keeps the prior text; the payload bump above is
      // the load-bearing part). Silent: a routine status refresh shouldn't fan out
      // subscriber notifications every wake.
      const refreshed = await (deps.updateIssuePatch ?? updateIssue)(prior.id, {
        title: input.title,
        body: input.body,
        silent: true,
        confirmShrink: true,
      }).catch(() => null);
      const finalIssue = (refreshed && 'id' in refreshed ? refreshed : merged) ?? prior;
      return {
        ok: true,
        created: false,
        reason: 'coalesced',
        kind: finalIssue.kind as 'bug' | 'change',
        improvementKind: input.kind,
        issue: finalIssue,
        topics,
        possibleDuplicates,
        dedupCoverage,
        ...(alreadyDecided.length ? { alreadyDecided } : {}),
      };
    }
  }

  // Kind-specific payload: the 'feature' refinement + candidate paths (close-loop D-002) + sourceRole (P-010).
  const payload: Record<string, unknown> = {};
  if (isObservation) {
    // A PRE-IDEA sensor reading (D-005): mark the lane; carry no auto-implement
    // lifecycle / paths — it is never dispatchable. Structured fields ride payloadExtra.
    payload.lane = 'observation';
    // EI-15448: stamp the key on first filing too, so the NEXT repeat call's
    // findIssuesByWatchdogKeys lookup above actually finds this row.
    if (input.watchdogKey) payload.watchdogKey = input.watchdogKey;
  } else {
    if (input.kind === 'feature') payload.improvementKind = 'feature';
    if (input.paths?.length) payload.paths = input.paths;
    // Stable signal identity (watchdog-audit P-004 / D-001): the indexed cross-tick
    // dedup key the watchdog pre-filters against (findIssuesByWatchdogKeys).
    if (input.watchdogKey) payload.watchdogKey = input.watchdogKey;
    // Machine-readable finding class (frontier P-044/D-008) — the taxonomy slug
    // the triage/graduation rails route and count by.
    if (input.findingClass) payload.findingClass = input.findingClass;
    // Idea lifecycle starts at capture (self-learning P-031): open → triaged → applied
    // → verified/recurred. triage-core / resolve-core / the decay sweep advance it.
    payload.ideaLifecycle = initializeIdeaLifecycle();
  }
  // P-010 source-tag: track who filed this for per-Hive analytics
  if (sourceRole !== 'human') payload.sourceRole = sourceRole;
  // Filer-role attribution (close-observation-attribution-gap 2026-06-21): stamp the
  // caller's resolved fine role so per-role observation analytics group it instead of
  // bucketing 'unknown'. Stored for BOTH lanes — every capture has a filer worth
  // attributing. Read back by the OverwatchBrief observation panel (compute.ts).
  if (input.filedByRole) payload.filedByRole = input.filedByRole;
  // Structured-field seam (D-005): the observation's { kind, scope, confidence, refs }.
  if (input.payloadExtra) Object.assign(payload, input.payloadExtra);

  // EI-19450720466036446: generated Scout proposals must resolve their cited
  // work-items before those citations can be treated as incident evidence.
  // Keep capture fail-open (metadata records resolver failures); triage makes
  // the fresh place→gate decision from the live rows.
  if (!isObservation && sourceRole === 'Scout') {
    const evidenceIntegrity = await validateScoutEvidenceCitations(
      `${input.title}\n${input.body ?? ''}`,
      deps.getIssue,
    );
    if (evidenceIntegrity) payload.evidenceIntegrity = evidenceIntegrity;
  }

  const issue = await deps.createIssue({
    title: input.title,
    kind: isObservation ? 'change' : storageKindOf(input.kind),
    body: input.body,
    severity: input.severity ?? (isObservation ? 'nit' : input.kind === 'bug' ? 'major' : 'minor'),
    scope: input.scope,
    topics,
    foundDuring: input.foundDuring,
    createdBy: input.createdBy,
    // WI-5950: atomic claim-on-file. An observation is a sensor reading, never claimable
    // work, so it never carries an assignee however the caller asked.
    ...(input.assignee && !isObservation ? { assignee: input.assignee, assignedBy: input.createdBy } : {}),
    source: input.source,
    signalOrigin: origin,
    payload: Object.keys(payload).length > 0 ? payload : undefined,
  });
  // Push the right Learning-tab feed (operator-learning-tab-2026-06-09 P-002 /
  // observations P-044). Fire-and-forget via a lazy import so the pure, PG-free
  // capture core (+ its unit tests) never statically depend on the SSE layer.
  void import('../../sync-sse')
    .then((m) => m.notifySyncInvalidate(isObservation ? 'learning.observations' : 'learning.improvements'))
    .catch(() => {});
  // Push-on-write for the Health tab's observations/improvements panels
  // (stop-discarded-dedup-and-audit-server-polling-2026-07-26 P-013 / D-007):
  // refresh the cached panel now instead of waiting up to 30s for the next
  // health tick to notice this write. Same lazy fire-and-forget discipline —
  // a cold health cache (or the flag off) makes this a safe no-op.
  void import('../../system-health/compute')
    .then((m) => m.refreshHealthPanel(isObservation ? 'observations' : 'improvements'))
    .catch(() => {});
  // Calibration bet on flake-shaped signals (frontier P-041 / FB-13): filing a
  // flake IS the natural moment to bet on its recurrence. Same lazy
  // fire-and-forget discipline as above (the seam is flag-gated + never-throw
  // inside recordPrediction); origin rides along so a drill's bet stays
  // partitioned from organic scoring (D-002).
  const flakeKey = input.watchdogKey;
  if (flakeKey && isFlakeKey(flakeKey)) {
    const flakePredictor = input.createdBy ?? sourceRole;
    const flakeSubjectId = issue.id;
    void import('../../calibration/capture')
      .then((m) =>
        m.recordPrediction({
          predictor: flakePredictor,
          domain: 'flake-recurrence',
          subjectKind: 'improvement',
          subjectId: flakeSubjectId,
          claim: `flake ${flakeKey} re-captures within the horizon`,
          watchdogKey: flakeKey,
          origin,
          // P-002 pot-scope: a 'harness:<slug>' scope names the owning-pot grain;
          // other scopes (operator/workspace-global) resolve via the env home pot.
          harnessSlug: input.scope?.startsWith('harness:')
            ? input.scope.slice('harness:'.length)
            : null,
        }),
      )
      .catch(() => {});
  }
  // Auto-ratify-on-first-scorecard (WI-5415): a scorecard just landed against
  // `observationForGate.rubricRef` — if that rubric is still `proposed`, grading it IS
  // adoption (owner ask 2026-07-19). Awaited (not fire-and-forget) so the ratification
  // is visible the moment this capture returns, but never lets a ratify failure fail
  // the scorecard write itself — the underlying function already never throws.
  if (isObservation && observationForGate?.rubricRef && input.createdBy) {
    await (deps.autoRatifyRubric ?? autoRatifyRubricOnFirstScorecard)(
      observationForGate.rubricRef,
      input.createdBy,
    ).catch(() => null);
  }

  return {
    ok: true,
    created: true,
    kind: issue.kind as 'bug' | 'change',
    improvementKind: input.kind,
    issue,
    topics,
    possibleDuplicates,
    dedupCoverage,
    ...(alreadyDecided.length ? { alreadyDecided } : {}),
  };
}
