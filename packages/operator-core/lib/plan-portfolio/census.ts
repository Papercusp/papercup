/**
 * Plan-portfolio census: the nine Background measures of plan
 * `plan-portfolio-flow-and-weight-2026-11-13` as one repeatable measurement (P-001, bar R-6).
 *
 * This module is pure. It owns three things:
 *   1. the versioned MANIFEST that states, for each of M-1 to M-9, its definition, unit,
 *      window, population, counting rule and source. A run is stamped with the manifest's
 *      fingerprint, so two runs are comparable exactly when their fingerprints are equal;
 *   2. the POPULATION rule. Every measure counts only plans of the population its manifest
 *      entry records; an entry that names none gets the default (open, non-archived plans of
 *      the papercusp harness that are not rubric templates). The rule lives here, once: the
 *      store hands over every plan row and applies no population filter of its own;
 *   3. the batched READ. Plans are read in key order, `batchSize` at a time. A run that stops
 *      before the end reports how many plans it left out and returns a cursor; a follow-up
 *      run from that cursor reads the remaining plans once and yields the same result an
 *      uninterrupted run would have.
 *
 * Reading the store is `census-store.ts`; registering instruments and recording runs in the
 * results ledger is `census-instruments.ts`.
 */
import { createHash } from 'node:crypto';
import { canonicalJson } from '@papercusp/hash-chain';

export const CENSUS_MEASURE_IDS = ['M-1', 'M-2', 'M-3', 'M-4', 'M-5', 'M-6', 'M-7', 'M-8', 'M-9'] as const;
export type CensusMeasureId = (typeof CENSUS_MEASURE_IDS)[number];

/** `template` value of a rubric-template plan (plans/rubric-template.ts RUBRIC_TEMPLATE_NAME). */
export const RUBRIC_TEMPLATE_NAME = 'rubric';
/** `payload.claim_hold_by` of the plan-line transition hold (plans/plan-admission-preflight.ts). */
export const PLAN_LINE_HOLD_BY = 'migration:plan-line-work-item-nodes';

// ── Population ───────────────────────────────────────────────────────────────

export interface CensusPopulation {
  /** The one harness whose plans are counted (plan decision D-004). */
  harness: string;
  /** 'open' leaves out shipped and superseded plans; 'all' keeps every status. */
  statuses: 'open' | 'all';
  archived: 'exclude' | 'include';
  rubricTemplates: 'exclude' | 'include';
}

/** The census population of the Background section, used by every entry that names none. */
export const DEFAULT_CENSUS_POPULATION: CensusPopulation = Object.freeze({
  harness: 'papercusp', statuses: 'open', archived: 'exclude', rubricTemplates: 'exclude',
});

const CLOSED_PLAN_STATUSES: ReadonlySet<string> = new Set(['shipped', 'superseded']);

export function resolveCensusPopulation(entry: { population?: CensusPopulation }): CensusPopulation {
  return { ...(entry.population ?? DEFAULT_CENSUS_POPULATION) };
}

export function inCensusPopulation(
  plan: Pick<CensusPlanRow, 'harnessSlug' | 'status' | 'archived' | 'template'>,
  population: CensusPopulation,
): boolean {
  if (plan.harnessSlug !== population.harness) return false;
  if (population.rubricTemplates === 'exclude' && plan.template === RUBRIC_TEMPLATE_NAME) return false;
  if (population.archived === 'exclude' && plan.archived) return false;
  if (population.statuses === 'open' && CLOSED_PLAN_STATUSES.has(plan.status)) return false;
  return true;
}

// ── Manifest ─────────────────────────────────────────────────────────────────

export type CensusWindow =
  | { kind: 'point-in-time' }
  /** The `days` whole UTC days that end at the start of the run's UTC day. */
  | { kind: 'trailing-utc-days'; days: number };

