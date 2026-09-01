/**
 * PostgreSQL persistence for the existing resource-governor admission queue.
 *
 * Unlike the bounded legacy adapter, this store has no work-item dependency:
 * every new receipt is an RG-UUID row in resource_governor_admissions.
 */
import { getOrgPg } from '@papercusp/db-org';
import { activeWorkspaceId } from '../workspace-registry';
import { boundedOrgTxn } from '../pg-bounded-txn';
import { AdmissionPersistenceError, type QueueReceiptState } from './admission';
import {
  GOVERNOR_RECEIPT_ABANDON_MS,
  RESOURCE_GOVERNOR_QUEUE_SCHEMA_VERSION,
  type DurableAdmissionQueueStore,
  type DurableAdmissionRecord,
  type QueueLeaseSelection,
  type QueueMutationResult,
  type QueueReconciliationResult,
  type SqlClient,
  type StoredAdmissionRecord,
} from './queue';

const RECONCILE_LOCK_PREFIX = 'resource-governor-reconcile:';
const RECONCILE_BATCH_SIZE = 25;
export const RESOURCE_GOVERNOR_LEDGER_CUTOVER_SETTING_PREFIX = 'resource_governor_admission_ledger_cutover:';

type DecisionValue = string | number | boolean | null;

interface LedgerDbRow {
  receipt_id: string;
  record: unknown;
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

function durableRecord(value: unknown, receiptId: string): DurableAdmissionRecord {
  const raw = jsonObject(value);
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
    throw new AdmissionPersistenceError(`resource-governor admission ${receiptId} carries a corrupt ledger record`);
  }
  return raw as unknown as DurableAdmissionRecord;
}

function storedFromRow(row: LedgerDbRow): StoredAdmissionRecord {
  return { receiptId: row.receipt_id, record: durableRecord(row.record, row.receipt_id) };
}

