/**
 * Durable logical qualification transaction.
 *
 * One record lives beside the green-checkpoint routine's existing gate_health /
 * repair_queue metadata. It is a coordination root, not a second scheduler or
 * lock: the existing routine claimant and physical run lock remain the safety
 * authorities. This record makes the logical attempt, retry policy, current
 * physical runner, blockers, and evidence machine-readable across processes.
 */
import { execFileSync } from 'node:child_process';
import { getOrgPg } from '@papercusp/db-org';
import type { GateVerdictTarget } from './gate-verdict-target';
import { boundedOrgTxn } from '../pg-bounded-txn';
import {
  frozenRepairHeadAwaitsVerification,
  parseFrozenCandidateRepairQueue,
  type FrozenCandidateRepairQueue,
} from './frozen-candidate-repair-queue';
import {
  parseCheckpointEligibilitySnapshot,
  type CheckpointEligibilitySnapshot,
} from './checkpoint-eligibility-snapshot';

export const CHECKPOINT_QUALIFICATION_METADATA_KEY = 'qualificationTransaction';
export const CHECKPOINT_QUALIFICATION_SCHEMA_VERSION = 1 as const;
/** Transported into a detached checkpoint so its verdict settles the exact logical attempt. */
export const CHECKPOINT_QUALIFICATION_ATTEMPT_ENV = 'PAPERCUSP_CHECKPOINT_QUALIFICATION_ATTEMPT_ID';

/**
 * What a caller has PROVED about a runner's process. 'unknown' is not a soft 'dead': every
 * reclaim path below treats it exactly as the pre-liveness code did, so a probe that breaks
 * degrades to the old lease-only behaviour instead of handing one candidate to two runners.
 */
export type RunnerLiveness = 'live' | 'dead' | 'unknown';
export type RunnerLivenessProber = (runner: QualificationPhysicalRunner) => RunnerLiveness;

/**
 * How long an attempt with NO physical runner may sit untouched before it is treated as abandoned.
 *
 * Deliberately derived, not tuned: a runner cannot outlive the detached suite's own systemd
 * ceiling (`CHECKPOINT_MAX_RUNTIME_SEC`, 3h — duplicated here rather than imported to keep this
 * coordination record free of a dependency on the launcher). So a record untouched for longer than
 * that ceiling cannot still have a living owner, whatever it claims.
 */
export const QUALIFICATION_OWNER_ABANDONED_MS = 3 * 60 * 60 * 1_000;

const systemdRunnerLiveness: RunnerLivenessProber = (runner) => {
  const unit = runner.unit?.trim();
  // Rows written before `unit` existed cannot be falsified — say so rather than guessing.
  if (!unit) return 'unknown';
  const read = (value: unknown): RunnerLiveness | null => {
    const state = String(value ?? '').trim();
    if (state === 'active' || state === 'activating') return 'live';
    // `is-active` prints `inactive` for a unit systemd has never heard of, which is precisely the
    // case we care about: a transient unit that has already been collected.
    if (state === 'inactive' || state === 'failed' || state === 'deactivating') return 'dead';
    return null;
  };
  try {
    return read(execFileSync('systemctl', ['--user', 'is-active', unit], {
      encoding: 'utf8',
      timeout: 5_000,
    })) ?? 'unknown';
  } catch (error) {
    // A non-active unit makes `is-active` exit non-zero WITH the state on stdout, so the throw is
    // the normal path for a dead unit, not an error.
    return read((error as { stdout?: unknown } | null)?.stdout) ?? 'unknown';
  }
};

let runnerLivenessProber: RunnerLivenessProber = systemdRunnerLiveness;

/** Host seam — tests install a deterministic prober instead of shelling out to systemd. */
export function configureRunnerLivenessProber(prober: RunnerLivenessProber | null): void {
  runnerLivenessProber = prober ?? systemdRunnerLiveness;
}

export function probeRunnerLiveness(runner: QualificationPhysicalRunner | null | undefined): RunnerLiveness {
  return runner ? runnerLivenessProber(runner) : 'unknown';
}

export const PRE_SUITE_NO_VERDICT_REASONS = [
  'authority-unreadable',
  'authority-held',
  'migrations-pending',
  'source-mutated',
  'eligibility-wait',
  'would-exclude-declared-paths',
  'wait-for-eligibility-unavailable',
  'repair-in-progress',
  'repair-queue-unreadable',
  'required-ancestor-missing',
  'required-ancestor-unverifiable',
  'probe-failed',
  'already-running',
  'skipped-locked',
  'cancelled',
  'deadline-exceeded',
  // The reserving process PROVED the incumbent runner's unit was gone and took the lease from it.
  // Distinct from 'deadline-exceeded' (a runner that overran) and from 'cancelled' (a deliberate
  // stop): this one means nobody was ever going to advance that attempt.
  'runner-vanished',
  'disk-headroom',
  'infra-inconclusive',
  'target-readers',
  'dependency-generation',
  'backup-admission',
  'launch-refused',
] as const;

export type PreSuiteNoVerdictReason = (typeof PRE_SUITE_NO_VERDICT_REASONS)[number];
export type QualificationPhase = 'waiting' | 'ready' | 'running' | 'terminal';
export type QualificationOutcome =
  | { kind: 'pending' }
  | { kind: 'pre-suite-no-verdict'; reason: PreSuiteNoVerdictReason }
  | { kind: 'green'; reason: string }
  | { kind: 'red'; reason: string }
  | { kind: 'code-inconclusive'; reason: string };

export interface QualificationBlocker {
  code: string;
  detail?: string;
  clearEvents: string[];
  observedAtMs: number;
}

export interface QualificationPhysicalRunner {
  id: string;
  candidate: string | null;
  reservedAtMs: number;
  leaseExpiresAtMs?: number;
  evidenceRefs: string[];
  /**
   * The systemd unit that IS this runner, when the reserver knows it — the only field here that
   * can FALSIFY the lease. Everything else is a timestamp, and a timestamp cannot tell a working
   * runner from a dead one; see `reserveQualificationRunner`. Optional because rows written before
   * this field existed have none, and those must keep their pre-existing (lease-only) behaviour.
   */
  unit?: string | null;
}

export interface QualificationPhysicalRun extends QualificationPhysicalRunner {
  endedAtMs: number;
  outcome: QualificationOutcome;
}

export type QualificationSafeNextAction =
  | { code: 'launch-physical-run'; reason: string; waitEvents: string[] }
  | { code: 'launch-preflight-runner'; reason: string; waitEvents: string[] }
  | { code: 'await-blocker-events'; reason: string; waitEvents: string[] }
  | { code: 'await-current-run'; reason: string; waitEvents: string[] }
  | { code: 'recover-expired-runner'; reason: string; waitEvents: string[] }
  | { code: 'repair-code'; reason: string; waitEvents: string[] }
  | { code: 'inspect-terminal-evidence'; reason: string; waitEvents: string[] }
  | { code: 'read-release-control'; reason: string; waitEvents: string[] };

