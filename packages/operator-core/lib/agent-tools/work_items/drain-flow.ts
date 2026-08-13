/**
 * Exact DRAIN bug-flow economics and the write-side admission circuit breaker.
 *
 * `work_items:burn_down` deliberately caps its item census at 2,000 rows. That is
 * appropriate for a leader-facing row listing, but it cannot answer the control
 * question this module owns: "has this DRAIN agent terminaled more bugs than it
 * has admitted since entering DRAIN?" The answer is computed directly over the
 * canonical `harness_shared.work_items` relation, as one aggregate query.
 *
 * Attribution is intentionally asymmetric because the two events have different
 * writers in the schema:
 *   - admitted/opened: `created_ts` + `payload._ei.created_by`
 *   - terminaled:      `closed_ts`  + `terminal_owner`
 *
 * The admission wrapper holds a transaction-scoped advisory lock across the
 * oracle read AND the supplied persistence callback. Every cooperating DRAIN bug
 * writer therefore serializes read -> decision -> write for one
 * workspace/harness/owner tuple; two concurrent first filings cannot both observe
 * 0/0 and pass the breaker.
 */
import type postgres from 'postgres';
import { getOrgPg } from '@papercusp/db-org';

export const DRAIN_FLOW_SEVERITIES = ['critical', 'major', 'minor', 'nit'] as const;
export type DrainFlowSeverity = (typeof DRAIN_FLOW_SEVERITIES)[number];

export interface DrainFlowCount {
  opened: number;
  terminaled: number;
  net: number;
}

export interface DrainFlowReport {
  exact: true;
  windowStart: string;
  workspaceId: string;
  harness: string;
  ownerId: string;
  totals: DrainFlowCount;
  bySeverity: Record<DrainFlowSeverity, DrainFlowCount>;
  breaker: {
    tripped: boolean;
    blocksNewBugs: boolean;
    rule: string;
    reason: string;
  };
}

interface DrainFlowAggregateRow {
  severity: unknown;
  opened: unknown;
  terminaled: unknown;
}

type QuerySql = postgres.Sql | postgres.TransactionSql;

