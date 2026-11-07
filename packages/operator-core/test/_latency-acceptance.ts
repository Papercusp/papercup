/** LATENCY-M1 measurement support. This does not run tasks or certify a baseline.
 * Uses the existing fixture/test/results rails; simulated unit samples prove only
 * arithmetic and fail-closed accounting, never a measured latency improvement.
 */
import { createHash } from 'node:crypto';
import { canonicalJson } from '../../../libs/generic/hash-chain/src/canonical-json';

export const LATENCY_M1_TASKS = Object.freeze(Array.from({ length: 10 }, (_, i) =>
  `T${String(i + 1).padStart(2, '0')}`));
export const LATENCY_M1_DEADLINE_MS = 600_000;
export type LatencyArm = 'baseline' | 'candidate';
export type CacheStratum = 'cold' | 'warm';
export interface LatencyAttemptKey {
  task: string;
  stratum: CacheStratum;
  repetition: number;
  arm: LatencyArm;
}

export function latencyAttemptId(key: LatencyAttemptKey): string {
  return `${key.task}:${key.stratum}:${key.repetition}:${key.arm}`;
}

/** Manifest4: complete baseline, independent acceptance, edits, then candidate.
 * Both arms retain the same task/stratum/repetition order; this is not temporal
 * counterbalancing. */
export function latencyAttemptSchedule(): LatencyAttemptKey[] {
  return (['baseline', 'candidate'] as const).flatMap(arm =>
    LATENCY_M1_TASKS.flatMap(task => (['cold', 'warm'] as const).flatMap(stratum =>
      [1, 2, 3].map(repetition => ({ task, stratum, repetition, arm })))));
}

export function latencyFixtureDigest(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');
}

/** Frozen LATENCY-M1 seed, independent of the wall clock and the measured arm.
 * These are inputs/reference data only; no production reader supplies the oracle.
 * The existing migrated PG fixture can insert these ordinary work-item/envelope
 * records without introducing another store or benchmark runner. */