export interface CheckpointQualificationState {
  status: 'none' | 'unreadable' | 'present';
  attemptId: string | null;
  candidate: string | null;
  phase: QualificationPhase | null;
  outcome: QualificationOutcome | null;
  owner: { kind: 'routine'; id: 'system:green-checkpoint' };
  lease: {
    holder: string;
    acquiredAtMs: number;
    expiresAtMs: number;
    expired: boolean;
  } | null;
  blockers: QualificationBlocker[];
  phaseDurationsMs: Partial<Record<QualificationPhase, number>>;
  consumedPhysicalRuns: QualificationPhysicalRun[];
  eligibilitySnapshot: CheckpointEligibilitySnapshot | null;
  safeNextAction: QualificationSafeNextAction;
  unknown: { code: 'resolver-failed'; detail: string } | null;
}

export interface CheckpointQualificationTransaction {
  schemaVersion: typeof CHECKPOINT_QUALIFICATION_SCHEMA_VERSION;
  attemptId: string;
  createdAtMs: number;
  updatedAtMs: number;
  requiredAncestorSha: string | null;
  candidatePolicy: {
    kind: 'quiet-cut';
    declaredPaths: string[];
  };
  candidate: string | null;
  phase: QualificationPhase;
  phaseEnteredAtMs?: number;
  phaseDurationsMs?: Partial<Record<QualificationPhase, number>>;
  outcome: QualificationOutcome;
  blockers: QualificationBlocker[];
  waitGeneration: number;
  currentPhysicalRunner: QualificationPhysicalRunner | null;
  consumedPhysicalRuns?: QualificationPhysicalRun[];
  evidenceRefs: string[];
  previousAttemptId: string | null;
  eligibilitySnapshot?: CheckpointEligibilitySnapshot | null;
}

export interface BeginQualificationInput {
  attemptId: string;
  requiredAncestorSha?: string | null;
  declaredPaths?: readonly string[];
  candidate?: string | null;
  evidenceRefs?: readonly string[];
  /** What the caller proved about the INCUMBENT attempt's runner. Default 'unknown' = old behaviour. */
  incumbentLiveness?: RunnerLiveness;
  nowMs?: number;
}

export interface CancelQualificationInput {
  /** The exact logical attempt the caller intends to stop. */
  attemptId: string;
  /** The exact systemd unit recorded on that attempt's physical runner. */
  unit: string;
  /** A durable, human-readable reason for the inconclusive terminal outcome. */
  reason?: string;
  evidenceRefs?: readonly string[];
  nowMs?: number;
}

export type QualificationTransition =
  | { status: 'updated' | 'idempotent'; transaction: CheckpointQualificationTransaction }
  | { status: 'conflict' | 'terminal'; transaction: CheckpointQualificationTransaction };

/**
 * EI-21643577467008123 — this waiting reason is emitted only after the durable
 * waiter failed to start. It therefore has no owner that can ever advance it and
 * must not retain the singleton transaction against a later retry/successor.
 * Every other pre-suite wait remains exclusive until its real owner advances it.
 */
function isRetryableUnownedWait(
  current: CheckpointQualificationTransaction | null,
): boolean {
  return Boolean(
    current &&
      current.phase === 'waiting' &&
      current.outcome.kind === 'pre-suite-no-verdict' &&
      current.outcome.reason === 'wait-for-eligibility-unavailable' &&
      current.currentPhysicalRunner === null,
  );
}

/**
 * Has the attempt's owner GONE, leaving the singleton held by nobody?
 *
 * The exclusivity above is correct only while "its real owner advances it" holds. Nothing enforced
 * that: an owner that died mid-attempt kept the transaction non-terminal AND non-retryable
 * forever, so `beginQualificationTransaction` returned `conflict` to every later attempt — the
 * scheduled routine included. The gate then renders no verdict at all while looking merely red,
 * and no amount of fixing tests moves it. Two provable ways an owner is gone:
 *
 *  - a physical runner whose unit the caller probed and found absent; or
 *  - no runner at all, and no write for longer than a runner could legally live.
 *
 * Both require evidence. An owner we cannot prove dead keeps its claim.
 */
function isAbandonedQualification(
  current: CheckpointQualificationTransaction | null,
  incumbentLiveness: RunnerLiveness | undefined,
  nowMs: number,
): boolean {
  if (!current || isTerminalQualificationOutcome(current.outcome)) return false;
  if (current.currentPhysicalRunner) return incumbentLiveness === 'dead';
  return nowMs - current.updatedAtMs > QUALIFICATION_OWNER_ABANDONED_MS;
}

const uniqueStrings = (values: readonly string[], cap = 64): string[] =>
  [...new Set(values.map((value) => value.trim()).filter(Boolean))].slice(0, cap);

export const isTerminalQualificationOutcome = (outcome: QualificationOutcome): boolean =>
  outcome.kind === 'green' || outcome.kind === 'red' || outcome.kind === 'code-inconclusive';

function isQualificationOutcome(value: unknown): value is QualificationOutcome {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const outcome = value as { kind?: unknown; reason?: unknown };
  if (outcome.kind === 'pending') return true;
  if (outcome.kind === 'pre-suite-no-verdict') {
    return (PRE_SUITE_NO_VERDICT_REASONS as readonly unknown[]).includes(outcome.reason);
  }
  return (
    ['green', 'red', 'code-inconclusive'].includes(String(outcome.kind)) &&
    typeof outcome.reason === 'string'
  );
}

