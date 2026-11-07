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
