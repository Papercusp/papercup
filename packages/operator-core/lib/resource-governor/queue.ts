import { randomUUID, createHash } from 'node:crypto';
import { getOrgPg } from '@papercusp/db-org';
import { activeWorkspaceId } from '../workspace-registry';
import { boundedOrgTxn } from '../pg-bounded-txn';
import {
  acquireWithContentionRetry,
  isWorkspaceContended,
  LOCK_CONTENTION_BACKOFFS_MS,
} from '../agent-tools/locks/contention-retry';
import {
  AdmissionIdempotencyConflictError,
  AdmissionPersistenceError,
  admissionRequestFingerprint,
  type AdmissionCancellation,
  type AdmissionContext,
  type AdmissionDriver,
  type AdmissionLease,
  type AdmissionOutcome,
  type AdmissionRelease,
  type AdmissionStatus,
  type AdmissionMetadataValue,
  type NormalizedAdmissionRequest,
  type QueueReceipt,
  type QueueReceiptState,
  type ResourceDemand,
} from './admission';
import type { HealthResource } from './health-analysis';

export const RESOURCE_GOVERNOR_PAYLOAD_KEY = 'resource_governor';
export const RESOURCE_GOVERNOR_QUEUE_SCHEMA_VERSION = 1 as const;
export const RESOURCE_GOVERNOR_PARK_OWNER = 'system:resource-governor';

/**
 * The vocabulary `harness_shared.work_items_signal_origin_chk` accepts for
 * `payload._ei.signal_origin` (migration 403-work-items-signal-origin-restore.sql).
 *
 * This is deliberately NOT the same vocabulary as the `work_items.origin` COLUMN,
 * which takes 'local' | 'federated'. Writing a column value here raises SQLSTATE
 * 23514 on the enqueue INSERT — and because that INSERT is how EVERY spawner-sidecar
 * admission is persisted, a single wrong word stops every process this host admits,
 * which in turn stops git-sync from spawning `git` at all. See WI-144314.
 */
export const WORK_ITEM_SIGNAL_ORIGINS = ['organic', 'drill', 'replay', 'shadow'] as const;

/** Governor receipts are real, locally-originated rows — not a drill/replay/shadow. */
export const RESOURCE_GOVERNOR_SIGNAL_ORIGIN: (typeof WORK_ITEM_SIGNAL_ORIGINS)[number] = 'organic';

export type SqlClient = ReturnType<typeof getOrgPg>['sql'];
type DecisionValue = string | number | boolean | null;

export interface QueueDecision {
  readonly generation: number;
  readonly atMs: number;
  readonly reason: string;
  readonly evidence: Readonly<Record<string, DecisionValue>>;
}

export interface DurableAdmissionLease {
  readonly leaseId: string;
  readonly owner: string;
  readonly generation: number;
  readonly expiresAtMs: number;
}

/**
 * Typed payload stored on the canonical work-item row. The row id is the public
 * receipt id; this payload owns only governor-specific state.
 */
export interface DurableAdmissionRecord {
  readonly schemaVersion: typeof RESOURCE_GOVERNOR_QUEUE_SCHEMA_VERSION;
  readonly namespace: string;
  readonly idempotencyKey: string;
  readonly requestFingerprint: string;
  readonly admissionClass: string;
  readonly priority: number;
  readonly deadlineAtMs: number | null;
  readonly demand: Readonly<ResourceDemand>;
  readonly payloadRef: string | null;
  readonly coalesceKey: string | null;
  readonly metadata: Readonly<Record<string, AdmissionMetadataValue>>;
  readonly context: AdmissionContext;
  readonly state: QueueReceiptState;
  readonly enqueuedAtMs: number;
  readonly updatedAtMs: number;
  readonly decision: QueueDecision;
  readonly lease?: DurableAdmissionLease;
  readonly cancellationReason?: string;
  readonly supersededByReceiptId?: string;
  readonly resultRef?: string;
  readonly actualDemand?: Readonly<ResourceDemand>;
  readonly releasedAtMs?: number;
}

export interface StoredAdmissionRecord {
  readonly receiptId: string;
  readonly record: DurableAdmissionRecord;
}

export interface QueueMutationResult extends StoredAdmissionRecord {
  readonly changed: boolean;
}

export interface QueueReconciliationResult {
  readonly requeued: number;
  readonly expired: number;
  readonly total: number;
}

export interface AdmissionQueueLeaseClaim extends StoredAdmissionRecord {
  readonly context: AdmissionContext;
  readonly lease: AdmissionLease & { readonly owner: string };
}

export interface QueueLeaseClassPolicy {
  readonly admissionClass: string;
  /** Weighted fair-service clock; lower values are served first. */
  readonly virtualTime: number;
  readonly weight: number;
  /** Live controller feedback for this class, used to prefer other resource shapes. */
  readonly constrainedResources: readonly HealthResource[];
}

/** Transient controller policy for one lease selection. It is never a capacity ceiling. */
export interface QueueLeaseSelection {
  readonly classes: readonly QueueLeaseClassPolicy[];
  readonly releasedResources: readonly HealthResource[];
  readonly agingIntervalMs: number;
  readonly deadlineHorizonMs: number;
  readonly resourceAffinityBonus: number;
  readonly constrainedResourcePenalty: number;
}

export interface DurableAdmissionQueueStore {
  enqueue(record: DurableAdmissionRecord): Promise<StoredAdmissionRecord & { readonly created: boolean }>;
  find(namespace: string, idempotencyKey: string): Promise<StoredAdmissionRecord | null>;
  cancel(
    namespace: string,
    idempotencyKey: string,
    reason: string | undefined,
    nowMs: number,
  ): Promise<QueueMutationResult | null>;
  leaseNext(
    namespace: string,
    owner: string,
    leaseId: string,
    ttlMs: number,
    nowMs: number,
    selection?: QueueLeaseSelection,
  ): Promise<QueueMutationResult | null>;
  /** Target one already-persisted receipt during observe-only migration. */
  leaseReceipt(
    namespace: string,
    receiptId: string,
    owner: string,
    leaseId: string,
    ttlMs: number,
    nowMs: number,
  ): Promise<QueueMutationResult | null>;
  markRunning(receiptId: string, leaseId: string, nowMs: number): Promise<QueueMutationResult | null>;
  complete(
    receiptId: string,
    leaseId: string,
    resultRef: string | undefined,
    nowMs: number,
  ): Promise<QueueMutationResult | null>;
  releaseLease(receiptId: string, leaseId: string, nowMs: number): Promise<QueueMutationResult | null>;
  releaseClaim(
    receiptId: string,
    leaseId: string,
    actualDemand: Readonly<ResourceDemand> | undefined,
    nowMs: number,
  ): Promise<QueueMutationResult | null>;
  supersede(receiptId: string, replacementReceiptId: string, nowMs: number): Promise<QueueMutationResult | null>;
  /** Reconcile lapsed leases and overdue deadlines before selecting work. */
  reconcileExpired?(namespace: string, nowMs: number): Promise<QueueReconciliationResult>;
}