export function latencyDataFixtures() {
  const workspace = 'latency-acceptance-fixture';
  const harness = 'papercusp';
  const plan = 'latency-acceptance-coverage';
  const anchorMs = Date.parse('2026-11-06T00:00:00.000Z');
  const dayMs = 86_400_000;
  const workItems = Array.from({ length: 10_000 }, (_, ordinal) => ({
    feature_id: `WI-${8_000_000 + ordinal}`,
    workspace_id: workspace,
    harness_slug: harness,
    item_kind: 'task',
    status: 'open',
    title: `Unrelated deterministic item ${ordinal}`,
    summary: '',
    payload: {} as Record<string, unknown>,
    created_ts: anchorMs - dayMs,
    updated_ts: anchorMs - dayMs,
  }));
  const marker = (item: string) => `Plan: ${plan} item ${item}`;
  const stamp = (item: string) => ({ plan_item: {
    plan_slug: plan, item_id: item, harness_slug: harness,
  } });
  workItems[0]!.payload = stamp('P-001'); // typed-only
  workItems[1]!.summary = marker('P-002'); // legacy-only
  workItems[2]!.payload = stamp('P-003'); // mixed, one target
  workItems[2]!.summary = marker('P-003');
  workItems[3]!.summary = marker('P-004'); // terminal coverage is retained
  workItems[3]!.status = 'done';
  workItems[4]!.payload = { ...stamp('P-005'), _claimHold: true }; // shadow
  workItems[5]!.payload = stamp('P-005'); // eligible target beside the shadow
  workItems[6]!.summary = `(${marker('P-006')})`; // exact marker boundary
  workItems[7]!.summary = `${marker('P-006')}0`; // adjacent item is not P-006
  workItems[8]!.summary = `x${marker('P-006')}`; // adjacent marker prefix
  workItems[9]!.payload = stamp('P-007'); // repeated lookup uses the same target
  workItems[10]!.summary = marker('P-008');
  workItems[10]!.workspace_id = 'latency-acceptance-other';
  workItems[11]!.summary = marker('P-009');
  workItems[11]!.harness_slug = 'other-harness';
  const coverageReference = [
    { case: 'typed-only', item: 'P-001', eligibleIds: ['WI-8000000'] },
    { case: 'legacy-only', item: 'P-002', eligibleIds: ['WI-8000001'] },
    { case: 'mixed', item: 'P-003', eligibleIds: ['WI-8000002'] },
    { case: 'terminal', item: 'P-004', eligibleIds: ['WI-8000003'] },
    { case: 'parked', item: 'P-005', eligibleIds: ['WI-8000005'] },
    { case: 'exact-boundary', item: 'P-006', eligibleIds: ['WI-8000006'] },
    { case: 'idempotent-repeat', item: 'P-007', eligibleIds: ['WI-8000009'] },
    { case: 'cross-workspace', item: 'P-008', eligibleIds: [] },
    { case: 'cross-harness', item: 'P-009', eligibleIds: [] },
  ];
  const coverageEdges = [0, 2, 4, 5, 9].map(ordinal => ({
    workspace_id: workspace, src_kind: 'issue', src_ref: workItems[ordinal]!.feature_id,
    dst_kind: 'plan_item',
    dst_ref: `${plan}#${ordinal === 0 ? 'P-001' : ordinal === 2 ? 'P-003'
      : ordinal === 9 ? 'P-007' : 'P-005'}`,
    rel: 'implements', created_at: '2026-11-05T00:00:00.000Z',
  }));

  const busy = 'latency-acceptance:busy:';
  const quiet = 'latency-acceptance:quiet:';
  const unrelated = 'latency-acceptance:unrelated:';
  const oldKeys = Array.from({ length: 20 }, (_, i) =>
    `${i < 10 ? busy : quiet}old-${String(i % 10).padStart(2, '0')}`);
  const bodies: Array<Record<string, unknown> & { ts: string }> = oldKeys.map(condition_key => ({
    condition_key, ts: new Date(anchorMs - 30 * dayMs).toISOString(),
  }));
  const controls = [
    { condition_key: busy + 'closed-exact' },
    { condition_key: busy + 'closed-many-a' },
    { condition_key: quiet + 'closed-many-b' },
    { resolves_condition: busy + 'closed-exact' },
    { resolves_conditions: [busy + 'closed-many-a', quiet + 'closed-many-b'] },
    // Same suffix, different key: cannot release an old busy-prefix hold.
    { resolves_condition: unrelated + 'old-00' },
  ];
  for (const [i, control] of controls.entries()) bodies.push({ ...control,
    ts: new Date(anchorMs - dayMs + i).toISOString() });
  while (bodies.length < 10_000) bodies.push({
    resolves_condition: busy + `resolved-noise-${bodies.length}`,
    ts: new Date(anchorMs - 10_000 + bodies.length).toISOString(),
  });
  const conditionEnvelopes = bodies.map((body, ordinal) => ({
    ...body, msg_id: `latency-m1-condition-${String(ordinal).padStart(5, '0')}`,
    from: 'fixture:latency-author-su', to: ['*'], summary: 'Frozen condition fixture',
  }));
  const conditionReference = {
    [busy]: ['00', '01', '02', '03', '04', '05', '06', '07', '08', '09'].map(n => busy + 'old-' + n),
    [quiet]: ['00', '01', '02', '03', '04', '05', '06', '07', '08', '09'].map(n => quiet + 'old-' + n),
    [unrelated]: [] as string[],
  };
  return { seed: 'LATENCY-M1-v2-20261107', anchorMs, workspace, harness, plan,
    workItems, coverageEdges, coverageReference, conditionEnvelopes, conditionReference };
}

/** T06 source inputs and independent normalized inbox references. The future
 * runtime capture supplies build generations, reasons and monotonic durations;
 * none of those observations are manufactured by this preparation fixture. */
