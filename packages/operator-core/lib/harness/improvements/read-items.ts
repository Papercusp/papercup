/**
 * read-items.ts — the SINGLE repointable seam between the self-improvement loop
 * and the work-unit storage (papercusp-self-improvement-loop-2026-06-04 +
 * close-the-self-improvement-loop-2026-06-05 D-002).
 *
 * The capture unit is an `engineer_issue` = work_item[kind ∈ bug|change]
 * (unify-work-items migration 142/152). The loop reads candidates through
 * `readImprovementItems`, so any future storage move stays a one-function repoint.
 *
 * `kind` is the REAL `engineer_issues.kind` column now (close-loop D-002) — the
 * old `[kind]` title-prefix convention + its `deriveKind` parser are RETIRED
 * (legacy prefixed rows were backfilled + stripped by the close-loop migration).
 * Two payload refinements ride `engineer_issues.payload`:
 *   - `improvementKind: 'feature'` — a net-new capture (display refinement of
 *     kind='change'; the feature *family* lives in the features base table).
 *   - `paths: string[]` — candidate implementation paths (the protected-path gate).
 *   - `implementAttempts` / `needsHuman` — the auto-implement loop's lifecycle
 *     (anti-re-dispatch counter + the explicit human-routing flag, D-001).
 */

import {
  countIssues,
  listIssueScopes,
  listIssues,
  type EngineerIssue,
  type IssueState,
  type ListIssueScopesFilter,
  type ListIssuesFilter,
} from '../../issues-engineer';
import type { ImprovementCandidate, ImprovementState, WorkItemKind } from './policy';
import { isSignalOrigin, originAllowed, ORGANIC_ONLY, type SignalOrigin } from './provenance';
import { asStructuredObservation } from './observation-types';

/** Collapse the richer 8-value `IssueState` (unify-work-items) onto the
 *  domain-free 3-value `LifecycleState` (open|resolved|closed) that
 *  `ImprovementCandidate.state` is typed as (P-007 canonical lifecycle
 *  vocabulary). Every non-terminal issue state reads as 'open' — every
 *  downstream consumer of candidate.state only ever checks `=== 'open'`, so
 *  the wip/blocked/needs-human distinction is deliberately NOT surfaced
 *  here; 'done'/'resolved' → 'resolved', 'dropped'/'closed' → 'closed'
 *  mirrors the resolved/closed→done/dropped aliasing issues-engineer.ts
 *  documents at IssueState's definition. */
function toLifecycleState(state: IssueState): ImprovementState {
  if (state === 'done' || state === 'resolved') return 'resolved';
  if (state === 'dropped' || state === 'closed') return 'closed';
  return 'open';
}

/** The built-in capture/triage lens topic (D-003). */
export const IMPROVEMENT_TOPIC = 'papercusp-improvement';

/**
 * The observation-lane topic (turn-end-reflection-observations-2026-06-14 D-005).
 * Observations are PRE-IDEAS — a turn-end reflection's sensor reading. They reuse
 * the engineer_issues store but are tagged THIS distinct topic, so they are
 * invisible to every `topic: IMPROVEMENT_TOPIC` reader (the digest, triage, the
 * auto-implement lane, the `/adv/create` improvement facet) BY CONSTRUCTION — no
 * per-consumer exclusion filter to maintain. The ONLY consumers are Scout's
 * corpus-digest (via `readObservationItems`, unioned into the friction lane) and
 * the browse-only Observations pane. An observation reaches work solely by Scout
 * clustering a RECURRING one and promoting it to a real `improvements:capture`
 * idea — a one-off reflection can never enter the work queue.
 */
export const OBSERVATION_TOPIC = 'papercusp-observation';

/**
 * The CANONICAL identity of the observation population (P-006 / D-031).
 *
 * `OBSERVATION_TOPIC` above is still written on capture, but it is a LABEL — reads
 * select on this lane value, which is a stored generated column (`payload->>'lane'`)
 * on the row itself. The two disagreed by 834 rows when measured on 2026-08-09, in
 * both directions, and the same column is what `excludeObservationLane` keys on — so
 * selecting by lane is what makes "kept out of the work queue" and "read as an
 * observation" the same set. Full measurement: `ListIssuesFilter.lane`.
 */
