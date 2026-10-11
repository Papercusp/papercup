/**
 * Pins the BM25 configuration page (plan bm25-lexical-search-evoke-adoption-2026-10-10,
 * requirement R-15, item P-010) to the code it describes.
 *
 * The page is authored through docs:author and projected into the docs tree. Every value it
 * states that the code also owns (flag key, preload list, availability signal, compaction
 * mode, schedule, lock timeout, advisory lock, reclaim thresholds) is read from that code
 * here, so a change to any of them fails this test until the page is updated with it.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { FLAGS } from '@papercusp/flags';
import {
  BM25_MAX_BLOAT_RATIO,
  BM25_RECLAIM_MIN_BYTES,
  CONCURRENT_DDL_LOCK_TIMEOUT,
} from '../search/lexical/bm25-maintenance';
import { BM25_CORPORA } from '../search/lexical/corpora';

const REPO = new URL('../../../../', import.meta.url);
const read = (rel: string): string => readFileSync(new URL(rel, REPO), 'utf8');

// Overridable so scripts/mutation-probe.sh can point the test at a mutated COPY of the page
// (copy-out mode) instead of mutating the shared tree. An absolute path resolves as-is.
const DOC = read(
  process.env.BM25_CONFIG_DOC_PATH ??
    'apps/operator-docs/src/content/docs/agent-insights/pg-textsearch-bm25-configuration.mdx',
);
const MIGRATION_1447 = read('libs/papercusp/libs/db/sql/1447-bm25-pg-textsearch-indexes.sql');
const EMBEDDED_PG_PATH = 'libs/papercusp/packages/embedded-postgres-server/src/index.js';
const EMBEDDED_PG = read(EMBEDDED_PG_PATH);
const PERIODIC = read('packages/operator-core/lib/dbos/periodic-workflows.ts');
const MAINTENANCE = read('packages/operator-core/lib/search/lexical/bm25-maintenance.ts');
const RANK = read('packages/operator-core/lib/search/lexical/rank.ts');

function section(heading: string): string {
  const start = DOC.indexOf(`## ${heading}`);
  expect(start, `missing section: ${heading}`).toBeGreaterThanOrEqual(0);
  const next = DOC.indexOf('\n## ', start + heading.length + 3);
  return DOC.slice(start, next >= 0 ? next : undefined);
}

describe('pg_textsearch (BM25) configuration page', () => {
  it('states the preload requirement and the signal that proves the library is loaded', () => {
    const preload = section('Preload is mandatory');
    expect(preload).toContain('`shared_preload_libraries`');
    expect(preload).toContain('`CREATE EXTENSION pg_textsearch` is **not** enough');
    expect(preload).toContain('restart');

    const signal = "current_setting('pg_textsearch.library_version', true)";
    expect(preload).toContain(signal);
    expect(MIGRATION_1447).toContain(signal);
    expect(RANK).toContain(signal);

    expect(preload).toContain('`skipped:library-not-preloaded`');
    expect(MIGRATION_1447).toContain("'skipped:library-not-preloaded'");
  });

  it('names the preload list embedded PG and pg-autotune actually use', () => {
    const list = /export const OPTIONAL_PRELOAD_LIBRARIES = Object\.freeze\((\[[^\]]*\])\)/.exec(EMBEDDED_PG);
    expect(list, 'OPTIONAL_PRELOAD_LIBRARIES not found in embedded-postgres-server').not.toBeNull();
    const libraries = JSON.parse(list![1]!.replace(/'/g, '"')) as string[];
    expect(libraries).toContain('pg_textsearch');
    expect(DOC).toContain(`\`OPTIONAL_PRELOAD_LIBRARIES\` (\`${JSON.stringify(libraries).replace(/"/g, "'")}\`)`);
    expect(DOC).toContain(`\`${EMBEDDED_PG_PATH}\``);
    expect(read('scripts/pg-autotune.ts')).toContain('presentPreloadLibraries(');
  });

  it('names the kill-switch flag by its real key', () => {
    expect(DOC).toContain(`\`${FLAGS.BM25_LEXICAL_RANKING}\``);
  });

  it('documents explicit index naming through to_bm25query with the registry index names', () => {
    const naming = section('Name the index explicitly in every query');
    expect(naming).toContain("to_bm25query($query, 'harness_shared.work_items_bm25')");
    expect(RANK).toContain('to_bm25query(');
    expect(BM25_CORPORA.map(c => c.indexName)).toContain('work_items_bm25');
    expect(naming).toContain('`lexicalLeg()`');
  });

  it('pins manual compaction, the maintenance schedule and the reclaim thresholds to the code', () => {
    const compaction = section('Compaction is manual, and maintenance owns it');
    expect(compaction).toContain("compaction = 'manual'");
    expect(MIGRATION_1447).toContain("c.text_config, 'manual')");

    const cron = /registerScheduled\(bm25MaintenanceWorkflow, \{[^}]*crontab: '([^']+)'/.exec(PERIODIC);
    expect(cron, 'bm25Maintenance crontab not found').not.toBeNull();
    expect(compaction).toContain(`crontab \`${cron![1]}\``);

    expect(compaction).toContain(`${BM25_MAX_BLOAT_RATIO}x its estimated live bytes`);
    expect(compaction).toContain(`at least ${BM25_RECLAIM_MIN_BYTES / (1024 * 1024)} MB`);
  });

  it('marks the older ts_rank_cd page superseded and points it at this page', () => {
    const legacy = read('apps/operator-docs/src/content/docs/agent-insights/lexical-leg-is-ts-rank-cd-not-bm25.mdx');
    expect(legacy).toMatch(/^status: superseded$/m);
    expect(legacy).toContain('(/internal/docs/agent-insights/pg-textsearch-bm25-configuration)');
    expect(DOC).toContain('(/internal/docs/agent-insights/lexical-leg-is-ts-rank-cd-not-bm25)');
  });

  it('pins the CONCURRENTLY lock_timeout and the advisory lock name to the maintenance module', () => {
    const trap = section('Compaction is manual, and maintenance owns it');
    expect(trap).toContain(`\`lock_timeout\` of \`${CONCURRENT_DDL_LOCK_TIMEOUT}\``);
    const lock = /const RECLAIM_LOCK = '([^']+)'/.exec(MAINTENANCE);
    expect(lock, 'RECLAIM_LOCK not found in bm25-maintenance.ts').not.toBeNull();
    expect(trap).toContain(`\`${lock![1]}\``);
  });
});