interface QueueDbRow {
  feature_id: string;
  payload: unknown;
  status: string | null;
  taken_by: string | null;
  created_ts: number | string | null;
}

function jsonObject(value: unknown): Record<string, unknown> | null {
  let current = value;
  for (let i = 0; i < 2 && typeof current === 'string'; i += 1) {
    try {
      current = JSON.parse(current) as unknown;
    } catch {
      return null;
    }
  }
  return current && typeof current === 'object' && !Array.isArray(current)
    ? (current as Record<string, unknown>)
    : null;
}

function isQueueState(value: unknown): value is QueueReceiptState {
  return (
    value === 'queued' ||
    value === 'eligible' ||
    value === 'leased' ||
    value === 'running' ||
    value === 'completed' ||
    value === 'cancelled' ||
    value === 'superseded' ||
    value === 'expired'
  );
}

function recordFromPayload(payload: unknown): DurableAdmissionRecord | null {
  const outer = jsonObject(payload);
  const raw = jsonObject(outer?.[RESOURCE_GOVERNOR_PAYLOAD_KEY]);
  if (
    !raw ||
    raw.schemaVersion !== RESOURCE_GOVERNOR_QUEUE_SCHEMA_VERSION ||
    typeof raw.namespace !== 'string' ||
    typeof raw.idempotencyKey !== 'string' ||
    typeof raw.requestFingerprint !== 'string' ||
    typeof raw.admissionClass !== 'string' ||
    typeof raw.priority !== 'number' ||
    typeof raw.enqueuedAtMs !== 'number' ||
    typeof raw.updatedAtMs !== 'number' ||
    !isQueueState(raw.state)
  ) {
    return null;
  }
  return raw as unknown as DurableAdmissionRecord;
}

/**
 * Whether a work-item payload belongs to the durable resource-governor queue.
 *
 * Generic work-item mutations must not treat these rows as ordinary issue-family
 * work: the outer status/assignee is a projection of the nested receipt state and
 * lease, while `_claimHold` keeps the row out of generic self-selection. The
 * reserved payload key is the protection boundary (rather than only the hold
 * provenance), so even a partially-corrupted receipt remains outside generic
 * work-item mutations.
 */
export function hasResourceGovernorReceiptPayload(payload: unknown): boolean {
  const outer = jsonObject(payload);
  return outer !== null && Object.prototype.hasOwnProperty.call(outer, RESOURCE_GOVERNOR_PAYLOAD_KEY);
}

/** Raised when an ordinary work-item release would bypass governor state transitions. */
export class ResourceGovernorReleaseRequiredError extends Error {
  readonly code = 'RESOURCE_GOVERNOR_RELEASE_REQUIRED';
  readonly receiptId: string;

  constructor(receiptId: string) {
    super(
      `work-item '${receiptId}' is a protected resource-governor receipt; ` +
        'release it through the resource-governor admission context instead of generic work_items:release',
    );
    this.name = 'ResourceGovernorReleaseRequiredError';
    this.receiptId = receiptId;
  }
}

function storedFromRow(row: QueueDbRow): StoredAdmissionRecord {
  const record = recordFromPayload(row.payload);
  if (!record) {
    throw new AdmissionPersistenceError(`canonical work-item ${row.feature_id} carries a corrupt governor record`);
  }
  return { receiptId: row.feature_id, record };
}

function requestDigest(request: NormalizedAdmissionRequest): string {
  return createHash('sha256').update(admissionRequestFingerprint(request)).digest('hex');
}

function nextDecision(
  record: DurableAdmissionRecord,
  state: QueueReceiptState,
  nowMs: number,
  reason: string,
  evidence: Readonly<Record<string, DecisionValue>> = {},
): DurableAdmissionRecord {
  return {
    ...record,
    state,
    updatedAtMs: nowMs,
    decision: {
      generation: record.decision.generation + 1,
      atMs: nowMs,
      reason,
      evidence,
    },
  };
}

function queueReceipt(stored: StoredAdmissionRecord): QueueReceipt {
  return {
    receiptId: stored.receiptId,
    idempotencyKey: stored.record.idempotencyKey,
    state: stored.record.state,
    enqueuedAtMs: stored.record.enqueuedAtMs,
    decisionGeneration: stored.record.decision.generation,
  };
}

function activeState(state: QueueReceiptState): boolean {
  return state === 'queued' || state === 'eligible' || state === 'leased' || state === 'running';
}

function outerState(state: QueueReceiptState): 'open' | 'wip' | 'done' | 'dropped' {
  if (state === 'leased' || state === 'running') return 'wip';
  if (state === 'completed') return 'done';
  if (state === 'cancelled' || state === 'superseded' || state === 'expired') return 'dropped';
  return 'open';
}

/**
 * Durable admission driver. It always accepts valid work into the durable queue;
 * a later feedback controller promotes queue records into leases.
 */
/**
 * Render an unknown thrown value into a short, diagnosable suffix.
 *
 * The admission path wraps every store failure in a single AdmissionPersistenceError. Before this
 * existed the wrapper carried a CONSTANT message and kept the real fault only on `.cause`, which is
 * not serialised to MCP callers — so every distinct DB fault (constraint, type, permission,
 * deadlock, missing relation) surfaced to an agent as the same undiagnosable sentence. Postgres
 * error fields are included when present because the SQLSTATE is usually the whole diagnosis.
 */
function describeAdmissionCause(error: unknown): string {
  if (!(error instanceof Error)) return typeof error === 'string' ? error : JSON.stringify(error);
  const pg = error as Error & {
    code?: unknown;
    detail?: unknown;
    constraint?: unknown;
    table?: unknown;
    schema?: unknown;
  };
  const parts = [error.message];
  for (const [label, value] of [
    ['sqlstate', pg.code],
    ['detail', pg.detail],
    ['constraint', pg.constraint],
    ['relation', pg.schema && pg.table ? `${String(pg.schema)}.${String(pg.table)}` : pg.table],
  ] as const) {
    if (typeof value === 'string' && value.trim()) parts.push(`${label}=${value.trim()}`);
  }
  return parts.join(' | ');
}

