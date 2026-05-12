import postgres from 'postgres';

const url =
  process.env.PAPERCUSP_TELEMETRY_DB_URL ??
  process.env.DATABASE_URL ??
  'postgresql://postgres:postgres@127.0.0.1:5432/papercusp_telemetry';

export const sql = postgres(url, {
  max: 10,
  idle_timeout: 30,
  prepare: false,
});

export interface IncomingReport {
  workspace_id: string;
  received_at: string;
  kind: string;
  app_version?: string | null;
  os?: string | null;
  payload?: unknown;
}

export async function insertEvent(report: IncomingReport, sourceIp: string | null): Promise<number> {
  const payloadJson = report.payload == null ? null : JSON.stringify(report.payload);
  const rows = await sql<{ id: string }[]>`
    INSERT INTO papercusp_telemetry.events
      (workspace_id, received_at, kind, app_version, os, payload, source_ip)
    VALUES (
      ${report.workspace_id},
      ${report.received_at}::timestamptz,
      ${report.kind},
      ${report.app_version ?? null},
      ${report.os ?? null},
      ${payloadJson}::jsonb,
      ${sourceIp}::inet
    )
    RETURNING id
  `;
  return Number(rows[0].id);
}

export async function ping(): Promise<void> {
  await sql`SELECT 1`;
}