export function latencyAttentionFixtures() {
  const workspace = 'latency-acceptance-fixture';
  const otherWorkspace = 'latency-acceptance-other';
  const anchorMs = Date.parse('2026-11-06T00:00:00.000Z');
  const message = (id: string, ordinal: number, to = ['human']) => ({
    msg_id: `latency-attention-${id}`, from: 'fixture:latency-author-su', to,
    kind: 'message', summary: id, body: `${id} body`, expects: 'none',
    ts: new Date(anchorMs + ordinal).toISOString(),
  });
  const seed = [message('selected', 0), message('neighbor', 1)];
  const unrelated = Array.from({ length: 100 }, (_, i) =>
    message(`unrelated-${String(i).padStart(3, '0')}`, i + 2, ['fixture:unrelated-agent']));
  const relevant = message('relevant', 102);
  const ids = ['coord-message:latency-attention-neighbor', 'coord-message:latency-attention-selected'];
  return { seed: 'LATENCY-M1-attention-v1', workspace, otherWorkspace, harness: 'papercusp',
    keys: [`${workspace}/papercusp/unchanged`, `${workspace}/papercusp/relevant`,
      `${otherWorkspace}/papercusp/isolation`],
    seedMessages: seed, unrelatedMessages: unrelated, relevantMessage: relevant,
    acknowledgment: { acker: 'admin', msgId: seed[0]!.msg_id, atMs: anchorMs + 103 },
    reference: {
      before: ids, afterUnrelated: ids,
      afterRelevant: [...ids, 'coord-message:latency-attention-relevant'].sort(),
      afterAcknowledgment: ['coord-message:latency-attention-neighbor', 'coord-message:latency-attention-relevant'],
      otherWorkspace: [] as string[], maxBuildsPerKeyGeneration: 1,
    },
    observationRequired: ['normalizedContents', 'sourceBuildsByKeyGeneration',
      'invalidationReasons', 'handlerMonotonicDurations', 'effectiveCacheConfiguration'],
    measured: false,
  };
}

/** T10 deterministic dependency schedules, expressed relative to monotonic
 * task entry. These are injected test inputs, never measured latency samples.
 * The caller must separately pin the actual unchanged runtime budget. */
export function latencyRetrievalFixtures(budgetMs: number) {
  if (!Number.isSafeInteger(budgetMs) || budgetMs < 4) {
    throw new Error('LATENCY-M1 retrieval fixture requires an explicit integer budget >=4ms');
  }
  const common = { callEntryMs: 0, embedderEntryMs: 0, budgetMs, deadlineMs: budgetMs,
    lexicalFallbackId: 'latency-lexical-001' };
  const half = Math.floor(budgetMs / 2);
  return { seed: 'LATENCY-M1-retrieval-v1', budgetMs, measured: false,
    budgetProvenance: 'caller-supplied; actual loaded runtime configuration must be pinned separately',
    cases: [
      { id: 'on-time', ...common, synchronousReturnMs: 0, queuedAtMs: 0, networkAtMs: 1,
        resultAtMs: budgetMs - 1, timerCallbackMs: null,
        expected: { embeddingAccepted: true, fallback: null, cancellation: null } },
      { id: 'synchronous-entry-block', ...common, synchronousReturnMs: budgetMs + 1,
        queuedAtMs: null, networkAtMs: null, resultAtMs: budgetMs + 1, timerCallbackMs: budgetMs + 2,
        expected: { embeddingAccepted: false, fallback: 'latency-lexical-001', cancellation: 'non-preemptible-entry-explicit' } },
      { id: 'queue-delay', ...common, synchronousReturnMs: 0, queuedAtMs: 0, networkAtMs: null,
        resultAtMs: null, timerCallbackMs: budgetMs,
        expected: { embeddingAccepted: false, fallback: 'latency-lexical-001', cancellation: 'queued' } },
      { id: 'late-timer', ...common, synchronousReturnMs: 0, queuedAtMs: 0, networkAtMs: 1,
        resultAtMs: budgetMs + 1, timerCallbackMs: budgetMs + 2,
        expected: { embeddingAccepted: false, fallback: 'latency-lexical-001', cancellation: 'network' } },
      { id: 'late-success', ...common, synchronousReturnMs: 0, queuedAtMs: 0, networkAtMs: 1,
        resultAtMs: budgetMs + 2, timerCallbackMs: budgetMs,
        expected: { embeddingAccepted: false, fallback: 'latency-lexical-001', cancellation: 'network' } },
      { id: 'abort-network', ...common, synchronousReturnMs: 0, queuedAtMs: 0, networkAtMs: 1,
        abortAtMs: half, resultAtMs: null, timerCallbackMs: null,
        expected: { embeddingAccepted: false, fallback: null, cancellation: 'network', callerAborted: true } },
      { id: 'abort-queued', ...common, synchronousReturnMs: 0, queuedAtMs: 0, networkAtMs: null,
        abortAtMs: half, resultAtMs: null, timerCallbackMs: null,
        expected: { embeddingAccepted: false, fallback: null, cancellation: 'queued', callerAborted: true } },
      { id: 'lexical-fallback', ...common, synchronousReturnMs: 0, queuedAtMs: null, networkAtMs: null,
        resultAtMs: 0, timerCallbackMs: null,
        expected: { embeddingAccepted: false, fallback: 'latency-lexical-001', cancellation: null } },
    ],
  };
}