export const OBSERVATION_LANE = 'observation';

/** Typed view over the kind-specific payload the improvement loop writes. */
interface ImprovementPayload {
  improvementKind?: string;
  paths?: unknown;
  implementAttempts?: unknown;
  needsHuman?: unknown;
  /** One-line "already decided: <reason>" recall for the recurrence matcher
   *  (self-learning P-003) — set when an item is resolved/closed with a durable
   *  rationale worth recalling on the next same-signature capture. */
  decidedReason?: unknown;
  /** P-010 source-tag: Queen, bee, system, or human — tracks who filed this improvement. */
  sourceRole?: unknown;
  /** Idea-lifecycle journey (self-learning P-030/P-031) — written by capture/triage-core/resolve-core/decay. */
  ideaLifecycle?: unknown;
  /** Stable watchdog signal identity ('<source>:<key>' — watchdog-audit P-004). */
  watchdogKey?: unknown;
  /** Machine-readable finding class ('<miner>:<shape>' — frontier P-044/D-008). */
  findingClass?: unknown;
  /** The structured-observation v2 record (rubric-driven-observations-2026-06-20
   *  P-001 / D-003) — payload.observation, surfaced onto the candidate for Scout (P-006). */
  observation?: unknown;
  /** IDEATE-pass provenance (su-ideate-learning-substrate-2026-07-10 P-007) —
   *  payload.ideation { lens, bet, cheapExperiment }, persisted at capture and
   *  surfaced onto the candidate for the bettable-first ranking feature. */
  ideation?: unknown;
  /** EI-1404: parsed quota/rate-limit reset instant (ISO) — see policy.ts's
   *  ImprovementCandidate.dispatchHoldUntil doc. */
  dispatchHoldUntil?: unknown;
}

function payloadOf(issue: EngineerIssue): ImprovementPayload {
  return issue.payload && typeof issue.payload === 'object' ? (issue.payload as ImprovementPayload) : {};
}

/** Map an engineer_issue → the storage-agnostic ImprovementCandidate. */
export function issueToCandidate(issue: EngineerIssue): ImprovementCandidate {
  const p = payloadOf(issue);
  const kind: WorkItemKind = p.improvementKind === 'feature' ? 'feature' : (issue.kind as WorkItemKind);
  const paths = Array.isArray(p.paths) ? p.paths.filter((x): x is string => typeof x === 'string') : undefined;
  const attempts = typeof p.implementAttempts === 'number' ? p.implementAttempts : undefined;
  const decidedReason = typeof p.decidedReason === 'string' && p.decidedReason.trim() ? p.decidedReason : undefined;
  const sourceRole = typeof p.sourceRole === 'string' ? (p.sourceRole as 'Queen' | 'cup' | 'system' | 'Scout' | 'human') : undefined;
  // Structured-observation v2 view (rubric-driven-observations-2026-06-20 P-001 /
  // D-003) — surfaced from payload.observation so Scout's corpus-digest (P-006)
  // reads rubric ratings + source-hive without re-parsing the raw payload.
  // Undefined on non-observation / free-text rows.
  const observation = asStructuredObservation(p.observation);
  const ideation = asCandidateIdeation(p.ideation);
  const dispatchHoldUntil =
    typeof p.dispatchHoldUntil === 'string' && !Number.isNaN(Date.parse(p.dispatchHoldUntil)) ? p.dispatchHoldUntil : undefined;
  return {
    id: issue.id,
    kind,
    scope: issue.scope,
    title: issue.title,
    body: issue.body,
    severity: issue.severity,
    state: toLifecycleState(issue.state),
    assignee: issue.assignee,
    assignedAt: issue.assignedAt,
    createdAt: issue.createdAt,
    updatedAt: issue.updatedAt,
    // The filer's ownerId — the "distinct authors" axis for Scout's rubric-gap
    // detection (plan-templates-and-rubric-v2 P-008). Surfaced when present.
    ...(issue.createdBy ? { createdBy: issue.createdBy } : {}),
    ...(paths?.length ? { paths } : {}),
    ...(attempts !== undefined ? { attempts } : {}),
    ...(p.needsHuman === true ? { needsHuman: true } : {}),
    ...(decidedReason ? { decidedReason } : {}),
    ...(sourceRole ? { sourceRole } : {}),
    ...(isIdeaLifecycle(p.ideaLifecycle) ? { ideaLifecycle: p.ideaLifecycle } : {}),
    ...(typeof p.watchdogKey === 'string' && p.watchdogKey ? { watchdogKey: p.watchdogKey } : {}),
    ...(typeof p.findingClass === 'string' && p.findingClass ? { findingClass: p.findingClass } : {}),
    ...(isSignalOrigin(issue.signalOrigin) ? { origin: issue.signalOrigin } : {}),
    // EI-15659: federation provenance (DISTINCT from the SignalOrigin `origin`
    // field above) — surfaced only when 'remote' so the risk-tier policy can
    // exclude a remote-authored row from this node's auto-eligible lane (it can
    // never be terminal-completed here; see policy.ts's workItemOrigin gate).
    ...(issue.origin === 'remote' ? { workItemOrigin: 'remote' as const } : {}),
    ...(observation ? { observation } : {}),
    ...(ideation ? { ideation } : {}),
    ...(dispatchHoldUntil ? { dispatchHoldUntil } : {}),
  };
}