export interface CensusManifestEntryInput {
  id: CensusMeasureId;
  title: string;
  definition: string;
  unit: string;
  window: CensusWindow;
  countingRule: string;
  source: string;
  /** Thresholds the counting rule uses; fingerprinted with the rest of the entry. */
  params?: Record<string, number>;
  /** Omit to record the default population. */
  population?: CensusPopulation;
}

export interface CensusManifestEntry extends CensusManifestEntryInput {
  population: CensusPopulation;
  params: Record<string, number>;
}

export interface CensusManifest {
  version: number;
  measures: CensusManifestEntry[];
}

/** Bump on ANY change to an entry below: the fingerprint changes with it. */
export const PLAN_PORTFOLIO_CENSUS_MANIFEST_VERSION = 1;

const PLAN_STORE = 'harness_shared.harness_plans (status, archived, template, created_at, updated_at, content, items, decisions, embedding)';
const WORK_ITEMS = 'harness_shared.work_items rows linked by plan_slug + plan_line_id (status, taken_by, claim_hold, payload.claim_hold_by, lane)';
const WORKABLE = 'A workable item is a plan item in todo or wip whose blockers are all done or dropped; a blocker id that is not an item of the same plan counts as open.';
const OPEN_ROWS = 'An item\'s open work items are its linked rows whose status is not done, dropped, closed or resolved, observation-lane rows left out.';

// The explicit element type keeps each literal checked against the entry shape; left to
// inference, the union of literals gains `params?: undefined`, which exact optionals reject.
export const PLAN_PORTFOLIO_CENSUS_ENTRIES: readonly CensusManifestEntryInput[] = Object.freeze<CensusManifestEntryInput[]>([
  {
    id: 'M-1', title: 'Plans created vs shipped',
    definition: 'Plans created in the window, beside the plans that are shipped and were last written in the window.',
    unit: 'plans', window: { kind: 'trailing-utc-days', days: 12 },
    population: { ...DEFAULT_CENSUS_POPULATION, statuses: 'all', archived: 'include' },
    countingRule: 'value = plans whose created_at falls in the window. shippedUpperBound = plans with status shipped whose updated_at falls in the window; the store keeps no ship date, so this is an upper bound on plans shipped in the window.',
    source: PLAN_STORE,
  },
  {
    id: 'M-2', title: 'Workable items that are held',
    definition: 'Workable plan items that an agent holds.',
    unit: 'items', window: { kind: 'point-in-time' },
    countingRule: `${WORKABLE} ${OPEN_ROWS} value = workable items with at least one open work item that has a holder (taken_by set). workable = all workable items.`,
    source: `${PLAN_STORE}; ${WORK_ITEMS}`,
  },
  {
    id: 'M-3', title: 'Workable items behind a claim hold',
    definition: 'Workable plan items that no agent holds and that cannot be claimed because every open work item linked to them carries a claim hold.',
    unit: 'items', window: { kind: 'point-in-time' },
    countingRule: `${WORKABLE} ${OPEN_ROWS} An item with a held open work item is counted under M-2, not here. value = items that have at least one open work item and whose open work items all have claim_hold true. inReadyOrActive = those in plans with status ready or active. planLineHoldOnly = those whose open work items all carry the plan-line transition hold (claim_hold_by = ${PLAN_LINE_HOLD_BY}); an item with any other blocker besides the hold is still counted, which overcounts.`,
    source: `${PLAN_STORE}; ${WORK_ITEMS}`,
  },
  {
    id: 'M-4', title: 'Plans carrying a system-written readiness block',
    definition: 'Plans whose text contains the system-written acceptance-readiness block.',
    unit: 'plans', window: { kind: 'point-in-time' },
    countingRule: 'value = plans whose content contains the readiness mark (plans/plan-now-markers.ts BAR_READINESS_NOW_MARK). withOpenItems = those with at least one item that is not done or dropped. population = plans in the population.',
    source: PLAN_STORE,
  },
  {
    id: 'M-5', title: 'Plans with open items and no edit in 30 days',
    definition: 'Plans that still have open items and whose plan row was last written more than idleDays days before the run.',
    unit: 'plans', window: { kind: 'point-in-time' }, params: { idleDays: 30 },
    countingRule: 'value = plans with at least one item that is not done or dropped and updated_at earlier than the run instant minus idleDays days. Activity on linked work items does not count as an edit. plansWithOpenItems = plans with at least one open item.',
    source: PLAN_STORE,
  },
  {
    id: 'M-6', title: 'Plans with every item closed that have not shipped',
    definition: 'Plans whose stored status is awaiting-acceptance: the items are closed and the plan is not recorded as shipped.',
    unit: 'plans', window: { kind: 'point-in-time' },
    population: { ...DEFAULT_CENSUS_POPULATION, archived: 'include' },
    countingRule: 'value = plans with status awaiting-acceptance. archived = those that are archived. withOpenItems = those that still have an item that is not done or dropped.',
    source: PLAN_STORE,
  },
  {
    id: 'M-7', title: 'Plan size',
    definition: 'Length of the stored plan text.',
    unit: 'characters', window: { kind: 'point-in-time' }, params: { largeChars: 100_000 },
    countingRule: 'value = median of char_length(content) over the population; the mean of the two middle values when the count is even. overLarge = plans over largeChars characters. largest = the longest plan.',
    source: PLAN_STORE,
  },
  {
    id: 'M-8', title: 'Decisions per plan',
    definition: 'Number of recorded decisions on a plan.',
    unit: 'decisions', window: { kind: 'point-in-time' }, params: { manyDecisions: 20 },
    countingRule: 'value = median of the length of the decisions array over the population; the mean of the two middle values when the count is even. withMany = plans with manyDecisions or more. largest = the highest count.',
    source: PLAN_STORE,
  },
  {
    id: 'M-9', title: 'Near-twin pairs',
    definition: 'Unordered pairs of plans whose stored embeddings have cosine similarity of minSimilarity or more.',
    unit: 'pairs', window: { kind: 'point-in-time' }, params: { minSimilarity: 0.92 },
    countingRule: 'value = unordered pairs of population plans, both with a stored embedding of the same embedding profile, with 1 - cosine distance >= minSimilarity. plans = distinct plans in those pairs. withoutEmbedding = population plans with no stored embedding, which no pair can include.',
    source: PLAN_STORE,
  },
]);