function isPhysicalRun(value: unknown): value is QualificationPhysicalRun {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const run = value as Partial<QualificationPhysicalRun>;
  return (
    typeof run.id === 'string' && !!run.id &&
    (run.candidate === null || typeof run.candidate === 'string') &&
    Number.isFinite(run.reservedAtMs) &&
    Number.isFinite(run.leaseExpiresAtMs) &&
    Number.isFinite(run.endedAtMs) &&
    Array.isArray(run.evidenceRefs) && run.evidenceRefs.every((ref) => typeof ref === 'string') &&
    isQualificationOutcome(run.outcome)
  );
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  const a = uniqueStrings(left).sort();
  const b = uniqueStrings(right).sort();
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function completedPhaseDurations(
  current: CheckpointQualificationTransaction,
  nextPhase: QualificationPhase,
  nowMs: number,
): Partial<Record<QualificationPhase, number>> {
  if (current.phase === nextPhase) return current.phaseDurationsMs ?? {};
  const phaseDurations = current.phaseDurationsMs ?? {};
  const phaseEnteredAtMs = current.phaseEnteredAtMs ?? current.updatedAtMs;
  return {
    ...phaseDurations,
    [current.phase]:
      (phaseDurations[current.phase] ?? 0) + Math.max(0, nowMs - phaseEnteredAtMs),
  };
}

function consumedRunner(
  current: CheckpointQualificationTransaction,
  outcome: QualificationOutcome,
  nowMs: number,
): QualificationPhysicalRun[] {
  if (!current.currentPhysicalRunner) return current.consumedPhysicalRuns ?? [];
  return [
    ...(current.consumedPhysicalRuns ?? []),
    { ...current.currentPhysicalRunner, endedAtMs: nowMs, outcome },
  ].slice(-32);
}

export function qualificationPhaseDurations(
  current: CheckpointQualificationTransaction,
  nowMs = Date.now(),
): Partial<Record<QualificationPhase, number>> {
  return {
    ...(current.phaseDurationsMs ?? {}),
    [current.phase]:
      ((current.phaseDurationsMs ?? {})[current.phase] ?? 0) +
      Math.max(0, nowMs - (current.phaseEnteredAtMs ?? current.updatedAtMs)),
  };
}

export function projectCheckpointQualificationState(
  raw: unknown,
  nowMs = Date.now(),
): CheckpointQualificationState {
  const owner = { kind: 'routine' as const, id: 'system:green-checkpoint' as const };
  if (raw == null) {
    return {
      status: 'none', attemptId: null, candidate: null, phase: null, outcome: null, owner,
      lease: null, blockers: [], phaseDurationsMs: {}, consumedPhysicalRuns: [], unknown: null,
      eligibilitySnapshot: null,
      safeNextAction: {
        code: 'read-release-control',
        reason: 'no logical qualification attempt exists; read current serializer/manual-run authority before starting one',
        waitEvents: [],
      },
    };
  }
  const transaction = parseCheckpointQualificationTransaction(raw);
  if (!transaction) {
    return {
      status: 'unreadable', attemptId: null, candidate: null, phase: null, outcome: null, owner,
      lease: null, blockers: [], phaseDurationsMs: {}, consumedPhysicalRuns: [],
      eligibilitySnapshot: null,
      safeNextAction: {
        code: 'read-release-control',
        reason: 'qualification metadata is malformed; repair the durable record before launching',
        waitEvents: [],
      },
      unknown: { code: 'resolver-failed', detail: 'qualification transaction metadata is malformed' },
    };
  }
  const runner = transaction.currentPhysicalRunner;
  const lease = runner
    ? {
        holder: runner.id,
        acquiredAtMs: runner.reservedAtMs,
        expiresAtMs: runner.leaseExpiresAtMs ?? runner.reservedAtMs,
        expired: nowMs >= (runner.leaseExpiresAtMs ?? runner.reservedAtMs),
      }
    : null;
  const waitEvents = uniqueStrings(transaction.blockers.flatMap((blocker) => blocker.clearEvents));
  let safeNextAction: QualificationSafeNextAction;
  if (transaction.eligibilitySnapshot && !isTerminalQualificationOutcome(transaction.outcome)) {
    safeNextAction = transaction.eligibilitySnapshot.safeNextAction;
  } else if (transaction.outcome.kind === 'green') {
    safeNextAction = { code: 'read-release-control', reason: 'qualification is green; read promotion/deploy authority before acting', waitEvents: [] };
  } else if (transaction.outcome.kind === 'red') {
    safeNextAction = { code: 'repair-code', reason: 'a real red is terminal for this logical attempt; repair code before starting a successor', waitEvents: [] };
  } else if (transaction.outcome.kind === 'code-inconclusive') {
    safeNextAction = { code: 'inspect-terminal-evidence', reason: 'the terminal code outcome is inconclusive; inspect evidence before a successor', waitEvents: [] };
  } else if (runner && lease?.expired) {
    safeNextAction = { code: 'recover-expired-runner', reason: 'the physical-run lease expired without a terminal result', waitEvents: [] };
  } else if (runner) {
    safeNextAction = { code: 'await-current-run', reason: 'one physical runner owns the live lease', waitEvents: [] };
  } else if (transaction.phase === 'waiting') {
    safeNextAction = { code: 'await-blocker-events', reason: 'pre-suite infrastructure blocked this attempt; resume it after the named events clear', waitEvents };
  } else {
    safeNextAction = { code: 'launch-physical-run', reason: 'the logical attempt is ready and has no live physical runner', waitEvents: [] };
  }
  return {
    status: 'present',
    attemptId: transaction.attemptId,
    candidate: transaction.candidate,
    phase: transaction.phase,
    outcome: transaction.outcome,
    owner,
    lease,
    blockers: transaction.blockers,
    phaseDurationsMs: qualificationPhaseDurations(transaction, nowMs),
    consumedPhysicalRuns: transaction.consumedPhysicalRuns ?? [],
    eligibilitySnapshot: transaction.eligibilitySnapshot ?? null,
    safeNextAction,
    unknown: null,
  };
}

/**
 * A waiting/running logical attempt survives candidate movement. The caller intent is the
 * required ancestor plus the declared-path policy; the candidate is a physical-run snapshot.
 */
export function qualificationIntentMatches(
  current: CheckpointQualificationTransaction,
  input: Pick<BeginQualificationInput, 'requiredAncestorSha' | 'declaredPaths'>,
): boolean {
  if (isTerminalQualificationOutcome(current.outcome)) return false;
  return (
    current.requiredAncestorSha === (input.requiredAncestorSha?.trim() || null) &&
    sameStrings(current.candidatePolicy.declaredPaths, input.declaredPaths ?? [])
  );
}

export function parseCheckpointQualificationTransaction(
  value: unknown,
): CheckpointQualificationTransaction | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Partial<CheckpointQualificationTransaction>;
  if (
    row.schemaVersion !== CHECKPOINT_QUALIFICATION_SCHEMA_VERSION ||
    typeof row.attemptId !== 'string' ||
    !row.attemptId ||
    !Number.isFinite(row.createdAtMs) ||
    !Number.isFinite(row.updatedAtMs) ||
    !Number.isInteger(row.waitGeneration) ||
    (row.waitGeneration ?? -1) < 0 ||
    !row.outcome ||
    typeof row.outcome !== 'object' ||
    !['waiting', 'ready', 'running', 'terminal'].includes(String(row.phase)) ||
    !row.candidatePolicy ||
    row.candidatePolicy.kind !== 'quiet-cut' ||
    !Array.isArray(row.candidatePolicy.declaredPaths) ||
    !Array.isArray(row.blockers) ||
    !Array.isArray(row.evidenceRefs) ||
    (row.phaseEnteredAtMs != null && !Number.isFinite(row.phaseEnteredAtMs)) ||
    (row.phaseDurationsMs != null &&
      (typeof row.phaseDurationsMs !== 'object' || Array.isArray(row.phaseDurationsMs) ||
        Object.entries(row.phaseDurationsMs).some(
          ([phase, duration]) =>
            !['waiting', 'ready', 'running', 'terminal'].includes(phase) ||
            typeof duration !== 'number' || !Number.isFinite(duration) || duration < 0,
        ))) ||
    (row.consumedPhysicalRuns != null &&
      (!Array.isArray(row.consumedPhysicalRuns) || row.consumedPhysicalRuns.some((run) => !isPhysicalRun(run)))) ||
    (row.eligibilitySnapshot != null && !parseCheckpointEligibilitySnapshot(row.eligibilitySnapshot))
  ) return null;
  if (!isQualificationOutcome(row.outcome)) return null;
  if (
    row.blockers.some((blocker) =>
      !blocker ||
      typeof blocker !== 'object' ||
      typeof blocker.code !== 'string' ||
      !Array.isArray(blocker.clearEvents) ||
      blocker.clearEvents.some((event) => typeof event !== 'string') ||
      !Number.isFinite(blocker.observedAtMs),
    ) ||
    row.evidenceRefs.some((ref) => typeof ref !== 'string') ||
    row.candidatePolicy.declaredPaths.some((declaredPath) => typeof declaredPath !== 'string')
  ) return null;
  if (
    row.currentPhysicalRunner != null &&
    (
      typeof row.currentPhysicalRunner !== 'object' ||
      typeof row.currentPhysicalRunner.id !== 'string' ||
      !row.currentPhysicalRunner.id ||
      !Number.isFinite(row.currentPhysicalRunner.reservedAtMs) ||
      (row.currentPhysicalRunner.leaseExpiresAtMs != null && !Number.isFinite(row.currentPhysicalRunner.leaseExpiresAtMs)) ||
      !Array.isArray(row.currentPhysicalRunner.evidenceRefs) ||
      row.currentPhysicalRunner.evidenceRefs.some((ref) => typeof ref !== 'string')
    )
  ) return null;
  const phaseEnteredAtMs = Number.isFinite(row.phaseEnteredAtMs) ? row.phaseEnteredAtMs! : row.updatedAtMs!;
  const phaseDurationsMs =
    row.phaseDurationsMs && typeof row.phaseDurationsMs === 'object' && !Array.isArray(row.phaseDurationsMs)
      ? Object.fromEntries(
          Object.entries(row.phaseDurationsMs).filter(
            ([phase, duration]) =>
              ['waiting', 'ready', 'running', 'terminal'].includes(phase) &&
              typeof duration === 'number' && Number.isFinite(duration) && duration >= 0,
          ),
        )
      : {};
  const consumedPhysicalRuns = Array.isArray(row.consumedPhysicalRuns)
    ? row.consumedPhysicalRuns.slice(-32)
    : [];
  const currentPhysicalRunner = row.currentPhysicalRunner
    ? {
        ...row.currentPhysicalRunner,
        leaseExpiresAtMs:
          typeof row.currentPhysicalRunner.leaseExpiresAtMs === 'number'
            ? row.currentPhysicalRunner.leaseExpiresAtMs
            : row.currentPhysicalRunner.reservedAtMs,
      }
    : null;
  const eligibilitySnapshot = row.eligibilitySnapshot == null
    ? null
    : parseCheckpointEligibilitySnapshot(row.eligibilitySnapshot);
  return {
    ...(row as CheckpointQualificationTransaction),
    phaseEnteredAtMs,
    phaseDurationsMs,
    currentPhysicalRunner,
    consumedPhysicalRuns,
    eligibilitySnapshot,
  };
}