export interface LatencyCardReference {
  issueId: string;
  rubricRef: string;
  subjectRef: string | null;
  /** Independently pinned historical population, including its source order. */
  keys: readonly string[];
}

export interface LatencyCardSnapshot {
  issueId: string;
  rubricRef: string;
  subjectRef: string | null;
  nKeys: number;
  complete: boolean;
  missingKeys: readonly string[];
  extraKeys: readonly string[];
  criteria: readonly { key: string; rating: string; evidence: string }[];
}

function assertCriterionKeys(keys: readonly string[]) {
  if (!keys.length || keys.some(key => !key.trim()) || new Set(keys).size !== keys.length) {
    throw new Error('LATENCY-M1 requires a nonempty unique criterion population');
  }
}

/** A recipe's hardcoded rubric keys are not the requested card's population.
 * Check this before opening a measured task; never fabricate missing criteria
 * or let a successful wrapper certify retrieval of a different rubric. */
export function latencyRecipeCriterionCompatibility(
  referenceKeys: readonly string[], recipeKeys: readonly string[],
) {
  assertCriterionKeys(referenceKeys);
  assertCriterionKeys(recipeKeys);
  const required = new Set(referenceKeys);
  const supplied = new Set(recipeKeys);
  const missing = referenceKeys.filter(key => !supplied.has(key));
  const unexpected = recipeKeys.filter(key => !required.has(key));
  return { compatible: missing.length === 0 && unexpected.length === 0, missing, unexpected };
}

/** Pin only complete evidence for the independently selected historical card.
 * This validates fixture capture, not a task attempt or baseline acceptance. */
export function pinLatencyCardFixture(reference: LatencyCardReference, snapshot: LatencyCardSnapshot) {
  assertCriterionKeys(reference.keys);
  const keys = snapshot.criteria.map(criterion => criterion.key);
  assertCriterionKeys(keys);
  if (snapshot.issueId !== reference.issueId || snapshot.rubricRef !== reference.rubricRef
    || snapshot.subjectRef !== reference.subjectRef || !snapshot.complete
    || snapshot.missingKeys.length || snapshot.extraKeys.length
    || snapshot.nKeys !== reference.keys.length
    || keys.length !== reference.keys.length || keys.some((key, i) => key !== reference.keys[i])
    || snapshot.criteria.some(criterion => !criterion.rating.trim() || !criterion.evidence.trim())) {
    throw new Error('LATENCY-M1 card fixture does not match its complete pinned population');
  }
  return { issueId: snapshot.issueId, count: keys.length, keys, sha256: latencyFixtureDigest(snapshot) };
}

export interface LatencyReferenceInterval {
  id: string;
  sourceRef: string;
  kind: 'model' | 'tool';
  startMs: number;
  endMs: number;
  /** A stage is evidence about its parent, never another elapsed-time charge. */
  parentId?: string;
}

/** Independent fixture oracle: endpoint sweep, without any timeline reader or
 * production attribution code. Inputs must carry measured interval endpoints;
 * absence of a span remains unobserved, never inferred idle/model time. */
