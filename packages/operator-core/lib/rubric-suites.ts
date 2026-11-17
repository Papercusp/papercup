/** Rubric suites reuse plan records; no relation or process cache owns membership. */
import { createHash } from 'node:crypto';
import { classifyRatingForGate, evaluateReleaseProfile, worstMemberVerdict, type ComponentRawVerdict } from '@papercusp/release-profile';
import { getPlanRow, type PlanRow, type PlanSourceOpts } from './agent-tools/plans/source';
import { withPlanLock } from './agent-tools/plans/with-plan-lock';
import { rubricSuiteTemplateDataSchema, type RubricSuiteTemplateData } from './agent-tools/plans/rubric-suite-template';
import { getRubric, type Rubric } from './rubrics';
import { listScorecardPage, type ScorecardRow, type ScorecardListCursor } from './scorecards';
import { acceptanceLineageClosure, areAcceptanceLineageRelated } from './acceptance-author-identity';
import { insertPlanRun, readPlanRunCheckpoint, compareAndSetPlanRunCheckpoint } from './agent-tools/plans/runs';
import { runWithWorkspaceIfConcrete } from './workspace-als';

// These are processing/page bounds, never population limits. The canonical
// scorecard reader accepts default 100 / maximum 500 (scorecards.ts).
export const SUITE_PAGE_SIZE = 100;
export const SUITE_MAX_PAGE_SIZE = 500;
export const SUITE_SCORECARD_PAGE_SIZE = 500;

export interface RubricSuite extends RubricSuiteTemplateData {
  suiteRef: string;
  name: string;
  version: number;
}
export interface SuiteDeps {
  readPlan: (slug: string, scope?: PlanSourceOpts) => Promise<Pick<PlanRow, 'template' | 'templateData' | 'title' | 'version'> | null>;
  writePlan: typeof withPlanLock;
  readRubric: typeof getRubric;
  scorecardPage: typeof listScorecardPage;
  related: typeof areAcceptanceLineageRelated;
}
const defaults: SuiteDeps = {
  readPlan: getPlanRow, writePlan: withPlanLock, readRubric: getRubric,
  scorecardPage: listScorecardPage, related: areAcceptanceLineageRelated,
};
const dependencies = (deps: Partial<SuiteDeps>): SuiteDeps => ({ ...defaults, ...deps });
const serializeEvidence = (value: unknown): string => JSON.stringify(value, (_key, entry) =>
  entry && typeof entry === 'object' && !Array.isArray(entry)
    ? Object.fromEntries(Object.entries(entry).sort(([a], [b]) => a.localeCompare(b))) : entry) ?? 'null';

export async function getRubricSuite(suiteRef: string, scope: PlanSourceOpts = {}, deps: Partial<SuiteDeps> = {}): Promise<RubricSuite | null> {
  const row = await dependencies(deps).readPlan(suiteRef, scope);
  if (!row) return null;
  if (row.template !== 'rubric-suite') throw new Error(`not_a_rubric_suite: ${suiteRef}`);
  const data = rubricSuiteTemplateDataSchema.parse(row.templateData);
  return { ...data, suiteRef, name: row.title ?? suiteRef, version: row.version };
}

export interface WriteSuiteInput {
  suiteRef: string;
  name?: string;
  purpose?: string;
  owner?: string;
  members?: Array<{ rubricRef: string }>;
  /** null explicitly removes aging; omission preserves the last declaration. */
  rescoreIntervalMs?: number | null;
  expectedVersion?: number;
  create?: boolean;
}