export function beginQualificationTransaction(
  current: CheckpointQualificationTransaction | null,
  input: BeginQualificationInput,
): QualificationTransition {
  const nowMs = input.nowMs ?? Date.now();
  const retryableUnownedWait = isRetryableUnownedWait(current);
  const abandoned = isAbandonedQualification(current, input.incumbentLiveness, nowMs);
  if (current?.attemptId === input.attemptId) {
    if (retryableUnownedWait) {
      return {
        status: 'updated',
        transaction: {
          ...current,
          updatedAtMs: nowMs,
          requiredAncestorSha: input.requiredAncestorSha?.trim() || current.requiredAncestorSha,
          candidate: input.candidate?.trim() || current.candidate,
          phase: 'ready',
          phaseEnteredAtMs: nowMs,
          phaseDurationsMs: completedPhaseDurations(current, 'ready', nowMs),
          outcome: { kind: 'pending' },
          blockers: [],
          evidenceRefs: uniqueStrings([...current.evidenceRefs, ...(input.evidenceRefs ?? [])]),
        },
      };
    }
    return {
      status: isTerminalQualificationOutcome(current.outcome) ? 'terminal' : 'idempotent',
      transaction: current,
    };
  }
  if (current && !isTerminalQualificationOutcome(current.outcome) && !retryableUnownedWait && !abandoned) {
    return { status: 'conflict', transaction: current };
  }
  const transaction: CheckpointQualificationTransaction = {
    schemaVersion: CHECKPOINT_QUALIFICATION_SCHEMA_VERSION,
    attemptId: input.attemptId,
    createdAtMs: nowMs,
    updatedAtMs: nowMs,
    requiredAncestorSha: input.requiredAncestorSha?.trim() || null,
    candidatePolicy: {
      kind: 'quiet-cut',
      declaredPaths: uniqueStrings(input.declaredPaths ?? []),
    },
    candidate: input.candidate?.trim() || null,
    phase: 'ready',
    phaseEnteredAtMs: nowMs,
    phaseDurationsMs: {},
    outcome: { kind: 'pending' },
    blockers: [],
    waitGeneration: 0,
    currentPhysicalRunner: null,
    consumedPhysicalRuns: [],
    evidenceRefs: uniqueStrings(input.evidenceRefs ?? []),
    previousAttemptId: current?.attemptId ?? null,
    eligibilitySnapshot: null,
  };
  return { status: 'updated', transaction };
}

export function recordQualificationEligibilitySnapshot(
  current: CheckpointQualificationTransaction,
  input: {
    attemptId: string;
    snapshot: CheckpointEligibilitySnapshot;
    nowMs?: number;
  },
): QualificationTransition {
  if (
    current.attemptId !== input.attemptId ||
    input.snapshot.attemptId !== input.attemptId
  ) return { status: 'conflict', transaction: current };
  if (isTerminalQualificationOutcome(current.outcome)) {
    return { status: 'terminal', transaction: current };
  }
  const parsed = parseCheckpointEligibilitySnapshot(input.snapshot);
  if (!parsed) return { status: 'conflict', transaction: current };
  if (JSON.stringify(current.eligibilitySnapshot ?? null) === JSON.stringify(parsed)) {
    return { status: 'idempotent', transaction: current };
  }
  const evidenceRefs = uniqueStrings([
    ...current.evidenceRefs,
    ...parsed.predicates.flatMap((predicate) => predicate.evidenceRefs),
  ]);
  return {
    status: 'updated',
    transaction: {
      ...current,
      updatedAtMs: input.nowMs ?? Date.now(),
      eligibilitySnapshot: parsed,
      evidenceRefs,
    },
  };
}