/**
 * Narrow an unknown payload.ideation to the CandidateIdeation view (P-007) —
 * string fields only, junk shapes read as absent (enrichment must never make a
 * candidate read throw). Returns undefined when nothing substantive survives,
 * so legacy / non-ideation rows stay byte-identical candidates.
 */
function asCandidateIdeation(v: unknown): ImprovementCandidate['ideation'] {
  if (!v || typeof v !== 'object') return undefined;
  const o = v as Record<string, unknown>;
  const str = (x: unknown): string | undefined => (typeof x === 'string' && x.trim() ? x : undefined);
  const lens = str(o.lens);
  const bet = str(o.bet);
  let cheapExperiment: NonNullable<ImprovementCandidate['ideation']>['cheapExperiment'];
  if (o.cheapExperiment && typeof o.cheapExperiment === 'object') {
    const e = o.cheapExperiment as Record<string, unknown>;
    const hypothesis = str(e.hypothesis);
    const method = str(e.method);
    const falsifiableSignal = str(e.falsifiableSignal);
    if (hypothesis || method || falsifiableSignal) {
      cheapExperiment = {
        ...(hypothesis ? { hypothesis } : {}),
        ...(method ? { method } : {}),
        ...(falsifiableSignal ? { falsifiableSignal } : {}),
      };
    }
  }
  if (!lens && !bet && !cheapExperiment) return undefined;
  return { ...(lens ? { lens } : {}), ...(bet ? { bet } : {}), ...(cheapExperiment ? { cheapExperiment } : {}) };
}

/** Narrow an unknown payload field to the lifecycle shape (cheap structural check). */
function isIdeaLifecycle(v: unknown): v is import('./lifecycle').IdeaLifecyclePayload {
  return (
    !!v &&
    typeof v === 'object' &&
    typeof (v as { state?: unknown }).state === 'string' &&
    typeof (v as { stateUpdatedAt?: unknown }).stateUpdatedAt === 'string'
  );
}

