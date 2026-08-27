import { randomUUID, createHash } from 'node:crypto';
import { getOrgPg } from '@papercusp/db-org';
import { activeWorkspaceId } from '../workspace-registry';
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

export const RESOURCE_GOVERNOR_PAYLOAD_KEY = 'resource_governor';
export const RESOURCE_GOVERNOR_QUEUE_SCHEMA_VERSION = 1 as const;
export const RESOURCE_GOVERNOR_PARK_OWNER = 'system:resource-governor';

type SqlClient = ReturnType<typeof getOrgPg>['sql'];
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
}

export interface StoredAdmissionRecord {
  readonly receiptId: string;
  readonly record: DurableAdmissionRecord;
}

export interface QueueMutationResult extends StoredAdmissionRecord {
  readonly changed: boolean;
}

export interface AdmissionQueueLeaseClaim extends StoredAdmissionRecord {
  readonly context: AdmissionContext;
  readonly lease: AdmissionLease & { readonly owner: string };
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
  ): Promise<QueueMutationResult | null>;
  markRunning(receiptId: string, leaseId: string, nowMs: number): Promise<QueueMutationResult | null>;
  complete(
    receiptId: string,
    leaseId: string,
    resultRef: string | undefined,
    nowMs: number,
  ): Promise<QueueMutationResult | null>;
  releaseLease(receiptId: string, leaseId: string, nowMs: number): Promise<QueueMutationResult | null>;
  supersede(receiptId: string, replacementReceiptId: string, nowMs: number): Promise<QueueMutationResult | null>;
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
export class WorkItemAdmissionQueueDriver implements AdmissionDriver {
  private readonly namespace: string;
  private readonly now: () => number;
  private readonly leaseIdFactory: () => string;

  constructor(
    private readonly store: DurableAdmissionQueueStore,
    options: { namespace?: string; now?: () => number; leaseIdFactory?: () => string } = {},
  ) {
    this.namespace = options.namespace?.trim() || 'operator';
    this.now = options.now ?? (() => Date.now());
    this.leaseIdFactory = options.leaseIdFactory ?? (() => randomUUID());
  }

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
      stored = await this.store.enqueue(candidate);
    } catch (error) {
      if (error instanceof AdmissionIdempotencyConflictError || error instanceof AdmissionPersistenceError) throw error;
      throw new AdmissionPersistenceError('durable admission record could not be persisted', { cause: error });
    }
    if (stored.record.requestFingerprint !== candidate.requestFingerprint) {
      throw new AdmissionIdempotencyConflictError(request.idempotencyKey);
    }
    return { kind: 'queued', context: stored.record.context, receipt: queueReceipt(stored) };
  }

  async status(idempotencyKey: string): Promise<AdmissionStatus> {
    const stored = await this.store.find(this.namespace, idempotencyKey);
    if (!stored) return { idempotencyKey, state: 'unknown' };
    return {
      idempotencyKey,
      state: stored.record.state,
      receipt: queueReceipt(stored),
      ...(stored.record.resultRef ? { resultRef: stored.record.resultRef } : {}),
    };
  }

  async cancel(idempotencyKey: string, reason?: string): Promise<AdmissionCancellation> {
    const result = await this.store.cancel(this.namespace, idempotencyKey, reason, this.now());
    if (!result) return { idempotencyKey, cancelled: false, state: 'unknown' };
    return { idempotencyKey, cancelled: result.changed, state: result.record.state };
  }

  async leaseNext(input: { owner: string; ttlMs: number }): Promise<AdmissionQueueLeaseClaim | null> {
    const owner = input.owner.trim();
    if (!owner) throw new Error('queue lease owner must be non-empty');
    if (!Number.isFinite(input.ttlMs) || input.ttlMs <= 0) throw new Error('queue lease ttlMs must be positive');
    const result = await this.store.leaseNext(this.namespace, owner, this.leaseIdFactory(), input.ttlMs, this.now());
    if (!result?.record.lease) return null;
    const lease = result.record.lease;
    return {
      receiptId: result.receiptId,
      record: result.record,
      context: {
        ...result.record.context,
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

  async release(context: AdmissionContext): Promise<AdmissionRelease> {
    if (!context.leaseId) return { requestId: context.requestId, released: false };
    const stored = await this.store.find(this.namespace, context.idempotencyKey);
    if (!stored) return { requestId: context.requestId, released: false };
    const released = await this.store.releaseLease(stored.receiptId, context.leaseId, this.now());
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
    return (await this.sql.begin(async (tx) => fn(tx as unknown as SqlClient))) as T;
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
          signal_origin: 'local',
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
  ): Promise<QueueMutationResult | null> {
    return this.transaction(async (tx) => {
      await tx`
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
           AND payload->'resource_governor'->>'namespace' = ${namespace}
           AND payload->'resource_governor'->>'state' IN ('leased', 'running')
           AND (payload->'resource_governor'->'lease'->>'expiresAtMs')::double precision <= ${nowMs}`;

      await tx`
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
           AND payload->'resource_governor'->>'namespace' = ${namespace}
           AND payload->'resource_governor'->>'state' IN ('queued', 'eligible')
           AND jsonb_typeof(payload->'resource_governor'->'deadlineAtMs') = 'number'
           AND (payload->'resource_governor'->>'deadlineAtMs')::double precision <= ${nowMs}`;

      const rows = await tx<QueueDbRow[]>`
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