export function waitQualificationTransaction(
  current: CheckpointQualificationTransaction,
  input: {
    attemptId: string;
    reason: PreSuiteNoVerdictReason;
    blockers?: readonly Omit<QualificationBlocker, 'observedAtMs'>[];
    evidenceRefs?: readonly string[];
    nowMs?: number;
  },
): QualificationTransition {
  if (current.attemptId !== input.attemptId) return { status: 'conflict', transaction: current };
  if (isTerminalQualificationOutcome(current.outcome)) return { status: 'terminal', transaction: current };
  if (
    current.phase === 'waiting' &&
    current.outcome.kind === 'pre-suite-no-verdict' &&
    current.outcome.reason === input.reason &&
    (input.blockers ?? []).length === current.blockers.length &&
    (input.blockers ?? []).every((blocker, index) => {
      const existing = current.blockers[index];
      return (
        existing?.code === blocker.code &&
        existing.detail === blocker.detail &&
        sameStrings(existing.clearEvents, blocker.clearEvents)
      );
    }) &&
    (input.evidenceRefs ?? []).every((ref) => current.evidenceRefs.includes(ref))
  ) {
    return { status: 'idempotent', transaction: current };
  }
  const nowMs = input.nowMs ?? Date.now();
  const outcome = { kind: 'pre-suite-no-verdict' as const, reason: input.reason };
  return {
    status: 'updated',
    transaction: {
      ...current,
      updatedAtMs: nowMs,
      phase: 'waiting',
      phaseEnteredAtMs: current.phase === 'waiting' ? current.phaseEnteredAtMs : nowMs,
      phaseDurationsMs: completedPhaseDurations(current, 'waiting', nowMs),
      outcome,
      blockers: (input.blockers ?? []).slice(0, 24).map((blocker) => ({ ...blocker, observedAtMs: nowMs })),
      waitGeneration: current.waitGeneration + 1,
      currentPhysicalRunner: null,
      consumedPhysicalRuns: consumedRunner(current, outcome, nowMs),
      evidenceRefs: uniqueStrings([...current.evidenceRefs, ...(input.evidenceRefs ?? [])]),
    },
  };
}

export function reserveQualificationRunner(
  current: CheckpointQualificationTransaction,
  input: {
    attemptId: string;
    runnerId: string;
    candidate?: string | null;
    evidenceRefs?: readonly string[];
    leaseDurationMs: number;
    unit?: string | null;
    /**
     * What the caller PROVED about the incumbent runner's process. Default 'unknown' keeps the
     * historical lease-only behaviour, so this can never loosen the lock on its own.
     */
    incumbentLiveness?: RunnerLiveness;
    nowMs?: number;
  },
): QualificationTransition {
  if (current.attemptId !== input.attemptId) return { status: 'conflict', transaction: current };
  if (isTerminalQualificationOutcome(current.outcome)) return { status: 'terminal', transaction: current };
  const nowMs = input.nowMs ?? Date.now();
  /**
   * A lease is evidence of INTENT, never of life. Until this carried a liveness term, a runner that
   * died without settling (crash, OOM, `systemd` stop, an aborted pre-suite phase) kept the whole
   * gate wedged for the remainder of its 3h lease, and every scheduled fire in that window returned
   * `conflict` and was skipped — which surfaces as `writer-starved`, i.e. a gate that looks red but
   * has in fact rendered no verdict at all. Only a PROVEN-dead incumbent is reclaimed; 'unknown'
   * (no unit recorded, or an unreadable probe) still waits the lease out, so the failure mode of a
   * broken probe is the old behaviour rather than two runners on one candidate.
   */
  const liveRunner =
    current.currentPhysicalRunner &&
    nowMs < (current.currentPhysicalRunner.leaseExpiresAtMs ?? current.currentPhysicalRunner.reservedAtMs) &&
    input.incumbentLiveness !== 'dead';
  if (liveRunner && current.currentPhysicalRunner!.id !== input.runnerId) {
    return { status: 'conflict', transaction: current };
  }
  if (liveRunner && current.currentPhysicalRunner?.id === input.runnerId) return { status: 'idempotent', transaction: current };
  const evidenceRefs = uniqueStrings(input.evidenceRefs ?? []);
  // Keep the two displacement causes distinct in the history: a lease that ran out is a runner that
  // overran, a reclaimed one is a runner that DIED. Collapsing them would hide exactly the signal
  // that makes a recurring vanish diagnosable.
  const displacedOutcome: QualificationOutcome = {
    kind: 'pre-suite-no-verdict',
    reason: input.incumbentLiveness === 'dead' ? 'runner-vanished' : 'deadline-exceeded',
  };
  const expiredRuns = current.currentPhysicalRunner
    ? consumedRunner(current, displacedOutcome, nowMs)
    : current.consumedPhysicalRuns ?? [];
  return {
    status: 'updated',
    transaction: {
      ...current,
      updatedAtMs: nowMs,
      candidate: input.candidate?.trim() || current.candidate,
      phase: 'running',
      phaseEnteredAtMs:
        current.phase === 'running' && !current.currentPhysicalRunner
          ? current.phaseEnteredAtMs ?? current.updatedAtMs
          : nowMs,
      phaseDurationsMs: completedPhaseDurations(current, 'running', nowMs),
      outcome: { kind: 'pending' },
      blockers: [],
      currentPhysicalRunner: {
        id: input.runnerId,
        candidate: input.candidate?.trim() || current.candidate,
        reservedAtMs: nowMs,
        leaseExpiresAtMs: nowMs + Math.max(1, input.leaseDurationMs),
        evidenceRefs,
        unit: input.unit?.trim() || null,
      },
      consumedPhysicalRuns: expiredRuns,
      evidenceRefs: uniqueStrings([...current.evidenceRefs, ...evidenceRefs]),
    },
  };
}

export function classifyQualificationVerdict(input: {
  reason: string;
  green?: boolean | null;
}): QualificationOutcome {
  const normalized = input.reason.trim().replaceAll('_', '-');
  if (input.green === true || ['advanced', 'up-to-date', 'advanced-prefix'].includes(normalized)) {
    return { kind: 'green', reason: input.reason };
  }
  if ((PRE_SUITE_NO_VERDICT_REASONS as readonly string[]).includes(normalized)) {
    return { kind: 'pre-suite-no-verdict', reason: normalized as PreSuiteNoVerdictReason };
  }
  if (input.green === false || normalized === 'not-green') return { kind: 'red', reason: input.reason };
  return { kind: 'code-inconclusive', reason: input.reason || 'unknown' };
}

