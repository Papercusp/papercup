/**
 * Work-selection census — every path that SELECTS or COUNTS work in harness_shared.work_items,
 * what item kinds it admits today, and whether a non-work datatype instance can reach it.
 *
 * Plan enterprise-data-sources-2026-10-01, item P-007 (WI-10005043). Long form, live counts and
 * the verdict on the plan's [inferred] claim: docs/evidence/work-selection-census-2026-10-01.md.
 *
 * Two consumers:
 *   - P-009 (the single work predicate, D-001/D-008) rewires every `selection` row below to read
 *     one nature-derived predicate. A row whose `admits` is not the predicate is a remaining decider.
 *   - P-012 (the recurrence guard) seeds WORK_SELECTION_SEED_ROWS into an isolated DB and asserts
 *     every `selection` path returns only rows with `expectAgentClaimable: true`.
 *
 * The `anchor` of each row is a literal string that must appear in `file`; the sibling test pins
 * it, so a refactor that moves or deletes the decider fails here instead of leaving this census
 * silently describing code that no longer exists (derived-truth ladder, rung 2: PIN).
 */

export type CensusRole =
  /** Hands an item to an agent (claim, get-next, by-id claim, dispatch). */
  | 'selection'
  /** Counts or lists "the queue"; never claims, but drives what an agent believes is work. */
  | 'listing'
  /** Mints work_items rows; P-009/D-008 make these stamp nature. */
  | 'writer'
  /** Reads work_items for another purpose (embedding, dedupe, admission bookkeeping). */
  | 'auxiliary'
  /** SQL object (view, function, index) that encodes a kind split. */
  | 'sql';

/** How the row's `admits`/`reachesNonWork` statement was established. */
export type CensusEvidence =
  /** Read from the code at `file`/`anchor`. */
  | 'code'
  /** Read from code AND measured against the live operator DB on 2026-10-01. */
  | 'code+live'
  /** Grep found no kind predicate; the absence is not yet proven by reading the full path. */
  | 'unverified';

export interface WorkSelectionCensusRow {
  id: string;
  role: CensusRole;
  surface: string;
  /** Repo-relative path (from the papercusp superproject root). */
  file: string;
  /** Literal substring of `file` that locates the kind decider. Pinned by the test. */
  anchor: string;
  /** Item kinds the path admits today, in plain words. */
  admits: string;
  /** Can a non-work or human-audience generic-kind instance (e.g. email-draft-proposal) reach it? */
  reachesNonWork: 'no' | 'yes' | 'no-by-convention' | 'unknown';
  /** Existing discriminators the path applies besides kind. */
  discriminators: string[];
  evidence: CensusEvidence;
  note?: string;
}

