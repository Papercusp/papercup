/**
 * Audit-log writer for plugin action invocations.
 *
 * Every invocation produces one row capturing trigger source, action,
 * params, outcome, capabilities used, and timing. The CLI uses
 * `InMemoryAuditWriter` (rows are kept process-local, optionally dumped via
 * `PAPERCUSP_INVOKE_AUDIT=1`); the operator can swap in a Postgres-backed
 * writer (TODO v1.1) for cross-restart durability.
 */

export interface AuditRow {
  ts: number;
  pluginName: string;
  installSlug: string;
  actionName: string;
  triggerSource: 'cli' | 'ui' | 'mission-done' | 'webhook' | 'api';
  triggerId: string;
  params: unknown;
  outcome: 'ok' | 'error' | 'timeout' | 'capability-denied';
  durationMs: number;
  errorMessage?: string;
}

export interface AuditWriter {
  write(row: AuditRow): Promise<void> | void;
}

export class InMemoryAuditWriter implements AuditWriter {
  private rows: AuditRow[] = [];

  write(row: AuditRow): void {
    this.rows.push(row);
  }

  rowsForInspection(): AuditRow[] {
    return this.rows.slice();
  }

  clear(): void {
    this.rows = [];
  }
}