export function settleQualificationTransaction(
  current: CheckpointQualificationTransaction,
  input: { attemptId: string; reason: string; green?: boolean | null; evidenceRefs?: readonly string[]; nowMs?: number },
): QualificationTransition {
  if (current.attemptId !== input.attemptId) return { status: 'conflict', transaction: current };
  if (isTerminalQualificationOutcome(current.outcome)) return { status: 'terminal', transaction: current };
  const outcome = classifyQualificationVerdict(input);
  if (outcome.kind === 'pre-suite-no-verdict') {
    return waitQualificationTransaction(current, {
      attemptId: input.attemptId,
      reason: outcome.reason,
      evidenceRefs: input.evidenceRefs,
      nowMs: input.nowMs,
    });
  }
  const nowMs = input.nowMs ?? Date.now();
  return {
    status: 'updated',
    transaction: {
      ...current,
      updatedAtMs: nowMs,
      phase: 'terminal',
      phaseEnteredAtMs: nowMs,
      phaseDurationsMs: completedPhaseDurations(current, 'terminal', nowMs),
      outcome,
      blockers: [],
      currentPhysicalRunner: null,
      consumedPhysicalRuns: consumedRunner(current, outcome, nowMs),
      evidenceRefs: uniqueStrings([...current.evidenceRefs, ...(input.evidenceRefs ?? [])]),
    },
  };
}

/**
 * Deliberately cancel one known physical runner without turning an ordinary external
 * SIGTERM into a retryable pre-suite wait. The caller must name both identities that
 * make the destructive action safe: the logical attempt and the systemd unit recorded
 * for its current runner. A terminal `code-inconclusive` result preserves the repair
 * queue and prevents the producer's later signal/result callback from settling a newer
 * attempt by accident.
 */
export function cancelQualificationTransaction(
  current: CheckpointQualificationTransaction,
  input: CancelQualificationInput,
): QualificationTransition {
  if (current.attemptId !== input.attemptId) return { status: 'conflict', transaction: current };
  if (isTerminalQualificationOutcome(current.outcome)) return { status: 'terminal', transaction: current };
  const runner = current.currentPhysicalRunner;
  if (!runner || runner.unit !== input.unit.trim()) return { status: 'conflict', transaction: current };
  const nowMs = input.nowMs ?? Date.now();
  const outcome: QualificationOutcome = {
    kind: 'code-inconclusive',
    reason: input.reason?.trim() || 'cancelled',
  };
  return {
    status: 'updated',
    transaction: {
      ...current,
      updatedAtMs: nowMs,
      phase: 'terminal',
      phaseEnteredAtMs: nowMs,
      phaseDurationsMs: completedPhaseDurations(current, 'terminal', nowMs),
      outcome,
      blockers: [],
      currentPhysicalRunner: null,
      consumedPhysicalRuns: consumedRunner(current, outcome, nowMs),
      evidenceRefs: uniqueStrings([
        ...current.evidenceRefs,
        ...(input.evidenceRefs ?? []),
        `cancelled:${runner.id}`,
      ]),
    },
  };
}

export type RepairQueueReconciliation = {
  status: 'none' | 'preserved' | 'retired' | 'blocked';
  reason:
    | 'no-queue'
    | 'queue-malformed'
    | 'queue-origin-mismatch'
    | 'queue-origin-unknown'
    | 'queue-not-safe-unstarted'
    | 'matching-untested-repair-head'
    | 'exact-safe-unstarted'
    | 'cas-miss';
  predecessorAttemptId: string;
  successorAttemptId: string;
  candidate?: string;
};

export type StoredQualificationMutation =
  | (QualificationTransition & { repairQueueReconciliation?: RepairQueueReconciliation })
  | { status: 'missing' | 'unreadable'; error?: string };

export type StoredQualificationCancellation =
  | StoredQualificationMutation
  | { status: 'stop-failed'; transaction: CheckpointQualificationTransaction; error: string };

/**
 * A terminal logical attempt may leave its pre-suite frozen candidate behind. Retire it
 * only for an explicitly distinct successor and only while the queue is still the exact,
 * unstarted row created by that predecessor. Any legacy, mismatched, dispatched, repaired,
 * or otherwise advanced queue stays authoritative and blocks the successor fail-closed.
 *
 * A queue with a NULL `qualificationAttemptId` (schema v3 permits this — see WI-41667) is
 * judged the same way: null means the origin is unknown, not that it belongs to someone
 * else, so it is never fail-closed purely for that reason. It is retired when it is
 * otherwise exact/safe/unstarted, and blocked with the distinguishing `queue-origin-unknown`
 * reason only when the phase/attempts/fixer checks say it genuinely isn't idle (WI-2142947).
 */
export function assessTerminalRepairQueueReconciliation(
  current: CheckpointQualificationTransaction,
  successor: BeginQualificationInput,
  rawRepairQueue: unknown,
): RepairQueueReconciliation {
  const base = {
    predecessorAttemptId: current.attemptId,
    successorAttemptId: successor.attemptId,
  };
  if (rawRepairQueue == null) return { status: 'none', reason: 'no-queue', ...base };
  const queue = parseFrozenCandidateRepairQueue(rawRepairQueue);
  if (!queue) return { status: 'blocked', reason: 'queue-malformed', ...base };
  // A NULL origin is an ABSENCE of provenance, not evidence of a competing owner: schema v3
  // permits a queue created without a stamped `qualificationAttemptId` (see WI-41667), and such
  // a queue is well-formed, not corrupt. Only a KNOWN, DIFFERENT attemptId is a genuine mismatch
  // (someone else's queue) that must stay fail-closed forever. A null origin instead falls
  // through to the same phase/attempts/fixer safety checks below, so it is judged on its actual
  // state rather than being permanently blocked (WI-2142947).
  const originUnknown = queue.qualificationAttemptId === null;
  const originMatchesTerminal = queue.qualificationAttemptId === current.attemptId;
  // A logical qualification can inherit the queue selected by its immediate predecessor.
  // If that inherited run then terminates inconclusively, the queue still names the earlier
  // attempt while `previousAttemptId` is the durable link from the terminal transaction back
  // to it. This link is accepted only for the narrow untested repair-head state below.
  const originMatchesImmediatePredecessor =
    current.previousAttemptId !== null && queue.qualificationAttemptId === current.previousAttemptId;
  const safeUntestedRepairHead =
    queue.phase === 'ready-to-verify' &&
    queue.fixerSpawnId === null &&
    queue.dispatchReservation == null &&
    frozenRepairHeadAwaitsVerification(queue);
  if (!originUnknown && !originMatchesTerminal && !(originMatchesImmediatePredecessor && safeUntestedRepairHead)) {
    return {
      status: 'blocked',
      reason: 'queue-origin-mismatch',
      candidate: queue.candidate,
      ...base,
    };
  }
  // WI-10000288: a red terminal attempt may own a queue that has since converged onto a
  // DIFFERENT, never-judged repairHead. That row is not predecessor residue to retire and it
  // is not an in-flight repair to block behind: `ready-to-verify` is the queue's explicit
  // suite-producing state. Preserve the exact queue while installing the successor logical
  // qualification, which will select the same repairHead through the ordinary frozen-queue /
  // required-ancestor preflight below. Keep this deliberately narrow: provenance must name the
  // terminal attempt or its explicitly recorded immediate predecessor, no fixer or dispatch
  // reservation may still own the row, and the head must be absent from the convergence rounds.
  // Unknown, unrelated, or deeper ancestry stays fail-closed, as does a repairHead that has
  // already consumed a verification run.
  if (!originUnknown && (originMatchesTerminal || originMatchesImmediatePredecessor) && safeUntestedRepairHead) {
    return {
      status: 'preserved',
      reason: 'matching-untested-repair-head',
      candidate: queue.candidate,
      ...base,
    };
  }
  if (
    queue.phase !== 'ready-to-test' ||
    queue.repairHead !== queue.candidate ||
    queue.attempts !== 0 ||
    queue.fixerSpawnId !== null ||
    queue.dispatchReservation != null
  ) {
    return {
      status: 'blocked',
      // Origin-unknown-and-unsafe gets its own reason so the refusal is diagnosable as "we
      // don't know whose queue this is, and it also isn't verifiably idle" rather than reading
      // like a takeover race against a known owner.
      reason: originUnknown ? 'queue-origin-unknown' : 'queue-not-safe-unstarted',
      candidate: queue.candidate,
      ...base,
    };
  }
  return {
    status: 'retired',
    reason: 'exact-safe-unstarted',
    candidate: queue.candidate,
    ...base,
  };
}