export async function writeRubricSuite(input: WriteSuiteInput, scope: PlanSourceOpts = {}, ctx: unknown = {}, deps: Partial<SuiteDeps> = {}) {
  const d = dependencies(deps);
  return d.writePlan(ctx, { slug: input.suiteRef, intent: 'rubrics:suite write', ...scope }, async (body, meta) => {
    if (input.create && body !== null) throw new Error(`suite_exists: ${input.suiteRef}`);
    if (!input.create && body === null) throw new Error(`suite_not_found: ${input.suiteRef}`);
    if (input.expectedVersion !== undefined && input.expectedVersion !== meta?.version) throw new Error('stale_suite_version: re-read the suite before editing');
    if (body !== null && !/^template:\s*['"]?rubric-suite['"]?\s*$/m.test(body)) throw new Error('not_a_rubric_suite');
    const prior = body === null ? {} : rubricSuiteTemplateDataSchema.parse(meta?.templateData);
    const { rescoreIntervalMs: oldInterval, ...priorFields } = prior as Partial<RubricSuiteTemplateData>;
    const interval = input.rescoreIntervalMs === undefined ? oldInterval : input.rescoreIntervalMs;
    const data = rubricSuiteTemplateDataSchema.parse({
      ...priorFields,
      ...(input.purpose !== undefined ? { purpose: input.purpose } : {}),
      ...(input.owner !== undefined ? { owner: input.owner } : {}),
      ...(input.members !== undefined ? { members: input.members } : {}),
      ...(interval != null ? { rescoreIntervalMs: interval } : {}),
    });
    for (const { rubricRef } of data.members) {
      const rubric = await d.readRubric(rubricRef);
      if (!rubric) throw new Error(`unknown_suite_member: ${rubricRef}`);
      if (rubric.status === 'retired') throw new Error(`retired_suite_member: ${rubricRef}`);
    }
    const name = input.name;
    if (name !== undefined && (!name.trim() || /[\r\n]/.test(name))) throw new Error('invalid_suite_name');
    const date = new Date().toISOString().slice(0, 10);
    const created = `---\ntitle: ${JSON.stringify(name ?? input.suiteRef)}\nslug: ${input.suiteRef}\nstatus: draft\ntemplate: rubric-suite\ncreated: ${date}\nupdated: ${date}\n---\n\n## Purpose\n\n${data.purpose}\n`;
    const newBody = body === null ? created : name === undefined ? body :
      /^title:.*$/m.test(body) ? body.replace(/^title:.*$/m, () => `title: ${JSON.stringify(name)}`) : body.replace(/^---\n/, `---\ntitle: ${JSON.stringify(name)}\n`);
    return { newBody, templateData: { data }, value: { ok: true, suiteRef: input.suiteRef } };
  });
}

export interface SuiteCursor { suiteRef: string; scopeKey: string; version: number; offset: number; comparisonTime: string; sourceFingerprint?: string }
const suiteScopeKey = (scope: PlanSourceOpts = {}) => JSON.stringify([scope.workspaceId ?? null, scope.harnessSlug ?? null]);
export class StaleSuiteCursorError extends Error {
  readonly code = 'stale_suite_cursor';
  readonly resync = 'Restart from offset 0 without a cursor; keep the prior result as incomplete history.';
  constructor() { super('The canonical suite changed; restart its population read.'); }
}

function pageBounds(suite: RubricSuite, limit: number, cursor?: SuiteCursor, now = Date.now(), scope: PlanSourceOpts = {}) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > SUITE_MAX_PAGE_SIZE) throw new Error('invalid_suite_page_size');
  if (cursor && (cursor.suiteRef !== suite.suiteRef || cursor.scopeKey !== suiteScopeKey(scope) || cursor.version !== suite.version || !Number.isSafeInteger(cursor.offset) || cursor.offset < 0 || cursor.offset > suite.members.length || !Number.isFinite(Date.parse(cursor.comparisonTime)))) throw new StaleSuiteCursorError();
  return { offset: cursor?.offset ?? 0, comparisonTime: cursor?.comparisonTime ?? new Date(now).toISOString() };
}

export interface SuiteMemberVerdict {
  rubricRef: string;
  verdict: ComponentRawVerdict;
  reason: string;
  scorecardRef: string | null;
  rubricRevision: number | null;
  historyRead: number;
  unreadable: number;
  evidenceFingerprint?: string;
}