export function resolveCensusManifest(
  entries: readonly CensusManifestEntryInput[] = PLAN_PORTFOLIO_CENSUS_ENTRIES,
  version: number = PLAN_PORTFOLIO_CENSUS_MANIFEST_VERSION,
): CensusManifest {
  return {
    version,
    measures: entries.map((entry) => ({
      ...entry, window: { ...entry.window }, params: { ...(entry.params ?? {}) }, population: resolveCensusPopulation(entry),
    })),
  };
}

/** sha256 of the canonical JSON of the resolved manifest: the run's definition fingerprint. */
export function censusManifestFingerprint(manifest: CensusManifest): string {
  return createHash('sha256').update(canonicalJson(manifest), 'utf8').digest('hex');
}

// ── Rows ─────────────────────────────────────────────────────────────────────

export interface CensusPlanItemRow { id: string; status: string; blockedBy: string[] }

export interface CensusWorkItemRow {
  planLineId: string;
  status: string;
  /** A holder is set (taken_by). */
  held: boolean;
  claimHold: boolean;
  claimHoldBy: string | null;
  lane: string | null;
}

export interface CensusPlanRow {
  harnessSlug: string;
  planSlug: string;
  status: string;
  archived: boolean;
  template: string | null;
  createdAt: string;
  updatedAt: string;
  contentChars: number;
  decisionCount: number;
  hasReadinessBlock: boolean;
  hasEmbedding: boolean;
  items: CensusPlanItemRow[];
  workItems: CensusWorkItemRow[];
}

export interface CensusKey { harnessSlug: string; planSlug: string }