export interface ReadImprovementOpts {
  /** Restrict to a lifecycle state (default: all states, so rollups + dedup see resolved too). */
  state?: 'open' | 'resolved' | 'closed';
  limit?: number;
  /**
   * ISO timestamp — rows created STRICTLY before it (WI-39455, the stale-tail
   * selector). The underlying read is newest-first + capped, so an age-out consumer
   * without this filter only ever sees a recency window and old rows are structurally
   * invisible (the WI-4532 class). See {@link ListIssuesFilter.createdBefore}.
   */
  createdBefore?: string;
  /**
   * Read the newest `limit` rows independently for every represented scope.
   * The default global recency window can hide older scopes before recurrence
   * grouping runs; this mode is for cross-scope consumers such as recurrence
   * escalation (WI-9454).
   */
  windowPerScope?: boolean;
  /**
   * P-008 (db-performance-remediation-2026-07-26): skip the `body` column for a
   * consumer that never reads `candidate.body`. Default (omitted) keeps it, so this
   * is opt-OUT per caller — see {@link ListIssuesFilter.includeBody} for the measured
   * numbers (body is 76% of this read's bytes) and for why slicing it is SLOWER than
   * either keeping or dropping it.
   *
   * ⚠ Check before flipping a caller: `ImprovementCandidate.body` is `body?: string`,
   * so a consumer that reads it will NOT fail to compile — it will silently see an
   * empty body. Real readers today are triage / triage-core / digest / policy /
   * reversibility / watchdog-key-migration / recurrence-escalation (all doing
   * `title + body` text matching). Verify the whole downstream path, not just the
   * immediate caller.
   */
  includeBody?: boolean;
  /** (P-010) Restrict to a specific harness scope. Omit for all scopes (papercusp + all harnesses). */
  harnessSlug?: string;
  /**
   * (per-hive-learning-loops P-040) Restrict to a SET of harness scopes — the
   * member-harness scopes of one Hive (`['harness:<home>', 'harness:<member>', …]`,
   * the Hive being the tenancy unit, D-008). Takes precedence over `harnessSlug`
   * when both are set. Omit for all scopes. An empty array matches NOTHING (a Hive
   * with no member harnesses has no improvements of its own).
   */
  harnessScopes?: readonly string[];
  /**
   * Signal-provenance allowlist (frontier P-002/D-002). DEFAULT: organic only —
   * synthetic rows (drill/replay/shadow) never reach a learning consumer unless
   * it explicitly opts in here (e.g. the vaccination measurement loop passes
   * ['drill']; an all-origins inspection read passes SIGNAL_ORIGINS).
   */
  origins?: readonly SignalOrigin[];
  /**
   * Restrict to what the LEARNING LOOP produced — the Improve view's scope
   * (learning-tab-surface-public-release-2026-07-27 P-001 / D-002).
   *
   * Without it, the improvement topic is the whole captured corpus: 8,272 rows, of
   * which 8,202 also render in the Work tab (99.93% — measured 2026-07-27). That
   * duplication is the entire reason the Learning tab's Improve list needed scoping;
   * "everything tagged `papercusp-improvement`" is a topic, not a provenance.
   *
   * Resolves via {@link ReadImprovementDeps.readLoopOutputIds} (the three-record
   * union — see `loop-output.ts`) and is applied as a SQL `issueIds` predicate, so
   * `limit` still bounds the SCOPED set rather than the corpus.
   */
  loopOutputOnly?: boolean;
}

/** Injectable dependency seam so the adapter is unit-testable without PG. */
export interface ReadImprovementDeps {
  listIssues: (filter: ListIssuesFilter) => Promise<EngineerIssue[]>;
  /** Resolves the distinct scopes before a per-scope recency window is read. */
  listScopes?: (filter: ListIssueScopesFilter) => Promise<readonly string[]>;
  /**
   * Resolves the learning-loop provenance union — required ONLY when
   * {@link ReadImprovementOpts.loopOutputOnly} is set.
   *
   * OPTIONAL on purpose: making it required would instantly stale every fixture
   * constructing `ReadImprovementDeps` across the tree — in files this change never
   * touches, which neither `test:affected` nor the per-file tsc baseline selects.
   * That is the exact trap this file already documents at {@link CountObservationDeps}
   * and CLAUDE.md calls out as the #1 cause of silent cross-tree breakage.
   */
  readLoopOutputIds?: () => Promise<readonly string[]>;
}

const defaultDeps: ReadImprovementDeps = {
  listIssues,
  listScopes: listIssueScopes,
  readLoopOutputIds: async () => (await (await import('./loop-output')).readLoopOutputIds()).ids,
};