/** Display budget only: omitted records remain recoverable through the cursor. */
export const SUITE_RESULT_PAGE_BYTES = 3072;
export function boundSuiteMemberResult<T extends object, R extends { rubricRef: string; unreadable?: number }>(header: T, members: R[], snapshot: Omit<SuiteCursor, 'offset'>, offset: number, total: number, byteLimit?: number) {
  const build = (count: number) => ({ ...header, total, returned: count, omitted: total - offset - count,
    members: members.slice(0, count),
    unreadable: 'unreadable' in header && typeof header.unreadable === 'number' ? header.unreadable : members.slice(0, count).reduce((n, m) => n + (m.unreadable ?? 0), 0),
    complete: offset === 0 && count === total && members.slice(0, count).every(m => !m.unreadable) && (!('aggregateComplete' in header) || header.aggregateComplete === true),
    next: offset + count < total ? { ...snapshot, offset: offset + count } : null });
  if (byteLimit === undefined) return build(members.length);
  if (!Number.isSafeInteger(byteLimit) || byteLimit < 1) throw new Error('invalid_suite_byte_budget');
  let count = 0;
  for (; count < members.length; count++) {
    if (Buffer.byteLength(JSON.stringify(build(count + 1)), 'utf8') > byteLimit) break;
  }
  if ((members.length > 0 && count === 0) || Buffer.byteLength(JSON.stringify(build(count)), 'utf8') > byteLimit) {
    throw new Error(`suite_record_exceeds_page_budget: ${members[0]?.rubricRef ?? snapshot.suiteRef}; identity preserved; retry with a larger byte budget through the service reader`);
  }
  return build(count);
}

/** Read the canonical definition in recoverable, byte-bounded member pages. */
export async function readSuiteDefinitionPage(suiteRef: string, opts: { scope?: PlanSourceOpts; cursor?: SuiteCursor; limit?: number; byteLimit?: number; now?: number } = {}, deps: Partial<SuiteDeps> = {}) {
  const suite = await getRubricSuite(suiteRef, opts.scope, deps);
  if (!suite) throw new Error(`suite_not_found: ${suiteRef}`);
  const { offset, comparisonTime } = pageBounds(suite, opts.limit ?? SUITE_PAGE_SIZE, opts.cursor, opts.now, opts.scope);
  const { members, ...metadata } = suite;
  const snapshot = { suiteRef, scopeKey: suiteScopeKey(opts.scope), version: suite.version, comparisonTime };
  return boundSuiteMemberResult({ ok: true, suite: metadata, snapshot }, members.slice(offset, offset + (opts.limit ?? SUITE_PAGE_SIZE)), snapshot, offset, members.length, opts.byteLimit ?? SUITE_RESULT_PAGE_BYTES);
}

function scorecardComplete(row: ScorecardRow, rubric: Rubric): boolean {
  const keys = rubric.criteria.map(c => c.key);
  return row.rubricResolved && row.missingKeys.length === 0 && row.extraKeys.length === 0 &&
    keys.length > 0 && Object.keys(row.ratings).length === keys.length && keys.every(key => row.ratings[key] !== undefined);
}

/** Hash the evidence used by this verdict, excluding read-time UI diagnostics. */
function memberEvidenceFingerprint(rubric: Rubric, row: ScorecardRow): string {
  return createHash('sha256').update(serializeEvidence({
    rubricRevision: rubric.revision, criteriaHash: rubric.criteriaHash,
    createdBy: rubric.createdBy, criteria: rubric.criteria,
    scorecard: { issueId: row.issueId, rubricRef: row.rubricRef,
      rubricRevision: row.rubricRevision, criteriaHash: row.criteriaHash,
      createdAt: row.createdAt, createdBy: row.createdBy, ratings: row.ratings,
      retracted: row.retracted, supersededBy: row.supersededBy,
      provisional: row.provisional, purpose: row.purpose },
  })).digest('hex');
}

const emptyMemberVerdict = (rubricRef: string): SuiteMemberVerdict => ({ rubricRef, verdict: 'unknown',
  reason: 'no complete independent current scorecard', scorecardRef: null, rubricRevision: null, historyRead: 0, unreadable: 0 });
const rubricFingerprint = (rubric: Rubric) => createHash('sha256').update(serializeEvidence({
  revision: rubric.revision, criteriaHash: rubric.criteriaHash, createdBy: rubric.createdBy, criteria: rubric.criteria,
})).digest('hex');

export interface SuiteHistoryProgress {
  rubricFingerprint: string;
  before?: ScorecardListCursor;
  eligibilityUnknown: boolean;
  result: SuiteMemberVerdict;
}