function count(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

function zeroCount(): DrainFlowCount {
  return { opened: 0, terminaled: 0, net: 0 };
}

export function buildDrainFlowReport(
  rows: readonly DrainFlowAggregateRow[],
  basis: { windowStart: string; workspaceId: string; harness: string; ownerId: string },
): DrainFlowReport {
  const bySeverity = Object.fromEntries(
    DRAIN_FLOW_SEVERITIES.map((severity) => [severity, zeroCount()]),
  ) as Record<DrainFlowSeverity, DrainFlowCount>;

  for (const row of rows) {
    const severity = DRAIN_FLOW_SEVERITIES.includes(row.severity as DrainFlowSeverity)
      ? (row.severity as DrainFlowSeverity)
      : 'minor';
    const opened = count(row.opened);
    const terminaled = count(row.terminaled);
    const bucket = bySeverity[severity];
    bucket.opened += opened;
    bucket.terminaled += terminaled;
    bucket.net = bucket.opened - bucket.terminaled;
  }

  const totals = DRAIN_FLOW_SEVERITIES.reduce<DrainFlowCount>(
    (acc, severity) => {
      acc.opened += bySeverity[severity].opened;
      acc.terminaled += bySeverity[severity].terminaled;
      acc.net = acc.opened - acc.terminaled;
      return acc;
    },
    zeroCount(),
  );
  // The 0/0 exception admits the first directly-blocking bug. Thereafter the
  // drain must be strictly net-negative before it may mint another one:
  // opened === terminaled is break-even, not burn-down.
  const tripped = totals.opened > 0 && totals.opened >= totals.terminaled;
  const rule = 'after the first admitted bug, block while opened >= terminaled; admit only when terminaled > opened';

  return {
    exact: true,
    ...basis,
    totals,
    bySeverity,
    breaker: {
      tripped,
      blocksNewBugs: tripped,
      rule,
      reason: tripped
        ? `DRAIN bug admission is paused: ${totals.opened} opened vs ${totals.terminaled} terminaled since ${basis.windowStart} (net ${totals.net >= 0 ? '+' : ''}${totals.net}).`
        : totals.opened === 0
          ? `DRAIN bug admission is open for the first directly-blocking defect: 0 opened vs ${totals.terminaled} terminaled since ${basis.windowStart}.`
          : `DRAIN bug admission is open: ${totals.opened} opened vs ${totals.terminaled} terminaled since ${basis.windowStart} (net ${totals.net}).`,
    },
  };
}

export async function readDrainFlow(args: {
  workspaceId: string;
  harness: string;
  ownerId: string;
  drainStartedAt: string;
  sql?: QuerySql;
}): Promise<DrainFlowReport> {
  const windowStartMs = Date.parse(args.drainStartedAt);
  if (!Number.isFinite(windowStartMs)) {
    throw new Error(`invalid DRAIN mode setAt timestamp: ${args.drainStartedAt}`);
  }
  const sql = args.sql ?? getOrgPg().sql;
  const rows = await sql<DrainFlowAggregateRow[]>`
    SELECT
      CASE COALESCE(
        NULLIF(payload #>> '{_ei,severity}', ''),
        NULLIF(payload ->> 'severity', '')
      )
        WHEN 'critical' THEN 'critical'
        WHEN 'major' THEN 'major'
        WHEN 'nit' THEN 'nit'
        ELSE 'minor'
      END AS severity,
      COUNT(*) FILTER (
        WHERE created_ts >= ${windowStartMs}
          AND COALESCE(payload, '{}'::jsonb) #>> '{_ei,created_by}' = ${args.ownerId}
      )::int AS opened,
      COUNT(*) FILTER (
        WHERE closed_ts >= ${windowStartMs}
          AND terminal_owner = ${args.ownerId}
      )::int AS terminaled
    FROM harness_shared.work_items
    WHERE workspace_id = ${args.workspaceId}
      AND harness_slug = ${args.harness}
      AND item_kind = 'bug'
      AND (
        (created_ts >= ${windowStartMs}
          AND COALESCE(payload, '{}'::jsonb) #>> '{_ei,created_by}' = ${args.ownerId})
        OR
        (closed_ts >= ${windowStartMs} AND terminal_owner = ${args.ownerId})
      )
    GROUP BY 1
  `;
  return buildDrainFlowReport(rows, {
    windowStart: new Date(windowStartMs).toISOString(),
    workspaceId: args.workspaceId,
    harness: args.harness,
    ownerId: args.ownerId,
  });
}

export type DrainBugAdmissionResult<T> =
  | { ok: true; allowed: true; flow: DrainFlowReport; value: T }
  | {
      ok: true;
      allowed: false;
      code: 'drain_flow_circuit_open';
      message: string;
      flow: DrainFlowReport;
    }
  | {
      ok: false;
      allowed: false;
      code: 'drain_flow_unavailable';
      message: string;
    };

/**
 * Serialize the exact read and the caller's persistence under one advisory
 * transaction lock. Persistence errors remain persistence errors; only failures
 * before the callback starts are normalized to a fail-closed oracle verdict.
 */
export async function withDrainBugAdmission<T>(
  args: {
    workspaceId: string;
    harness: string;
    ownerId: string;
    drainStartedAt: string;
    sql?: postgres.Sql;
  },
  persist: (flow: DrainFlowReport) => Promise<T>,
): Promise<DrainBugAdmissionResult<T>> {
  const sql = args.sql ?? getOrgPg().sql;
  const lockKey = `drain-bug-admission:${args.workspaceId}:${args.harness}:${args.ownerId}`;
  let persistenceStarted = false;
  try {
    return (await sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`;
      const flow = await readDrainFlow({ ...args, sql: tx });
      if (flow.breaker.tripped) {
        return {
          ok: true as const,
          allowed: false as const,
          code: 'drain_flow_circuit_open' as const,
          message: `${flow.breaker.reason} Terminal one more bug before filing another; severity detail is attached in drainFlow.`,
          flow,
        };
      }
      persistenceStarted = true;
      const value = await persist(flow);
      return { ok: true as const, allowed: true as const, flow, value };
    })) as DrainBugAdmissionResult<T>;
  } catch (error) {
    if (persistenceStarted) throw error;
    return {
      ok: false,
      allowed: false,
      code: 'drain_flow_unavailable',
      message:
        `DRAIN bug admission failed closed because the exact flow oracle was unavailable: ` +
        (error instanceof Error ? error.message : String(error)),
    };
  }
}
