/**
 * projection-write-cost.integration.test.ts — per-projection-writer cost over
 * the FULL migrated schema on real Postgres (the P-004 "per-projection-writer
 * cost" axis). An integration test rather than a runner scenario on purpose:
 * it needs Docker (testcontainers PG), and `*.integration.test.ts` is exactly
 * the repo's Docker gate.
 *
 * What it measures: the cost of `applyOpVia` → projection writeToPg/deleteFromPg
 * per table tag, against a fresh database migrated 000-baseline → head (the
 * same chain embedded-pg applies on boot). Emits a `merge.projection-write`
 * artifact (tier 1) to test-results/p2p-perf/ so runs are inspectable next to
 * the runner's artifacts — but it is NOT in the runner baseline (Docker-gated
 * runs are not comparable to bare-metal runner runs).
 *
 * It is also a CORRECTNESS canary: every corpus table tag must dispatch to a
 * registered projection and at least the high-traffic writers must actually
 * apply rows against the real schema — a corpus/projection drift fails here,
 * not silently in a bench.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { createMigratedTestDb, type MigratedTestDb } from '@papercusp/test-config';
import { buildHarnessProjectionApply } from '../projections/register-all';
import type { OpEnvelope } from '../op-envelope-types';
import { corpusArray } from './corpus';
import { ScenarioMeter, startTimer } from './metrics';

const HERE = dirname(fileURLToPath(import.meta.url));
const SQL_DIR = resolve(HERE, '../../../../../../libs/papercusp/libs/db/sql');

const WS = 'ws-proj-cost';
const HARNESS = 'proj-cost';
const AUTHOR = 'a'.repeat(64);

let db: MigratedTestDb;
let sql: postgres.Sql;

beforeAll(async () => {
  const files = readdirSync(SQL_DIR)
    .filter((f) => /^\d+-.*\.sql$/.test(f))
    .sort((a, b) => Number(a.split('-')[0]) - Number(b.split('-')[0]))
    .map((f) => join(SQL_DIR, f));
  expect(files[0].endsWith('000-baseline.sql')).toBe(true);
  db = await createMigratedTestDb(files);
  sql = postgres(db.url, { max: 4, onnotice: () => {}, prepare: false });
}, 180_000);

afterAll(async () => {
  await sql?.end({ timeout: 5 });
  await db?.drop();
});

describe('per-projection-writer cost (real PG, full migrated schema)', () => {
  it(
    'applies a corpus through every registered projection and measures per-table write cost',
    async () => {
      const apply = buildHarnessProjectionApply({
        workspaceId: WS,
        harnessSlug: HARNESS,
        sql,
      });

      const ops = corpusArray({ seed: 99, count: 3_000, authorPubkey: AUTHOR, harnessSlug: HARNESS });
      const meter = new ScenarioMeter({
        scenario: 'merge.projection-write',
        tier: 1,
        params: { ops: ops.length, seed: 99 },
      });

      const applied = new Map<string, number>();
      const skipped = new Map<string, number>();
      for (const op of ops) {
        const env: OpEnvelope = {
          type: op.type,
          table: op.table,
          hbKey: op.hbKey,
          value: op.value,
          ts: op.ts,
          schema_version: op.schema_version,
          writerPubkey: op.author_pubkey,
        };
        const series = meter.metric(`write.${op.table}`, 'ms');
        const done = startTimer();
        const ok = await apply(env);
        series.push(done());
        const bucket = ok ? applied : skipped;
        bucket.set(op.table, (bucket.get(op.table) ?? 0) + 1);
        if (ok) meter.opsDecoded++;
      }

      for (const [table, n] of applied) meter.note(`${table}: ${n} applied`);
      for (const [table, n] of skipped) meter.note(`${table}: ${n} skipped (decode/shape guard)`);
      const artifact = meter.finish();

      const outDir = join(process.cwd(), '..', '..', 'test-results', 'p2p-perf', 'projection-write');
      try {
        mkdirSync(outDir, { recursive: true });
        writeFileSync(
          join(outDir, `${artifact.startedAt.replace(/[:.]/g, '-')}.json`),
          JSON.stringify(artifact, null, 2),
        );
      } catch {
        // artifact persistence is best-effort — the assertions below are the test
      }

      // Correctness canary: the high-traffic writers must actually apply
      // against the real schema. (Some corpus rows are intentionally dropped
      // by projections' defensive shape guards — that's fine — but a table
      // applying ZERO rows means corpus/projection drift or a schema break.)
      for (const tag of ['features-by-id', 'presence', 'claims', 'queue', 'issues']) {
        expect(applied.get(tag) ?? 0, `projection '${tag}' applied no rows`).toBeGreaterThan(0);
      }

      // The D-003 SLO holds while writing projections.
      expect(artifact.sloPassed).toBe(true);

      // And rows really landed in PG (spot-check the busiest table).
      const [{ count }] = await sql<[{ count: string }]>`
        SELECT count(*)::text AS count FROM harness_shared.harness_features_consolidated
        WHERE harness_slug = ${HARNESS}`;
      expect(Number(count)).toBeGreaterThan(0);
    },
    240_000,
  );
});