/** One processing page. The caller may checkpoint this state before continuing. */
export async function advanceSuiteMemberHistory(rubricRef: string, suite: RubricSuite, comparisonTime: string,
  prior: SuiteHistoryProgress | undefined, deps: Partial<SuiteDeps> = {}, scope: PlanSourceOpts = {}) {
  const d = dependencies(deps);
  const rubric = await d.readRubric(rubricRef);
  const out = prior ? { ...prior.result } : emptyMemberVerdict(rubricRef);
  if (!rubric) return { complete: true, progress: { rubricFingerprint: '', eligibilityUnknown: false,
    result: { ...out, reason: 'member rubric is missing', unreadable: out.unreadable + 1 } } };
  const identity = rubricFingerprint(rubric);
  if (prior && (prior.rubricFingerprint !== identity || prior.result.rubricRef !== rubricRef)) throw new StaleSuiteCursorError();
  out.rubricRevision = rubric.revision ?? null;
  if (!rubric.createdBy?.trim()) return { complete: true, progress: { rubricFingerprint: identity, eligibilityUnknown: false,
    result: { ...out, reason: 'rubric author identity is unavailable', unreadable: out.unreadable + 1 } } };
  let eligibilityUnknown = prior?.eligibilityUnknown ?? false;
  // One lazy census per processing step. The legacy pairwise reader bounds its
  // walk and cannot prove independence beyond that frontier. A strict census
  // rejects incomplete evidence; a new run can retry after the graph is readable.
  // Keep the injected pairwise seam for callers supplying their own relation.
  let lineage: Promise<Set<string>> | undefined;
  const page = await d.scorecardPage({ rubricRef, limit: SUITE_SCORECARD_PAGE_SIZE, before: prior?.before, comparisonTime });
  out.historyRead += page.rows.length;
  for (const row of page.rows) {
    if (Date.parse(row.createdAt) > Date.parse(comparisonTime) || !scorecardComplete(row, rubric)) continue;
    if (row.retracted || row.supersededBy || row.provisional || row.purpose === 'diagnostic') continue;
    if (!row.createdBy?.trim()) {
      eligibilityUnknown = true; out.unreadable++;
      out.reason = 'scorecard grader identity is unavailable; start a new suite run after identity evidence is repaired';
      continue;
    }
    let related: boolean;
    try {
      related = deps.related
        ? await d.related(rubric.createdBy, row.createdBy, { workspaceId: scope.workspaceId })
        : (await (lineage ??= acceptanceLineageClosure(rubric.createdBy,
          { workspaceId: scope.workspaceId, requireComplete: true }))).has(row.createdBy.trim());
    } catch (error) {
      eligibilityUnknown = true; out.unreadable++;
      out.reason = `scorecard independence unreadable: ${String(error)}; start a new suite run after the lineage census is readable`;
      continue;
    }
    if (related || out.scorecardRef || eligibilityUnknown) continue;
    out.scorecardRef = row.issueId;
    out.evidenceFingerprint = memberEvidenceFingerprint(rubric, row);
    if (row.rubricRevision !== rubric.revision || !rubric.revision ||
      (rubric.criteriaHash && row.criteriaHash !== rubric.criteriaHash)) { out.reason = 'scorecard is not on the current rubric revision'; continue; }
    const measured = Date.parse(row.createdAt);
    if (!Number.isFinite(measured) || (suite.rescoreIntervalMs !== undefined && Date.parse(comparisonTime) - measured > suite.rescoreIntervalMs)) {
      out.reason = 'scorecard is outside the declared rescore interval'; continue;
    }
    out.verdict = worstMemberVerdict(rubric.criteria.map(criterion => classifyRatingForGate(row.ratings[criterion.key].rating)));
    out.reason = 'latest complete outside-lineage scorecard on the current revision';
  }
  const current = await d.readRubric(rubricRef);
  if (!current || rubricFingerprint(current) !== identity) throw new StaleSuiteCursorError();
  const tail = page.rows.at(-1);
  if (page.hasMore && (!tail || (prior?.before?.issueId === tail.issueId && prior.before.createdAt === tail.createdAt))) throw new Error('scorecard_history_cursor_did_not_advance');
  const before = tail ? { createdAt: tail.createdAt, issueId: tail.issueId } : prior?.before;
  if (out.unreadable > 0 && out.verdict !== 'fail') out.verdict = 'unknown';
  return { complete: !page.hasMore, progress: { rubricFingerprint: identity, before, eligibilityUnknown, result: out } };
}