type StoredQualificationMutationOptions = {
  /**
   * Reconcile the predecessor's exact safe queue in the SAME locked row update that
   * installs a distinct successor qualification.
   */
  successorInput?: BeginQualificationInput;
};

async function mutateStoredQualification(
  target: GateVerdictTarget,
  change: (current: CheckpointQualificationTransaction | null) => StoredQualificationMutation,
  options: StoredQualificationMutationOptions = {},
): Promise<StoredQualificationMutation> {
  try {
    return await boundedOrgTxn<StoredQualificationMutation>(async (tx) => {
      const rows = await tx<{ metadata: Record<string, unknown> | null }[]>`
        SELECT metadata
          FROM harness_shared.routines
         WHERE workspace_id = ${target.workspaceId}
           AND install_slug = ${target.installSlug}
           AND target_role = 'system:green-checkpoint'
         FOR UPDATE`;
      if (!rows[0]) return { status: 'missing' as const };
      const metadata = rows[0].metadata ?? {};
      const raw = metadata[CHECKPOINT_QUALIFICATION_METADATA_KEY];
      const current = raw == null ? null : parseCheckpointQualificationTransaction(raw);
      if (raw != null && !current) {
        return { status: 'unreadable' as const, error: 'qualification transaction metadata is malformed' };
      }
      const transition = change(current);
      if (transition.status !== 'updated') return transition;
      const predecessor =
        options.successorInput &&
        current &&
        isTerminalQualificationOutcome(current.outcome) &&
        current.attemptId !== transition.transaction.attemptId
          ? current
          : null;
      const reconciliation =
        predecessor && options.successorInput
          ? assessTerminalRepairQueueReconciliation(
              predecessor,
              options.successorInput,
              metadata.repair_queue,
            )
          : null;
      if (reconciliation?.status === 'blocked') {
        return {
          status: 'conflict' as const,
          transaction: predecessor!,
          repairQueueReconciliation: reconciliation,
        };
      }
      if (reconciliation?.status === 'retired') {
        const updatedRows = await tx<{ metadata: Record<string, unknown> }[]>`
          UPDATE harness_shared.routines
             SET metadata = jsonb_set(
                   CASE
                     WHEN metadata #>> '{gate_health,inconclusive,status}'
                            IN ('repair-in-progress', 'repair-staging-mismatch')
                       THEN (COALESCE(metadata, '{}'::jsonb) - 'repair_queue')
                            #- '{gate_health,inconclusive}'
                     ELSE COALESCE(metadata, '{}'::jsonb) - 'repair_queue'
                   END,
                   '{${tx.unsafe(CHECKPOINT_QUALIFICATION_METADATA_KEY)}}',
                   ${JSON.stringify(transition.transaction)}::text::jsonb,
                   true
                 ),
                 updated_at = now()
           WHERE workspace_id = ${target.workspaceId}
             AND install_slug = ${target.installSlug}
             AND target_role = 'system:green-checkpoint'
             AND metadata->'repair_queue' = ${JSON.stringify(metadata.repair_queue)}::text::jsonb
             AND metadata->${CHECKPOINT_QUALIFICATION_METADATA_KEY} = ${JSON.stringify(raw)}::text::jsonb
           RETURNING metadata`;
        if (updatedRows.length === 0) {
          return {
            status: 'conflict' as const,
            transaction: predecessor!,
            repairQueueReconciliation: {
              ...reconciliation,
              status: 'blocked',
              reason: 'cas-miss',
            },
          };
        }
        return { ...transition, repairQueueReconciliation: reconciliation };
      }
      if (reconciliation?.status === 'preserved') {
        // Preservation is a queue handoff, not just permission to leave an old id behind.
        // Re-stamp the queue to the successor in the SAME exact-row CAS that installs the
        // successor transaction. Otherwise the next inconclusive run sees ancestry two hops
        // old and wedges on queue-origin-mismatch again.
        const updatedRows = await tx<{ metadata: Record<string, unknown> }[]>`
          UPDATE harness_shared.routines
             SET metadata = jsonb_set(
                   jsonb_set(
                     COALESCE(metadata, '{}'::jsonb),
                     '{repair_queue,qualificationAttemptId}',
                     ${JSON.stringify(transition.transaction.attemptId)}::text::jsonb,
                     true
                   ),
                   '{${tx.unsafe(CHECKPOINT_QUALIFICATION_METADATA_KEY)}}',
                   ${JSON.stringify(transition.transaction)}::text::jsonb,
                   true
                 ),
                 updated_at = now()
           WHERE workspace_id = ${target.workspaceId}
             AND install_slug = ${target.installSlug}
             AND target_role = 'system:green-checkpoint'
             AND metadata->'repair_queue' = ${JSON.stringify(metadata.repair_queue)}::text::jsonb
             AND metadata->${CHECKPOINT_QUALIFICATION_METADATA_KEY} = ${JSON.stringify(raw)}::text::jsonb
           RETURNING metadata`;
        if (updatedRows.length === 0) {
          return {
            status: 'conflict' as const,
            transaction: predecessor!,
            repairQueueReconciliation: {
              ...reconciliation,
              status: 'blocked',
              reason: 'cas-miss',
            },
          };
        }
        return { ...transition, repairQueueReconciliation: reconciliation };
      }
      await tx`
        UPDATE harness_shared.routines
           SET metadata = jsonb_set(
                 COALESCE(metadata, '{}'::jsonb),
                 '{${tx.unsafe(CHECKPOINT_QUALIFICATION_METADATA_KEY)}}',
                 ${JSON.stringify(transition.transaction)}::text::jsonb,
                 true
               ),
               updated_at = now()
         WHERE workspace_id = ${target.workspaceId}
           AND install_slug = ${target.installSlug}
           AND target_role = 'system:green-checkpoint'`;
      return reconciliation ? { ...transition, repairQueueReconciliation: reconciliation } : transition;
    });
  } catch (error) {
    return { status: 'unreadable', error: error instanceof Error ? error.message : String(error) };
  }
}