export function latencyIntervalReference(window: { startMs: number; endMs: number },
  input: readonly LatencyReferenceInterval[]) {
  if (!Number.isSafeInteger(window.startMs) || !Number.isSafeInteger(window.endMs)
    || window.endMs <= window.startMs) throw new Error('LATENCY-M1 invalid reference window');
  const identities = new Map<string, LatencyReferenceInterval>();
  for (const row of input) {
    if (!row.id.trim() || !row.sourceRef.trim() || !['model', 'tool'].includes(row.kind)
      || !Number.isSafeInteger(row.startMs) || !Number.isSafeInteger(row.endMs)
      || row.endMs < row.startMs) throw new Error('LATENCY-M1 invalid reference interval');
    const previous = identities.get(row.id);
    if (previous && latencyFixtureDigest(previous) !== latencyFixtureDigest(row)) {
      throw new Error('LATENCY-M1 conflicting reference identity');
    }
    identities.set(row.id, row);
  }
  for (const row of identities.values()) if (row.parentId !== undefined) {
    const parent = identities.get(row.parentId);
    if (!parent || parent.parentId !== undefined || parent.id === row.id
      || row.startMs < parent.startMs || row.endMs > parent.endMs) {
      throw new Error('LATENCY-M1 missing or inconsistent interval parent');
    }
  }
  const intervals = [...identities.values()].filter(row => row.parentId === undefined)
    .map(row => ({ ...row, startMs: Math.max(window.startMs, row.startMs),
      endMs: Math.min(window.endMs, row.endMs) }))
    .filter(row => row.endMs > row.startMs).sort((a, b) => a.id.localeCompare(b.id));
  const endpoints = [...new Set([window.startMs, window.endMs,
    ...intervals.flatMap(row => [row.startMs, row.endMs])])].sort((a, b) => a - b);
  const categories = { modelOnlyMs: 0, toolOnlyMs: 0, overlapMs: 0, unobservedMs: 0 };
  for (let i = 1; i < endpoints.length; i++) {
    const start = endpoints[i - 1]!, end = endpoints[i]!;
    const active = intervals.filter(row => row.startMs <= start && row.endMs >= end);
    const model = active.some(row => row.kind === 'model');
    const tool = active.some(row => row.kind === 'tool');
    categories[model && tool ? 'overlapMs' : model ? 'modelOnlyMs'
      : tool ? 'toolOnlyMs' : 'unobservedMs'] += end - start;
  }
  const wallMs = window.endMs - window.startMs;
  const knownMs = wallMs - categories.unobservedMs;
  return { window, intervals, subdivisions: [...identities.values()]
    .filter(row => row.parentId !== undefined).sort((a, b) => a.id.localeCompare(b.id)),
  wallMs, knownMs, coveragePercent: 100 * knownMs / wallMs, ...categories };
}

/** Freeze T02's complete small sibling page and the original stored recipe.
 * A digest-only recipe is not replay-body evidence. Explicit absence is valid. */
export function pinLatencySiblingFixture(reference: {
  issueId: string; rubricRef: string; subjectRef: string;
}, snapshot: {
  issueId: string; rubricRef: string; subjectRef: string;
  rerunRecipe: Record<string, unknown> | null;
  count: number; hasMore: boolean; truncatedByLimit: boolean; nextCursor: unknown;
  siblings: readonly { issueId: string; rubricRef: string; subjectRef: string;
    createdAt: string; supersededBy: string | null; retracted: boolean }[];
}) {
  if (snapshot.issueId !== reference.issueId || snapshot.rubricRef !== reference.rubricRef
    || snapshot.subjectRef !== reference.subjectRef || snapshot.hasMore
    || snapshot.truncatedByLimit || snapshot.nextCursor !== null
    || snapshot.count !== snapshot.siblings.length || snapshot.count < 1 || snapshot.count > 20
    || new Set(snapshot.siblings.map(row => row.issueId)).size !== snapshot.count
    || !snapshot.siblings.some(row => row.issueId === reference.issueId)
    || snapshot.siblings.some(row => !row.issueId.trim() || row.rubricRef !== reference.rubricRef
      || row.subjectRef !== reference.subjectRef || !Number.isFinite(Date.parse(row.createdAt)))
    || (snapshot.rerunRecipe !== null && ('omittedChars' in snapshot.rerunRecipe
      || snapshot.rerunRecipe._partial === true || snapshot.rerunRecipe._stub === true))) {
    throw new Error('LATENCY-M1 incomplete or mismatched sibling fixture');
  }
  return { issueId: snapshot.issueId, count: snapshot.count,
    recipePresent: snapshot.rerunRecipe !== null, sha256: latencyFixtureDigest(snapshot) };
}

