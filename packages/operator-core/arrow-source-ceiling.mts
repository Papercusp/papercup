/**
 * WI-6009 — What is the CEILING on "Postgres delivers Arrow directly"?
 *
 * D-004 rates columnar-at-source as the highest-leverage fix because it would kill
 * Arrow encode phase 1 (row->column transpose) and most of phase 2 (per-cell JS
 * builders). That is only true if the payload IS a query result.
 *
 * v2 — v1 was INVALID: it timed callPlansRead('items') against listPlanRows(), but
 * plans:items is wrapped in cachedRead(softTtlMs), so arm B hit a warm cache and
 * t_derive came out NEGATIVE. This version reconstructs the uncached derivation from
 * the same exports items.ts uses, so nothing is cached.
 *
 *   t_sql     PG query + pg-driver row materialization   <- the ONLY part ADBC replaces
 *   t_derive  the JS assembly on top (overlays, effectiveStatus, new row objects)
 *   t_encode  JSON.stringify of the final rows
 *
 * Run: cd packages/operator-core && npx tsx arrow-source-ceiling.mts
 */
delete process.env.VITEST;

const ROOT = '/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib';

const { listPlanRows, planItemsForRow } = await import(`${ROOT}/agent-tools/plans/source.ts`);
const { resolveEffectiveStatusForItems } = await import(
  `${ROOT}/agent-tools/plans/effective-status.ts`
);
const { getAllBlockedPlanItems, applyPlanItemBlocks, planItemRef } = await import(
  `${ROOT}/issue-blocks-merge.ts`
);
const { getAllPlanItemCoverage } = await import(`${ROOT}/plan-item-coverage.ts`);

const OPTS = { workspaceId: 'papercusp-workspace', harnessSlug: 'papercusp' };
const RUNS = 5;

const ms = (t0: bigint) => Number(process.hrtime.bigint() - t0) / 1e6;
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

async function bench<T>(label: string, fn: () => Promise<T> | T): Promise<{ v: T; med: number }> {
  const s: number[] = [];
  let v!: T;
  for (let i = 0; i <= RUNS; i++) {
    const t0 = process.hrtime.bigint();
    v = await fn();
    if (i > 0) s.push(ms(t0)); // discard warmup
  }
  const med = median(s);
  console.log(`  ${label.padEnd(48)} ${med.toFixed(1)} ms`);
  return { v, med };
}

// ── A. the PG read ────────────────────────────────────────────────────────────
console.log('\n=== A. t_sql — listPlanRows(), the PG read behind plans.items ===');
const { v: planRows, med: tSql } = await bench('t_sql', () =>
  listPlanRows({ ...OPTS, includeArchived: false }),
);
const rowsArr = planRows as Array<{ content?: string; items?: unknown[]; planSlug: string; archived: boolean; isLegacy?: boolean; status?: string }>;
console.log(`  plan rows: ${rowsArr.length}`);

let contentBytes = 0, viaJsonb = 0, viaMarkdownParse = 0;
for (const r of rowsArr) {
  contentBytes += (r.content ?? '').length;
  if ((r.items?.length ?? 0) > 0) viaJsonb++; else viaMarkdownParse++;
}
console.log(`  content markdown pulled from PG: ${(contentBytes / 1024 / 1024).toFixed(2)} MB`);
console.log(`  items from jsonb: ${viaJsonb} plans | needing a markdown PARSE: ${viaMarkdownParse} plans`);

// ── B. the JS derivation (uncached, reconstructed from items.ts) ─────────────
console.log('\n=== B. t_derive — the JS assembly on top (no cache) ===');
const { med: tOverlays } = await bench('  overlay reads (blocks + coverage, 2 PG round-trips)', async () => {
  const [b, c] = await Promise.all([
    getAllBlockedPlanItems().catch(() => new Map()),
    getAllPlanItemCoverage().catch(() => new Map()),
  ]);
  return [b, c] as const;
});
const allBlocked = await getAllBlockedPlanItems().catch(() => new Map<string, string[]>());
const coverage = await getAllPlanItemCoverage().catch(() => new Map());

const { v: finalRows, med: tLoop } = await bench('  derivation loop (plan x item -> new row objects)', () => {
  const out: unknown[] = [];
  for (const row of rowsArr) {
    if (row.isLegacy) continue;
    const { items: resolved, blockingIssues } = applyPlanItemBlocks(
      resolveEffectiveStatusForItems(planItemsForRow(row as never)).items,
      (id: string) => allBlocked.get(planItemRef(row.planSlug, id)),
    );
    for (const item of resolved) {
      const cov = coverage.get(planItemRef(row.planSlug, item.id));
      out.push({
        plan: row.planSlug,
        archived: row.archived,
        item,
        ...(blockingIssues[item.id] ? { blockedByIssues: blockingIssues[item.id] } : {}),
        ...(cov ? { coverage: cov } : {}),
      });
    }
  }
  return out;
});
const tDerive = tOverlays + tLoop;
console.log(`  final rows: ${(finalRows as unknown[]).length}`);

// ── C. encode ────────────────────────────────────────────────────────────────
console.log('\n=== C. t_encode — JSON.stringify ===');
const { v: json, med: tEncode } = await bench('t_encode', () => JSON.stringify(finalRows));
console.log(`  bytes: ${((json as string).length / 1024 / 1024).toFixed(2)} MB`);

// ── verdict ──────────────────────────────────────────────────────────────────
const total = tSql + tDerive + tEncode;
const pct = (x: number) => `${((x / total) * 100).toFixed(0)}%`;
console.log('\n=== VERDICT: what could columnar-at-source actually remove? ===');
console.log(`  t_sql     ${tSql.toFixed(1).padStart(7)} ms  ${pct(tSql).padStart(4)}   <- the ONLY part ADBC / Flight SQL replaces`);
console.log(`  t_derive  ${tDerive.toFixed(1).padStart(7)} ms  ${pct(tDerive).padStart(4)}   <- pure JS; PRODUCES the row objects that ARE the payload`);
console.log(`  t_encode  ${tEncode.toFixed(1).padStart(7)} ms  ${pct(tEncode).padStart(4)}   <- JSON.stringify`);
console.log(`  TOTAL     ${total.toFixed(1).padStart(7)} ms`);
console.log('\n  Everything after t_sql operates on JS row objects that Postgres never held,');
console.log('  so an Arrow encode would still pay the full transpose + per-cell build.');

process.exit(0);