export const WORK_SELECTION_CENSUS: readonly WorkSelectionCensusRow[] = [
  // ── selection ──────────────────────────────────────────────────────────────────────────
  {
    id: 'get-next-issue',
    role: 'selection',
    surface: 'scheduler:get_next (issue path)',
    file: 'packages/operator-core/lib/scheduler/get-next.ts',
    anchor: "wi.item_kind IN ('bug', 'change', 'task')",
    admits: 'bug, change, task (hardcoded list #1)',
    reachesNonWork: 'no',
    discriminators: ['needs-owner-action exclusion', 'claim floors', 'lane=observation'],
    evidence: 'code',
  },
  {
    id: 'claim-floors-feature',
    role: 'selection',
    surface: 'scheduler:get_next (feature path) and work_items:claim_next feature tier, via claimFloorsWhereSql',
    file: 'packages/operator-core/lib/work-items.ts',
    anchor: 'AND ${frontierPlacementKindClause(sql, opts.workspaceId)}',
    admits: "feature, plus generic-kind datatypes tagged with HIVE_PLACEMENT_TAG ('pot-placement')",
    reachesNonWork: 'no-by-convention',
    discriminators: ['claim floors', 'admission', 'rig floor'],
    evidence: 'code+live',
    note: 'Live 2026-10-01: none of the 7 active generic-kind datatypes carries the tag, so no generic instance is reachable. One tag added to email-draft-proposal would make all 129 open rows self-selectable.',
  },
  {
    id: 'frontier-placement-clause',
    role: 'selection',
    surface: 'frontierPlacementKindClause (shared by claim floors, pot survey, wake-frontier guard, composition rig)',
    file: 'packages/operator-core/lib/datatype-frontier-placement.ts',
    anchor: 'AND ${HIVE_PLACEMENT_TAG} = ANY(tags)',
    admits: 'feature + tag-gated generic kinds (tag convention #4)',
    reachesNonWork: 'no-by-convention',
    discriminators: ['datatype_registry tag'],
    evidence: 'code+live',
    note: 'Per-row subquery against datatype_registry inside the claim path: exactly the JOIN shape D-008 retires.',
  },
  {
    id: 'claim-next-tool',
    role: 'selection',
    surface: 'work_items:claim_next',
    file: 'packages/operator-core/lib/agent-tools/work_items/claim_next.ts',
    anchor: "kind: z.enum(['feature']).optional()",
    admits: 'feature family via claimFloorsWhereSql, then additive fall-through to the issue family; routes to getNextForBee in a fleet',
    reachesNonWork: 'no-by-convention',
    discriminators: ['fleet scope', 'fleet pause', 'claim floors'],
    evidence: 'code',
  },
  {
    id: 'fleet-scope-admission',
    role: 'selection',
    surface: 'fleet claim spec admission (getNextForBee)',
    file: 'packages/operator-core/lib/scheduler/claim-spec-store.ts',
    anchor: 'SELECT feature_id AS id, item_kind AS kind',
    admits: 'whatever the spec names, then delegates to get-next floors',
    reachesNonWork: 'no-by-convention',
    discriminators: ['claim spec view', 'get-next floors'],
    evidence: 'code',
  },
  {
    id: 'claimable-tool',
    role: 'selection',
    surface: 'work_items:claimable',
    file: 'packages/operator-core/lib/agent-tools/work_items/claimable.ts',
    anchor: "const ISSUE_KINDS = ['bug', 'change', 'task'] as const;",
    admits: 'bug, change, task (hardcoded list #2, a local copy)',
    reachesNonWork: 'no',
    discriminators: ['work_items_claimable view'],
    evidence: 'code+live',
    note: 'Live claimable by kind 2026-10-01: change 1292, task 765, bug 513; zero generic-kind rows.',
  },
  {
    id: 'by-id-claim',
    role: 'selection',
    surface: 'work_items:claim { id } -> claimWorkItem -> claimIssue (and leader dispatch)',
    file: 'packages/operator-core/lib/agent-tools/work_items/claim.ts',
    anchor: 'claimWorkItem returns a bare null for THREE distinct outcomes',
    admits: 'any id that passes admittedWhereSql/autoPickableWhereSql; no item_kind predicate found',
    reachesNonWork: 'yes',
    discriminators: ['admission', 'auto-pickable', 'leaderDispatchAdmission bypass (WI-5826)'],
    evidence: 'code',
    note: '[inferred from code, not executed] email-draft-proposal rows carry admission NULL, lane NULL, needsOwnerAction NULL (measured), so no existing discriminator refuses them. An agent that takes an id from work_items:list can claim one. P-012 must execute this against an isolated DB.',
  },
  {
    id: 'diagnose-claim-next-miss',
    role: 'listing',
    surface: 'diagnoseClaimNextMiss (claim_next empty-result diagnosis)',
    file: 'packages/operator-core/lib/work-items.ts',
    anchor: 'AND ${frontierPlacementKindClause(sql, ws)}',
    admits: 'feature + tag-gated generic kinds for the feature count',
    reachesNonWork: 'no-by-convention',
    discriminators: ['claim floors'],
    evidence: 'code',
  },
  // ── listing ────────────────────────────────────────────────────────────────────────────
  {
    id: 'list-search-count',
    role: 'listing',
    surface: 'work_items:list / work_items:search / countWorkItems / countWorkItemsByState',
    file: 'packages/operator-core/lib/work-items.ts',
    anchor: 'function featureFamilyKindClause(',
    admits: "feature + EVERY active generic-kind datatype (no tag gate); 'chunk' only when asked",
    reachesNonWork: 'yes',
    discriminators: ['includeObservations:false default (lane)'],
    evidence: 'code+live',
    note: 'Live 2026-10-01: work_items:list { notTerminal:true } shows the 129 open email-draft-proposal rows beside real work. This is the surface a drain enumerates from.',
  },
  {
    id: 'issues-list',
    role: 'listing',
    surface: 'issues:list / issues:* (engineer_issues view)',
    file: 'packages/operator-core/lib/issues-engineer.ts',
    anchor: "export const ISSUE_KINDS: readonly IssueKind[] = ['bug', 'change'];",
    admits: "view: bug, change, task; issues-engineer ISSUE_KINDS: bug, change (hardcoded list #3, disagrees with #1 and #2 on 'task')",
    reachesNonWork: 'no',
    discriminators: ['engineer_issues view kind filter'],
    evidence: 'code+live',
    note: 'engineer_issues spells kind/title/created_at where work_items has item_kind/summary/created_ts.',
  },
  {
    id: 'leader-brief-backlog',
    role: 'listing',
    surface: 'fleet:leader-brief backlog figures',
    file: 'packages/operator-core/lib/agent-tools/fleet/leader-brief.ts',
    anchor: 'work_items:claimable',
    admits: 'inherits work_items:claimable (bug, change, task)',
    reachesNonWork: 'no',
    discriminators: ['claim spec'],
    evidence: 'code',
  },
  {
    id: 'burn-down',
    role: 'listing',
    surface: 'work_items:burn_down',
    file: 'packages/operator-core/lib/agent-tools/work_items/burn_down.ts',
    anchor: "(payload as Record<string, unknown>).lane === 'observation',",
    admits: 'excludes lane=observation in JS; kind handling not read',
    reachesNonWork: 'unknown',
    discriminators: ['lane'],
    evidence: 'unverified',
  },
  {
    id: 'unclaimed-digest',
    role: 'listing',
    surface: 'daily unclaimed-work digest routine',
    file: 'packages/operator-core/lib/harness/routines/unclaimed-work-digest-action.ts',
    anchor: 'unclaimed',
    admits: 'no item_kind / lane / ISSUE_KINDS predicate found by grep',
    reachesNonWork: 'unknown',
    discriminators: [],
    evidence: 'unverified',
  },
  {
    id: 'drain-mode',
    role: 'listing',
    surface: 'DRAIN mode backlog enumeration',
    file: 'packages/operator-core/lib/operating-modes-policy.ts',
    anchor: '"drain the queue" / "clear the backlog" ⇒ \\`drain\\`',
    admits: 'no enumerator of its own: the drain overlay is prompt text, so the backlog is whichever surface the agent reads',
    reachesNonWork: 'yes',
    discriminators: [],
    evidence: 'code',
    note: 'Through work_items:list (list-search-count) a drain sees email-draft-proposal; through scheduler:get_next it does not; through work_items:claim { id } it can claim one. The P-012 LLM scenario covers this path.',
  },
  // ── auxiliary ──────────────────────────────────────────────────────────────────────────
  {
    id: 'admission-promoter',
    role: 'auxiliary',
    surface: 'work-items admission promoter',
    file: 'packages/operator-core/lib/work-items-admission-promoter.ts',
    anchor: 'wi.status, wi.item_kind, wi.admission, wi.condition_key, wi.created_ts,',
    admits: 'reads item_kind and admission; per-kind behaviour not read',
    reachesNonWork: 'unknown',
    discriminators: ['admission', 'needsOwnerAction count'],
    evidence: 'unverified',
  },
  {
    id: 'embed-backfill',
    role: 'auxiliary',
    surface: 'search embedding backfill ordering',
    file: 'packages/operator-core/lib/search/embed-backfill.ts',
    anchor: "(lane IS DISTINCT FROM 'observation' AND NOT harness_shared.work_item_status_is_terminal(status)) DESC,",
    admits: 'all kinds; observation and terminal rows only deprioritized',
    reachesNonWork: 'yes',
    discriminators: ['lane (ordering only)'],
    evidence: 'code',
    note: 'Owned by shared-vector-search-libraries-2026-09-29 (D-009c).',
  },
  {
    id: 'composition-rig',
    role: 'auxiliary',
    surface: 'shared-pot-loop composition rig (test DDL mirror)',
    file: 'packages/operator-core/lib/shared-pot-loop/composition-rig.ts',
    anchor: "item_kind           TEXT NOT NULL DEFAULT 'feature',",
    admits: 'mirrors claimFloorsWhereSql incl. frontierPlacementKindClause',
    reachesNonWork: 'no-by-convention',
    discriminators: ['claim floors'],
    evidence: 'code',
    note: 'D-008: the nature column lands here and in HFC_DDL in the same change.',
  },
  // ── sql ────────────────────────────────────────────────────────────────────────────────
  {
    id: 'sql-claimable-view',
    role: 'sql',
    surface: 'harness_shared.work_items_claimable view',
    file: 'libs/papercusp/libs/db/sql/864-migrate-legacy-human-parks-to-agent-review.sql',
    anchor: 'VIEW harness_shared.work_items_claimable',
    admits: "item_kind = ANY(bug, change, task); payload lane <> observation; payload needsOwnerAction <> true; zero claim floors",
    reachesNonWork: 'no',
    discriminators: ['payload lane', 'payload needsOwnerAction', 'work_item_claim_floors'],
    evidence: 'code+live',
    note: 'Definition read live via pg_get_viewdef 2026-10-01. Migration 1301 recreates it (D-009a); any recreation here lands after 1301.',
  },
  {
    id: 'sql-design-keyset-index',
    role: 'sql',
    surface: 'partial index work_items_design_created_keyset_idx',
    file: 'libs/papercusp/libs/db/sql/885-design-features-created-keyset.sql',
    anchor: 'work_items_design_created_keyset_idx',
    admits: 'hardcoded item_kind family split in the index predicate',
    reachesNonWork: 'unknown',
    discriminators: [],
    evidence: 'unverified',
  },
];