/** EI-1211660: default coalescing window for reconcileExpired() — see the field doc below. */
const DEFAULT_RECONCILE_COALESCE_MS = 2_000;

export class WorkItemAdmissionQueueDriver implements AdmissionDriver {
  private readonly namespace: string;
  private readonly now: () => number;
  private readonly leaseIdFactory: () => string;

  /** EI-21863356544930781: backoffs + sleep for the admission-enqueue contention retry.
   *  Injectable for the same reason `now` / `leaseIdFactory` are — so a test can prove
   *  the retry without spending the real ~6s of backoff. */
  private readonly admissionRetryBackoffsMs: readonly number[] | undefined;
  private readonly sleep: ((ms: number) => Promise<void>) | undefined;

  /** EI-1211660: how long a settled reconcile result is shared with concurrent/soon-after
   *  callers before the next call issues a fresh store round-trip. Injectable so a test can
   *  prove coalescing without waiting out the real window. */
  private readonly reconcileCoalesceMs: number;
  /** EI-1211660: the in-flight (or most recently settled, within the window) reconcile
   *  promise, shared across concurrent callers — see reconcileExpired() below. */
  private reconcileInFlight: Promise<QueueReconciliationResult> | undefined;
  /** EI-1211660: `this.now()` at which reconcileInFlight was started/last refreshed. */
  private reconcileStartedAtMs = -Infinity;

  constructor(
    private readonly store: DurableAdmissionQueueStore,
    options: {
      namespace?: string;
      now?: () => number;
      leaseIdFactory?: () => string;
      admissionRetryBackoffsMs?: readonly number[];
      sleep?: (ms: number) => Promise<void>;
      reconcileCoalesceMs?: number;
      onActualDemand?: (input: {
        readonly receiptId: string;
        readonly context: AdmissionContext;
        readonly plannedDemand: Readonly<ResourceDemand>;
        readonly actualDemand: Readonly<ResourceDemand>;
        readonly releasedAtMs: number;
      }) => void | Promise<void>;
    } = {},
  ) {
    this.admissionRetryBackoffsMs = options.admissionRetryBackoffsMs;
    this.sleep = options.sleep;
    this.namespace = options.namespace?.trim() || 'operator';
    this.now = options.now ?? (() => Date.now());
    this.leaseIdFactory = options.leaseIdFactory ?? (() => randomUUID());
    this.reconcileCoalesceMs =
      options.reconcileCoalesceMs !== undefined && options.reconcileCoalesceMs >= 0
        ? options.reconcileCoalesceMs
        : DEFAULT_RECONCILE_COALESCE_MS;
    this.onActualDemand = options.onActualDemand;
  }

  private readonly onActualDemand:
    | ((input: {
        readonly receiptId: string;
        readonly context: AdmissionContext;
        readonly plannedDemand: Readonly<ResourceDemand>;
        readonly actualDemand: Readonly<ResourceDemand>;
        readonly releasedAtMs: number;
      }) => void | Promise<void>)
    | undefined;

  async admit(request: NormalizedAdmissionRequest, context: AdmissionContext): Promise<AdmissionOutcome> {
    const nowMs = this.now();
    const candidate: DurableAdmissionRecord = {
      schemaVersion: RESOURCE_GOVERNOR_QUEUE_SCHEMA_VERSION,
      namespace: this.namespace,
      idempotencyKey: request.idempotencyKey,
      requestFingerprint: requestDigest(request),
      admissionClass: request.admissionClass,
      priority: request.priority,
      deadlineAtMs: request.deadlineAtMs,
      demand: request.demand,
      payloadRef: request.payloadRef,
      coalesceKey: request.coalesceKey,
      metadata: request.metadata,
      context,
      state: 'queued',
      enqueuedAtMs: nowMs,
      updatedAtMs: nowMs,
      decision: { generation: 0, atMs: nowMs, reason: 'persisted', evidence: {} },
    };

    let stored: StoredAdmissionRecord;
    try {
      // EI-21863356544930781: ride out a TRANSIENT pg contention timeout (55P03 lock_timeout /
      // 57014 statement_timeout) instead of losing the whole admission on one failed write.
      //
      // Admission is PRE-execution — this record is what admits the work — so the caller's
      // "run it anyway and record best-effort" shape is not available here: dropping the
      // record would mean running ungoverned. The retry is the correct lever instead, and it
      // is SAFE because enqueue is keyed by idempotencyKey: a lock timeout aborts its
      // transaction (nothing committed), and if an earlier attempt HAD committed, the retry
      // returns that same row and the fingerprint check below still guards a genuine
      // idempotency conflict. Non-contention faults (a real bug, a missing relation, DB down)
      // are NOT retried — they propagate on the first attempt, unchanged.
      //
      // Reuses the shared EI-1720 primitive rather than a second backoff loop; that bug class
      // (a single transient timeout taken as terminal) is the same one, one layer up.
      stored = await acquireWithContentionRetry(() => this.store.enqueue(candidate), {
        ...(this.admissionRetryBackoffsMs ? { backoffsMs: this.admissionRetryBackoffsMs } : {}),
        ...(this.sleep ? { sleep: this.sleep } : {}),
      });
    } catch (error) {
      if (error instanceof AdmissionIdempotencyConflictError || error instanceof AdmissionPersistenceError) throw error;
      // EI-21863356544930781: when contention is what beat us, say that the retries are already
      // spent. The prior message left a caller unable to tell whether retrying was worth it, and
      // an immediate manual retry into a still-contended box is the wrong next move.
      const attempts = (this.admissionRetryBackoffsMs ?? LOCK_CONTENTION_BACKOFFS_MS).length + 1;
      const prefix = isWorkspaceContended(error)
        ? `durable admission record could not be persisted after ${attempts} attempts (transient pg contention did not clear)`
        : 'durable admission record could not be persisted';
      throw new AdmissionPersistenceError(`${prefix}: ${describeAdmissionCause(error)}`, {
        cause: error,
      });
    }
    if (stored.record.requestFingerprint !== candidate.requestFingerprint) {
      throw new AdmissionIdempotencyConflictError(request.idempotencyKey);
    }
    return {
      kind: 'queued',
      context: Object.freeze({ ...stored.record.context, receiptId: stored.receiptId }),
      receipt: queueReceipt(stored),
    };
  }

