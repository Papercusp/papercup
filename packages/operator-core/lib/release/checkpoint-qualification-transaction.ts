/**
 * Durable logical qualification transaction.
 *
 * One record lives beside the green-checkpoint routine's existing gate_health /
 * repair_queue metadata. It is a coordination root, not a second scheduler or
 * lock: the existing routine claimant and physical run lock remain the safety
 * authorities. This record makes the logical attempt, retry policy, current
 * physical runner, blockers, and evidence machine-readable across processes.
 */
import { getOrgPg } from '@papercusp/db-org';
import type { GateVerdictTarget } from './gate-verdict-target';
import { boundedOrgTxn } from '../pg-bounded-txn';
import {
  parseFrozenCandidateRepairQueue,
  type FrozenCandidateRepairQueue,
} from './frozen-candidate-repair-queue';

export const CHECKPOINT_QUALIFICATION_METADATA_KEY = 'qualificationTransaction';
export const CHECKPOINT_QUALIFICATION_SCHEMA_VERSION = 1 as const;
/** Transported into a detached checkpoint so its verdict settles the exact logical attempt. */
export const CHECKPOINT_QUALIFICATION_ATTEMPT_ENV = 'PAPERCUSP_CHECKPOINT_QUALIFICATION_ATTEMPT_ID';

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
  evidenceRefs: string[];
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
  outcome: QualificationOutcome;
  blockers: QualificationBlocker[];
  waitGeneration: number;
  currentPhysicalRunner: QualificationPhysicalRunner | null;
  evidenceRefs: string[];
  previousAttemptId: string | null;
}

export interface BeginQualificationInput {
  attemptId: string;
  requiredAncestorSha?: string | null;
  declaredPaths?: readonly string[];
  candidate?: string | null;
  evidenceRefs?: readonly string[];
  nowMs?: number;
}

export type QualificationTransition =
  | { status: 'updated' | 'idempotent'; transaction: CheckpointQualificationTransaction }
  | { status: 'conflict' | 'terminal'; transaction: CheckpointQualificationTransaction };

const uniqueStrings = (values: readonly string[], cap = 64): string[] =>
  [...new Set(values.map((value) => value.trim()).filter(Boolean))].slice(0, cap);

export const isTerminalQualificationOutcome = (outcome: QualificationOutcome): boolean =>
  outcome.kind === 'green' || outcome.kind === 'red' || outcome.kind === 'code-inconclusive';

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  const a = uniqueStrings(left).sort();
  const b = uniqueStrings(right).sort();
  return a.length === b.length && a.every((value, index) => value === b[index]);
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
    !Array.isArray(row.evidenceRefs)
  ) return null;
  const outcome = row.outcome as Partial<QualificationOutcome>;
  if (!['pending', 'pre-suite-no-verdict', 'green', 'red', 'code-inconclusive'].includes(String(outcome.kind))) {
    return null;
  }
  if (
    outcome.kind === 'pre-suite-no-verdict' &&
    !(PRE_SUITE_NO_VERDICT_REASONS as readonly string[]).includes(String((outcome as { reason?: unknown }).reason))
  ) return null;
  if (
    (outcome.kind === 'green' || outcome.kind === 'red' || outcome.kind === 'code-inconclusive') &&
    typeof (outcome as { reason?: unknown }).reason !== 'string'
  ) return null;
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
      !Array.isArray(row.currentPhysicalRunner.evidenceRefs) ||
      row.currentPhysicalRunner.evidenceRefs.some((ref) => typeof ref !== 'string')
    )
  ) return null;
  return row as CheckpointQualificationTransaction;
}

export function beginQualificationTransaction(
  current: CheckpointQualificationTransaction | null,
  input: BeginQualificationInput,
): QualificationTransition {
  const nowMs = input.nowMs ?? Date.now();
  if (current?.attemptId === input.attemptId) {
    return {
      status: isTerminalQualificationOutcome(current.outcome) ? 'terminal' : 'idempotent',
      transaction: current,
    };
  }
  if (current && !isTerminalQualificationOutcome(current.outcome)) {
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
    outcome: { kind: 'pending' },
    blockers: [],
    waitGeneration: 0,
    currentPhysicalRunner: null,
    evidenceRefs: uniqueStrings(input.evidenceRefs ?? []),
    previousAttemptId: current?.attemptId ?? null,
  };
  return { status: 'updated', transaction };
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
  return {
    status: 'updated',
    transaction: {
      ...current,
      updatedAtMs: nowMs,
      phase: 'waiting',
      outcome: { kind: 'pre-suite-no-verdict', reason: input.reason },
      blockers: (input.blockers ?? []).slice(0, 24).map((blocker) => ({ ...blocker, observedAtMs: nowMs })),
      waitGeneration: current.waitGeneration + 1,
      currentPhysicalRunner: null,
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
    nowMs?: number;
  },
): QualificationTransition {
  if (current.attemptId !== input.attemptId) return { status: 'conflict', transaction: current };
  if (isTerminalQualificationOutcome(current.outcome)) return { status: 'terminal', transaction: current };
  if (current.currentPhysicalRunner && current.currentPhysicalRunner.id !== input.runnerId) {
    return { status: 'conflict', transaction: current };
  }
  if (current.currentPhysicalRunner?.id === input.runnerId) return { status: 'idempotent', transaction: current };
  const nowMs = input.nowMs ?? Date.now();
  const evidenceRefs = uniqueStrings(input.evidenceRefs ?? []);
  return {
    status: 'updated',
    transaction: {
      ...current,
      updatedAtMs: nowMs,
      candidate: input.candidate?.trim() || current.candidate,
      phase: 'running',
      outcome: { kind: 'pending' },
      blockers: [],
      currentPhysicalRunner: {
        id: input.runnerId,
        candidate: input.candidate?.trim() || current.candidate,
        reservedAtMs: nowMs,
        evidenceRefs,
      },
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
      outcome,
      blockers: [],
      currentPhysicalRunner: null,
      evidenceRefs: uniqueStrings([...current.evidenceRefs, ...(input.evidenceRefs ?? [])]),
    },
  };
}

export type RepairQueueReconciliation = {
  status: 'none' | 'retired' | 'blocked';
  reason:
    | 'no-queue'
    | 'queue-malformed'
    | 'queue-origin-mismatch'
    | 'queue-not-safe-unstarted'
    | 'exact-safe-unstarted'
    | 'cas-miss';
  predecessorAttemptId: string;
  successorAttemptId: string;
  candidate?: string;
};

export type StoredQualificationMutation =
  | (QualificationTransition & { repairQueueReconciliation?: RepairQueueReconciliation })
  | { status: 'missing' | 'unreadable'; error?: string };

/**
 * A terminal logical attempt may leave its pre-suite frozen candidate behind. Retire it
 * only for an explicitly distinct successor and only while the queue is still the exact,
 * unstarted row created by that predecessor. Any legacy, mismatched, dispatched, repaired,
 * or otherwise advanced queue stays authoritative and blocks the successor fail-closed.
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
  if (queue.qualificationAttemptId !== current.attemptId) {
    return {
      status: 'blocked',
      reason: 'queue-origin-mismatch',
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
      reason: 'queue-not-safe-unstarted',
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
    (current) => beginQualificationTransaction(current, input),
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
    current ? reserveQualificationRunner(current, input) : { status: 'unreadable', error: 'missing attempt' });
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
