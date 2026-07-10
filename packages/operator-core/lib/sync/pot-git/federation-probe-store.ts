/**
 * federation-probe-store — PG persistence for `harness_shared.federation_probes`
 * (fleet-reliability-verification-2026-07-10 P-010, WI-3812; migration 544).
 *
 * Thin persistence layer over the pure shape/logic in `federation-probe.ts`
 * (mirrors the `results-receipt.ts` shape / `agent-facts/store.ts` persistence
 * split used elsewhere in this package). `insertProbe` is the only write path
 * that can create a row (probe:emit); `recordProbeHop` is the EXTENSION SEAM
 * later pipeline-stage wiring (P-012 named-hop observability, P-011 gate
 * canaries) calls to stamp a later hop as the real op is observed flowing
 * through capture/drain/replicate/merge/member-guard/project.
 */
import type { Sql } from 'postgres';
import { getOrgPg } from '@papercusp/db-org';
import { InvalidInputError } from '@papercusp/tooldef';
import { PROBE_HOP_COLUMN, type ProbeHop, type ProbeReceipt, type StampedProbe } from './federation-probe';

function sqlOf(inject?: Sql): Sql {
  return inject ?? getOrgPg().sql;
}

interface FederationProbeRow {
  probe_key: string;
  workspace_id: string;
  harness_slug: string;
  emitted_by: string;
  emitted_at: string;
  captured_at: string | null;
  drained_at: string | null;
  replicated_at: string | null;
  merged_at: string | null;
  member_guard_at: string | null;
  projected_at: string | null;
  status: ProbeReceipt['status'];
  refusal_reason: string | null;
}

function rowToReceipt(row: FederationProbeRow): ProbeReceipt {
  const hops: ProbeReceipt['hops'] = {};
  const at = (v: string | null): number | undefined => (v ? new Date(v).getTime() : undefined);
  const captured = at(row.captured_at);
  const drained = at(row.drained_at);
  const replicated = at(row.replicated_at);
  const merged = at(row.merged_at);
  const memberGuard = at(row.member_guard_at);
  const projected = at(row.projected_at);
  if (captured !== undefined) hops.captured = captured;
  if (drained !== undefined) hops.drained = drained;
  if (replicated !== undefined) hops.replicated = replicated;
  if (merged !== undefined) hops.merged = merged;
  if (memberGuard !== undefined) hops.memberGuard = memberGuard;
  if (projected !== undefined) hops.projected = projected;
  return {
    probeKey: row.probe_key,
    workspaceId: row.workspace_id,
    harnessSlug: row.harness_slug,
    emittedBy: row.emitted_by,
    emittedAtMs: new Date(row.emitted_at).getTime(),
    status: row.status,
    ...(row.refusal_reason ? { refusalReason: row.refusal_reason } : {}),
    hops,
  };
}

/**
 * Persist a stamped probe (probe:emit's success path) with `captured` stamped
 * at insert time — a probe row only ever exists once captured. Throws
 * InvalidInputError on a probe_key collision (should be astronomically rare
 * given buildProbeKey's nonce, but a collision must be a loud caller error,
 * never a silent overwrite of a DIFFERENT probe's receipts).
 */
export async function insertProbe(stamped: StampedProbe, inject?: Sql): Promise<ProbeReceipt> {
  const sql = sqlOf(inject);
  const nowIso = new Date(stamped.emittedAtMs).toISOString();
  let rows: FederationProbeRow[];
  try {
    rows = await sql<FederationProbeRow[]>`
      INSERT INTO harness_shared.federation_probes
        (workspace_id, harness_slug, probe_key, emitted_by, emitted_at, captured_at, status)
      VALUES
        (${stamped.workspaceId}, ${stamped.harnessSlug}, ${stamped.probeKey}, ${stamped.emittedBy},
         ${nowIso}, ${nowIso}, 'pending')
      RETURNING probe_key, workspace_id, harness_slug, emitted_by, emitted_at::text,
                captured_at::text, drained_at::text, replicated_at::text, merged_at::text,
                member_guard_at::text, projected_at::text, status, refusal_reason`;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/duplicate key value.*federation_probes_probe_key/.test(msg)) {
      throw new InvalidInputError(
        `probe:emit — probe_key '${stamped.probeKey}' already exists (collision) — retry (buildProbeKey re-nonces)`,
      );
    }
    throw e;
  }
  return rowToReceipt(rows[0]);
}

