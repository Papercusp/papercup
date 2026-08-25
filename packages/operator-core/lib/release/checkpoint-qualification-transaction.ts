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

export const CHECKPOINT_QUALIFICATION_METADATA_KEY = 'qualificationTransaction';
export const CHECKPOINT_QUALIFICATION_SCHEMA_VERSION = 1 as const;

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

const isTerminalOutcome = (outcome: QualificationOutcome): boolean =>
  outcome.kind === 'green' || outcome.kind === 'red' || outcome.kind === 'code-inconclusive';

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
  return row as CheckpointQualificationTransaction;
}

export function beginQualificationTransaction(
  current: CheckpointQualificationTransaction | null,
  input: BeginQualificationInput,
): QualificationTransition {
  const nowMs = input.nowMs ?? Date.now();
  if (current?.attemptId === input.attemptId) {
    return { status: isTerminalOutcome(current.outcome) ? 'terminal' : 'idempotent', transaction: current };
  }
  if (current && !isTerminalOutcome(current.outcome)) return { status: 'conflict', transaction: current };
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
  if (isTerminalOutcome(current.outcome)) return { status: 'terminal', transaction: current };
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
  if (isTerminalOutcome(current.outcome)) return { status: 'terminal', transaction: current };
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
  if (isTerminalOutcome(current.outcome)) return { status: 'terminal', transaction: current };
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

type StoredMutation = QualificationTransition | { status: 'missing' | 'unreadable'; error?: string };

async function mutateStoredQualification(
  target: GateVerdictTarget,
  change: (current: CheckpointQualificationTransaction | null) => QualificationTransition,
): Promise<StoredMutation> {
  try {
    return await boundedOrgTxn(async (tx) => {
      const rows = await tx<{ metadata: Record<string, unknown> | null }[]>`
        SELECT metadata
          FROM harness_shared.routines
         WHERE workspace_id = ${target.workspaceId}
           AND install_slug = ${target.installSlug}
           AND name = 'green-checkpoint'
           AND group_slug = 'release'
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
           AND name = 'green-checkpoint'
           AND group_slug = 'release'
           AND target_role = 'system:green-checkpoint'`;
      return transition;
    });
  } catch (error) {
    return { status: 'unreadable', error: error instanceof Error ? error.message : String(error) };
  }
}

export function beginStoredQualification(
  target: GateVerdictTarget,
  input: BeginQualificationInput,
): Promise<StoredMutation> {
  return mutateStoredQualification(target, (current) => beginQualificationTransaction(current, input));
}

export function waitStoredQualification(
  target: GateVerdictTarget,
  input: Parameters<typeof waitQualificationTransaction>[1],
): Promise<StoredMutation> {
  return mutateStoredQualification(target, (current) =>
    current ? waitQualificationTransaction(current, input) : { status: 'unreadable', error: 'missing attempt' } as never);
}

export function reserveStoredQualificationRunner(
  target: GateVerdictTarget,
  input: Parameters<typeof reserveQualificationRunner>[1],
): Promise<StoredMutation> {
  return mutateStoredQualification(target, (current) =>
    current ? reserveQualificationRunner(current, input) : { status: 'unreadable', error: 'missing attempt' } as never);
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
         AND name = 'green-checkpoint'
         AND group_slug = 'release'
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
  input: { reason: string; green?: boolean | null; evidenceRefs?: readonly string[]; nowMs?: number },
): Promise<StoredMutation> {
  return mutateStoredQualification(target, (current) => {
    if (!current) return { status: 'unreadable', error: 'missing attempt' } as never;
    return settleQualificationTransaction(current, { attemptId: current.attemptId, ...input });
  });
}