/**
 * Deps for {@link countObservationFilingsSince}. Deliberately a SEPARATE, narrow type
 * rather than a new field on {@link ReadImprovementDeps}: adding a required member to
 * that shared interface would instantly stale every fixture that constructs it across
 * the tree — in files this change never touches, which neither `test:affected` nor the
 * per-file tsc baseline would select (the exact trap called out in CLAUDE.md).
 */
export interface CountObservationDeps {
  countIssues: (filter: ListIssuesFilter) => Promise<number>;
}

const defaultCountDeps: CountObservationDeps = { countIssues };

/**
 * Read every captured improvement (tagged the `papercusp-improvement` topic) as
 * storage-agnostic candidates. THE repoint point for any future storage move.
 * (P-010) Supports per-Hive scope filtering via harnessSlug.
 */
export async function readImprovementItems(
  opts: ReadImprovementOpts = {},
  deps: ReadImprovementDeps = defaultDeps,
): Promise<ImprovementCandidate[]> {
  return readBySelector({ topic: IMPROVEMENT_TOPIC }, opts, deps);
}

/**
 * Deps for {@link countImprovementItems}. A separate narrow type, same rationale as
 * {@link CountObservationDeps} below: adding a required member to the shared
 * {@link ReadImprovementDeps} would instantly stale every fixture that constructs it
 * across the tree.
 */
export interface CountImprovementDeps {
  countIssues: (filter: ListIssuesFilter) => Promise<number>;
  /**
   * Resolves the learning loop's own output ids, so a `loopOutputOnly` count is
   * taken over the SAME population the matching read returns. OPTIONAL for the
   * same reason as {@link ReadImprovementDeps.readLoopOutputIds} — a required
   * member would instantly stale every fixture constructing this type across the
   * tree, in files neither `test:affected` nor the per-file tsc baseline selects.
   */
  readLoopOutputIds?: () => Promise<readonly string[]>;
}

const defaultCountImprovementDeps: CountImprovementDeps = {
  countIssues,
  readLoopOutputIds: async () => (await (await import('./loop-output')).readLoopOutputIds()).ids,
};

/**
 * The TRUE corpus total for the SAME filter {@link readImprovementItems} applies —
 * a SQL `COUNT(*)`, not bounded by `limit` and never materialising a row
 * (EI-18790490225750395 D2: `improvements:digest`'s `digest.total` was reporting
 * the WINDOW size — it exactly tracked whatever `limit` the caller passed, 5/30/200
 * in the filed repro — because `buildDigest`'s `total` is just `candidates.length`
 * over whatever `readImprovementItems` happened to fetch. A caller reading
 * `total: 30` reasonably read it as "30 captured", when the true corpus was far
 * larger).
 *
 * `harnessScopes` (a per-Hive SET of scopes) sums one `COUNT` per scope — the
 * shared `countIssues`/`listIssues` SQL only supports a single `scope` equality,
 * not an IN-list — cheap since a Hive's member-harness set is small (unlike the
 * corpus itself). `harnessSlug` (a single scope) is one direct `COUNT`.
 *
 * `loopOutputOnly` is NOT supported here (no current caller needs it for a count):
 * fails loudly rather than silently counting the whole untagged corpus under a
 * name that promises the loop's scoped output, mirroring {@link readByTopic}'s own
 * fail-loud stance on the same option.
 */
