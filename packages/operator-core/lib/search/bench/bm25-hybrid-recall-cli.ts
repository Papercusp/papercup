/**
 * bm25-hybrid-recall-cli.ts — requirement R-13's instrument (plan
 * bm25-lexical-search-evoke-adoption-2026-10-10; decisions D-004, D-006).
 *
 * Known-item recall of HYBRID search (lexical leg + cosine leg, RRF) with the BM25
 * lexical leg vs the legacy ts_rank_cd leg, on the identical sample in ONE process:
 *
 *   npx tsx packages/operator-core/lib/search/bench/bm25-hybrid-recall-cli.ts \
 *     --pairs 60 --out docs/evidence/bm25-hybrid-recall-2026-10-11.json
 *
 * For each source with a BM25 lexical leg in `search:semantic` (work_item, session_turn)
 * it samples real rows, derives a probe query from each (the recall canary's
 * `deriveCanaryQuery`, alternating fragment and keyword styles), and runs that query
 * through `runHybridSearch` — the engine `search:semantic` calls — once per arm. The arm
 * is set by `PAPERCUSP_FLAG_PAPERCUSP_BM25_LEXICAL_RANKING` (=0 legacy, =1 BM25), which
 * `getFlag` re-reads on every call, so both arms share the process, the pool and the
 * sample. Each arm records the engine the seam (`lexicalEngine`) actually chose; a run
 * whose arms did not run different engines is reported `invalid`, not `pass`.
 *
 * Only the lexical leg may differ between arms: the query embedding is computed once per
 * query and reused, so the cosine leg is identical. Fused recall is read before any
 * rerank (R-13 is about fusion, not the cross-encoder).
 *
 * READ-ONLY against PG. Writes the JSON artifact and a Markdown summary beside it.
 * Exit 0 = pass, 1 = fail or invalid, 2 = could not run.
 */
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import type { Sql } from 'postgres';

import {
  ARMS,
  LATENCY_P95_CEILING_MS,
  MIN_PAIRS_PER_SOURCE,
  RECALL_K,
  armOrder,
  overallLatencyVerdict,
  overallVerdict,
  rankOf,
  redactPairsForArtifact,
  sampleFingerprint,
  summarizeSource,
  warmQueryEmbeddings,
  type Arm,
  type PairResult,
  type QueryStyle,
} from './bm25-hybrid-recall';

const PLAN = 'bm25-lexical-search-evoke-adoption-2026-10-10';

