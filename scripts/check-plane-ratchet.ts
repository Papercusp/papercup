#!/usr/bin/env npx tsx
/**
 * check-plane-ratchet.ts — THE INTERPRETABILITY RATCHET, run against live data
 * (agent-state-plane-verification-2026-07-27 P-003).
 *
 * All judgement lives in `agent-plane-ratchet.ts` and is unit-tested there. This
 * file is the thin live-data half: read the series, resolve which known-gap items
 * have closed, print, exit.
 *
 * ⚠ THIS MUST NOT BE ADDED TO THE CI LINT JOB. It reads
 * `harness_shared.agent_plane_measurements`, and CI's Postgres is freshly
 * migrated and empty — so every metric would judge `no-data`, the gate would exit
 * 0 on every run forever, and it would present as coverage. That is exactly the
 * defect filed as WI-6476 against P-001's producer census; adding a second one
 * would be building the trap twice knowing what it is. Its runner belongs
 * alongside the P-015 sweep, on the live database.
 */
import { ratchetPlaneSeries, type RatchetRow } from '../packages/operator-core/lib/agent-plane-ratchet';
import type { PlaneZeroReason } from '../packages/operator-core/lib/agent-plane-measurement';
import { readFileSync } from 'node:fs';
import os from 'node:os';

function resolvePgUrl(): string {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  try {
    const p = JSON.parse(readFileSync(`${os.homedir()}/.papercusp/embedded-pg.json`, 'utf8'));
    if (p?.host && p?.port && p.user && p.password) {
      return `postgresql://${p.user}:${p.password}@${p.host}:${p.port}/papercusp`;
    }
  } catch {
    /* no discovery file — fall through to the dev default */
  }
  return 'postgresql://harness_admin:harness_admin_pwd@localhost:5432/papercusp';
}

interface StoredMetric {
  id: string;
  interpretable: boolean;
  fillRate: number | null;
  zeroReason: PlaneZeroReason | null;
}

async function main() {
  const workspaceId = process.env.PAPERCUSP_WORKSPACE_ID ?? 'papercusp-workspace';
  const postgres = (await import('postgres')).default;
  const sql = postgres(resolvePgUrl(), { max: 1, connect_timeout: 5, idle_timeout: 1, onnotice: () => {} });

  let series: Array<{ measuredAt: string; metrics: StoredMetric[] }> = [];
  let closedGaps = new Set<string>();
  try {
    const rows = await sql<Array<{ measured_at: string; metrics: StoredMetric[] }>>`
      SELECT measured_at::text AS measured_at, metrics
        FROM harness_shared.agent_plane_measurements
       WHERE workspace_id = ${workspaceId}
       ORDER BY measured_at ASC
    `;
    series = rows.map((r) => ({
      measuredAt: r.measured_at,
      metrics: (Array.isArray(r.metrics) ? r.metrics : []) as StoredMetric[],
    }));

    // Which known-gap items have CLOSED. A closed gap withdraws the exemption.
    const refs = [...new Set(Object.values((await import('../packages/operator-core/lib/agent-plane-ratchet')).METRIC_KNOWN_GAPS))].filter(Boolean) as string[];
    if (refs.length > 0) {
      const items = await sql<Array<{ id: string; state: string }>>`
        SELECT id, state FROM harness_shared.work_items WHERE id = ANY(${refs})
      `;
      closedGaps = new Set(items.filter((i) => i.state === 'done' || i.state === 'dropped').map((i) => i.id));
      const unknown = refs.filter((r) => !items.some((i) => i.id === r));
      for (const u of unknown) {
        console.error(`⚠ known-gap ref ${u} matches no work-item — the exemption it grants cannot be verified.`);
      }
    }
  } finally {
    await sql.end({ timeout: 5 });
  }

  const report = ratchetPlaneSeries({ series, closedGaps });
  const mark: Record<RatchetRow['verdict'], string> = {
    holding: '✓',
    regressed: '✗',
    incoherent: '✗',
    'never-interpretable': '·',
    'no-data': '?',
  };

  console.log('\nINTERPRETABILITY RATCHET — agent-state plane (P-003)\n');
  if (report.windows === 0) {
    console.log('  NO MEASUREMENTS. The series is empty, so there is no high-water mark to');
    console.log('  ratchet against. This says NOTHING about any producer — it is not a pass.\n');
    // Deliberately not exit 1: an empty series is "we looked at nothing", not a
    // defect. It is also why this script must never gate CI (see the header).
    return;
  }

  console.log(`  ${report.windows} windows · headline ${report.currentCount}/${report.metricCount} interpretable (high-water ${report.highWaterCount})\n`);
  for (const r of report.rows) {
    console.log(`  ${mark[r.verdict]} ${r.metric.padEnd(36)} ${r.verdict}`);
    if (r.verdict === 'regressed') {
      console.log(`      WORKED until ${r.lastInterpretableAt}, and does not now. A producer that`);
      console.log(`      demonstrably ran has stopped — this is a live regression, not an unbuilt metric.`);
    }
    if (r.verdict === 'incoherent') {
      console.log(`      claims interpretable while its own funnel reports nothing eligible.`);
      console.log(`      A zero was relabelled instead of a producer being built.`);
    }
    if (r.verdict === 'never-interpretable') {
      const gap = judgeGapLine(r);
      console.log(`      ${gap}`);
    }
  }

  console.log(
    `\n  ${report.rows.filter((r) => r.verdict === 'holding').length} holding · ` +
      `${report.failures.length} FAILING · ${report.exempt.length} filed-gap · ` +
      `${report.rows.filter((r) => r.verdict === 'no-data').length} no-data\n`,
  );

  if (report.failures.length > 0) {
    console.error('✗ interpretability ratchet: the plane got LESS measurable, or a gap is now unexcused.\n');
    for (const f of report.failures) console.error(`    ${f.metric} — ${f.verdict}${f.gapClosed ? ` (${f.knownGap} is CLOSED)` : ''}`);
    console.error(
      '\n  Do NOT green this by making a metric report a clean zero — its `vacuousPassWhen`\n' +
        '  says "the metric is unbuilt, not clean", and P-015 refusing to round a zero up to\n' +
        '  a pass is the only reason WI-6465 was ever findable. Build the producer, or\n' +
        '  reopen the gap item.\n',
    );
    process.exitCode = 1;
    return;
  }

  if (report.exempt.length > 0) {
    console.log(
      `✓ nothing regressed — but ${report.exempt.length} metric${report.exempt.length === 1 ? '' : 's'} ` +
        `${report.exempt.length === 1 ? 'has' : 'have'} never been interpretable and ${report.exempt.length === 1 ? 'is' : 'are'} ` +
        `waiting on a filed gap. The plane is not fully measurable.\n`,
    );
    return;
  }
  console.log('✓ every plane metric is interpretable, and none has regressed.\n');
}

function judgeGapLine(r: RatchetRow): string {
  if (!r.knownGap) {
    return 'never interpretable across the whole series, and NOTHING explains it — file the producer gap.';
  }
  if (r.gapClosed) {
    return `${r.knownGap} is CLOSED but this metric is still blind — the producer fix cannot be done.`;
  }
  return `awaiting ${r.knownGap} (open) — reported, not failing the build.`;
}

main().catch((err) => {
  console.error('interpretability ratchet failed to run:', err?.message ?? err);
  process.exitCode = 1;
});