export function beginStoredQualification(
  target: GateVerdictTarget,
  input: BeginQualificationInput,
  options: { reconcileTerminalRepairQueueForSuccessor?: boolean } = {},
): Promise<StoredQualificationMutation> {
  return mutateStoredQualification(
    target,
    // Probe INSIDE the mutation so the liveness verdict is taken against the same `current` the
    // transition decides on. Probing outside would race: the incumbent can die, or a fresh runner
    // can take the lease, between the read and the write.
    (current) =>
      beginQualificationTransaction(current, {
        ...input,
        incumbentLiveness: input.incumbentLiveness ?? probeRunnerLiveness(current?.currentPhysicalRunner),
      }),
    options.reconcileTerminalRepairQueueForSuccessor ? { successorInput: input } : {},
  );
}

export function waitStoredQualification(
  target: GateVerdictTarget,
  input: Parameters<typeof waitQualificationTransaction>[1],
): Promise<StoredQualificationMutation> {
  return mutateStoredQualification(target, (current) =>
    current ? waitQualificationTransaction(current, input) : { status: 'unreadable', error: 'missing attempt' });
}

export function reserveStoredQualificationRunner(
  target: GateVerdictTarget,
  input: Parameters<typeof reserveQualificationRunner>[1],
): Promise<StoredQualificationMutation> {
  return mutateStoredQualification(target, (current) =>
    current
      ? reserveQualificationRunner(current, {
          ...input,
          incumbentLiveness: input.incumbentLiveness ?? probeRunnerLiveness(current.currentPhysicalRunner),
        })
      : { status: 'unreadable', error: 'missing attempt' });
}

export function recordStoredQualificationEligibility(
  target: GateVerdictTarget,
  input: Parameters<typeof recordQualificationEligibilitySnapshot>[1],
): Promise<StoredQualificationMutation> {
  return mutateStoredQualification(target, (current) =>
    current
      ? recordQualificationEligibilitySnapshot(current, input)
      : { status: 'unreadable', error: 'missing attempt' });
}

export async function readStoredQualification(
  target: GateVerdictTarget,
): Promise<{ status: 'present'; transaction: CheckpointQualificationTransaction } | { status: 'none' | 'unreadable'; error?: string }> {
  try {
    const { sql } = getOrgPg();
    const rows = await sql<{ transaction: unknown }[]>`
      SELECT metadata->${CHECKPOINT_QUALIFICATION_METADATA_KEY} AS transaction
        FROM harness_shared.routines
       WHERE workspace_id = ${target.workspaceId}
         AND install_slug = ${target.installSlug}
         AND target_role = 'system:green-checkpoint'
       LIMIT 1`;
    if (!rows[0]?.transaction) return { status: 'none' };
    const transaction = parseCheckpointQualificationTransaction(rows[0].transaction);
    return transaction
      ? { status: 'present', transaction }
      : { status: 'unreadable', error: 'qualification transaction metadata is malformed' };
  } catch (error) {
    return { status: 'unreadable', error: error instanceof Error ? error.message : String(error) };
  }
}

export function recordStoredQualificationVerdict(
  target: GateVerdictTarget,
  input: {
    attemptId?: string;
    reason: string;
    green?: boolean | null;
    evidenceRefs?: readonly string[];
    nowMs?: number;
  },
): Promise<StoredQualificationMutation> {
  return mutateStoredQualification(target, (current) => {
    if (!current) return { status: 'unreadable', error: 'missing attempt' };
    return settleQualificationTransaction(current, {
      ...input,
      attemptId: input.attemptId ?? current.attemptId,
    });
  });
}

/**
 * Stop and settle a runner while the qualification row is held FOR UPDATE. The exact
 * attempt/unit predicates are repeated on the UPDATE as a row-level CAS, and the repair
 * queue is intentionally absent from the SET clause: cancelling a verifier may abandon
 * the physical run, but it must never retire or rewrite the frozen repair lineage.
 */
export async function cancelStoredQualification(
  target: GateVerdictTarget,
  input: CancelQualificationInput,
  stop: () => Promise<{ stopped: boolean; reason?: string }> | { stopped: boolean; reason?: string },
): Promise<StoredQualificationCancellation> {
  try {
    return await boundedOrgTxn<StoredQualificationCancellation>(async (tx) => {
      const rows = await tx<{ metadata: Record<string, unknown> | null }[]>`
        SELECT metadata
          FROM harness_shared.routines
         WHERE workspace_id = ${target.workspaceId}
           AND install_slug = ${target.installSlug}
           AND target_role = 'system:green-checkpoint'
         FOR UPDATE`;
      if (!rows[0]) return { status: 'missing' as const };
      const metadata = rows[0].metadata ?? {};
      const raw = metadata[CHECKPOINT_QUALIFICATION_METADATA_KEY];
      const current = raw == null ? null : parseCheckpointQualificationTransaction(raw);
      if (raw != null && !current) {
        return { status: 'unreadable' as const, error: 'qualification transaction metadata is malformed' };
      }
      if (!current) return { status: 'unreadable' as const, error: 'missing attempt' };
      const transition = cancelQualificationTransaction(current, input);
      if (transition.status !== 'updated') return transition;

      const stopped = await stop();
      if (!stopped.stopped) {
        return {
          status: 'stop-failed' as const,
          transaction: current,
          error: stopped.reason?.trim() || 'systemd kill did not stop the exact checkpoint unit',
        };
      }

      const updatedRows = await tx<{ metadata: Record<string, unknown> }[]>`
        UPDATE harness_shared.routines
           SET metadata = jsonb_set(
                 COALESCE(metadata, '{}'::jsonb),
                 '{${tx.unsafe(CHECKPOINT_QUALIFICATION_METADATA_KEY)}}',
                 ${JSON.stringify(transition.transaction)}::text::jsonb,
                 true
               ),
               updated_at = now()
         WHERE workspace_id = ${target.workspaceId}
           AND install_slug = ${target.installSlug}
           AND target_role = 'system:green-checkpoint'
           AND metadata->${CHECKPOINT_QUALIFICATION_METADATA_KEY}->>'attemptId' = ${input.attemptId}
           AND metadata->${CHECKPOINT_QUALIFICATION_METADATA_KEY}->'currentPhysicalRunner'->>'unit' = ${input.unit.trim()}
           AND metadata->${CHECKPOINT_QUALIFICATION_METADATA_KEY} = ${JSON.stringify(raw)}::text::jsonb
         RETURNING metadata`;
      if (updatedRows.length === 0) return { status: 'conflict' as const, transaction: current };
      return transition;
    });
  } catch (error) {
    return { status: 'unreadable', error: error instanceof Error ? error.message : String(error) };
  }
}