/** Natures from D-001, plus the two internal row classes D-009(e) keeps in work_items. */
export type SeedNature = 'work' | 'record' | 'document' | 'event' | 'internal-excluded' | 'retired';

export interface WorkSelectionSeedRow {
  itemKind: string;
  nature: SeedNature;
  audience: 'agent' | 'human' | null;
  /** Extra payload to stamp (lane, needsOwnerAction). */
  payload: Record<string, unknown>;
  status: string;
  /** What every `selection` path must do with this row after P-009. */
  expectAgentClaimable: boolean;
  source: string;
}

/**
 * One row per (nature, audience) class that exists today, for P-012's isolated-DB guard.
 * Documents and events have no work_items instances yet (D-003/D-005 give them their own
 * tables), so P-012 adds their seeds when those tables land.
 */
export const WORK_SELECTION_SEED_ROWS: readonly WorkSelectionSeedRow[] = [
  { itemKind: 'bug', nature: 'work', audience: 'agent', payload: {}, status: 'open', expectAgentClaimable: true, source: 'built-in kind' },
  { itemKind: 'change', nature: 'work', audience: 'agent', payload: {}, status: 'open', expectAgentClaimable: true, source: 'built-in kind' },
  { itemKind: 'task', nature: 'work', audience: 'agent', payload: {}, status: 'open', expectAgentClaimable: true, source: 'built-in kind' },
  { itemKind: 'feature', nature: 'work', audience: 'agent', payload: {}, status: 'open', expectAgentClaimable: true, source: 'built-in kind' },
  { itemKind: 'calendar-meeting-prep', nature: 'work', audience: 'agent', payload: {}, status: 'open', expectAgentClaimable: true, source: 'D-007' },
  { itemKind: 'email-draft-proposal', nature: 'work', audience: 'human', payload: {}, status: 'open', expectAgentClaimable: false, source: 'D-007; 129 open live' },
  { itemKind: 'pipeline-deal', nature: 'record', audience: null, payload: {}, status: 'open', expectAgentClaimable: false, source: 'D-007' },
  { itemKind: 'bet', nature: 'record', audience: null, payload: {}, status: 'open', expectAgentClaimable: false, source: 'D-007' },
  { itemKind: 'wager', nature: 'record', audience: null, payload: {}, status: 'open', expectAgentClaimable: false, source: 'D-007' },
  { itemKind: 'forecast', nature: 'record', audience: null, payload: {}, status: 'open', expectAgentClaimable: false, source: 'D-007' },
  { itemKind: 'calibration-record', nature: 'record', audience: null, payload: {}, status: 'open', expectAgentClaimable: false, source: 'D-007' },
  { itemKind: 'change', nature: 'internal-excluded', audience: null, payload: { lane: 'observation' }, status: 'open', expectAgentClaimable: false, source: 'D-009(e): observation reflections and scorecards (scorecards are lane=observation rows)' },
  { itemKind: 'bug', nature: 'work', audience: 'human', payload: { needsOwnerAction: true }, status: 'open', expectAgentClaimable: false, source: 'existing needs-owner-action discriminator' },
  { itemKind: 'chunk', nature: 'retired', audience: null, payload: {}, status: 'open', expectAgentClaimable: false, source: "retired kind; 12 live rows (status 'passed')" },
];