/** Rows come back in (harnessSlug, planSlug) code-unit order, strictly after `after`. */
export interface CensusPlanStore {
  readPlans(input: { after: CensusKey | null; limit: number }): Promise<CensusPlanRow[]>;
  countPlansAfter(after: CensusKey | null): Promise<number>;
  readNearTwinPairs(input: { harnessSlug: string; planSlugs: string[]; minSimilarity: number }):
    Promise<Array<{ a: string; b: string; similarity: number }>>;
}

// ── Item classification ──────────────────────────────────────────────────────

const CLOSED_ITEM_STATUSES: ReadonlySet<string> = new Set(['done', 'dropped']);
const WORKABLE_ITEM_STATUSES: ReadonlySet<string> = new Set(['todo', 'wip']);
const CLOSED_WORK_ITEM_STATUSES: ReadonlySet<string> = new Set(['done', 'dropped', 'closed', 'resolved']);
const LIVE_PLAN_STATUSES: ReadonlySet<string> = new Set(['ready', 'active']);

export function openItemCount(plan: Pick<CensusPlanRow, 'items'>): number {
  return plan.items.filter((item) => !CLOSED_ITEM_STATUSES.has(item.status)).length;
}

export function workableItems(plan: Pick<CensusPlanRow, 'items'>): CensusPlanItemRow[] {
  const statusById = new Map(plan.items.map((item) => [item.id, item.status]));
  return plan.items.filter((item) => WORKABLE_ITEM_STATUSES.has(item.status) &&
    item.blockedBy.every((id) => CLOSED_ITEM_STATUSES.has(statusById.get(id) ?? 'unknown')));
}

export type WorkableBucket = 'held-by-agent' | 'no-work-item' | 'plan-line-hold-only' | 'other-hold' | 'open-unheld';

/** Where one workable item stands. Buckets are exclusive and tested in this order. */
export function classifyWorkableItem(plan: Pick<CensusPlanRow, 'workItems'>, itemId: string): WorkableBucket {
  const rows = plan.workItems.filter((row) => row.planLineId === itemId &&
    !CLOSED_WORK_ITEM_STATUSES.has(row.status) && row.lane !== 'observation');
  if (rows.some((row) => row.held)) return 'held-by-agent';
  if (rows.length === 0) return 'no-work-item';
  if (!rows.every((row) => row.claimHold)) return 'open-unheld';
  return rows.every((row) => row.claimHoldBy === PLAN_LINE_HOLD_BY) ? 'plan-line-hold-only' : 'other-hold';
}

// ── The batched run ──────────────────────────────────────────────────────────

/** Labelled preview only: the count beside it is exact. */
export const HELD_ONLY_SAMPLE_SIZE = 20;
export const DEFAULT_CENSUS_BATCH_SIZE = 200;

/** Mergeable state of a run in progress. Counters add; the three lists concatenate. */
export interface CensusPartial {
  plansRead: number;
  population: { total: number; byStatus: Record<string, number> };
  m1: { created: number; shipped: number };
  m2: { workable: number; heldByAgent: number };
  m3: {
    onHold: number; onHoldReadyOrActive: number; planLineHoldOnly: number;
    planLineHoldOnlyReadyOrActive: number; otherHold: number; noWorkItem: number; openUnheld: number;
    sample: string[];
  };
  m4: { population: number; plans: number; withOpenItems: number };
  m5: { plansWithOpenItems: number; idle: number };
  m6: { awaiting: number; archived: number; withOpenItems: number };
  m7: number[];
  m8: number[];
  m9: { embedded: string[]; withoutEmbedding: number };
}

export interface CensusCursor {
  v: 1;
  manifestFingerprint: string;
  /** The run instant every pass of this run measures against. */
  runAt: string;
  /** The last plan read; the follow-up run reads strictly after it. */
  after: CensusKey;
}

export interface CensusResume { cursor: CensusCursor; partial: CensusPartial }

export interface CensusMeasureReading {
  id: CensusMeasureId;
  title: string;
  unit: string;
  /** null when the population read so far gives the measure nothing to compute. */
  value: number | null;
  components: Record<string, number>;
}

