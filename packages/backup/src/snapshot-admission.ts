/**
 * Shared pre-destructive snapshot admission.
 *
 * A PostgreSQL advisory lock is only a rendezvous: it says that a snapshot
 * and a migration are not running at the same time, not that a restore point
 * actually completed.  Both migration appliers therefore consume this
 * fail-closed predicate, while the snapshot writer records the intent before
 * waiting for that rendezvous.
 */

/** The trigger label used for the restore point required before migrations. */
export const PRE_DESTRUCTIVE_SNAPSHOT_TRIGGER = 'pre_destructive' as const;

/**
 * Migration 1006 adds `backup_snapshots.db_dump_ok`.  It must be allowed to
 * apply without this guard so an older database can install the column that
 * the guard itself reads.
 */
export const PRE_DESTRUCTIVE_SNAPSHOT_SCHEMA_MIGRATION =
  '1006-backup-snapshot-db-dump-integrity.sql' as const;
export const PRE_DESTRUCTIVE_SNAPSHOT_ADMISSION_FROM = 1007;

export interface PreDestructiveSnapshotReceiptLike {
  status?: unknown;
  finishedAt?: unknown;
  kopiaSnapshotId?: unknown;
  dbDumpOk?: unknown;
}

export type PreDestructiveSnapshotAdmissionReason =
  | 'missing'
  | 'running'
  | 'failed'
  | 'degraded'
  | 'unknown'
  | 'incomplete';

export interface PreDestructiveSnapshotAdmission {
  admitted: boolean;
  latest: PreDestructiveSnapshotReceiptLike | null;
  reason?: PreDestructiveSnapshotAdmissionReason;
}

function hasFinishedAt(value: unknown): boolean {
  if (value instanceof Date) return Number.isFinite(value.getTime());
  if (typeof value === 'string') return Number.isFinite(Date.parse(value));
  if (typeof value === 'number') return Number.isFinite(value);
  return false;
}

function hasKopiaSnapshotId(value: unknown): boolean {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * The single pure completion predicate shared by the SQL guard's contract
 * and its unit tests.  A receipt is usable only when all four durable facts
 * are positive: terminal `ok`, finished timestamp, Kopia artifact id, and a
 * successful database dump.
 */
export function isCompletedPreDestructiveSnapshotReceipt(
  receipt: PreDestructiveSnapshotReceiptLike | null | undefined,
): boolean {
  return (
    receipt?.status === 'ok' &&
    hasFinishedAt(receipt.finishedAt) &&
    hasKopiaSnapshotId(receipt.kopiaSnapshotId) &&
    receipt.dbDumpOk === true
  );
}

/**
 * Evaluate rows ordered newest-first.  The newest pre-destructive row is the
 * authority: an older good receipt must not mask a newer running, failed,
 * degraded, unknown, or incomplete attempt.
 */
export function evaluateLatestPreDestructiveSnapshot(
  rows: readonly PreDestructiveSnapshotReceiptLike[],
): PreDestructiveSnapshotAdmission {
  const latest = rows[0] ?? null;
  if (!latest) return { admitted: false, latest: null, reason: 'missing' };
  if (isCompletedPreDestructiveSnapshotReceipt(latest)) {
    return { admitted: true, latest };
  }

  if (latest.status === 'running') return { admitted: false, latest, reason: 'running' };
  if (latest.status === 'failed' || latest.status === 'aborted') {
    return { admitted: false, latest, reason: 'failed' };
  }
  if (latest.status === 'degraded' || latest.dbDumpOk === false) {
    return { admitted: false, latest, reason: 'degraded' };
  }
  if (latest.status === 'ok') {
    return { admitted: false, latest, reason: 'incomplete' };
  }
  return { admitted: false, latest, reason: 'unknown' };
}

/** Whether a migration filename needs the completed-snapshot guard. */
export function requiresPreDestructiveSnapshotAdmission(filename: string): boolean {
  const basename = filename.split(/[\\/]/).pop() ?? filename;
  if (basename === PRE_DESTRUCTIVE_SNAPSHOT_SCHEMA_MIGRATION) return false;
  const number = /^(\d+)-/.exec(basename)?.[1];
  // Fresh/reused databases must be able to install the baseline and the
  // db_dump_ok column before this guard can be meaningful.  Once migration
  // 1006 has landed, every later migration uses the completed-receipt gate.
  return number === undefined || Number(number) >= PRE_DESTRUCTIVE_SNAPSHOT_ADMISSION_FROM;
}

function sqlStringLiteral(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error('pre-destructive snapshot admission requires a concrete workspace id');
  return `'${trimmed.replace(/'/g, "''")}'`;
}

/**
 * Return the SQL SELECT used by the guard.  It deliberately selects only the
 * newest pre-destructive receipt before applying the completion predicate.
 */
export function completedPreDestructiveSnapshotQuerySql(workspaceId: string): string {
  const workspace = sqlStringLiteral(workspaceId);
  return (
    `SELECT 1\n` +
    `  FROM (\n` +
    `    SELECT status, finished_at, kopia_snapshot_id, db_dump_ok\n` +
    `      FROM harness_shared.backup_snapshots\n` +
    `     WHERE workspace_id = ${workspace}\n` +
    `       AND trigger_reason = '${PRE_DESTRUCTIVE_SNAPSHOT_TRIGGER}'\n` +
    `     ORDER BY started_at DESC, id DESC\n` +
    `     LIMIT 1\n` +
    `  ) AS latest\n` +
    ` WHERE latest.status = 'ok'\n` +
    `   AND latest.finished_at IS NOT NULL\n` +
    `   AND latest.kopia_snapshot_id IS NOT NULL\n` +
    `   AND btrim(latest.kopia_snapshot_id) <> ''\n` +
    `   AND latest.db_dump_ok IS TRUE`
  );
}

/**
 * Return a transaction-safe, fail-closed migration guard.  The caller places
 * this before the migration's DDL; a missing table/column or a non-complete
 * latest receipt therefore aborts the migration rather than guessing.
 */
export function preDestructiveSnapshotAdmissionGuardSql(workspaceId: string): string {
  const workspace = sqlStringLiteral(workspaceId);
  return (
    `DO $papercusp_pre_destructive_snapshot_guard$\n` +
    `BEGIN\n` +
    `  IF NOT EXISTS (\n` +
    completedPreDestructiveSnapshotQuerySql(workspaceId)
      .split('\n')
      .map((line) => `    ${line}`)
      .join('\n') +
    `\n` +
    `  ) THEN\n` +
    `    RAISE EXCEPTION 'pre-destructive snapshot admission failed for workspace %: latest receipt is not a completed database-backed snapshot', ${workspace}\n` +
    `      USING ERRCODE = '55000';\n` +
    `  END IF;\n` +
    `END\n` +
    `$papercusp_pre_destructive_snapshot_guard$;\n`
  );
}