  /**
   * Reconcile stale protected receipts in this namespace without selecting new work.
   *
   * EI-1211660: every inference-gateway admission calls this before enqueueing (see
   * durable-admission.ts) so a crashed/abandoned request can never keep its idempotency
   * key pinned forever. Under real fleet concurrency that made this a namespace-wide
   * `UPDATE harness_shared.work_items ...` fired once PER CONCURRENT ADMISSION — live
   * pg_stat_activity showed dozens of backends simultaneously contending the identical
   * statement's row tuple locks, starving unrelated work_items writes fleet-wide
   * (scheduler:get_next claims, checkpoints) with 57014 statement_timeout aborts.
   *
   * Reconciliation is idempotent and only meaningfully changes state at the granularity of
   * lease TTLs (seconds to minutes), so concurrent/rapid-succession callers do not need their
   * own store round-trip each — sharing one in-flight (or just-settled) result within a short
   * window is behaviorally equivalent and collapses N concurrent admits to ~1 DB write. A
   * rejected reconcile is never cached, so a real failure surfaces to every caller and the
   * very next call retries fresh.
   */
  reconcileExpired(): Promise<QueueReconciliationResult> {
    const nowMs = this.now();
    if (this.reconcileInFlight && nowMs - this.reconcileStartedAtMs < this.reconcileCoalesceMs) {
      return this.reconcileInFlight;
    }
    this.reconcileStartedAtMs = nowMs;
    const pending = (
      this.store.reconcileExpired?.(this.namespace, nowMs) ??
      Promise.resolve({ requeued: 0, expired: 0, total: 0 })
    ).catch((error: unknown) => {
      // Don't let a failed reconcile poison the coalescing window — the next caller (which
      // may arrive within the same window) should get a fresh attempt, not a cached rejection.
      if (this.reconcileInFlight === pending) {
        this.reconcileInFlight = undefined;
        this.reconcileStartedAtMs = -Infinity;
      }
      throw error;
    });
    this.reconcileInFlight = pending;
    return pending;
  }

  async status(idempotencyKey: string): Promise<AdmissionStatus> {
    const stored = await this.store.find(this.namespace, idempotencyKey);
    if (!stored) return { idempotencyKey, state: 'unknown' };
    return {
      idempotencyKey,
      state: stored.record.state,
      receipt: queueReceipt(stored),
      context: Object.freeze({ ...stored.record.context, receiptId: stored.receiptId }),
      ...(stored.record.resultRef ? { resultRef: stored.record.resultRef } : {}),
    };
  }

  async cancel(idempotencyKey: string, reason?: string): Promise<AdmissionCancellation> {
    const result = await this.store.cancel(this.namespace, idempotencyKey, reason, this.now());
    if (!result) return { idempotencyKey, cancelled: false, state: 'unknown' };
    return { idempotencyKey, cancelled: result.changed, state: result.record.state };
  }

  async leaseNext(input: {
    owner: string;
    ttlMs: number;
    selection?: QueueLeaseSelection;
  }): Promise<AdmissionQueueLeaseClaim | null> {
    const owner = input.owner.trim();
    if (!owner) throw new Error('queue lease owner must be non-empty');
    if (!Number.isFinite(input.ttlMs) || input.ttlMs <= 0) throw new Error('queue lease ttlMs must be positive');
    const result = await this.store.leaseNext(
      this.namespace,
      owner,
      this.leaseIdFactory(),
      input.ttlMs,
      this.now(),
      input.selection,
    );
    if (!result?.record.lease) return null;
    const lease = result.record.lease;
    return {
      receiptId: result.receiptId,
      record: result.record,
      context: {
        ...result.record.context,
        receiptId: result.receiptId,
        decisionGeneration: result.record.decision.generation,
        leaseId: lease.leaseId,
      },
      lease: {
        leaseId: lease.leaseId,
        owner: lease.owner,
        generation: lease.generation,
        admissionClass: result.record.admissionClass,
        expiresAtMs: lease.expiresAtMs,
      },
    };
  }

  async leaseReceipt(input: {
    receiptId: string;
    owner: string;
    ttlMs: number;
  }): Promise<AdmissionQueueLeaseClaim | null> {
    const owner = input.owner.trim();
    if (!owner) throw new Error('queue lease owner must be non-empty');
    if (!Number.isFinite(input.ttlMs) || input.ttlMs <= 0) throw new Error('queue lease ttlMs must be positive');
    const leaseId = this.leaseIdFactory();
    const result = await this.store.leaseReceipt(
      this.namespace,
      input.receiptId,
      owner,
      leaseId,
      input.ttlMs,
      this.now(),
    );
    if (!result?.changed || !result.record.lease) return null;
    const lease = result.record.lease;
    return {
      receiptId: result.receiptId,
      record: result.record,
      context: {
        ...result.record.context,
        receiptId: result.receiptId,
        decisionGeneration: result.record.decision.generation,
        leaseId: lease.leaseId,
      },
      lease: {
        leaseId: lease.leaseId,
        owner: lease.owner,
        generation: lease.generation,
        admissionClass: result.record.admissionClass,
        expiresAtMs: lease.expiresAtMs,
      },
    };
  }

  markRunning(receiptId: string, leaseId: string): Promise<QueueMutationResult | null> {
    return this.store.markRunning(receiptId, leaseId, this.now());
  }

  complete(receiptId: string, leaseId: string, resultRef?: string): Promise<QueueMutationResult | null> {
    return this.store.complete(receiptId, leaseId, resultRef, this.now());
  }

  releaseLease(receiptId: string, leaseId: string): Promise<QueueMutationResult | null> {
    return this.store.releaseLease(receiptId, leaseId, this.now());
  }

  supersede(receiptId: string, replacementReceiptId: string): Promise<QueueMutationResult | null> {
    return this.store.supersede(receiptId, replacementReceiptId, this.now());
  }