export interface CensusRun {
  manifestVersion: number;
  manifestFingerprint: string;
  runAt: string;
  /** Plans read by this run so far, earlier passes included. */
  plansRead: number;
  /** Plans the run has not read. Zero exactly when the run is complete. */
  omitted: number;
  complete: boolean;
  /** Where a follow-up run starts; null when nothing was left out. */
  cursor: CensusCursor | null;
  /** Cursor plus the state a follow-up run merges into; null when nothing was left out. */
  resume: CensusResume | null;
  /** Computed over the plans read so far. Final only when `complete`. */
  measures: Record<CensusMeasureId, CensusMeasureReading>;
  population: { total: number; byStatus: Record<string, number> };
  /** Workable items in ready or active plans that only the plan-line hold keeps unclaimable. */
  heldOnlyWorkableItems: { count: number; sample: string[] };
}

function emptyPartial(): CensusPartial {
  return {
    plansRead: 0,
    population: { total: 0, byStatus: {} },
    m1: { created: 0, shipped: 0 },
    m2: { workable: 0, heldByAgent: 0 },
    m3: { onHold: 0, onHoldReadyOrActive: 0, planLineHoldOnly: 0, planLineHoldOnlyReadyOrActive: 0,
      otherHold: 0, noWorkItem: 0, openUnheld: 0, sample: [] },
    m4: { population: 0, plans: 0, withOpenItems: 0 },
    m5: { plansWithOpenItems: 0, idle: 0 },
    m6: { awaiting: 0, archived: 0, withOpenItems: 0 },
    m7: [], m8: [],
    m9: { embedded: [], withoutEmbedding: 0 },
  };
}