/** Exhaust the same processing pages when the caller does not need to pause. */
export async function readSuiteMemberVerdict(rubricRef: string, suite: RubricSuite, comparisonTime: string, deps: Partial<SuiteDeps> = {}, scope: PlanSourceOpts = {}): Promise<SuiteMemberVerdict> {
  let progress: SuiteHistoryProgress | undefined;
  try {
    while (true) {
      const page = await advanceSuiteMemberHistory(rubricRef, suite, comparisonTime, progress, deps, scope);
      progress = page.progress;
      if (page.complete) return progress.result;
    }
  } catch (error) {
    const out = progress?.result ?? emptyMemberVerdict(rubricRef);
    return { ...out, verdict: 'unknown', reason: `required evidence unreadable: ${String(error)}`, unreadable: out.unreadable + 1 };
  }
}

interface SuiteScanState {
  schemaVersion: 'rubric-suite-scan-v1';
  suiteRef: string; scopeKey: string; version: number; comparisonTime: string;
  phase: 'collect' | 'verify' | 'done'; offset: number;
  members: SuiteMemberVerdict[]; history?: SuiteHistoryProgress;
}
export interface SuiteRunStore {
  create: (suiteRef: string, scope: PlanSourceOpts) => Promise<number>;
  read: (runId: number, suiteRef: string, scope: PlanSourceOpts) => Promise<Record<string, unknown> | null>;
  save: (runId: number, suiteRef: string, scope: PlanSourceOpts, prior: Record<string, unknown> | null,
    next: Record<string, unknown>, complete: boolean) => Promise<boolean>;
}
const SUITE_RUN_SESSION = 'system:rubric-suite-evaluation-v1';
async function suiteRunScope(suiteRef: string, scope: PlanSourceOpts) {
  const row = await getPlanRow(suiteRef, scope);
  if (!row || row.template !== 'rubric-suite') throw new Error('suite_not_found: ' + suiteRef);
  return { planSlug: suiteRef, harnessSlug: row.harnessSlug, sessionId: SUITE_RUN_SESSION };
}
const suiteRunStore: SuiteRunStore = {
  create: async (suiteRef, scope) => {
    const row = await getPlanRow(suiteRef, scope);
    if (!row || row.template !== 'rubric-suite') throw new Error('suite_not_found: ' + suiteRef);
    return insertPlanRun({ planSlug: suiteRef, harnessSlug: row.harnessSlug, planContentHash: row.contentHash,
      sessionId: SUITE_RUN_SESSION, note: 'Resumable suite evidence scan; outputs retain member and history progress.',
      launchedBy: SUITE_RUN_SESSION, title: 'Rubric suite evaluation', status: 'idle' });
  },
  read: async (runId, suiteRef, scope) => readPlanRunCheckpoint(runId, await suiteRunScope(suiteRef, scope)),
  save: async (runId, suiteRef, scope, prior, next, complete) => compareAndSetPlanRunCheckpoint(runId,
    await suiteRunScope(suiteRef, scope), prior, next, complete),
};