function argValue(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

/** Search source name → the BM25 corpus table its lexical leg consults. */
const SOURCE_TABLES = { work_item: 'work_items', session_turn: 'session_turns' } as const;
type SourceName = keyof typeof SOURCE_TABLES;

interface Candidate {
  id: string;
  text: string;
}

async function sampleCandidates(sql: Sql, source: SourceName, workspaceId: string, want: number, seed: string): Promise<Candidate[]> {
  const pool = Math.max(want * 4, 40);
  if (source === 'work_item') {
    return sql<Candidate[]>`
      SELECT issue_id AS id, coalesce(title, '') || E'\n' || coalesce(body, '') AS text
        FROM harness_shared.engineer_issues
       WHERE workspace_id = ${workspaceId}
         AND length(coalesce(body, '')) >= 200
       ORDER BY md5(issue_id || ${seed})
       LIMIT ${pool}`;
  }
  // session_turns is large: a repeatable block sample bounds the scan, then a seeded
  // order picks from it. The `scoped()` filter of the source admits the workspace or
  // 'default' rows; the sample uses the same rule.
  const seedInt = parseInt(seed.replace(/[^0-9]/g, '').slice(0, 9) || '13', 10);
  return sql.unsafe<Candidate[]>(
    `SELECT source_kind || ':' || session_id || ':' || turn_idx AS id, text
       FROM harness_shared.session_turns TABLESAMPLE SYSTEM (1) REPEATABLE (${seedInt})
      WHERE (workspace_id = $1 OR workspace_id = 'default')
        AND length(text) BETWEEN 200 AND 20000
      ORDER BY md5(session_id || ':' || turn_idx::text || $2)
      LIMIT ${pool}`,
    [workspaceId, seed],
  );
}

async function main(): Promise<number> {
  const perSource = Number(argValue('--pairs') ?? '60');
  const seed = argValue('--seed') ?? 'r13-20261011';
  const out = argValue('--out') ?? `docs/evidence/bm25-hybrid-recall-${new Date().toISOString().slice(0, 10)}.json`;
  const sourceNames = (argValue('--sources') ?? 'work_item,session_turn')
    .split(',')
    .map((s) => s.trim())
    .filter((s): s is SourceName => s in SOURCE_TABLES);
  if (!Number.isInteger(perSource) || perSource < 1) throw new Error('--pairs must be a positive integer');
  if (sourceNames.length === 0) throw new Error(`--sources must name one of ${Object.keys(SOURCE_TABLES).join(', ')}`);

  const [{ runHybridSearch }, { SEARCH_SOURCES }, { buildQueryEmbedder }, { activeWorkspaceId }, { getOrgPg }, flags, rank, canary] =
    await Promise.all([
      import('@papercusp/search'),
      import('../../agent-tools/search/sources'),
      import('../../agent-tools/search/embedder'),
      import('../../workspace-registry'),
      import('@papercusp/db-org'),
      import('@papercusp/flags'),
      import('../lexical/rank'),
      import('../../memory/bench/recall-canary'),
    ]);
  const envVar = flags.flagEnvVarName(flags.FLAGS.BM25_LEXICAL_RANKING);
  const envBefore = process.env[envVar];
  const { sql } = getOrgPg();
  const pg = sql as unknown as Sql;
  const workspaceId = activeWorkspaceId();

  // Which server is this? With no DSN in env, connection discovery can resolve a DIFFERENT
  // Postgres than the operator's (measured 2026-10-11: a bare shell on the dev box reached
  // the installed desktop app's embedded PG on :24680, which has no pg_textsearch, while the
  // operator reads :5432). Record it, and refuse before measuring if the BM25 arm cannot
  // run BM25 here: that run could only ever be `invalid`.
  const [server] = await pg<{ db: string; port: number | null; serverVersion: string; libver: string | null }[]>`
    SELECT current_database() AS db, inet_server_port() AS port,
           current_setting('server_version') AS "serverVersion",
           current_setting('pg_textsearch.library_version', true) AS libver`;
  process.env[envVar] = '1';
  const unavailable: string[] = [];
  for (const s of sourceNames) {
    if ((await rank.lexicalEngine(pg, SOURCE_TABLES[s])) !== 'bm25') unavailable.push(SOURCE_TABLES[s]);
  }
  if (envBefore === undefined) delete process.env[envVar];
  else process.env[envVar] = envBefore;
  console.log(
    `[r13] database ${server?.db} on port ${server?.port ?? 'unix-socket'}, PostgreSQL ${server?.serverVersion ?? 'unknown'}, ` +
      `pg_textsearch ${server?.libver ?? 'not loaded'}`,
  );
  if (unavailable.length > 0) {
    console.error(
      `[r13] REFUSING TO RUN: with the BM25 flag on, ${unavailable.join(', ')} still rank with the legacy engine on ` +
        `this server, so the comparison could only be invalid. Point the CLI at the operator's database ` +
        `(HARNESS_ADMIN_DATABASE_URL, as the operator's systemd unit sets it).`,
    );
    return 2;
  }

  // A null embedder degrades hybrid to lexical-only, which would measure a different
  // system than R-13 names. Refuse rather than report lexical recall as hybrid.
  const embedder = await buildQueryEmbedder({ acquireBudgetMs: 30_000 }).catch(() => null);
  if (!embedder) {
    console.error('[r13] REFUSING TO RUN: the query embedder is unavailable, so hybrid search would run lexical-only.');
    return 2;
  }
  const vectors = new Map<string, Promise<number[]>>();
  const sharedEmbedder = (text: string, signal?: AbortSignal): Promise<number[]> => {
    let v = vectors.get(text);
    if (!v) {
      v = embedder(text, signal);
      vectors.set(text, v);
      v.catch(() => vectors.delete(text));
    }
    return v;
  };

  // ---- Sample: identical pairs for both arms --------------------------------
  const pairs: PairResult[] = [];
  for (const source of sourceNames) {
    const candidates = await sampleCandidates(pg, source, workspaceId, perSource, seed);
    let taken = 0;
    for (const [i, c] of candidates.entries()) {
      if (taken >= perSource) break;
      const style: QueryStyle = i % 2 === 0 ? 'fragment' : 'keyword';
      const query = canary.deriveCanaryQuery(c.text, style);
      if (!query) continue;
      pairs.push({ source, targetId: c.id, style, query, arms: {} });
      taken += 1;
    }
    console.log(`[r13] ${source}: ${candidates.length} candidates -> ${taken} pairs`);
  }
  const fingerprint = sampleFingerprint(pairs);

  // ---- Embed every query before timing (D-021): otherwise the arm that runs first in a
  // pair also pays for the embedding, which lands in its R-18 latency.
  const embeddedQueries = await warmQueryEmbeddings(pairs, (q) => sharedEmbedder(q));
  console.log(`[r13] embedded ${embeddedQueries} distinct queries before timing`);

  // ---- Measure: both arms per pair, alternating which goes first -------------
  const startedAt = new Date().toISOString();
  try {
    for (const [i, p] of pairs.entries()) {
      const source = SEARCH_SOURCES.find((s) => s.name === p.source);
      if (!source) throw new Error(`search source ${p.source} is not registered`);
      const table = SOURCE_TABLES[p.source as SourceName];
      for (const arm of armOrder(i)) {
        process.env[envVar] = arm === 'bm25' ? '1' : '0';
        const engine = await rank.lexicalEngine(pg, table);
        const t0 = performance.now();
        const { results } = await runHybridSearch([source], {
          caller: 'bench:bm25-hybrid-recall',
          sql,
          query: p.query,
          workspaceId,
          scopeFilter: null,
          limit: RECALL_K,
          mode: 'hybrid',
          embedder: sharedEmbedder,
          embedTimeoutMs: 30_000,
        });
        p.arms[arm] = {
          rank: rankOf(results, p.source, p.targetId),
          latencyMs: Math.round((performance.now() - t0) * 10) / 10,
          engine,
          hits: results.length,
        };
      }
      if ((i + 1) % 10 === 0) console.log(`[r13] ${i + 1}/${pairs.length} pairs measured`);
    }
  } finally {
    if (envBefore === undefined) delete process.env[envVar];
    else process.env[envVar] = envBefore;
  }

  const summaries = sourceNames.map((s) => summarizeSource(s, pairs, Math.min(MIN_PAIRS_PER_SOURCE, perSource)));
  const verdict = overallVerdict(summaries);
  const latencyVerdict = overallLatencyVerdict(summaries);
  let commit: string | null = null;
  try {
    commit = execSync('git rev-parse HEAD', { encoding: 'utf8' }).trim();
  } catch {
    commit = null;
  }
  // Queries are sampled from live rows; scrub box identity before writing a tracked file.
  const written = redactPairsForArtifact(pairs);
  const artifact = {
    kind: 'bm25-hybrid-recall',
    plan: PLAN,
    requirement: 'R-13',
    decisions: ['D-004', 'D-006'],
    generatedAt: new Date().toISOString(),
    startedAt,
    commit,
    workspaceId,
    database: server ?? null,
    flagEnvVar: envVar,
    arms: ARMS,
    recallK: RECALL_K,
    seed,
    pairsPerSource: perSource,
    sampleFingerprint: fingerprint,
    sameProcess: true,
    sources: summaries,
    verdict,
    // R-18: end-to-end p95 of the BM25 arm against the legacy arm (D-019) and under the
    // per-source ceiling (D-020), per source.
    latencyRequirement: 'R-18',
    latencyDecisions: ['D-019', 'D-020', 'D-021'],
    latencyCeilingsMs: LATENCY_P95_CEILING_MS,
    // D-021: every query was embedded before any arm was timed, so neither arm's latency
    // carries the (shared, unchanged-by-this-plan) embedding cost.
    embeddingsPrecomputed: true,
    embeddedQueries,
    latencyVerdict,
    redactedQueries: written.redactedQueries,
    pairs: written.pairs,
  };
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, `${JSON.stringify(artifact, null, 2)}\n`);
  fs.writeFileSync(out.replace(/\.json$/, '.md'), renderMarkdown(artifact));
  for (const s of summaries) {
    const l = s.arms.legacy;
    const b = s.arms.bm25;
    console.log(
      `[r13] ${s.source}: legacy ${l.hitsAtK}/${l.scored} (MRR ${l.mrrAtK.toFixed(3)}) vs bm25 ${b.hitsAtK}/${b.scored} ` +
        `(MRR ${b.mrrAtK.toFixed(3)}) -> ${s.verdict}: ${s.reasons.join('; ')}; latency ${s.latency.verdict}: ${s.latency.reason}`,
    );
  }
  console.log(`[r13] verdict=${verdict} latencyVerdict=${latencyVerdict} sample=${fingerprint.slice(0, 12)} -> ${out}`);
  return verdict === 'pass' && latencyVerdict === 'pass' ? 0 : 1;
}