  async release(context: AdmissionContext, actualDemand?: ResourceDemand): Promise<AdmissionRelease> {
    if (!context.leaseId) return { requestId: context.requestId, released: false };
    const stored = await this.store.find(this.namespace, context.idempotencyKey);
    if (!stored) return { requestId: context.requestId, released: false };
    if (context.receiptId && context.receiptId !== stored.receiptId) {
      return { requestId: context.requestId, released: false };
    }
    const releasedAtMs = this.now();
    const released = await this.store.releaseClaim(stored.receiptId, context.leaseId, actualDemand, releasedAtMs);
    if (released?.changed && actualDemand && this.onActualDemand) {
      await this.onActualDemand({
        receiptId: stored.receiptId,
        context,
        plannedDemand: stored.record.demand,
        actualDemand,
        releasedAtMs,
      });
    }
    return { requestId: context.requestId, released: released?.changed === true };
  }
}

export interface PgWorkItemAdmissionQueueStoreOptions {
  readonly sql?: SqlClient;
  readonly workspaceId?: string;
}

/** PostgreSQL implementation backed solely by the canonical work_items table. */
export class PgWorkItemAdmissionQueueStore implements DurableAdmissionQueueStore {
  private readonly sql: SqlClient;
  private readonly workspaceId: string;

  constructor(options: PgWorkItemAdmissionQueueStoreOptions = {}) {
    this.sql = options.sql ?? getOrgPg().sql;
    this.workspaceId = options.workspaceId?.trim() || activeWorkspaceId();
  }

  private async transaction<T>(fn: (tx: SqlClient) => Promise<T>): Promise<T> {
    // Resource-governor transitions update the shared work_items table. Keep every
    // mutation atomic, but also bound both lock waits and statement execution so a
    // contended governor write cannot strand scheduler/get_next behind an unbounded
    // postgres-js transaction. Passing the injected client preserves hermetic tests
    // and non-default backends; production callers still use getOrgPg() through this.sql.
    return boundedOrgTxn(fn, { client: this.sql });
  }

  private async lockKeys(tx: SqlClient, keys: readonly string[]): Promise<void> {
    for (const key of [...new Set(keys)].sort()) {
      await tx`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`;
    }
  }

  private async findRow(
    sql: SqlClient,
    namespace: string,
    idempotencyKey: string,
    lock = false,
  ): Promise<QueueDbRow | null> {
    const rows = await sql<QueueDbRow[]>`
      SELECT feature_id, payload, status, taken_by, created_ts
        FROM harness_shared.work_items
       WHERE workspace_id = ${this.workspaceId}
         AND payload->'resource_governor'->>'schemaVersion' = ${String(RESOURCE_GOVERNOR_QUEUE_SCHEMA_VERSION)}
         AND payload->'resource_governor'->>'namespace' = ${namespace}
         AND payload->'resource_governor'->>'idempotencyKey' = ${idempotencyKey}
       ${lock ? sql`FOR UPDATE` : sql``}
       LIMIT 1`;
    return rows[0] ?? null;
  }

  private async findReceiptRow(sql: SqlClient, receiptId: string, lock = false): Promise<QueueDbRow | null> {
    const rows = await sql<QueueDbRow[]>`
      SELECT feature_id, payload, status, taken_by, created_ts
        FROM harness_shared.work_items
       WHERE workspace_id = ${this.workspaceId}
         AND feature_id = ${receiptId}
         AND payload->'resource_governor'->>'schemaVersion' = ${String(RESOURCE_GOVERNOR_QUEUE_SCHEMA_VERSION)}
       ${lock ? sql`FOR UPDATE` : sql``}
       LIMIT 1`;
    return rows[0] ?? null;
  }

  private async reconcileExpiredRows(
    tx: SqlClient,
    namespace: string | null,
    nowMs: number,
  ): Promise<QueueReconciliationResult> {
    const namespacePredicate =
      namespace === null ? tx`` : tx`AND payload->'resource_governor'->>'namespace' = ${namespace}`;
    const requeued = await tx<QueueDbRow[]>`
      UPDATE harness_shared.work_items
         SET payload = jsonb_set(
               payload,
               ARRAY['resource_governor']::text[],
               ((payload->'resource_governor') - 'lease') || jsonb_build_object(
                 'state', 'queued',
                 'updatedAtMs', ${nowMs}::bigint,
                 'decision', jsonb_build_object(
                   'generation', COALESCE((payload->'resource_governor'->'decision'->>'generation')::bigint, 0) + 1,
                   'atMs', ${nowMs}::bigint,
                   'reason', 'lease-expired',
                   'evidence', '{}'::jsonb
                 )
               ),
               true
             ),
             status = 'open', taken_by = NULL, taken_at = NULL, updated_ts = ${nowMs}
       WHERE workspace_id = ${this.workspaceId}
         AND payload->'resource_governor'->>'schemaVersion' = ${String(RESOURCE_GOVERNOR_QUEUE_SCHEMA_VERSION)}
         ${namespacePredicate}
         AND payload->'resource_governor'->>'state' IN ('leased', 'running')
         AND jsonb_typeof(payload->'resource_governor'->'lease'->'expiresAtMs') = 'number'
         AND (payload->'resource_governor'->'lease'->>'expiresAtMs')::double precision <= ${nowMs}
       RETURNING feature_id, payload, status, taken_by, created_ts`;

    const expired = await tx<QueueDbRow[]>`
      UPDATE harness_shared.work_items
         SET payload = jsonb_set(
               payload,
               ARRAY['resource_governor']::text[],
               ((payload->'resource_governor') - 'lease') || jsonb_build_object(
                 'state', 'expired',
                 'updatedAtMs', ${nowMs}::bigint,
                 'decision', jsonb_build_object(
                   'generation', COALESCE((payload->'resource_governor'->'decision'->>'generation')::bigint, 0) + 1,
                   'atMs', ${nowMs}::bigint,
                   'reason', 'deadline-expired',
                   'evidence', '{}'::jsonb
                 )
               ),
               true
             ),
             status = 'dropped', taken_by = NULL, taken_at = NULL, updated_ts = ${nowMs}
       WHERE workspace_id = ${this.workspaceId}
         AND payload->'resource_governor'->>'schemaVersion' = ${String(RESOURCE_GOVERNOR_QUEUE_SCHEMA_VERSION)}
         ${namespacePredicate}
         AND payload->'resource_governor'->>'state' IN ('queued', 'eligible')
         AND jsonb_typeof(payload->'resource_governor'->'deadlineAtMs') = 'number'
         AND (payload->'resource_governor'->>'deadlineAtMs')::double precision <= ${nowMs}
       RETURNING feature_id, payload, status, taken_by, created_ts`;

    return { requeued: requeued.length, expired: expired.length, total: requeued.length + expired.length };
  }

