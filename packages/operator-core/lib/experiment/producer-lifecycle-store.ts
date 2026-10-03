/** Common receipts live on the existing producer rows, atomically with their writes. */
import type { Sql } from 'postgres';
import {
  adaptScoutOutput, adaptGymOutput, adaptCalibrationOutput, adaptTransferOutput,
  adaptRegretOutput, adaptRedQueenOutput, type LearningProducer, type ProducerLifecycleObservation,
} from './lifecycle-adapter';

const stores = {
  scout: { table: 'scout_routed_ideas', key: 'idea_id', adapt: adaptScoutOutput },
  gym: { table: 'gym_proposals', key: 'id', adapt: adaptGymOutput },
  calibration: { table: 'calibration_predictions', key: 'id', adapt: adaptCalibrationOutput },
  transfer: { table: 'transfer_lessons', key: 'id', adapt: adaptTransferOutput },
  regret: { table: 'regret_findings', key: 'run_id', adapt: adaptRegretOutput },
  'red-queen': { table: 'red_queen_drills', key: 'id', adapt: adaptRedQueenOutput },
} as const;

export interface ProducerWriteScope {
  producer: LearningProducer;
  workspaceId: string;
  /** Null when an insert no-ops and returned no id. */
  sourceId: string | null;
}

/**
 * Snapshot only committed producer data. The WHERE keys and adapter are a fixed
 * allowlist, and the row lock serializes concurrent updates of the same output.
 * Domain acceptance remains in source; it is never relabelled contract acceptance.
 */
export async function recordProducerObservation(sql: Sql, scope: ProducerWriteScope): Promise<void> {
  if (scope.sourceId === null) return;
  const store = stores[scope.producer];
  const rows = await sql.unsafe(
    `SELECT * FROM harness_shared.${store.table} WHERE workspace_id = $1 AND ${store.key} = $2 FOR UPDATE`,
    [scope.workspaceId, scope.sourceId],
  );
  if (!rows.length) throw new Error(`producer lifecycle source missing: ${scope.producer}:${scope.sourceId}`);
  // Agent-review enrollment and REM/SU routes share Scout's store, but are not Scout output.
  if (scope.producer === 'scout' && rows[0].origin !== 'scout') return;
  const receipt = store.adapt({
    stage: 'observation', workspaceId: scope.workspaceId,
    sourceRef: `${scope.producer}:${scope.sourceId}`, source: rows[0], recordedAt: new Date().toISOString(),
  });
  await sql.unsafe(
    `UPDATE harness_shared.${store.table} SET learning_lifecycle = $3::text::jsonb WHERE workspace_id = $1 AND ${store.key} = $2`,
    [scope.workspaceId, scope.sourceId, JSON.stringify(receipt)],
  );
}

/** Root clients open a transaction; route/outer-transaction clients reuse theirs. */
export async function withProducerLifecycleWrite<T>(sql: Sql, write: (tx: Sql) => Promise<T>): Promise<T> {
  return typeof sql.begin === 'function'
    ? sql.begin((tx) => write(tx as unknown as Sql)) as Promise<T>
    : write(sql);
}

/** Bounded workspace-local read of the same persisted common envelope. */
export async function readProducerObservations(
  sql: Sql,
  query: { producer: LearningProducer; workspaceId: string; limit?: number },
): Promise<ProducerLifecycleObservation[]> {
  const store = stores[query.producer];
  const rows = await sql.unsafe(
    `SELECT * FROM harness_shared.${store.table}
      WHERE workspace_id = $1 AND learning_lifecycle IS NOT NULL
      ORDER BY learning_lifecycle->>'recordedAt' DESC, ${store.key} LIMIT $2`,
    [query.workspaceId, Math.min(Math.max(query.limit ?? 20, 1), 200)],
  );
  return rows.map((row) => {
    const receipt = (typeof row.learning_lifecycle === 'string'
      ? JSON.parse(row.learning_lifecycle) : row.learning_lifecycle) as ProducerLifecycleObservation;
    const current = store.adapt({
      stage: 'observation', workspaceId: query.workspaceId, sourceRef: receipt.sourceRef,
      recordedAt: receipt.recordedAt, source: row,
    });
    return { ...receipt, sourceCurrent: current.sourceHash === receipt.sourceHash };
  });
}
