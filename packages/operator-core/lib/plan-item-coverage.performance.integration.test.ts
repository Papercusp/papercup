/**
 * P-010 matched read benchmark. Normal CI exercises the probe on private PG.
 * An explicit PAPERCUSP_P010_LIVE_PROBE=1 runs SELECTs only against the operator
 * store in ONE repeatable-read/read-only transaction. No production data changes,
 * cache eviction, profiler changes, or service restart are performed.
 *
 * The control is the previous consumer algorithm: full authoritative coverage,
 * then select the requested plan. Candidate narrows that same production reader.
 * SQL wall time includes pool/queue/transfer/decoding; it is NOT database CPU or
 * isolated JSON decoding time. Burst requests deliberately share the frozen
 * transaction's one connection, identically on both sides.
 */
import { afterAll, describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { execFileSync } from 'node:child_process';
import { getTestPg } from '@papercusp/test-config/pg';
import { HARNESS_FEATURES_CONSOLIDATED_DDL } from '../test/_work-items-schema';
import { getHarnessAdminUrl } from './embedded-pg-discovery';

const live = process.env.PAPERCUSP_P010_LIVE_PROBE === '1';
const h = vi.hoisted(() => ({ sql: undefined as unknown as postgres.Sql }));
vi.mock('@papercusp/db-org', async (original) => ({
  ...(await original<typeof import('@papercusp/db-org')>()),
  getOrgPg: () => ({ sql: h.sql }),
}));
vi.mock('./fleet/assignments', async (original) => {
  const actual = await original<typeof import('./fleet/assignments')>();
  return { ...actual, listFleetAssignments: process.env.PAPERCUSP_P010_LIVE_PROBE === '1'
    ? actual.listFleetAssignments : async () => [] };
});

const { getAllPlanItemCoverage } = await import('./plan-item-coverage');
type Phase = { sql: string; wallMs: number; rows: number; ok: boolean; error?: string };
let phases: Phase[] = [];
let root: postgres.Sql | undefined;
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

// Preserve postgres-js Builder/Query identity so parameterised nested fragments
// still compose normally. Observe the actual lazy execution boundary, not when
// a SQL fragment is constructed. The query's own result supplies its population.
function observed(sql: postgres.Sql): postgres.Sql {
  const observe = (query: any) => {
    if (!query || typeof query.then !== 'function') return query;
    const originalThen = query.then.bind(query);
    let recorded = false;
    query.then = (resolve: any, reject: any) => {
      const started = performance.now();
      return originalThen((result: any) => {
        if (!recorded) {
          recorded = true;
          phases.push({ sql: result.statement?.string ?? query.strings?.join('?') ?? 'unknown',
            wallMs: performance.now() - started, rows: result.length, ok: true });
        }
        return resolve?.(result);
      }, (error: Error) => {
        if (!recorded) {
          recorded = true;
          phases.push({ sql: query.strings?.join('?') ?? 'unknown', wallMs: performance.now() - started,
            rows: 0, ok: false, error: error.message });
        }
        return reject?.(error);
      });
    };
    return query;
  };
  return new Proxy(sql, {
    apply: (target, self, args) => observe(Reflect.apply(target, self, args)),
    get: (target, property) => property === 'unsafe'
      ? (...args: any[]) => observe(Reflect.apply(target.unsafe, target, args))
      : Reflect.get(target, property),
  }) as postgres.Sql;
}

function normalized(map: Awaited<ReturnType<typeof getAllPlanItemCoverage>>, plan: string) {
  return [...map].filter(([ref]) => ref.startsWith(plan + '#'))
    .map(([ref, value]) => [ref, { ...value,
      links: [...value.links].sort((a, b) => a.workItemId.localeCompare(b.workItemId) || a.rel.localeCompare(b.rel)),
      workers: [...value.workers].sort(),
    }]).sort(([a], [b]) => String(a).localeCompare(String(b)));
}

afterAll(async () => { await root?.end({ timeout: 5 }); });

describe('matched plan coverage phase benchmark', () => {
  it('preserves exact scoped coverage and records the reduced hydrated population', async () => {
    const plan = process.env.PAPERCUSP_P010_PLAN ?? 'p010-benchmark';
    if (live) {
      root = postgres(getHarnessAdminUrl(), { max: 1, onnotice: () => {} });
    } else {
      const uri = await getTestPg();
      const name = `plic_perf_${randomBytes(5).toString('hex')}`;
      const admin = postgres(uri, { max: 1, onnotice: () => {} });
      try { await admin.unsafe(`CREATE DATABASE "${name}"`); } finally { await admin.end(); }
      const url = new URL(uri); url.pathname = '/' + name;
      root = postgres(url.toString(), { max: 1, onnotice: () => {} });
      await root`CREATE SCHEMA harness_shared`;
      await root.unsafe(HARNESS_FEATURES_CONSOLIDATED_DDL);
      await root`CREATE TABLE harness_shared.coord_links (
        dst_ref text, rel text, src_kind text, src_ref text, dst_kind text)`;
      await root.unsafe(`CREATE INDEX work_items_plan_item_stamp_idx ON harness_shared.work_items
        ((payload->'plan_item'->>'plan_slug'), (payload->'plan_item'->>'item_id'))
        WHERE payload->'plan_item' IS NOT NULL`);
      await root`INSERT INTO harness_shared.work_items
        (workspace_id,harness_slug,feature_id,item_kind,status,payload,updated_ts)
        SELECT 'papercusp-workspace','web','WI-bench-' || n,'bug',
          CASE WHEN n % 3 = 0 THEN 'done' ELSE 'open' END,
          jsonb_build_object('plan_item',jsonb_build_object('plan_slug',
            CASE WHEN n <= 8 THEN ${plan} ELSE 'unrelated-benchmark' END,'item_id','P-' || n),
            '_claimHold', n % 5 = 0),100 FROM generate_series(1,128) n`;
    }
    const windows = live ? 10 : 2;
    const requests = live ? 100 : 4;
    const samples: any[] = [];
    const fingerprints = Object.fromEntries(['plan-item-coverage.ts','fleet/assignments.ts']
      .map(path => [path, createHash('sha256').update(readFileSync(new URL(path, import.meta.url))).digest('hex')]));
    const startedAt = new Date().toISOString();
    let identity: any;
    let expected: ReturnType<typeof normalized>;
    await root!.begin('isolation level repeatable read read only', async (tx) => {
      await tx`SET LOCAL statement_timeout = '30s'`;
      identity = (await tx`SELECT current_database() AS database, version() AS postgres,
        txid_current_snapshot()::text AS snapshot, now() AS transaction_time`)[0];
      h.sql = observed(tx as unknown as postgres.Sql);
      expected = normalized(await getAllPlanItemCoverage(), plan);
      expect(expected.length).toBeGreaterThan(0);
      for (const concurrency of [1, 8]) {
        for (let window = 0; window < windows; window++) {
          const arms = window % 2 === 0 ? ['control','candidate'] : ['candidate','control'];
          for (const arm of arms) {
            for (let offset = 0; offset < requests; offset += concurrency) {
              const batchSize = Math.min(concurrency, requests - offset);
              const phaseStart = phases.length;
              const batch = await Promise.all(Array.from({ length: batchSize }, async (_, index) => {
                const t0 = performance.now();
                try {
                  const coverage = await getAllPlanItemCoverage(arm === 'candidate' ? { planSlug: plan } : {});
                  const result = normalized(coverage, plan);
                  const equal = digest(result) === digest(expected);
                  return { index: offset + index, ok: equal, wallMs: performance.now() - t0,
                    resultHash: digest(result), totalCoverageRefs: coverage.size, selectedRefs: result.length,
                    ...(equal ? {} : { error: 'exact coverage differs from frozen control' }) };
                } catch (error) {
                  return { index: offset + index, ok: false, wallMs: performance.now() - t0,
                    error: error instanceof Error ? error.message : String(error) };
                }
              }));
              samples.push({ concurrency, window, arm, batch, phases: phases.slice(phaseStart).map(p => ({
                ...p, sql: undefined, sqlHash: digest(p.sql),
                kind: /work_item_id[\s\S]*FROM harness_shared\.work_items/.test(p.sql) ? 'stamp' : 'other',
              })) });
            }
          }
        }
      }
      expect(normalized(await getAllPlanItemCoverage(), plan)).toEqual(expected);
    });
    const report = { schemaVersion: 1, workItem: 'WI-10004889', startedAt, endedAt: new Date().toISOString(),
      mode: live ? 'live-read-only' : 'private-PG', host: hostname(), plan, identity, fingerprints,
      sourceSha: execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),
      control: 'full production coverage then exact plan selection', candidate: 'production planSlug restriction',
      profiles: { concurrency: [1,8], windows, requestsPerSideWindow: requests,
        cache: 'no coverage result cache; PostgreSQL cache uncontrolled and shared',
        connection: 'one read-only repeatable-read connection on both sides' },
      populationHash: digest(expected), samples,
      limitations: ['SQL wall includes queue/transfer/decoding; not database CPU or isolated JSON extraction.',
        'Shared PostgreSQL cache is not a cold-cache benchmark.',
        'This is the production reader on frozen live data, not HTTP end-to-end timing.'],
    };
    if (process.env.PAPERCUSP_P010_REPORT) writeFileSync(process.env.PAPERCUSP_P010_REPORT, JSON.stringify(report) + '\n');
    const outcomes = samples.flatMap(s => s.batch);
    expect(outcomes.filter(s => !s.ok)).toEqual([]);
    const stampRows = (arm: string) => samples.filter(s => s.arm === arm)
      .flatMap(s => s.phases).filter(p => p.kind === 'stamp').reduce((sum, p) => sum + p.rows, 0);
    expect(stampRows('candidate')).toBeGreaterThan(0);
    expect(stampRows('candidate')).toBeLessThan(stampRows('control'));
    console.log(JSON.stringify({ mode: report.mode, samples: outcomes.length, failures: outcomes.filter(s => !s.ok).length,
      selectedRefs: expected!.length, stampRows: { control: stampRows('control'), candidate: stampRows('candidate') } }));
  }, 3_600_000);
});