  async reconcileExpired(namespace: string, nowMs: number): Promise<QueueReconciliationResult> {
    return this.transaction((tx) => this.reconcileExpiredRows(tx, namespace, nowMs));
  }

  /** Reconcile every governor namespace for the periodic maintenance workflow. */
  async reconcileExpiredAll(nowMs = Date.now()): Promise<QueueReconciliationResult> {
    return this.transaction((tx) => this.reconcileExpiredRows(tx, null, nowMs));
  }

  private async writeRecord(
    sql: SqlClient,
    receiptId: string,
    record: DurableAdmissionRecord,
    assignee: string | null,
  ): Promise<StoredAdmissionRecord> {
    const rows = await sql<QueueDbRow[]>`
      UPDATE harness_shared.work_items
         SET payload = jsonb_set(
               COALESCE(payload, '{}'::jsonb),
               ARRAY['resource_governor']::text[],
               ${JSON.stringify(record)}::text::jsonb,
               true
             ),
             status = ${outerState(record.state)},
             taken_by = ${assignee},
             taken_at = CASE WHEN ${assignee}::text IS NULL THEN NULL ELSE now() END,
             updated_ts = ${record.updatedAtMs}
       WHERE workspace_id = ${this.workspaceId}
         AND feature_id = ${receiptId}
       RETURNING feature_id, payload, status, taken_by, created_ts`;
    if (!rows[0]) throw new AdmissionPersistenceError(`canonical work-item ${receiptId} disappeared during transition`);
    return storedFromRow(rows[0]);
  }

  async enqueue(record: DurableAdmissionRecord): Promise<StoredAdmissionRecord & { readonly created: boolean }> {
    return this.transaction(async (tx) => {
      const identityLock = `resource-governor:${this.workspaceId}:${record.namespace}:id:${record.idempotencyKey}`;
      const coalesceLock = record.coalesceKey
        ? `resource-governor:${this.workspaceId}:${record.namespace}:coalesce:${record.coalesceKey}`
        : identityLock;
      await this.lockKeys(tx, [identityLock, coalesceLock]);

      const existing = await this.findRow(tx, record.namespace, record.idempotencyKey, true);
      if (existing) return { ...storedFromRow(existing), created: false };

      if (record.coalesceKey) {
        const priorRows = await tx<QueueDbRow[]>`
          SELECT feature_id, payload, status, taken_by, created_ts
            FROM harness_shared.work_items
           WHERE workspace_id = ${this.workspaceId}
             AND payload->'resource_governor'->>'schemaVersion' = ${String(RESOURCE_GOVERNOR_QUEUE_SCHEMA_VERSION)}
             AND payload->'resource_governor'->>'namespace' = ${record.namespace}
             AND payload->'resource_governor'->>'coalesceKey' = ${record.coalesceKey}
             AND payload->'resource_governor'->>'state' IN ('queued', 'eligible', 'leased', 'running')
           FOR UPDATE`;
        for (const row of priorRows) {
          const prior = storedFromRow(row);
          const superseded = {
            ...nextDecision(prior.record, 'superseded', record.enqueuedAtMs, 'coalesced-by-newer-request', {
              idempotencyKey: record.idempotencyKey,
            }),
            lease: undefined,
          };
          await this.writeRecord(tx, prior.receiptId, superseded, null);
        }
      }

      const ids = await tx<{ id: string }[]>`SELECT harness_shared.next_work_item_id() AS id`;
      const receiptId = ids[0]?.id;
      if (!receiptId) throw new AdmissionPersistenceError('canonical work-item id allocator returned no identity');
      const payload = {
        _ei: {
          scope: 'operator',
          severity: 'minor',
          source: 'resource-governor',
          created_by: RESOURCE_GOVERNOR_PARK_OWNER,
          // MUST be one of work_items_signal_origin_chk's vocabulary
          // (NULL|organic|drill|replay|shadow — migration 403). 'local' belongs to
          // the work_items.origin COLUMN, a DIFFERENT vocabulary; using it here made
          // every enqueue INSERT raise 23514, which failed every spawner-sidecar
          // admission and froze git-sync fleet-wide (WI-144314).
          signal_origin: RESOURCE_GOVERNOR_SIGNAL_ORIGIN,
        },
        _claimHold: true,
        claim_hold_by: RESOURCE_GOVERNOR_PARK_OWNER,
        claim_hold_reason: 'durable resource-governor queue; only governor lease transitions may select',
        claim_hold_at: new Date(record.enqueuedAtMs).toISOString(),
        [RESOURCE_GOVERNOR_PAYLOAD_KEY]: record,
      };
      const rows = await tx<QueueDbRow[]>`
        INSERT INTO harness_shared.work_items (
          workspace_id, harness_slug, feature_id, title, summary, status, attempts,
          item_kind, payload, taken_by, taken_at, origin, ts, created_ts, updated_ts,
          needs_design, needs_human_review
        ) VALUES (
          ${this.workspaceId}, '', ${receiptId}, ${`Queued ${record.admissionClass} admission`},
          ${`Durable resource-governor receipt for ${record.idempotencyKey}`}, 'open', 0,
          'task', ${JSON.stringify(payload)}::text::jsonb, NULL, NULL, 'local',
          ${record.enqueuedAtMs}, ${record.enqueuedAtMs}, ${record.updatedAtMs}, false, false
        )
        ON CONFLICT DO NOTHING
        RETURNING feature_id, payload, status, taken_by, created_ts`;
      if (rows[0]) return { ...storedFromRow(rows[0]), created: true };

      const raced = await this.findRow(tx, record.namespace, record.idempotencyKey, true);
      if (!raced) {
        throw new AdmissionPersistenceError('canonical work-item insert returned no row and no durable receipt exists');
      }
      return { ...storedFromRow(raced), created: false };
    });
  }

  async find(namespace: string, idempotencyKey: string): Promise<StoredAdmissionRecord | null> {
    const row = await this.findRow(this.sql, namespace, idempotencyKey);
    return row ? storedFromRow(row) : null;
  }