function utcDayStart(ms: number): number {
  const d = new Date(ms);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

const DAY_MS = 86_400_000;

function accumulate(partial: CensusPartial, plan: CensusPlanRow, manifest: CensusManifest, runAtMs: number): void {
  partial.plansRead += 1;
  if (inCensusPopulation(plan, DEFAULT_CENSUS_POPULATION)) {
    partial.population.total += 1;
    partial.population.byStatus[plan.status] = (partial.population.byStatus[plan.status] ?? 0) + 1;
  }
  const open = openItemCount(plan);
  const live = LIVE_PLAN_STATUSES.has(plan.status);
  for (const entry of manifest.measures) {
    // The one place a measure's recorded population is applied.
    if (!inCensusPopulation(plan, entry.population)) continue;
    switch (entry.id) {
      case 'M-1': {
        if (entry.window.kind !== 'trailing-utc-days') throw new Error('census_manifest_window_mismatch:M-1');
        const end = utcDayStart(runAtMs);
        const start = end - entry.window.days * DAY_MS;
        const within = (iso: string) => { const t = Date.parse(iso); return t >= start && t < end; };
        if (within(plan.createdAt)) partial.m1.created += 1;
        if (plan.status === 'shipped' && within(plan.updatedAt)) partial.m1.shipped += 1;
        break;
      }
      case 'M-2':
        for (const item of workableItems(plan)) {
          partial.m2.workable += 1;
          if (classifyWorkableItem(plan, item.id) === 'held-by-agent') partial.m2.heldByAgent += 1;
        }
        break;
      case 'M-3':
        for (const item of workableItems(plan)) {
          const bucket = classifyWorkableItem(plan, item.id);
          if (bucket === 'no-work-item') partial.m3.noWorkItem += 1;
          else if (bucket === 'open-unheld') partial.m3.openUnheld += 1;
          else if (bucket === 'plan-line-hold-only' || bucket === 'other-hold') {
            partial.m3.onHold += 1;
            if (live) partial.m3.onHoldReadyOrActive += 1;
            if (bucket === 'other-hold') { partial.m3.otherHold += 1; continue; }
            partial.m3.planLineHoldOnly += 1;
            if (!live) continue;
            partial.m3.planLineHoldOnlyReadyOrActive += 1;
            if (partial.m3.sample.length < HELD_ONLY_SAMPLE_SIZE) partial.m3.sample.push(`${plan.planSlug}#${item.id}`);
          }
        }
        break;
      case 'M-4':
        partial.m4.population += 1;
        if (plan.hasReadinessBlock) { partial.m4.plans += 1; if (open > 0) partial.m4.withOpenItems += 1; }
        break;
      case 'M-5':
        if (open > 0) {
          partial.m5.plansWithOpenItems += 1;
          if (Date.parse(plan.updatedAt) < runAtMs - (entry.params.idleDays ?? 30) * DAY_MS) partial.m5.idle += 1;
        }
        break;
      case 'M-6':
        if (plan.status === 'awaiting-acceptance') {
          partial.m6.awaiting += 1;
          if (plan.archived) partial.m6.archived += 1;
          if (open > 0) partial.m6.withOpenItems += 1;
        }
        break;
      case 'M-7': partial.m7.push(plan.contentChars); break;
      case 'M-8': partial.m8.push(plan.decisionCount); break;
      case 'M-9':
        if (plan.hasEmbedding) partial.m9.embedded.push(plan.planSlug); else partial.m9.withoutEmbedding += 1;
        break;
    }
  }
}

export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

function readings(
  partial: CensusPartial, manifest: CensusManifest, pairs: ReadonlyArray<{ a: string; b: string }>,
): Record<CensusMeasureId, CensusMeasureReading> {
  const out = {} as Record<CensusMeasureId, CensusMeasureReading>;
  for (const entry of manifest.measures) {
    const base = { id: entry.id, title: entry.title, unit: entry.unit };
    switch (entry.id) {
      case 'M-1': out[entry.id] = { ...base, value: partial.m1.created,
        components: { shippedUpperBound: partial.m1.shipped } }; break;
      case 'M-2': out[entry.id] = { ...base, value: partial.m2.heldByAgent,
        components: { workable: partial.m2.workable } }; break;
      case 'M-3': out[entry.id] = { ...base, value: partial.m3.onHold, components: {
        inReadyOrActive: partial.m3.onHoldReadyOrActive, planLineHoldOnly: partial.m3.planLineHoldOnly,
        planLineHoldOnlyInReadyOrActive: partial.m3.planLineHoldOnlyReadyOrActive, otherHold: partial.m3.otherHold,
        noWorkItem: partial.m3.noWorkItem, openUnheld: partial.m3.openUnheld } }; break;
      case 'M-4': out[entry.id] = { ...base, value: partial.m4.plans,
        components: { withOpenItems: partial.m4.withOpenItems, population: partial.m4.population } }; break;
      case 'M-5': out[entry.id] = { ...base, value: partial.m5.idle,
        components: { plansWithOpenItems: partial.m5.plansWithOpenItems } }; break;
      case 'M-6': out[entry.id] = { ...base, value: partial.m6.awaiting,
        components: { archived: partial.m6.archived, withOpenItems: partial.m6.withOpenItems } }; break;
      case 'M-7': out[entry.id] = { ...base, value: median(partial.m7), components: {
        overLarge: partial.m7.filter((n) => n > (entry.params.largeChars ?? 100_000)).length,
        largest: partial.m7.reduce((a, b) => Math.max(a, b), 0), plans: partial.m7.length } }; break;
      case 'M-8': out[entry.id] = { ...base, value: median(partial.m8), components: {
        withMany: partial.m8.filter((n) => n >= (entry.params.manyDecisions ?? 20)).length,
        largest: partial.m8.reduce((a, b) => Math.max(a, b), 0), plans: partial.m8.length } }; break;
      case 'M-9': out[entry.id] = { ...base, value: pairs.length, components: {
        plans: new Set(pairs.flatMap((pair) => [pair.a, pair.b])).size,
        withoutEmbedding: partial.m9.withoutEmbedding, candidates: partial.m9.embedded.length } }; break;
    }
  }
  return out;
}

function keyAfter(a: CensusKey, b: CensusKey | null): boolean {
  if (!b) return true;
  return a.harnessSlug > b.harnessSlug || (a.harnessSlug === b.harnessSlug && a.planSlug > b.planSlug);
}

/**
 * Read the plan store in batches and compute the nine measures.
 *
 * `maxBatches` bounds the work of one pass, never the truth: a pass that stops early reports
 * `omitted` and returns `resume`, and `runPlanPortfolioCensus({ resume })` reads the rest.
 */
export async function runPlanPortfolioCensus(input: {
  store: CensusPlanStore;
  /** Epoch ms of the run instant. Ignored on a resumed run, which keeps the first pass's instant. */
  now?: number;
  batchSize?: number;
  maxBatches?: number;
  resume?: CensusResume;
  manifest?: CensusManifest;
}): Promise<CensusRun> {
  const manifest = input.manifest ?? resolveCensusManifest();
  const manifestFingerprint = censusManifestFingerprint(manifest);
  const batchSize = input.batchSize ?? DEFAULT_CENSUS_BATCH_SIZE;
  const maxBatches = input.maxBatches ?? Number.POSITIVE_INFINITY;
  if (!Number.isInteger(batchSize) || batchSize < 1) throw new Error('census_invalid_batch_size');
  if (!(maxBatches >= 1)) throw new Error('census_invalid_max_batches');
  if (input.resume && input.resume.cursor.manifestFingerprint !== manifestFingerprint) {
    // A cursor cut under another definition cannot be continued under this one.
    throw new Error('census_cursor_manifest_mismatch');
  }
  const partial = input.resume ? structuredClone(input.resume.partial) : emptyPartial();
  const runAtMs = input.resume ? Date.parse(input.resume.cursor.runAt) : (input.now ?? Date.now());
  if (!Number.isFinite(runAtMs)) throw new Error('census_invalid_run_instant');
  let after: CensusKey | null = input.resume ? { ...input.resume.cursor.after } : null;
  let reachedEnd = false;
  for (let batch = 0; batch < maxBatches && !reachedEnd; batch += 1) {
    const rows = await input.store.readPlans({ after, limit: batchSize });
    if (rows.length > batchSize) throw new Error('census_store_batch_overflow');
    for (const row of rows) {
      const key = { harnessSlug: row.harnessSlug, planSlug: row.planSlug };
      // A row at or before the cursor would be counted twice.
      if (!keyAfter(key, after)) throw new Error(`census_store_order_violation:${row.harnessSlug}/${row.planSlug}`);
      accumulate(partial, row, manifest, runAtMs);
      after = key;
    }
    reachedEnd = rows.length < batchSize;
  }
  const omitted = reachedEnd ? 0 : await input.store.countPlansAfter(after);
  const complete = omitted === 0;
  const runAt = new Date(runAtMs).toISOString();
  const m9 = manifest.measures.find((entry) => entry.id === 'M-9');
  const embedded = new Set(partial.m9.embedded);
  const pairs = m9 && embedded.size >= 2
    ? (await input.store.readNearTwinPairs({ harnessSlug: m9.population.harness, planSlugs: [...embedded].sort(),
      minSimilarity: m9.params.minSimilarity ?? 0.92 }))
      // The store computes similarity; membership of the recorded population is decided here.
      .filter((pair) => pair.a !== pair.b && embedded.has(pair.a) && embedded.has(pair.b))
    : [];
  const cursor: CensusCursor | null = complete || !after ? null : { v: 1, manifestFingerprint, runAt, after };
  return {
    manifestVersion: manifest.version,
    manifestFingerprint,
    runAt,
    plansRead: partial.plansRead,
    omitted,
    complete,
    cursor,
    resume: cursor ? { cursor, partial } : null,
    measures: readings(partial, manifest, pairs),
    population: { total: partial.population.total, byStatus: { ...partial.population.byStatus } },
    heldOnlyWorkableItems: { count: partial.m3.planLineHoldOnlyReadyOrActive, sample: [...partial.m3.sample] },
  };
}