function renderMarkdown(a: {
  generatedAt: string;
  commit: string | null;
  recallK: number;
  sampleFingerprint: string;
  verdict: string;
  latencyVerdict: string;
  sources: ReturnType<typeof summarizeSource>[];
}): string {
  const rows = a.sources.flatMap((s) =>
    (['legacy', 'bm25'] as Arm[]).map((arm) => {
      const m = s.arms[arm];
      return `| ${s.source} | ${arm} | ${m.hitsAtK}/${m.scored} (${(m.recallAtK * 100).toFixed(1)}%) | ${m.mrrAtK.toFixed(3)} | ${m.zeroHit} | ${m.latencyP50Ms ?? '-'} | ${m.latencyP95Ms ?? '-'} | ${m.engines.join(', ')} |`;
    }),
  );
  const paired = a.sources.map(
    (s) => `| ${s.source} | ${s.paired.both} | ${s.paired.bm25Only} | ${s.paired.legacyOnly} | ${s.paired.neither} | ${s.verdict} |`,
  );
  return [
    `# BM25 hybrid recall A/B (R-13)`,
    ``,
    `Plan ${PLAN}, requirement R-13. Generated ${a.generatedAt} at commit ${a.commit ?? 'unknown'}.`,
    `Both arms ran in one process on the identical sample (fingerprint \`${a.sampleFingerprint}\`).`,
    `Recall is fused (RRF) recall@${a.recallK} before any rerank. Verdict: **${a.verdict}**.`,
    `Latency (R-18; D-019, D-020, D-021) is the p95 of the whole hybrid call with every query embedded before timing; the BM25 arm must not exceed legacy ` +
      `nor its source ceiling (${Object.entries(LATENCY_P95_CEILING_MS).map(([s, ms]) => `${s} ${ms} ms`).join(', ')}). ` +
      `Verdict: **${a.latencyVerdict}**.`,
    ``,
    `| source | arm | recall@${a.recallK} | MRR@${a.recallK} | zero-hit | p50 ms | p95 ms | engine |`,
    `|---|---|---|---|---|---|---|---|`,
    ...rows,
    ``,
    `| source | both found | BM25 only | legacy only | neither | verdict |`,
    `|---|---|---|---|---|---|`,
    ...paired,
    ``,
    ...a.sources.map((s) => `- ${s.source}: ${s.reasons.join('; ')}; latency ${s.latency.verdict}: ${s.latency.reason}`),
    ``,
  ].join('\n');
}

main().then(
  (code) => process.exit(code),
  (e) => {
    console.error(e);
    process.exit(2);
  },
);