  async cancel(
    namespace: string,
    idempotencyKey: string,
    reason: string | undefined,
    nowMs: number,
  ): Promise<QueueMutationResult | null> {
    return this.transaction(async (tx) => {
      const row = await this.findRow(tx, namespace, idempotencyKey, true);
      if (!row) return null;
      const stored = storedFromRow(row);
      if (!activeState(stored.record.state)) return { ...stored, changed: false };
      const next = {
        ...nextDecision(stored.record, 'cancelled', nowMs, 'cancelled', {
          ...(reason ? { reason } : {}),
        }),
        lease: undefined,
        ...(reason ? { cancellationReason: reason } : {}),
      };
      return { ...(await this.writeRecord(tx, stored.receiptId, next, null)), changed: true };
    });
  }

  async leaseNext(
    namespace: string,
    owner: string,
    leaseId: string,
    ttlMs: number,
    nowMs: number,
    selection?: QueueLeaseSelection,
  ): Promise<QueueMutationResult | null> {
    return this.transaction(async (tx) => {
      await this.reconcileExpiredRows(tx, namespace, nowMs);

      let rows: QueueDbRow[];
      if (!selection) {
        rows = await tx<QueueDbRow[]>`
          SELECT feature_id, payload, status, taken_by, created_ts
            FROM harness_shared.work_items
           WHERE workspace_id = ${this.workspaceId}
             AND payload->'resource_governor'->>'schemaVersion' = ${String(RESOURCE_GOVERNOR_QUEUE_SCHEMA_VERSION)}
             AND payload->'resource_governor'->>'namespace' = ${namespace}
             AND payload->'resource_governor'->>'state' IN ('queued', 'eligible')
             AND (taken_by IS NULL OR btrim(taken_by) = '')
           ORDER BY CASE
                      WHEN jsonb_typeof(payload->'resource_governor'->'priority') = 'number'
                      THEN (payload->'resource_governor'->>'priority')::double precision
                      ELSE 0
                    END DESC,
                    created_ts ASC,
                    feature_id ASC
           FOR UPDATE SKIP LOCKED
           LIMIT 1`;
      } else {
        if (selection.classes.length === 0) return null;
        const policies = JSON.stringify(
          selection.classes.map((item) => ({
            admission_class: item.admissionClass,
            virtual_time: Number.isFinite(item.virtualTime) ? Math.max(0, item.virtualTime) : 0,
            weight: Number.isFinite(item.weight) && item.weight > 0 ? item.weight : 1,
            constrained_resources: item.constrainedResources,
          })),
        );
        const releasedResources = JSON.stringify(selection.releasedResources);
        const agingIntervalMs = Math.max(1, Math.floor(selection.agingIntervalMs));
        const deadlineHorizonMs = Math.max(1, Math.floor(selection.deadlineHorizonMs));
        const resourceAffinityBonus = Math.max(0, selection.resourceAffinityBonus);
        const constrainedResourcePenalty = Math.max(0, selection.constrainedResourcePenalty);
        rows = await tx<QueueDbRow[]>`
          SELECT item.feature_id, item.payload, item.status, item.taken_by, item.created_ts
            FROM harness_shared.work_items AS item
            CROSS JOIN LATERAL (
              SELECT item.payload->'resource_governor' AS record
            ) AS governor
            JOIN LATERAL (
              SELECT policy.*
                FROM jsonb_to_recordset(${policies}::text::jsonb) AS policy(
                  admission_class text,
                  virtual_time double precision,
                  weight double precision,
                  constrained_resources jsonb
                )
               WHERE policy.admission_class = governor.record->>'admissionClass'
               LIMIT 1
            ) AS class_policy ON true
            CROSS JOIN LATERAL (
              SELECT
                (
                  SELECT count(*)
                    FROM jsonb_array_elements_text(COALESCE(class_policy.constrained_resources, '[]'::jsonb)) AS resource(value)
                   WHERE CASE resource.value
                           WHEN 'cpu' THEN COALESCE((governor.record->'demand'->>'cpuWeight')::double precision, 0)
                           WHEN 'memory' THEN COALESCE((governor.record->'demand'->>'memoryBytes')::double precision, 0)
                           WHEN 'database' THEN COALESCE((governor.record->'demand'->>'databaseConnections')::double precision, 0)
                           WHEN 'provider' THEN COALESCE((governor.record->'demand'->>'providerRequests')::double precision, 0)
                           ELSE COALESCE(
                             (governor.record->'demand'->'custom'->>('resource:' || resource.value))::double precision,
                             (governor.record->'demand'->'custom'->>resource.value)::double precision,
                             0
                           )
                         END > 0
                      OR governor.record->'metadata'->>'resourceAffinity' = resource.value
                ) AS constrained_count,
                (
                  SELECT count(*)
                    FROM jsonb_array_elements_text(${releasedResources}::text::jsonb) AS resource(value)
                   WHERE CASE resource.value
                           WHEN 'cpu' THEN COALESCE((governor.record->'demand'->>'cpuWeight')::double precision, 0)
                           WHEN 'memory' THEN COALESCE((governor.record->'demand'->>'memoryBytes')::double precision, 0)
                           WHEN 'database' THEN COALESCE((governor.record->'demand'->>'databaseConnections')::double precision, 0)
                           WHEN 'provider' THEN COALESCE((governor.record->'demand'->>'providerRequests')::double precision, 0)
                           ELSE COALESCE(
                             (governor.record->'demand'->'custom'->>('resource:' || resource.value))::double precision,
                             (governor.record->'demand'->'custom'->>resource.value)::double precision,
                             0
                           )
                         END > 0
                      OR governor.record->'metadata'->>'resourceAffinity' = resource.value
                ) AS affinity_count
            ) AS resource_score
           WHERE item.workspace_id = ${this.workspaceId}
             AND governor.record->>'schemaVersion' = ${String(RESOURCE_GOVERNOR_QUEUE_SCHEMA_VERSION)}
             AND governor.record->>'namespace' = ${namespace}
             AND governor.record->>'state' IN ('queued', 'eligible')
             AND (item.taken_by IS NULL OR btrim(item.taken_by) = '')
           ORDER BY class_policy.virtual_time ASC,
                    (
                      CASE
                        WHEN jsonb_typeof(governor.record->'priority') = 'number'
                        THEN (governor.record->>'priority')::double precision
                        ELSE 0
                      END
                      + floor(
                          GREATEST(0, ${nowMs} - (governor.record->>'enqueuedAtMs')::double precision)
                          / ${agingIntervalMs}
                        )
                      + CASE
                          WHEN jsonb_typeof(governor.record->'deadlineAtMs') = 'number'
                          THEN GREATEST(
                            0,
                            ${deadlineHorizonMs}
                              - GREATEST(0, (governor.record->>'deadlineAtMs')::double precision - ${nowMs})
                          ) / ${agingIntervalMs}
                          ELSE 0
                        END
                      + resource_score.affinity_count * ${resourceAffinityBonus}
                      - resource_score.constrained_count * ${constrainedResourcePenalty}
                    ) DESC,
                    (governor.record->>'enqueuedAtMs')::double precision ASC,
                    item.feature_id ASC
           FOR UPDATE OF item SKIP LOCKED
           LIMIT 1`;
      }
      if (!rows[0]) return null;
      const stored = storedFromRow(rows[0]);
      const generation = stored.record.decision.generation + 1;
      const next = {
        ...nextDecision(stored.record, 'leased', nowMs, 'leased', { owner }),
        lease: { leaseId, owner, generation, expiresAtMs: nowMs + ttlMs },
      };
      return { ...(await this.writeRecord(tx, stored.receiptId, next, owner)), changed: true };
    });
  }