function activeState(state: QueueReceiptState): boolean {
  return state === 'queued' || state === 'eligible' || state === 'leased' || state === 'running';
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

export interface PgAdmissionLedgerQueueStoreOptions {
  readonly sql?: SqlClient;
  readonly workspaceId?: string;
  readonly abandonAfterMs?: number;
}

/** Ledger-only implementation. Legacy WI receipt compatibility is composed outside this class. */
export class PgAdmissionLedgerQueueStore implements DurableAdmissionQueueStore {
  private readonly sql: SqlClient;
  private readonly workspaceId: string;
  private readonly abandonAfterMs: number;

  constructor(options: PgAdmissionLedgerQueueStoreOptions = {}) {
    this.sql = options.sql ?? getOrgPg().sql;
    this.workspaceId = options.workspaceId?.trim() || activeWorkspaceId();
    this.abandonAfterMs =
      typeof options.abandonAfterMs === 'number' &&
      Number.isFinite(options.abandonAfterMs) &&
      options.abandonAfterMs > 0
        ? options.abandonAfterMs
        : GOVERNOR_RECEIPT_ABANDON_MS;
  }

  private transaction<T>(fn: (tx: SqlClient) => Promise<T>): Promise<T> {
    return boundedOrgTxn(fn, { client: this.sql });
  }

  private async lockKeys(tx: SqlClient, keys: readonly string[]): Promise<void> {
    for (const key of [...new Set(keys)].sort()) {
      await tx`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`;
    }
  }

  private async latchCutover(tx: SqlClient): Promise<void> {
    const key = `${RESOURCE_GOVERNOR_LEDGER_CUTOVER_SETTING_PREFIX}${this.workspaceId}`;
    await tx`
      INSERT INTO harness_shared.operator_settings (
        key, value, description, updated_at, workspace_id
      ) VALUES (
        ${key},
        '1',
        'Resource-governor admission persistence is ledger-only; reject new legacy work-item receipts.',
        ${Date.now()},
        ${this.workspaceId}
      )
      ON CONFLICT (key) DO NOTHING`;
    const rows = await tx<{ value: string }[]>`
      SELECT value
        FROM harness_shared.operator_settings
       WHERE key = ${key}
       LIMIT 1`;
    if (rows[0]?.value !== '1') {
      throw new AdmissionPersistenceError(`resource-governor ledger cutover latch ${key} is missing or not enabled`);
    }
  }

  private async findRow(
    sql: SqlClient,
    namespace: string,
    idempotencyKey: string,
    lock = false,
  ): Promise<LedgerDbRow | null> {
    const rows = await sql<LedgerDbRow[]>`
      SELECT receipt_id, record
        FROM harness_shared.resource_governor_admissions
       WHERE workspace_id = ${this.workspaceId}
         AND namespace = ${namespace}
         AND idempotency_key = ${idempotencyKey}
       ${lock ? sql`FOR UPDATE` : sql``}
       LIMIT 1`;
    return rows[0] ?? null;
  }

  private async findReceiptRow(sql: SqlClient, receiptId: string, lock = false): Promise<LedgerDbRow | null> {
    const rows = await sql<LedgerDbRow[]>`
      SELECT receipt_id, record
        FROM harness_shared.resource_governor_admissions
       WHERE workspace_id = ${this.workspaceId}
         AND receipt_id = ${receiptId}
       ${lock ? sql`FOR UPDATE` : sql``}
       LIMIT 1`;
    return rows[0] ?? null;
  }

  private async writeRecord(
    sql: SqlClient,
    receiptId: string,
    record: DurableAdmissionRecord,
  ): Promise<StoredAdmissionRecord> {
    const rows = await sql<LedgerDbRow[]>`
      UPDATE harness_shared.resource_governor_admissions
         SET record = ${JSON.stringify(record)}::text::jsonb
       WHERE workspace_id = ${this.workspaceId}
         AND receipt_id = ${receiptId}
       RETURNING receipt_id, record`;
    if (!rows[0]) {
      throw new AdmissionPersistenceError(
        `canonical admission ledger receipt ${receiptId} disappeared during transition`,
      );
    }
    return storedFromRow(rows[0]);
  }

  async enqueue(record: DurableAdmissionRecord): Promise<StoredAdmissionRecord & { readonly created: boolean }> {
    return this.transaction(async (tx) => {
      const identityLock = `resource-governor:${this.workspaceId}:${record.namespace}:id:${record.idempotencyKey}`;
      const coalesceLock = record.coalesceKey
        ? `resource-governor:${this.workspaceId}:${record.namespace}:coalesce:${record.coalesceKey}`
        : identityLock;
      await this.lockKeys(tx, [identityLock, coalesceLock]);
      await this.latchCutover(tx);

      const existing = await this.findRow(tx, record.namespace, record.idempotencyKey, true);
      if (existing) return { ...storedFromRow(existing), created: false };

      if (record.coalesceKey) {
        const priorRows = await tx<LedgerDbRow[]>`
          SELECT receipt_id, record
            FROM harness_shared.resource_governor_admissions
           WHERE workspace_id = ${this.workspaceId}
             AND namespace = ${record.namespace}
             AND coalesce_key = ${record.coalesceKey}
             AND state IN ('queued', 'eligible', 'leased', 'running')
           FOR UPDATE`;
        for (const row of priorRows) {
          const prior = storedFromRow(row);
          const superseded: DurableAdmissionRecord = {
            ...nextDecision(prior.record, 'superseded', record.enqueuedAtMs, 'coalesced-by-newer-request', {
              idempotencyKey: record.idempotencyKey,
            }),
            lease: undefined,
          };
          await this.writeRecord(tx, prior.receiptId, superseded);
        }
      }

      const rows = await tx<LedgerDbRow[]>`
        INSERT INTO harness_shared.resource_governor_admissions (
          workspace_id, record
        ) VALUES (
          ${this.workspaceId}, ${JSON.stringify(record)}::text::jsonb
        )
        ON CONFLICT DO NOTHING
        RETURNING receipt_id, record`;
      if (rows[0]) return { ...storedFromRow(rows[0]), created: true };
      const raced = await this.findRow(tx, record.namespace, record.idempotencyKey, true);
      if (!raced) {
        throw new AdmissionPersistenceError('admission ledger insert returned no row and no durable receipt exists');
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
      const next: DurableAdmissionRecord = {
        ...nextDecision(stored.record, 'cancelled', nowMs, 'cancelled', {
          ...(reason ? { reason } : {}),
        }),
        lease: undefined,
        ...(reason ? { cancellationReason: reason } : {}),
      };
      return { ...(await this.writeRecord(tx, stored.receiptId, next)), changed: true };
    });
  }

  private async selectReconcileRows(
    tx: SqlClient,
    namespace: string | null,
    state: 'lease' | 'deadline' | 'abandoned',
    nowMs: number,
  ): Promise<StoredAdmissionRecord[]> {
    const namespaceSql = namespace === null ? tx`` : tx`AND namespace = ${namespace}`;
    const stateSql =
      state === 'lease'
        ? tx`
            AND state IN ('leased', 'running')
            AND lease_expires_at_ms <= ${nowMs}`
        : state === 'deadline'
          ? tx`
              AND state IN ('queued', 'eligible')
              AND deadline_at_ms IS NOT NULL
              AND deadline_at_ms <= ${nowMs}`
          : tx`
              AND state IN ('queued', 'eligible')
              AND deadline_at_ms IS NULL
              AND updated_at_ms <= ${nowMs - this.abandonAfterMs}`;
    const rows = await tx<LedgerDbRow[]>`
      SELECT receipt_id, record
        FROM harness_shared.resource_governor_admissions
       WHERE workspace_id = ${this.workspaceId}
         ${namespaceSql}
         ${stateSql}
       ORDER BY updated_at_ms ASC, receipt_id ASC
       FOR UPDATE SKIP LOCKED
       LIMIT ${RECONCILE_BATCH_SIZE}`;
    return rows.map(storedFromRow);
  }

  private async reconcileExpiredRows(
    tx: SqlClient,
    namespace: string | null,
    nowMs: number,
  ): Promise<QueueReconciliationResult> {
    const reconcileLock = `${RECONCILE_LOCK_PREFIX}${this.workspaceId}`;
    const lockRows = await tx<{ locked: boolean }[]>`
      SELECT pg_try_advisory_xact_lock(hashtextextended(${reconcileLock}, 0)) AS locked`;
    if (lockRows.length > 0 && lockRows[0]?.locked === false) {
      return { requeued: 0, expired: 0, abandoned: 0, total: 0 };
    }

    const lapsed = await this.selectReconcileRows(tx, namespace, 'lease', nowMs);
    for (const stored of lapsed) {
      const next: DurableAdmissionRecord = {
        ...nextDecision(stored.record, 'queued', nowMs, 'lease-expired'),
        lease: undefined,
      };
      await this.writeRecord(tx, stored.receiptId, next);
    }

    const deadlines = await this.selectReconcileRows(tx, namespace, 'deadline', nowMs);
    for (const stored of deadlines) {
      const next: DurableAdmissionRecord = {
        ...nextDecision(stored.record, 'expired', nowMs, 'deadline-expired'),
        lease: undefined,
      };
      await this.writeRecord(tx, stored.receiptId, next);
    }

    const abandoned = await this.selectReconcileRows(tx, namespace, 'abandoned', nowMs);
    for (const stored of abandoned) {
      const next: DurableAdmissionRecord = {
        ...nextDecision(stored.record, 'expired', nowMs, 'abandoned-without-deadline'),
        lease: undefined,
      };
      await this.writeRecord(tx, stored.receiptId, next);
    }
    return {
      requeued: lapsed.length,
      expired: deadlines.length,
      abandoned: abandoned.length,
      total: lapsed.length + deadlines.length + abandoned.length,
    };
  }

  reconcileExpired(namespace: string, nowMs: number): Promise<QueueReconciliationResult> {
    return this.transaction((tx) => this.reconcileExpiredRows(tx, namespace, nowMs));
  }

  reconcileExpiredAll(nowMs = Date.now()): Promise<QueueReconciliationResult> {
    return this.transaction((tx) => this.reconcileExpiredRows(tx, null, nowMs));
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
      let rows: LedgerDbRow[];
      if (!selection) {
        rows = await tx<LedgerDbRow[]>`
          SELECT receipt_id, record
            FROM harness_shared.resource_governor_admissions
           WHERE workspace_id = ${this.workspaceId}
             AND namespace = ${namespace}
             AND state IN ('queued', 'eligible')
           ORDER BY priority DESC, enqueued_at_ms ASC, receipt_id ASC
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
        const affinityBonus = Math.max(0, selection.resourceAffinityBonus);
        const constrainedPenalty = Math.max(0, selection.constrainedResourcePenalty);
        rows = await tx<LedgerDbRow[]>`
          SELECT item.receipt_id, item.record
            FROM harness_shared.resource_governor_admissions AS item
            JOIN LATERAL (
              SELECT policy.*
                FROM jsonb_to_recordset(${policies}::text::jsonb) AS policy(
                  admission_class text,
                  virtual_time double precision,
                  weight double precision,
                  constrained_resources jsonb
                )
               WHERE policy.admission_class = item.admission_class
               LIMIT 1
            ) AS class_policy ON true
            CROSS JOIN LATERAL (
              SELECT
                (
                  SELECT count(*)
                    FROM jsonb_array_elements_text(
                      COALESCE(class_policy.constrained_resources, '[]'::jsonb)
                    ) AS resource(value)
                   WHERE CASE resource.value
                           WHEN 'cpu' THEN COALESCE((item.record->'demand'->>'cpuWeight')::double precision, 0)
                           WHEN 'memory' THEN COALESCE((item.record->'demand'->>'memoryBytes')::double precision, 0)
                           WHEN 'database' THEN COALESCE((item.record->'demand'->>'databaseConnections')::double precision, 0)
                           WHEN 'provider' THEN COALESCE((item.record->'demand'->>'providerRequests')::double precision, 0)
                           ELSE COALESCE(
                             (item.record->'demand'->'custom'->>('resource:' || resource.value))::double precision,
                             (item.record->'demand'->'custom'->>resource.value)::double precision,
                             0
                           )
                         END > 0
                      OR item.record->'metadata'->>'resourceAffinity' = resource.value
                ) AS constrained_count,
                (
                  SELECT count(*)
                    FROM jsonb_array_elements_text(${releasedResources}::text::jsonb) AS resource(value)
                   WHERE CASE resource.value
                           WHEN 'cpu' THEN COALESCE((item.record->'demand'->>'cpuWeight')::double precision, 0)
                           WHEN 'memory' THEN COALESCE((item.record->'demand'->>'memoryBytes')::double precision, 0)
                           WHEN 'database' THEN COALESCE((item.record->'demand'->>'databaseConnections')::double precision, 0)
                           WHEN 'provider' THEN COALESCE((item.record->'demand'->>'providerRequests')::double precision, 0)
                           ELSE COALESCE(
                             (item.record->'demand'->'custom'->>('resource:' || resource.value))::double precision,
                             (item.record->'demand'->'custom'->>resource.value)::double precision,
                             0
                           )
                         END > 0
                      OR item.record->'metadata'->>'resourceAffinity' = resource.value
                ) AS affinity_count
            ) AS resource_score
           WHERE item.workspace_id = ${this.workspaceId}
             AND item.namespace = ${namespace}
             AND item.state IN ('queued', 'eligible')
           ORDER BY class_policy.virtual_time ASC,
                    (
                      item.priority
                      + floor(GREATEST(0, ${nowMs} - item.enqueued_at_ms) / ${agingIntervalMs})
                      + CASE
                          WHEN item.deadline_at_ms IS NOT NULL
                          THEN GREATEST(
                            0,
                            ${deadlineHorizonMs} - GREATEST(0, item.deadline_at_ms - ${nowMs})
                          ) / ${agingIntervalMs}
                          ELSE 0
                        END
                      + resource_score.affinity_count * ${affinityBonus}
                      - resource_score.constrained_count * ${constrainedPenalty}
                    ) DESC,
                    item.enqueued_at_ms ASC,
                    item.receipt_id ASC
           FOR UPDATE OF item SKIP LOCKED
           LIMIT 1`;
      }
      if (!rows[0]) return null;
      const stored = storedFromRow(rows[0]);
      const generation = stored.record.decision.generation + 1;
      const next: DurableAdmissionRecord = {
        ...nextDecision(stored.record, 'leased', nowMs, 'leased', { owner }),
        lease: { leaseId, owner, generation, expiresAtMs: nowMs + ttlMs },
      };
      return { ...(await this.writeRecord(tx, stored.receiptId, next)), changed: true };
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
      if (stored.record.deadlineAtMs !== null && stored.record.deadlineAtMs <= nowMs) {
        const expired: DurableAdmissionRecord = {
          ...nextDecision(stored.record, 'expired', nowMs, 'deadline-expired'),
          lease: undefined,
        };
        return { ...(await this.writeRecord(tx, receiptId, expired)), changed: false };
      }
      const generation = stored.record.decision.generation + 1;
      const next: DurableAdmissionRecord = {
        ...nextDecision(stored.record, 'leased', nowMs, 'observe-only-targeted-lease', { owner }),
        lease: { leaseId, owner, generation, expiresAtMs: nowMs + ttlMs },
      };
      return { ...(await this.writeRecord(tx, receiptId, next)), changed: true };
    });
  }

  private async leaseTransition(
    receiptId: string,
    leaseId: string,
    nowMs: number,
    mutate: (record: DurableAdmissionRecord) => DurableAdmissionRecord,
  ): Promise<QueueMutationResult | null> {
    return this.transaction(async (tx) => {
      const row = await this.findReceiptRow(tx, receiptId, true);
      if (!row) return null;
      const stored = storedFromRow(row);
      if (!stored.record.lease || stored.record.lease.leaseId !== leaseId) {
        return { ...stored, changed: false };
      }
      const next = mutate(stored.record);
      return { ...(await this.writeRecord(tx, receiptId, next)), changed: true };
    });
  }

  markRunning(receiptId: string, leaseId: string, nowMs: number): Promise<QueueMutationResult | null> {
    return this.leaseTransition(receiptId, leaseId, nowMs, (record) =>
      record.state === 'leased'
        ? nextDecision(record, 'running', nowMs, 'execution-started', {
            owner: record.lease?.owner ?? null,
          })
        : record,
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
    return this.leaseTransition(receiptId, leaseId, nowMs, (record) => {
      if (record.state !== 'leased' && record.state !== 'running') return record;
      return {
        ...nextDecision(record, 'completed', nowMs, 'execution-completed', {
          ...(resultRef ? { resultRef } : {}),
        }),
        lease: undefined,
        ...(resultRef ? { resultRef } : {}),
      };
    }).then((result) =>
      result && result.changed && result.record.state !== 'completed' ? { ...result, changed: false } : result,
    );
  }

  releaseLease(receiptId: string, leaseId: string, nowMs: number): Promise<QueueMutationResult | null> {
    return this.leaseTransition(receiptId, leaseId, nowMs, (record) => {
      if (record.state !== 'leased' && record.state !== 'running') return record;
      return { ...nextDecision(record, 'queued', nowMs, 'lease-released'), lease: undefined };
    }).then((result) =>
      result && result.changed && result.record.state !== 'queued' ? { ...result, changed: false } : result,
    );
  }

  releaseClaim(
    receiptId: string,
    leaseId: string,
    actualDemand: DurableAdmissionRecord['actualDemand'] | undefined,
    nowMs: number,
  ): Promise<QueueMutationResult | null> {
    return this.leaseTransition(receiptId, leaseId, nowMs, (record) => {
      if (record.state !== 'leased' && record.state !== 'running') return record;
      return {
        ...nextDecision(record, 'completed', nowMs, 'resources-released', {
          actualDemandReported: actualDemand !== undefined,
        }),
        lease: undefined,
        ...(actualDemand ? { actualDemand } : {}),
        releasedAtMs: nowMs,
      };
    }).then((result) =>
      result && result.changed && result.record.state !== 'completed' ? { ...result, changed: false } : result,
    );
  }

  async supersede(receiptId: string, replacementReceiptId: string, nowMs: number): Promise<QueueMutationResult | null> {
    return this.transaction(async (tx) => {
      const row = await this.findReceiptRow(tx, receiptId, true);
      if (!row) return null;
      const stored = storedFromRow(row);
      if (!activeState(stored.record.state)) return { ...stored, changed: false };
      const next: DurableAdmissionRecord = {
        ...nextDecision(stored.record, 'superseded', nowMs, 'superseded', {
          replacementReceiptId,
        }),
        lease: undefined,
        supersededByReceiptId: replacementReceiptId,
      };
      return { ...(await this.writeRecord(tx, receiptId, next)), changed: true };
    });
  }
}