/** LATENCY-M1 deliberately differs from P-013's nearest-rank p50. */
export function latencyDistribution(values: readonly number[]) {
  if (!values.length || values.some(x => !Number.isFinite(x) || x < 0)) {
    throw new Error('LATENCY-M1 requires nonempty finite nonnegative samples');
  }
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return {
    count: sorted.length,
    median: sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2,
    p95: sorted[Math.ceil(0.95 * sorted.length) - 1]!,
  };
}

export interface LatencyAttempt extends LatencyAttemptKey {
  status: 'passed' | 'failed' | 'aborted' | 'unknown';
  /** Monotonic task-entry to terminal business outcome, including waits. */
  actualElapsedMs: number | null;
  /** Actual gateway attempt identities; repeated wrapper/poll copies share an id.
   * A provider retry has its OWN attempt id and therefore remains in the count. */
  gatewayAttemptIds: readonly string[] | null;
  /** Hash of the identical fixture/reference/schema/client/model/effort contract.
   * Arm-specific source/build/runtime hashes are kept in each provenance receipt. */
  pairFingerprint: string;
  provenanceRef: string;
  oracle: { passed: boolean; evidenceRef: string; referenceSha256: string } | null;
}

const digestPattern = /^[a-f0-9]{64}$/;
function validAttempt(r: LatencyAttempt): boolean {
  return digestPattern.test(r.pairFingerprint) && r.provenanceRef.trim().length > 0
    && r.actualElapsedMs !== null && Number.isFinite(r.actualElapsedMs) && r.actualElapsedMs >= 0
    && r.gatewayAttemptIds !== null && r.gatewayAttemptIds.every(id => id.trim().length > 0)
    && r.oracle !== null && r.oracle.evidenceRef.trim().length > 0
    && digestPattern.test(r.oracle.referenceSha256);
}

type LatencyPhaseEvent = { atMs: number; evidenceRef: string } & (
  | { kind: 'baseline-ready'; producerId: string; contractSha256: string;
      sourceSha256: string; calibrationSha256: string; environmentSha256: string }
  | { kind: 'attempt'; startedAtMs: number; attempt: LatencyAttempt }
  | { kind: 'baseline-accepted'; reviewerId: string; baselineSha256: string }
  | { kind: 'product-edit' }
  | { kind: 'candidate-ready'; contractSha256: string; sourceSha256: string;
      calibrationSha256: string; baselineEnvironmentSha256: string; environmentSha256: string;
      comparability: 'comparable' | 'unknown'; comparabilityEvidenceRef: string }
);

/** Validate an ordered prefix of immutable receipts BEFORE opening the next
 * phase. Resolve receipt authors/bytes through the existing results rails first;
 * this pure validator does not authenticate a caller-supplied review identity.
 * All event times must come from the same pinned clock. */