export async function countImprovementItems(
  opts: ReadImprovementOpts = {},
  deps: CountImprovementDeps = defaultCountImprovementDeps,
): Promise<number> {
  const origins = opts.origins ?? ORGANIC_ONLY;
  const base: ListIssuesFilter = {
    topic: IMPROVEMENT_TOPIC,
    state: opts.state,
    signalOrigins: origins,
  };
  // Learning-loop provenance scope — resolved to the SAME `issueIds` predicate
  // readBySelector applies, so this count is taken over exactly the population
  // the matching read returns. Previously this threw ("no caller needs it yet");
  // the Learning tab is that caller (WI-39675): its default scope IS 'loop', so
  // without this the tab could only report the WINDOW size as its total.
  //
  // The fail-loud stance is kept, not softened: a missing dep still throws rather
  // than counting the whole untagged corpus under a name that promises the loop's
  // output — that would reinstate the 8,202-row Work-tab duplication this option
  // exists to remove, and it would be WORSE than the window bug, because a total
  // larger than the truth reads as a plausible corpus count.
  if (opts.loopOutputOnly) {
    if (!deps.readLoopOutputIds) {
      throw new Error(
        'countImprovementItems: loopOutputOnly requires deps.readLoopOutputIds (see improvements/loop-output.ts)',
      );
    }
    const loopIds = await deps.readLoopOutputIds();
    // Mirrors the harnessScopes empty-set rule below: an empty id set matches
    // nothing, and must not degrade to an unscoped count.
    if (loopIds.length === 0) return 0;
    base.issueIds = loopIds;
  }
  if (opts.harnessScopes) {
    if (opts.harnessScopes.length === 0) return 0; // mirrors readByTopic: an empty set matches nothing
    const counts = await Promise.all(opts.harnessScopes.map((scope) => deps.countIssues({ ...base, scope })));
    return counts.reduce((a, b) => a + b, 0);
  }
  if (opts.harnessSlug) {
    return deps.countIssues({ ...base, scope: `harness:${opts.harnessSlug}` });
  }
  return deps.countIssues(base);
}

/**
 * Read observation-lane records (turn-end-reflection-observations-2026-06-14
 * D-005) as storage-agnostic candidates. Separate topic from
 * `readImprovementItems` so observations NEVER enter the work/triage pipeline —
 * the ONLY callers are Scout's corpus-digest (unioned into the friction lane,
 * P-021) and the Observations pane's sync resolver (P-044).
 */
export async function readObservationItems(
  opts: ReadImprovementOpts = {},
  deps: ReadImprovementDeps = defaultDeps,
): Promise<ImprovementCandidate[]> {
  return readBySelector({ lane: OBSERVATION_LANE }, opts, deps);
}

/**
 * COUNT how many observation-lane rows `createdBy` filed strictly after `sinceIso`
 * — without materialising them.
 *
 * P-008 (db-performance-remediation-2026-07-26). Both orient hints
 * (orient-capture-miss-hint, orient-ideate-hint) computed this by calling
 * `readObservationItems({})` — up to 500 full candidates, each carrying `body` and
 * the entire `payload` JSONB — and then `.filter(...).length` in JS. That ran on
 * EVERY orient, fleet-wide: ~931k calls at ~825 rows/call, the #2 live consumer of
 * this database. The predicates are two indexed column comparisons; Postgres returns
 * the integer directly.
 *
 * Same lesson as the `countWorkItemsByState` fix in work-items.ts: when the caller
 * only wants a SCALAR, listing rows to tally them in JS is the bug — and a column
 * projection would not have helped, because these rows' own mapper genuinely reads
 * body/payload.
 *
 * `sinceIso == null` counts ALL of that author's observation rows (the ideate hint's
 * "no previous pass" case).
 */
export async function countObservationFilingsSince(
  createdBy: string,
  sinceIso: string | null,
  deps: CountObservationDeps = defaultCountDeps,
): Promise<number> {
  if (!createdBy) return 0;
  // Mirrors readObservationItems' effective filter EXACTLY (topic + the organic-only
  // origin allowlist it defaults to), minus the row materialisation — so this count
  // and that list can never disagree about what an "observation filing" is.
  return deps.countIssues({
    lane: OBSERVATION_LANE,
    signalOrigins: ORGANIC_ONLY,
    createdBy,
    ...(sinceIso ? { createdAfter: sinceIso } : {}),
  });
}

/**
 * Shared body for the candidate readers (improvement + observation).
 *
 * The population is chosen by a SELECTOR, not always a topic: improvements are still
 * selected by their topic tag, observations by the `lane` COLUMN (P-006 / D-031 — the
 * topic join is lossy in both directions for that population; see
 * `ListIssuesFilter.lane` for the measurement).
 */