/** One durable history page; only server-owned plan-run state can supply prior verdicts. */
export async function advanceRubricSuiteRun(suiteRef: string, opts: { scope?: PlanSourceOpts; runId?: number;
  cursor?: SuiteCursor; limit?: number; now?: number; byteLimit?: number } = {},
  deps: Partial<SuiteDeps> = {}, store: SuiteRunStore = suiteRunStore) {
  const scope = opts.scope ?? {};
  return runWithWorkspaceIfConcrete(scope.workspaceId, async () => {
    const suite = await getRubricSuite(suiteRef, scope, deps);
    if (!suite) throw new Error('suite_not_found: ' + suiteRef);
    const runId = opts.runId ?? await store.create(suiteRef, scope);
    const prior = opts.runId ? await store.read(runId, suiteRef, scope) : null;
    if (opts.runId && !prior) throw new Error('suite_run_not_initialized: restart without runId; incomplete history is retained');
    const state: SuiteScanState = prior ? JSON.parse(JSON.stringify(prior)) : {
      schemaVersion: 'rubric-suite-scan-v1', suiteRef, scopeKey: suiteScopeKey(scope), version: suite.version,
      comparisonTime: new Date(opts.now ?? Date.now()).toISOString(), phase: 'collect', offset: 0, members: [],
    };
    if (state.schemaVersion !== 'rubric-suite-scan-v1' || state.suiteRef !== suiteRef || state.scopeKey !== suiteScopeKey(scope)
      || state.version !== suite.version || !Number.isFinite(Date.parse(state.comparisonTime))
      || !Number.isSafeInteger(state.offset) || state.offset < 0 || state.offset > suite.members.length
      || !['collect', 'verify', 'done'].includes(state.phase) || !Array.isArray(state.members)) throw new StaleSuiteCursorError();
    if (opts.cursor && state.phase !== 'done') throw new Error('suite_run_still_processing: follow next.runId first');
    if (prior?.phase === 'done') {
      // Finished output is durable history. Before serving it as a current read,
      // check that its complete source population still produces the same proof.
      const current = await evaluateRubricSuite(suiteRef, scope, deps, Date.parse(state.comparisonTime));
      if (serializeEvidence(current.members) !== serializeEvidence(state.members)) throw new StaleSuiteCursorError();
    }
    if (state.phase !== 'done') {
      if (suite.members.length === 0) state.phase = 'done';
      else {
        const ref = suite.members[state.offset]?.rubricRef;
        if (!ref) throw new StaleSuiteCursorError();
        const page = await advanceSuiteMemberHistory(ref, suite, state.comparisonTime, state.history, deps, scope);
        if (page.complete) {
          if (state.phase === 'collect') state.members.push(page.progress.result);
          else if (serializeEvidence(state.members[state.offset]) !== serializeEvidence(page.progress.result)) throw new StaleSuiteCursorError();
          state.offset++; delete state.history;
          if (state.offset === suite.members.length) {
            if (state.phase === 'collect') { state.phase = 'verify'; state.offset = 0; }
            else state.phase = 'done';
          }
        } else state.history = page.progress;
      }
      const after = await getRubricSuite(suiteRef, scope, deps);
      if (!after || after.version !== state.version) throw new StaleSuiteCursorError();
      if (!await store.save(runId, suiteRef, scope, prior, { ...state }, state.phase === 'done')) {
        throw new Error('suite_run_progress_conflict: resume the same runId; another call committed first');
      }
    }
    if (state.phase !== 'done') return { ok: true, suiteRef, runId, verdict: 'unknown' as const, go: false,
      complete: false, aggregateComplete: false, scanComplete: false, phase: state.phase,
      processedMembers: state.offset, historyRead: state.history?.result.historyRead ?? 0,
      total: suite.members.length, members: [], returned: 0, omitted: suite.members.length, next: { runId } };
    const verdict = worstMemberVerdict(state.members.map(m => m.verdict));
    const profile = await evaluateReleaseProfile({ profileRef: suiteRef, components: state.members.map(m => ({
      key: m.rubricRef, title: m.rubricRef, mandatory: true, check: async () => ({ verdict: m.verdict, reason: m.reason,
        measuredAt: state.comparisonTime, evidence: m.scorecardRef ? [{ ref: m.scorecardRef, kind: 'scorecard' }] : [] }),
    })) });
    const snapshot = { suiteRef, scopeKey: state.scopeKey, version: state.version, comparisonTime: state.comparisonTime,
      sourceFingerprint: createHash('sha256').update(serializeEvidence(state.members)).digest('hex') };
    if (opts.cursor && opts.cursor.sourceFingerprint !== snapshot.sourceFingerprint) throw new StaleSuiteCursorError();
    const { offset } = pageBounds(suite, opts.limit ?? SUITE_PAGE_SIZE, opts.cursor, opts.now, scope);
    const aggregateComplete = state.members.length === suite.members.length && state.members.every(m => m.unreadable === 0);
    const page = boundSuiteMemberResult({ ok: true, suiteRef, runId, snapshot, verdict,
      go: verdict === 'pass' && aggregateComplete && profile.go, scanComplete: true, aggregateComplete,
      coverage: { pass: state.members.filter(m => m.verdict === 'pass').length,
        fail: state.members.filter(m => m.verdict === 'fail').length,
        unknown: state.members.filter(m => m.verdict === 'unknown').length, total: suite.members.length } },
    state.members.slice(offset, offset + (opts.limit ?? SUITE_PAGE_SIZE)), snapshot, offset, suite.members.length,
    (opts.byteLimit ?? SUITE_RESULT_PAGE_BYTES) - 128);
    return { ...page, next: page.next ? { runId, cursor: page.next } : null };
  });
}