export function assertLatencyPhaseOrder(events: readonly LatencyPhaseEvent[]) {
  const schedule = latencyAttemptSchedule();
  const baseline: LatencyPhaseEvent[] = [];
  let ready: Extract<LatencyPhaseEvent, { kind: 'baseline-ready' }> | undefined;
  let accepted = false;
  let edited = false;
  let candidateReady = false;
  let attempts = 0;
  let previousAt = -Infinity;
  let comparable = false;
  for (const event of events) {
    if (!Number.isSafeInteger(event.atMs) || event.atMs < 0 || event.atMs < previousAt
      || !event.evidenceRef.trim()) throw new Error('LATENCY-M1 invalid chronological receipt');
    const priorAt = previousAt;
    previousAt = event.atMs;
    switch (event.kind) {
      case 'baseline-ready':
        if (ready || attempts || !event.producerId.trim()
          || ![event.contractSha256, event.sourceSha256, event.calibrationSha256, event.environmentSha256]
            .every(hash => digestPattern.test(hash))) throw new Error('LATENCY-M1 invalid baseline preflight');
        ready = event;
        baseline.push(event);
        break;
      case 'attempt': {
        const key = schedule[attempts];
        if (!ready || !key || latencyAttemptId(event.attempt) !== latencyAttemptId(key)
          || !validAttempt(event.attempt) || event.attempt.status === 'unknown'
          || !Number.isSafeInteger(event.startedAtMs) || event.startedAtMs < priorAt
          || event.startedAtMs > event.atMs
          || event.atMs - event.startedAtMs !== event.attempt.actualElapsedMs
          || (event.attempt.arm === 'baseline' ? accepted || edited : !candidateReady)) {
          throw new Error('LATENCY-M1 attempt violates frozen population or phase order');
        }
        attempts++;
        if (event.attempt.arm === 'baseline') baseline.push(event);
        break;
      }
      case 'baseline-accepted':
        if (!ready || accepted || edited || attempts !== 60 || !event.reviewerId.trim()
          || event.reviewerId === ready.producerId
          || event.baselineSha256 !== latencyFixtureDigest(baseline)) {
          throw new Error('LATENCY-M1 requires independent acceptance of the complete immutable baseline');
        }
        accepted = true;
        break;
      case 'product-edit':
        if (!accepted || candidateReady) throw new Error('LATENCY-M1 edit before baseline acceptance or after candidate pin');
        edited = true;
        break;
      case 'candidate-ready':
        if (!ready || !accepted || !edited || candidateReady || attempts !== 60
          || event.contractSha256 !== ready.contractSha256
          || event.calibrationSha256 !== ready.calibrationSha256
          || event.baselineEnvironmentSha256 !== ready.environmentSha256
          || !digestPattern.test(event.sourceSha256) || !digestPattern.test(event.environmentSha256)
          || !event.comparabilityEvidenceRef.trim()
          || !['comparable', 'unknown'].includes(event.comparability)) {
          throw new Error('LATENCY-M1 candidate provenance or unchanged calibration is missing');
        }
        candidateReady = true;
        comparable = event.comparability === 'comparable';
        break;
      default:
        throw new Error('LATENCY-M1 unknown phase receipt');
    }
  }
  return { attempts, baselineAccepted: accepted, candidateReady,
    complete: attempts === schedule.length, comparable };
}

/** Arithmetic calibration alone cannot certify a measured experiment. */
export function assessLatencyExperiment(events: readonly LatencyPhaseEvent[]) {
  const phase = assertLatencyPhaseOrder(events);
  const cohort = assessLatencyCohort(events.flatMap(event => event.kind === 'attempt' ? [event.attempt] : []));
  return { ...cohort, phase, verdict: !phase.complete || !phase.comparable ? 'unknown' as const : cohort.verdict };
}

/** This is an exact frozen-output oracle for deterministic fixture outputs.
 * Authorization and semantic references are supplied by the maintained fixture,
 * not inferred from a returned status or from the candidate implementation. */
export function frozenOutputOracle(reference: unknown, observed: unknown, authorized: boolean): boolean {
  if (!authorized) return false;
  try { return canonicalJson(reference) === canonicalJson(observed); }
  catch { return false; }
}

export function calibrateLatencyOracle(check: (input: unknown, authorized: boolean) => boolean, controls: {
  positive: unknown;
  incorrect: unknown;
  incomplete: unknown;
}) {
  const results = {
    positive: check(controls.positive, true),
    incorrect: check(controls.incorrect, true),
    incomplete: check(controls.incomplete, true),
    unauthorized: check(controls.positive, false),
  };
  if (!results.positive || results.incorrect || results.incomplete || results.unauthorized) {
    throw new Error(`LATENCY-M1 oracle calibration failed: ${JSON.stringify(results)}`);
  }
  return results;
}