async function readBySelector(
  selector: { topic: string; lane?: undefined } | { lane: string; topic?: undefined },
  opts: ReadImprovementOpts,
  deps: ReadImprovementDeps,
): Promise<ImprovementCandidate[]> {
  const origins = opts.origins ?? ORGANIC_ONLY;

  // Learning-loop provenance scope (P-001/D-002). Resolved BEFORE the read so it
  // becomes a SQL predicate: `limit` is applied by Postgres, so post-filtering the
  // result would take the first N of the whole corpus and then shrink it — returning
  // an arbitrary fraction of the real answer while looking like it worked.
  let issueIds: readonly string[] | undefined;
  if (opts.loopOutputOnly) {
    if (!deps.readLoopOutputIds) {
      // Fail loudly. Silently ignoring the scope would return the ENTIRE improvement
      // corpus under a name that promises the loop's output — reinstating the exact
      // 8,202-row Work-tab duplication this option exists to remove.
      throw new Error(
        'readBySelector: loopOutputOnly requires deps.readLoopOutputIds (see improvements/loop-output.ts)',
      );
    }
    issueIds = await deps.readLoopOutputIds();
  }

  if (opts.windowPerScope) {
    if (!deps.listScopes) {
      throw new Error('readBySelector: windowPerScope requires deps.listScopes');
    }
    const discovered = await deps.listScopes({
      ...selector,
      state: opts.state,
      signalOrigins: origins,
      ...(issueIds ? { issueIds } : {}),
    });
    const allowed = opts.harnessScopes
      ? new Set(opts.harnessScopes)
      : opts.harnessSlug
        ? new Set([`harness:${opts.harnessSlug}`])
        : undefined;
    const scopes = allowed ? discovered.filter((scope) => allowed.has(scope)) : discovered;
    const scopedReads = await Promise.all(
      scopes.map((scope) =>
        readBySelector(
          selector,
          {
            ...opts,
            windowPerScope: false,
            harnessSlug: undefined,
            harnessScopes: [scope],
          },
          deps,
        ),
      ),
    );
    return scopedReads.flat();
  }

  const requestedScope = opts.harnessScopes?.length === 1
    ? opts.harnessScopes[0]
    : opts.harnessSlug
      ? `harness:${opts.harnessSlug}`
      : undefined;

  const issues = await deps.listIssues({
    ...selector,
    state: opts.state,
    limit: opts.limit ?? 500,
    signalOrigins: origins,
    ...(requestedScope ? { scope: requestedScope } : {}),
    ...(opts.includeBody === false ? { includeBody: false } : {}),
    ...(issueIds ? { issueIds } : {}),
    ...(opts.createdBefore ? { createdBefore: opts.createdBefore } : {}),
  });

  // Origin gate (frontier P-002/D-002): enforced HERE as well as in the SQL
  // filter above, so an injected/legacy listIssues that ignores signalOrigins
  // still can't leak a synthetic row into an organic consumer. Exact-match
  // allowlist — junk values fail closed; a row with NO origin reads organic
  // (the migration-DEFAULT backfill semantics, see provenance.ts).
  const originGated = issues.filter((issue) => originAllowed(issue.signalOrigin, origins));

  // (P-040) Per-Hive lens: filter to the Hive's member-harness scope SET when
  // given (the Hive is the tenancy unit, D-008). Takes precedence over the
  // single-harness filter; an empty set matches nothing.
  if (opts.harnessScopes) {
    const allowed = new Set(opts.harnessScopes);
    return originGated.filter((issue) => allowed.has(issue.scope)).map(issueToCandidate);
  }

  // (P-010) Filter by scope if harnessSlug is specified
  if (opts.harnessSlug) {
    const targetScope = `harness:${opts.harnessSlug}`;
    return originGated
      .filter(issue => issue.scope === targetScope)
      .map(issueToCandidate);
  }

  return originGated.map(issueToCandidate);
}