/** A portable page cursor can be saved on an existing plan run/checkpoint. */
export async function readSuiteScorecardPage(suiteRef: string, opts: { scope?: PlanSourceOpts; cursor?: SuiteCursor; limit?: number; now?: number; byteLimit?: number } = {}, deps: Partial<SuiteDeps> = {}) {
  const suite = await getRubricSuite(suiteRef, opts.scope, deps);
  if (!suite) throw new Error(`suite_not_found: ${suiteRef}`);
  const { offset, comparisonTime } = pageBounds(suite, opts.limit ?? SUITE_PAGE_SIZE, opts.cursor, opts.now, opts.scope);
  const selected = suite.members.slice(offset, offset + (opts.limit ?? SUITE_PAGE_SIZE));
  const members: SuiteMemberVerdict[] = [];
  for (const member of selected) members.push(await readSuiteMemberVerdict(member.rubricRef, suite, comparisonTime, deps, opts.scope));
  const after = await getRubricSuite(suiteRef, opts.scope, deps);
  if (!after || after.version !== suite.version) throw new StaleSuiteCursorError();
  const snapshot = { suiteRef, scopeKey: suiteScopeKey(opts.scope), version: suite.version, comparisonTime };
  const result = boundSuiteMemberResult({ ok: true, suiteRef, snapshot }, members, snapshot, offset, suite.members.length, opts.byteLimit);
  return result;
}

/** The aggregate consumer follows every continuation before claiming completeness. */
export async function evaluateRubricSuite(suiteRef: string, scope: PlanSourceOpts = {}, deps: Partial<SuiteDeps> = {}, now = Date.now()) {
  const members: SuiteMemberVerdict[] = [];
  let cursor: SuiteCursor | undefined;
  let total = 0;
  let snapshot: Omit<SuiteCursor, 'offset'> | undefined;
  do {
    const page = await readSuiteScorecardPage(suiteRef, { scope, cursor, now }, deps);
    total = page.total;
    snapshot = page.snapshot;
    members.push(...page.members);
    cursor = page.next ?? undefined;
  } while (cursor);
  const verdict = worstMemberVerdict(members.map(m => m.verdict));
  snapshot = { ...snapshot!, sourceFingerprint: createHash('sha256').update(serializeEvidence(members)).digest('hex') };
  const profile = await evaluateReleaseProfile({ profileRef: suiteRef, components: members.map(m => ({
    key: m.rubricRef, title: m.rubricRef, mandatory: true,
    check: async () => ({ verdict: m.verdict, reason: m.reason, measuredAt: new Date(now).toISOString(), evidence: m.scorecardRef ? [{ ref: m.scorecardRef, kind: 'scorecard' }] : [] }),
  })) }, { now });
  return {
    suiteRef, snapshot: snapshot!, verdict, go: verdict === 'pass' && profile.go, members, total, returned: members.length, omitted: 0,
    unreadable: members.reduce((n, m) => n + m.unreadable, 0),
    complete: members.every(m => m.unreadable === 0),
    coverage: { pass: members.filter(m => m.verdict === 'pass').length, fail: members.filter(m => m.verdict === 'fail').length, unknown: members.filter(m => m.verdict === 'unknown').length, total },
  };
}