  async leaseReceipt(
    namespace: string,
    receiptId: string,
    owner: string,
    leaseId: string,
    ttlMs: number,
    nowMs: number,
  ): Promise<QueueMutationResult | null> {
    return this.transaction(async (tx) => {
      await this.reconcileExpiredRows(tx, namespace, nowMs);
      const row = await this.findReceiptRow(tx, receiptId, true);
      if (!row) return null;
      const stored = storedFromRow(row);
      if (stored.record.namespace !== namespace) return { ...stored, changed: false };
      if (stored.record.state !== 'queued' && stored.record.state !== 'eligible') {
        return { ...stored, changed: false };
      }
      if (row.taken_by?.trim()) return { ...stored, changed: false };
      if (stored.record.deadlineAtMs !== null && stored.record.deadlineAtMs <= nowMs) {
        const expired = {
          ...nextDecision(stored.record, 'expired', nowMs, 'deadline-expired'),
          lease: undefined,
        };
        return { ...(await this.writeRecord(tx, receiptId, expired, null)), changed: false };
      }
      const generation = stored.record.decision.generation + 1;
      const next = {
        ...nextDecision(stored.record, 'leased', nowMs, 'observe-only-targeted-lease', { owner }),
        lease: { leaseId, owner, generation, expiresAtMs: nowMs + ttlMs },
      };
      return { ...(await this.writeRecord(tx, receiptId, next, owner)), changed: true };
    });
  }

  private async leaseTransition(
    receiptId: string,
    leaseId: string,
    nowMs: number,
    mutate: (record: DurableAdmissionRecord) => DurableAdmissionRecord,
    assignee: (record: DurableAdmissionRecord) => string | null,
  ): Promise<QueueMutationResult | null> {
    return this.transaction(async (tx) => {
      const row = await this.findReceiptRow(tx, receiptId, true);
      if (!row) return null;
      const stored = storedFromRow(row);
      if (!stored.record.lease || stored.record.lease.leaseId !== leaseId) return { ...stored, changed: false };
      const next = mutate(stored.record);
      return { ...(await this.writeRecord(tx, receiptId, next, assignee(next))), changed: true };
    });
  }

  markRunning(receiptId: string, leaseId: string, nowMs: number): Promise<QueueMutationResult | null> {
    return this.leaseTransition(
      receiptId,
      leaseId,
      nowMs,
      (record) =>
        record.state === 'leased'
          ? nextDecision(record, 'running', nowMs, 'execution-started', { owner: record.lease?.owner ?? null })
          : record,
      (record) => record.lease?.owner ?? null,
    ).then((result) =>
      result && result.changed && result.record.state !== 'running' ? { ...result, changed: false } : result,
    );
  }

  complete(
    receiptId: string,
    leaseId: string,
    resultRef: string | undefined,
    nowMs: number,
  ): Promise<QueueMutationResult | null> {
    return this.leaseTransition(
      receiptId,
      leaseId,
      nowMs,
      (record) => {
        if (record.state !== 'leased' && record.state !== 'running') return record;
        return {
          ...nextDecision(record, 'completed', nowMs, 'execution-completed', {
            ...(resultRef ? { resultRef } : {}),
          }),
          lease: undefined,
          ...(resultRef ? { resultRef } : {}),
        };
      },
      () => null,
    ).then((result) =>
      result && result.changed && result.record.state !== 'completed' ? { ...result, changed: false } : result,
    );
  }

  releaseLease(receiptId: string, leaseId: string, nowMs: number): Promise<QueueMutationResult | null> {
    return this.leaseTransition(
      receiptId,
      leaseId,
      nowMs,
      (record) => {
        if (record.state !== 'leased' && record.state !== 'running') return record;
        return { ...nextDecision(record, 'queued', nowMs, 'lease-released'), lease: undefined };
      },
      () => null,
    ).then((result) =>
      result && result.changed && result.record.state !== 'queued' ? { ...result, changed: false } : result,
    );
  }

  releaseClaim(
    receiptId: string,
    leaseId: string,
    actualDemand: Readonly<ResourceDemand> | undefined,
    nowMs: number,
  ): Promise<QueueMutationResult | null> {
    return this.leaseTransition(
      receiptId,
      leaseId,
      nowMs,
      (record) => {
        if (record.state !== 'leased' && record.state !== 'running') return record;
        return {
          ...nextDecision(record, 'completed', nowMs, 'resources-released', {
            actualDemandReported: actualDemand !== undefined,
          }),
          lease: undefined,
          ...(actualDemand ? { actualDemand } : {}),
          releasedAtMs: nowMs,
        };
      },
      () => null,
    ).then((result) =>
      result && result.changed && result.record.state !== 'completed' ? { ...result, changed: false } : result,
    );
  }

  async supersede(receiptId: string, replacementReceiptId: string, nowMs: number): Promise<QueueMutationResult | null> {
    return this.transaction(async (tx) => {
      const row = await this.findReceiptRow(tx, receiptId, true);
      if (!row) return null;
      const stored = storedFromRow(row);
      if (!activeState(stored.record.state)) return { ...stored, changed: false };
      const next = {
        ...nextDecision(stored.record, 'superseded', nowMs, 'superseded', { replacementReceiptId }),
        lease: undefined,
        supersededByReceiptId: replacementReceiptId,
      };
      return { ...(await this.writeRecord(tx, receiptId, next, null)), changed: true };
    });
  }
}