/**
 * Persist a REFUSED probe attempt (loud-refusal discipline: a refusal is
 * still recorded, not just returned-and-forgotten, so a pattern of refusals
 * against one harness is visible via probe:get / a future sweep).
 */
export async function insertRefusedProbe(
  args: { workspaceId: string; harnessSlug: string; emittedBy: string; probeKey: string; reason: string; nowMs: number },
  inject?: Sql,
): Promise<void> {
  const sql = sqlOf(inject);
  const nowIso = new Date(args.nowMs).toISOString();
  await sql`
    INSERT INTO harness_shared.federation_probes
      (workspace_id, harness_slug, probe_key, emitted_by, emitted_at, status, refusal_reason)
    VALUES
      (${args.workspaceId}, ${args.harnessSlug}, ${args.probeKey}, ${args.emittedBy}, ${nowIso}, 'refused', ${args.reason})
    ON CONFLICT (probe_key) DO NOTHING`;
}

/**
 * Stamp a later hop's receipt (the extension seam pipeline stages call). Only
 * ever moves a hop from NULL to a timestamp — re-stamping an already-landed
 * hop is a no-op (COALESCE), so a retried/duplicate observation can never move
 * a receipt backwards or overwrite the FIRST time a hop was actually seen.
 */
export async function recordProbeHop(
  probeKey: string,
  hop: ProbeHop,
  atMs: number,
  detail?: string,
  inject?: Sql,
): Promise<ProbeReceipt | null> {
  const sql = sqlOf(inject);
  // Column name is from the fixed PROBE_HOP_COLUMN map (never caller input),
  // so interpolating it directly into the query string is safe — the VALUES
  // are still bound params via sql.unsafe's second arg (never string-built).
  const column = PROBE_HOP_COLUMN[hop];
  const nowIso = new Date(atMs).toISOString();
  const rows = (await sql.unsafe(
    `UPDATE harness_shared.federation_probes
        SET ${column} = COALESCE(${column}, $1::timestamptz),
            detail = COALESCE($2, detail)
      WHERE probe_key = $3 AND status = 'pending'
      RETURNING probe_key, workspace_id, harness_slug, emitted_by, emitted_at::text,
                captured_at::text, drained_at::text, replicated_at::text, merged_at::text,
                member_guard_at::text, projected_at::text, status, refusal_reason`,
    [nowIso, detail ?? null, probeKey] as never,
  )) as unknown as FederationProbeRow[];
  return rows[0] ? rowToReceipt(rows[0]) : null;
}

/** Mark a probe 'acked' once every expected hop has landed (probe:get's write-back). */
export async function markProbeAcked(probeKey: string, inject?: Sql): Promise<void> {
  const sql = sqlOf(inject);
  await sql`UPDATE harness_shared.federation_probes SET status = 'acked' WHERE probe_key = ${probeKey} AND status = 'pending'`;
}

/** Mark a probe 'timed_out' (a caller/sweep gave up waiting on a stalled hop). */
export async function markProbeTimedOut(probeKey: string, inject?: Sql): Promise<void> {
  const sql = sqlOf(inject);
  await sql`UPDATE harness_shared.federation_probes SET status = 'timed_out' WHERE probe_key = ${probeKey} AND status = 'pending'`;
}

export async function getProbe(probeKey: string, inject?: Sql): Promise<ProbeReceipt | null> {
  const sql = sqlOf(inject);
  const rows = await sql<FederationProbeRow[]>`
    SELECT probe_key, workspace_id, harness_slug, emitted_by, emitted_at::text,
           captured_at::text, drained_at::text, replicated_at::text, merged_at::text,
           member_guard_at::text, projected_at::text, status, refusal_reason
      FROM harness_shared.federation_probes
     WHERE probe_key = ${probeKey}`;
  return rows[0] ? rowToReceipt(rows[0]) : null;
}

export async function listRecentProbes(
  workspaceId: string,
  harnessSlug: string,
  limit = 20,
  inject?: Sql,
): Promise<ProbeReceipt[]> {
  const sql = sqlOf(inject);
  const rows = await sql<FederationProbeRow[]>`
    SELECT probe_key, workspace_id, harness_slug, emitted_by, emitted_at::text,
           captured_at::text, drained_at::text, replicated_at::text, merged_at::text,
           member_guard_at::text, projected_at::text, status, refusal_reason
      FROM harness_shared.federation_probes
     WHERE workspace_id = ${workspaceId} AND harness_slug = ${harnessSlug}
     ORDER BY emitted_at DESC
     LIMIT ${limit}`;
  return rows.map(rowToReceipt);
}