/** Aggregate exhaustively; transport only a recoverable display page. */
export async function readSuiteScorecardResult(suiteRef: string, opts: { scope?: PlanSourceOpts; cursor?: SuiteCursor; limit?: number; now?: number; byteLimit?: number } = {}, deps: Partial<SuiteDeps> = {}) {
  const result = await evaluateRubricSuite(suiteRef, opts.scope, deps, opts.cursor ? Date.parse(opts.cursor.comparisonTime) : opts.now);
  if (opts.cursor && opts.cursor.sourceFingerprint !== result.snapshot.sourceFingerprint) throw new StaleSuiteCursorError();
  const suite = await getRubricSuite(suiteRef, opts.scope, deps);
  if (!suite || suite.version !== result.snapshot.version) throw new StaleSuiteCursorError();
  const { offset } = pageBounds(suite, opts.limit ?? SUITE_PAGE_SIZE, opts.cursor, opts.now, opts.scope);
  const { members, returned: _returned, omitted: _omitted, complete, ...header } = result;
  const page = boundSuiteMemberResult({ ok: true, ...header, aggregateComplete: complete },
    members.slice(offset, offset + (opts.limit ?? SUITE_PAGE_SIZE)), result.snapshot, offset, result.total, opts.byteLimit ?? SUITE_RESULT_PAGE_BYTES);
  return page;
}

/** Bound serialized list summaries; retain every omitted row behind nextOffset. */
export function boundSuiteListResult<T extends { rubrics: unknown[]; total: number; snapshot: number; complete: boolean }>(payload: T, offset: number, byteLimit = SUITE_RESULT_PAGE_BYTES) {
  const build = (count: number) => ({ ...payload, rubrics: payload.rubrics.slice(0, count), count, returned: count,
    omitted: Math.max(0, payload.total - offset - count), hasMore: offset + count < payload.total,
    nextOffset: offset + count < payload.total ? offset + count : null,
    next: offset + count < payload.total ? { offset: offset + count, suiteVersion: payload.snapshot } : null,
    complete: payload.complete && offset === 0 && count === payload.total });
  let count = payload.rubrics.length;
  while (count > 0 && Buffer.byteLength(JSON.stringify(build(count)), 'utf8') > byteLimit) count--;
  if ((payload.rubrics.length > 0 && count === 0) || Buffer.byteLength(JSON.stringify(build(count)), 'utf8') > byteLimit) {
    throw new Error('suite_list_record_exceeds_page_budget: read the canonical definition with rubrics:suite {op:get} and follow member refs with rubrics:get; no records were discarded');
  }
  return build(count);
}

/** List filter reads the canonical members on every call, including acceptance rubrics. */
export async function listSuiteRubricsPage(suiteRef: string, filter: { status?: string; characteristic?: string; subjectPlan?: string; kind?: string; limit?: number; offset?: number; suiteVersion?: number } = {}, scope: PlanSourceOpts = {}, deps: Partial<SuiteDeps> = {}) {
  const suite = await getRubricSuite(suiteRef, scope, deps);
  if (!suite) throw new Error(`suite_not_found: ${suiteRef}`);
  const limit = filter.limit ?? SUITE_PAGE_SIZE;
  pageBounds(suite, limit);
  if (filter.suiteVersion !== undefined && filter.suiteVersion !== suite.version) throw new StaleSuiteCursorError();
  const offset = filter.offset ?? 0;
  if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('invalid_suite_offset');
  const matching: Rubric[] = [];
  const unreadable: string[] = [];
  for (const { rubricRef } of suite.members) {
    const rubric = await dependencies(deps).readRubric(rubricRef);
    if (!rubric) { unreadable.push(rubricRef); continue; }
    if (filter.status && rubric.status !== filter.status) continue;
    if (filter.characteristic && rubric.characteristic !== filter.characteristic) continue;
    if (filter.subjectPlan && rubric.subjectPlan !== filter.subjectPlan) continue;
    if (filter.kind && filter.kind !== 'any' && rubric.kind !== filter.kind) continue;
    matching.push(rubric);
  }
  const rubrics = matching.slice(offset, offset + limit);
  const after = await getRubricSuite(suiteRef, scope, deps);
  if (!after || after.version !== suite.version) throw new StaleSuiteCursorError();
  const hasMore = offset + rubrics.length < matching.length;
  return { rubrics, hasMore, nextOffset: hasMore ? offset + rubrics.length : null, snapshot: suite.version,
    total: matching.length, memberTotal: suite.members.length, returned: rubrics.length,
    omitted: Math.max(0, matching.length - offset - rubrics.length), unreadable, complete: unreadable.length === 0 && !hasMore && offset === 0,
    resync: 'Read rubrics:list again from offset 0 if the suite snapshot changes.' };
}