/** Never drop a failed, aborted or unknown attempt from a performance cohort. */
export function assessLatencyCohort(attempts: readonly LatencyAttempt[]) {
  const expected = latencyAttemptSchedule();
  const expectedIds = new Set(expected.map(latencyAttemptId));
  const byId = new Map<string, LatencyAttempt>();
  for (const attempt of attempts) {
    const id = latencyAttemptId(attempt);
    if (!expectedIds.has(id)) throw new Error(`Unexpected LATENCY-M1 attempt: ${id}`);
    if (byId.has(id)) throw new Error(`Duplicate LATENCY-M1 attempt: ${id}`);
    byId.set(id, attempt);
  }
  const missing = [...expectedIds].filter(id => !byId.has(id));
  const unknown = attempts.filter(a => a.status === 'unknown' || !validAttempt(a)).map(latencyAttemptId);
  const failed = attempts.filter(a => a.status === 'failed' || a.status === 'aborted'
    || (a.oracle !== null && !a.oracle.passed)).map(latencyAttemptId);
  const incomparable: string[] = [];
  for (const key of expected.filter(a => a.arm === 'baseline')) {
    const baseline = byId.get(latencyAttemptId(key));
    const candidate = byId.get(latencyAttemptId({ ...key, arm: 'candidate' }));
    if (baseline && candidate && (baseline.pairFingerprint !== candidate.pairFingerprint
      || (baseline.oracle !== null && candidate.oracle !== null
        && baseline.oracle.referenceSha256 !== candidate.oracle.referenceSha256))) {
      incomparable.push(latencyAttemptId(key));
    }
  }
  const samples = attempts.map(a => ({
    id: latencyAttemptId(a),
    actualElapsedMs: a.actualElapsedMs,
    scoredElapsedMs: a.status === 'failed' || a.status === 'aborted' ? LATENCY_M1_DEADLINE_MS
      : a.status === 'unknown' ? null : a.actualElapsedMs,
    requests: a.gatewayAttemptIds === null ? null : new Set(a.gatewayAttemptIds).size,
  }));
  const incomplete = missing.length > 0 || unknown.length > 0;
  const comparable = !incomplete && !incomparable.length;
  const strata = (['cold', 'warm', 'pooled'] as const).map(stratum => {
    const arm = (name: LatencyArm) => {
      const selected = attempts.filter(a => a.arm === name && (stratum === 'pooled' || a.stratum === stratum));
      if (!selected.length || selected.some(a => !validAttempt(a) || a.status === 'unknown')) return null;
      return {
        elapsed: latencyDistribution(selected.map(a => a.status === 'failed' || a.status === 'aborted'
          ? LATENCY_M1_DEADLINE_MS : a.actualElapsedMs!)),
        requests: latencyDistribution(selected.map(a => new Set(a.gatewayAttemptIds!).size)),
      };
    };
    const baseline = arm('baseline');
    const candidate = arm('candidate');
    // Zero baseline has no defined multiplicative speedup. Keep UNKNOWN; never
    // turn 0/0 into a passing ratio or use infinity as a measured result.
    const ratios = comparable && baseline && candidate && baseline.requests.median > 0
      && baseline.elapsed.median > 0 && baseline.elapsed.p95 > 0 ? {
        requests: candidate.requests.median / baseline.requests.median,
        elapsed: candidate.elapsed.median / baseline.elapsed.median,
        p95: candidate.elapsed.p95 / baseline.elapsed.p95,
      } : null;
    return { stratum, baseline, candidate, ratios, passed: ratios !== null
      && ratios.requests <= 0.75 && ratios.elapsed <= 0.80 && ratios.p95 <= 1.10 };
  });
  return {
    expectedAttempts: expected.length,
    recordedAttempts: attempts.length,
    missing, unknown, failed, incomparable, samples, strata,
    verdict: failed.length || incomparable.length ? 'fail' as const
      : incomplete || strata.some(s => s.ratios === null) ? 'unknown' as const
        : strata.every(s => s.passed) ? 'pass' as const : 'fail' as const,
  };
}
