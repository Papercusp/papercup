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
 * R-18 (D-019, D-020, D-024, D-025, D-028, D-029). Per source the candidates split into three
 * disjoint samples: P (paired), W (warm-up), S (steady). The paired alternating pass over P
 * gives R-13, D-019's relative bound and D-029's looser cold ceiling (1,000 / 1,200 ms). Then
 * the warm-repeat pass over P (D-028): per query,
 * the BM25-arm call once untimed (it loads the call's pages) and once timed; the absolute
 * ceilings judge that pass's p95. Then, per source, an untimed BM25-only warm-up over W and a
 * timed BM25-only pass over S, whose queries no earlier pass has run (reported only, D-026).
 * pg_stat_statements deltas around the timed passes say how much of each lexical statement's
 * time was block reads. D-030: on every attributed call a reserved connection samples this
 * process's active backends' wait events every --wait-sample-ms (default 20; 0 = off), and
 * /proc/<pid>/schedstat deltas split their time into on-CPU and run-queue wait;
 * attribution[source].pairedBm25Tail lists the calls the cold p95 rests on.
 *
 * READ-ONLY against PG. Writes the JSON artifact and a Markdown summary beside it.
 * Exit 0 = pass, 1 = fail or invalid, 2 = could not run.
 */
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import type { Sql } from 'postgres';

import { monitorEventLoopDelay } from 'node:perf_hooks';

import {
  ARMS,
  COLD_LATENCY_P95_CEILING_MS,
  LATENCY_P95_CEILING_MS,
  callAttribution,
  parseSchedstat,
  schedstatDeltaMs,
  summarizeAttribution,
  summarizeWaitSamples,
  tailAttribution,
  MIN_PAIRS_PER_SOURCE,
  RECALL_K,
  armOrder,
  legDurations,
  overallLatencyVerdict,
  overallVerdict,
  rankOf,
  redactPairsForArtifact,
  sampleFingerprint,
  splitDisjointSamples,
  statementDeltas,
  summarizeSource,
  warmQueryEmbeddings,
  type Arm,
  type ArmObservation,
  type CallAttribution,
  type PairResult,
  type QueryStyle,
  type Schedstat,
  type StatementDelta,
  type StatementStat,
  type WaitPoll,
  type WaitProfile,
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

/** Host conditions at one instant: load average, PSI, and active PG backends (all sessions). */
interface HostSnapshot {
  at: string;
  loadavg: string | null;
  psiIoSome: string | null;
  psiCpuSome: string | null;
  activeBackends: number | null;
  /** D-027: a full-database dump (application `pcbackup`) has a transaction open; null if unreadable. */
  dumpInProgress: boolean | null;
}

/**
 * D-027: whether the scheduled full-database dump (papercusp-db-backup.service, which connects
 * as application `pcbackup`) has a transaction open right now. pg_dump holds one snapshot
 * transaction for the whole dump, so this is true from its first COPY to its last. Null when
 * pg_stat_activity is unreadable: the caller must treat that as unchecked, not as no dump.
 */
async function dumpActive(pg: Sql): Promise<boolean | null> {
  try {
    const [row] = await pg<{ on: boolean }[]>`
      SELECT EXISTS (
        SELECT 1 FROM pg_stat_activity
         WHERE application_name = 'pcbackup' AND xact_start IS NOT NULL AND pid <> pg_backend_pid()
      ) AS on`;
    return row?.on ?? null;
  } catch {
    return null;
  }
}

function firstLine(file: string): string | null {
  try {
    return fs.readFileSync(file, 'utf8').split('\n')[0]!.trim();
  } catch {
    return null;
  }
}

/** Default wait-sampler interval (D-030); `--wait-sample-ms 0` turns the sampler off. */
const WAIT_SAMPLE_MS = 20;

/**
 * D-030: this process's own backends. The org pools tag every connection
 * `pcusp:<label>:p<pid>` (libs/db connection.ts pgAppName), so the pattern matches this process's
 * pools only, never a peer's. Runs on the sampler's reserved connection, which excludes itself.
 */
function ownBackendPattern(): string {
  return `pcusp:%:p${process.pid}`;
}

async function ownBackendPids(conn: Sql): Promise<number[]> {
  const rows = await conn<{ pid: number }[]>`
    SELECT pid FROM pg_stat_activity
     WHERE application_name LIKE ${ownBackendPattern()} AND pid <> pg_backend_pid()`;
  return rows.map((r) => r.pid);
}

function readSchedstats(pids: readonly (number | 'self')[]): Map<number, Schedstat> {
  const out = new Map<number, Schedstat>();
  for (const pid of pids) {
    const s = parseSchedstat(firstLine(`/proc/${pid}/schedstat`));
    if (s) out.set(pid === 'self' ? process.pid : pid, s);
  }
  return out;
}

/**
 * D-030: poll pg_stat_activity for this process's active backends every `intervalMs` until the
 * returned stop function is called. Each poll awaits the previous one, so a slow poll delays the
 * next instead of stacking; a stalled sampler shows as a large `maxPollGapMs`.
 */
function startWaitSampler(
  conn: Sql,
  intervalMs: number,
  knownPids: ReadonlySet<number>,
): () => Promise<{ waits: WaitProfile | undefined; firstSight: Map<number, Schedstat> }> {
  let stopped = false;
  let failed = false;
  const polls: WaitPoll[] = [];
  // D-032: an active backend missing from the before-call pid list is baselined here, at first
  // sighting, instead of being counted from zero (run 12: such pids were long-lived).
  const firstSight = new Map<number, Schedstat>();
  const pattern = ownBackendPattern();
  const loop = (async () => {
    while (!stopped) {
      const atMs = performance.now();
      try {
        const rows = await conn<{ pid: number; t: string | null; e: string | null }[]>`
          SELECT pid, wait_event_type AS t, wait_event AS e FROM pg_stat_activity
           WHERE application_name LIKE ${pattern} AND state = 'active' AND pid <> pg_backend_pid()`;
        for (const r of rows) {
          if (knownPids.has(r.pid) || firstSight.has(r.pid)) continue;
          const s = parseSchedstat(firstLine(`/proc/${r.pid}/schedstat`));
          if (s) firstSight.set(r.pid, s);
        }
        polls.push({ atMs, samples: rows.map((r) => ({ waitEventType: r.t, waitEvent: r.e })) });
      } catch {
        failed = true;
        return;
      }
      if (!stopped) await new Promise((r) => setTimeout(r, intervalMs));
    }
  })();
  return async () => {
    stopped = true;
    await loop;
    return { waits: failed || polls.length === 0 ? undefined : summarizeWaitSamples(polls), firstSight };
  };
}

async function hostSnapshot(pg: Sql): Promise<HostSnapshot> {
  let activeBackends: number | null = null;
  try {
    const [row] = await pg<{ n: number }[]>`
      SELECT count(*)::int AS n FROM pg_stat_activity
       WHERE state = 'active' AND backend_type = 'client backend' AND pid <> pg_backend_pid()`;
    activeBackends = row?.n ?? null;
  } catch {
    activeBackends = null;
  }
  return {
    at: new Date().toISOString(),
    loadavg: firstLine('/proc/loadavg'),
    psiIoSome: firstLine('/proc/pressure/io'),
    psiCpuSome: firstLine('/proc/pressure/cpu'),
    activeBackends,
    dumpInProgress: await dumpActive(pg),
  };
}

/**
 * Cumulative pg_stat_statements counters for the lexical-leg statements over the two BM25
 * corpora (the BM25 top-k, the D-016 exact list, the GIN gate), or an error string. The
 * snapshot query names the same tables, so it excludes itself.
 */
async function statementSnapshot(pg: Sql, ids?: readonly string[]): Promise<StatementStat[] | string> {
  try {
    type Row = { queryid: string; calls: string; total: number; hit: string; read: string; readMs: number; query: string };
    // `[[:space:]]`, not a backslash class: inside a tagged template '\s' cooks to 's' (D-026).
    const rows = ids
      ? await pg<Row[]>`
          SELECT queryid::text AS queryid, calls::text AS calls, total_exec_time AS total,
                 shared_blks_hit::text AS hit, shared_blks_read::text AS read, shared_blk_read_time AS "readMs", '' AS query
            FROM pg_stat_statements(false)
           WHERE queryid = ANY(${ids as string[]}::bigint[])`
      : await pg<Row[]>`
          SELECT queryid::text AS queryid, calls::text AS calls, total_exec_time AS total,
                 shared_blks_hit::text AS hit, shared_blks_read::text AS read, shared_blk_read_time AS "readMs",
                 left(regexp_replace(query, '[[:space:]]+', ' ', 'g'), 200) AS query
            FROM pg_stat_statements
           WHERE dbid = (SELECT oid FROM pg_database WHERE datname = current_database())
             AND (query LIKE '%harness_shared.session_turns%' OR query LIKE '%harness_shared.work_items%')
             AND (query LIKE '%<@>%' OR query LIKE '%bm25%' OR query LIKE '%ts_rank_cd%' OR query LIKE '%count(*)::int AS n%')
             AND query NOT LIKE '%pg_stat_statements%'`;
    return rows.map((r) => ({
      queryid: r.queryid,
      calls: Number(r.calls),
      totalExecMs: Number(r.total),
      sharedBlksHit: Number(r.hit),
      sharedBlksRead: Number(r.read),
      sharedBlkReadMs: Number(r.readMs),
      query: r.query,
    }));
  } catch (e) {
    return `pg_stat_statements unreadable: ${e instanceof Error ? e.message : String(e)}`;
  }
}

function snapshotDelta(before: StatementStat[] | string, after: StatementStat[] | string): StatementDelta[] | string {
  if (typeof before === 'string') return before;
  if (typeof after === 'string') return after;
  return statementDeltas(before, after);
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
  const waitSampleMs = Number(argValue('--wait-sample-ms') ?? String(WAIT_SAMPLE_MS));
  const out = argValue('--out') ?? `docs/evidence/bm25-hybrid-recall-${new Date().toISOString().slice(0, 10)}.json`;
  const sourceNames = (argValue('--sources') ?? 'work_item,session_turn')
    .split(',')
    .map((s) => s.trim())
    .filter((s): s is SourceName => s in SOURCE_TABLES);
  if (!Number.isInteger(perSource) || perSource < 1) throw new Error('--pairs must be a positive integer');
  if (sourceNames.length === 0) throw new Error(`--sources must name one of ${Object.keys(SOURCE_TABLES).join(', ')}`);

  const { SEARCH_SEMANTIC_DEFER_HIGHLIGHT } = await import('../../agent-tools/search/semantic-engine-options');
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

  // ---- Sample: three disjoint sets per source (D-025) ------------------------
  // P (paired) is the first --pairs derivable candidates, the same sample the bench drew
  // before D-024 for a given seed; W (warm-up) and S (steady) are the next --pairs each.
  const pairs: PairResult[] = [];
  const warmupPairs: PairResult[] = [];
  const steadyPairs: PairResult[] = [];
  for (const source of sourceNames) {
    const candidates = await sampleCandidates(pg, source, workspaceId, perSource * 3, seed);
    const derived: PairResult[] = [];
    for (const [i, c] of candidates.entries()) {
      const style: QueryStyle = i % 2 === 0 ? 'fragment' : 'keyword';
      const query = canary.deriveCanaryQuery(c.text, style);
      if (query) derived.push({ source, targetId: c.id, style, query, arms: {} });
    }
    const split = splitDisjointSamples(derived, perSource);
    pairs.push(...split.paired);
    warmupPairs.push(...split.warmup);
    steadyPairs.push(...split.steady);
    console.log(
      `[r13] ${source}: ${candidates.length} candidates -> ${split.paired.length} paired, ` +
        `${split.warmup.length} warm-up, ${split.steady.length} steady (disjoint)`,
    );
  }
  const fingerprint = sampleFingerprint(pairs);

  // ---- Embed every timed query before timing (D-021): otherwise the arm that runs first in a
  // pair also pays for the embedding, which lands in its R-18 latency. Warm-up queries are
  // untimed and embed on demand.
  const embeddedQueries = await warmQueryEmbeddings([...pairs, ...steadyPairs], (q) => sharedEmbedder(q));
  console.log(`[r13] embedded ${embeddedQueries} distinct queries before timing`);

  // The lexical statements' queryids, refreshed from the full snapshot before each timed pass;
  // the per-call snapshots read only these, without query text, to stay cheap (D-026).
  let lexicalIds: string[] = [];
  const setLexicalIds = (snap: StatementStat[] | string) => {
    if (typeof snap !== 'string') lexicalIds = snap.map((s) => s.queryid);
  };
  const psiIoAvg10 = (): number | undefined => {
    const m = /avg10=([0-9.]+)/.exec(firstLine('/proc/pressure/io') ?? '');
    return m ? Number(m[1]) : undefined;
  };

  // D-030: a reserved connection for the wait sampler and the backend-pid lookup, so neither
  // borrows a pool connection from the call being timed, and both exclude themselves.
  const sampler =
    waitSampleMs > 0
      ? await (pg as unknown as { reserve(): Promise<Sql & { release(): void }> }).reserve().catch(() => null)
      : null;
  if (waitSampleMs > 0 && !sampler) console.warn('[r18] wait sampler unavailable: per-call waits not recorded');

  /**
   * One hybrid call for `p` with the flag set for `arm`, through the search:semantic path. With
   * `attribute`, the call is bracketed (outside the timed window) by statement snapshots, and the
   * bench process's CPU time and event-loop delay are sampled over it (D-026).
   */
  const measure = async (p: PairResult, arm: Arm, attribute = true): Promise<ArmObservation> => {
    const source = SEARCH_SOURCES.find((s) => s.name === p.source);
    if (!source) throw new Error(`search source ${p.source} is not registered`);
    process.env[envVar] = arm === 'bm25' ? '1' : '0';
    const engine = await rank.lexicalEngine(pg, SOURCE_TABLES[p.source as SourceName]);
    const track = attribute && lexicalIds.length > 0;
    // Outside the timed window, on every call: the D-020 ceiling is judged only when no call of
    // the source's paired pass met a dump (D-027).
    const dump = await dumpActive(pg);
    const snapBefore = track ? await statementSnapshot(pg, lexicalIds) : null;
    const psi = track ? psiIoAvg10() : undefined;
    // D-030: this process's backends (pool connections persist across calls) and their
    // schedstat, read outside the timed window; then the wait sampler runs over the call.
    const backendPids = track && sampler ? await ownBackendPids(sampler).catch(() => [] as number[]) : [];
    const schedT0 = performance.now();
    const schedBefore = track ? readSchedstats([...backendPids, 'self']) : null;
    const stopSampler = track && sampler ? startWaitSampler(sampler, waitSampleMs, new Set(backendPids)) : null;
    const loop = track ? monitorEventLoopDelay({ resolution: 10 }) : null;
    loop?.enable();
    const cpu0 = process.cpuUsage();
    const t0 = performance.now();
    const { results, legs } = await runHybridSearch([source], {
      caller: 'bench:bm25-hybrid-recall',
      sql,
      query: p.query,
      workspaceId,
      scopeFilter: null,
      limit: RECALL_K,
      mode: 'hybrid',
      embedder: sharedEmbedder,
      embedTimeoutMs: 30_000,
      // Mirrors search:semantic (SEARCH_SEMANTIC_DEFER_HIGHLIGHT), so R-18 times the
      // tool's path; it includes the final-page highlight hydration.
      deferHighlight: SEARCH_SEMANTIC_DEFER_HIGHLIGHT,
    });
    const latencyMs = Math.round((performance.now() - t0) * 10) / 10;
    const cpu = process.cpuUsage(cpu0);
    loop?.disable();
    const sampled = stopSampler ? await stopSampler() : undefined;
    const waits = sampled?.waits;
    let sched: Pick<
      CallAttribution,
      'pgCpuMs' | 'pgRunqMs' | 'clientRunqMs' | 'pgBackendsUnseen' | 'pgBackendsLateBaselined' | 'pgPidsImplausible'
    > = {};
    if (schedBefore) {
      // D-032: a pid in the after-list but not the before-list is NOT counted from zero (run 12:
      // such pids were long-lived; why they were missing is not known). It counts from the wait
      // sampler's first sighting when the sampler saw it, and is left out otherwise. Any per-pid
      // CPU delta above the schedstat window's wall time is dropped as implausible.
      const pidsAfter = sampler ? await ownBackendPids(sampler).catch(() => backendPids) : backendPids;
      const unseen = pidsAfter.filter((pid) => !backendPids.includes(pid));
      const schedAfter = readSchedstats([...backendPids, ...unseen, 'self']);
      const windowMs = performance.now() - schedT0;
      const self = new Map([...schedBefore].filter(([pid]) => pid === process.pid));
      const backends = new Map([...schedBefore].filter(([pid]) => pid !== process.pid));
      let lateBaselined = 0;
      for (const pid of unseen) {
        const b = sampled?.firstSight.get(pid);
        if (!b) continue;
        backends.set(pid, b);
        lateBaselined += 1;
      }
      const pgDelta = schedstatDeltaMs(backends, schedAfter, windowMs + 5);
      const selfDelta = schedstatDeltaMs(self, schedAfter);
      sched = {
        ...(pgDelta.pids > 0 ? { pgCpuMs: pgDelta.cpuMs, pgRunqMs: pgDelta.runqMs } : {}),
        ...(selfDelta.pids > 0 ? { clientRunqMs: selfDelta.runqMs } : {}),
        ...(sampler
          ? {
              pgBackendsUnseen: unseen.length,
              pgBackendsLateBaselined: lateBaselined,
              pgPidsImplausible: pgDelta.implausible,
            }
          : {}),
      };
    }
    // Per-leg time from the engine's own instrument, so an R-18 tail can be attributed to
    // a leg instead of inferred (WI-6554700010008520).
    const legMs = legDurations(legs);
    let attrib: CallAttribution | undefined;
    if (track && snapBefore && typeof snapBefore !== 'string') {
      const snapAfter = await statementSnapshot(pg, lexicalIds);
      if (typeof snapAfter !== 'string') {
        attrib = {
          ...callAttribution(snapBefore, snapAfter),
          clientCpuMs: Math.round((cpu.user + cpu.system) / 100) / 10,
          ...(loop ? { loopDelayMaxMs: Math.round(loop.max / 1e5) / 10 } : {}),
          ...(psi !== undefined ? { psiIoAvg10: psi } : {}),
          ...sched,
          ...(waits ? { waits } : {}),
        };
      }
    }
    return {
      rank: rankOf(results, p.source, p.targetId),
      latencyMs,
      engine,
      hits: results.length,
      ...(Object.keys(legMs).length ? { legMs } : {}),
      ...(attrib ? { attrib } : {}),
      dumpActive: dump,
    };
  };

  // ---- Paired pass over P: both arms per pair, alternating which goes first ----
  const startedAt = new Date().toISOString();
  const hostAtStart = await hostSnapshot(pg);
  const stmtBeforePaired = await statementSnapshot(pg);
  setLexicalIds(stmtBeforePaired);
  let stmtAfterPaired: StatementStat[] | string = 'not measured';
  let hostAtEnd = hostAtStart;
  const steadyHost: Record<string, { beforeWarmup: HostSnapshot; afterSteady: HostSnapshot }> = {};
  const steadyStatements: Record<string, StatementDelta[] | string> = {};
  let warmupCalls = 0;
  // D-028: the warm-repeat pass over P, BM25 arm only. Each entry carries the timed repeat.
  const warmPairs: PairResult[] = [];
  let warmStatements: StatementDelta[] | string = 'not measured';
  let warmHost: { before: HostSnapshot; after: HostSnapshot } | null = null;
  try {
    for (const [i, p] of pairs.entries()) {
      for (const arm of armOrder(i)) p.arms[arm] = await measure(p, arm);
      if ((i + 1) % 10 === 0) console.log(`[r13] ${i + 1}/${pairs.length} pairs measured`);
    }
    stmtAfterPaired = await statementSnapshot(pg);
    hostAtEnd = await hostSnapshot(pg);

    // ---- Warm-repeat pass over P (D-028): per query, the BM25-arm call once untimed, which
    // loads the call's pages, then once timed. The D-020 ceilings judge this pass's p95: the
    // path's own work, without the host's per-block read latency.
    const warmBefore = await hostSnapshot(pg);
    const stmtBeforeWarm = await statementSnapshot(pg);
    setLexicalIds(stmtBeforeWarm);
    for (const [i, p] of pairs.entries()) {
      await measure(p, 'bm25', false);
      warmPairs.push({ source: p.source, targetId: p.targetId, style: p.style, query: p.query, arms: { bm25: await measure(p, 'bm25') } });
      if ((i + 1) % 20 === 0) console.log(`[r18] ${i + 1}/${pairs.length} warm repeats measured`);
    }
    warmStatements = snapshotDelta(stmtBeforeWarm, await statementSnapshot(pg));
    warmHost = { before: warmBefore, after: await hostSnapshot(pg) };

    // ---- Steady pass (D-024/D-025), per source: untimed warm-up over W, then a timed
    // BM25-only pass over S, whose queries no earlier pass has run.
    for (const source of sourceNames) {
      const beforeWarmup = await hostSnapshot(pg);
      for (const p of warmupPairs.filter((w) => w.source === source)) {
        await measure(p, 'bm25', false);
        warmupCalls += 1;
      }
      const stmtBefore = await statementSnapshot(pg);
      setLexicalIds(stmtBefore);
      const mine = steadyPairs.filter((s) => s.source === source);
      for (const [i, p] of mine.entries()) {
        p.arms.bm25 = await measure(p, 'bm25');
        if ((i + 1) % 20 === 0) console.log(`[r18] ${source}: ${i + 1}/${mine.length} steady calls measured`);
      }
      steadyStatements[source] = snapshotDelta(stmtBefore, await statementSnapshot(pg));
      steadyHost[source] = { beforeWarmup, afterSteady: await hostSnapshot(pg) };
    }
  } finally {
    if (envBefore === undefined) delete process.env[envVar];
    else process.env[envVar] = envBefore;
    sampler?.release();
  }
  const pairedStatements = snapshotDelta(stmtBeforePaired, stmtAfterPaired);

  const minPairs = Math.min(MIN_PAIRS_PER_SOURCE, perSource);
  const summaries = sourceNames.map((s) => summarizeSource(s, pairs, minPairs, steadyPairs, warmPairs));
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
  const writtenSteady = redactPairsForArtifact(steadyPairs);
  const writtenWarm = redactPairsForArtifact(warmPairs);
  const perSourceCount = (list: PairResult[]) =>
    Object.fromEntries(sourceNames.map((s) => [s, list.filter((p) => p.source === s).length]));
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
    // R-18: the paired BM25 arm's end-to-end p95 against the legacy arm's (D-019), and the
    // warm-repeat pass's BM25 p95 (sources[].warmRepeat.latencyP95Ms) under the per-source
    // ceiling (D-020, D-028). The cold paired p95 is judged against the looser cold ceiling
    // (coldLatencyCeilingsMs, D-029) on every run; sources[].dumpOverlap stays recorded (D-027).
    latencyRequirement: 'R-18',
    latencyDecisions: ['D-019', 'D-020', 'D-021', 'D-026', 'D-027', 'D-028', 'D-029', 'D-030'],
    waitSampleMs,
    latencyCeilingsMs: LATENCY_P95_CEILING_MS,
    coldLatencyCeilingsMs: COLD_LATENCY_P95_CEILING_MS,
    // D-028: right after the paired pass, per query of P, the BM25-arm call untimed then timed.
    warmRepeatPass: {
      perSource: perSourceCount(warmPairs),
      host: warmHost,
      statementStats: warmStatements,
    },
    // D-024/D-025: after the warm-repeat pass, per source an untimed BM25-only warm-up over W
    // and a timed BM25-only pass over S. P, W and S are disjoint by target id and query.
    // sources[].steady.latencyP95Ms is reported data only (D-026).
    steadyPass: {
      order: [
        'paired over P',
        'warm-repeat over P: BM25 arm untimed, then timed (D-028)',
        'per source: untimed warm-up over W, then timed BM25-only over S',
      ],
      pairedPerSource: perSourceCount(pairs),
      warmupPerSource: perSourceCount(warmupPairs),
      steadyPerSource: perSourceCount(steadyPairs),
      warmupCalls,
      warmupSampleFingerprint: sampleFingerprint(warmupPairs),
      steadySampleFingerprint: sampleFingerprint(steadyPairs),
      host: steadyHost,
    },
    // Per-statement pg_stat_statements deltas for the lexical-leg statements, slowest first:
    // readTimeShare is the share of execution spent reading blocks not in shared buffers.
    statementStats: {
      note: 'pg_stat_statements is cluster-wide: a delta also counts concurrent calls of the same normalized statement by other sessions; compare calls with the bench calls.',
      paired: pairedStatements,
      steady: steadyStatements,
    },
    // D-026: per-call attribution sums (pairs[].arms[].attrib and steadyPairs[].arms.bm25.attrib
    // hold each call). outsideExecShare = the lexical leg's time outside statement execution.
    attribution: Object.fromEntries(sourceNames.map((s) => [s, {
      pairedBm25: summarizeAttribution(pairs.filter((p) => p.source === s).flatMap((p) => (p.arms.bm25 ? [p.arms.bm25] : []))),
      // D-030: the calls the cold p95 rests on, with their waits and schedstat deltas.
      pairedBm25Tail: tailAttribution(pairs.filter((p) => p.source === s).flatMap((p) => (p.arms.bm25 ? [p.arms.bm25] : []))),
      pairedLegacy: summarizeAttribution(pairs.filter((p) => p.source === s).flatMap((p) => (p.arms.legacy ? [p.arms.legacy] : []))),
      steady: summarizeAttribution(steadyPairs.filter((p) => p.source === s).flatMap((p) => (p.arms.bm25 ? [p.arms.bm25] : []))),
      warmRepeat: summarizeAttribution(warmPairs.filter((p) => p.source === s).flatMap((p) => (p.arms.bm25 ? [p.arms.bm25] : []))),
    }])),
    // D-021: every query was embedded before any arm was timed, so neither arm's latency
    // carries the (shared, unchanged-by-this-plan) embedding cost.
    embeddingsPrecomputed: true,
    embeddedQueries,
    // Host conditions bracketing the timed loop. Context for reading a latency, never a
    // cause by itself: attribute a tail with sources[].arms[].legP95Ms / pairs[].arms[].legMs.
    host: { atStart: hostAtStart, atEnd: hostAtEnd },
    latencyVerdict,
    redactedQueries: written.redactedQueries + writtenSteady.redactedQueries + writtenWarm.redactedQueries,
    pairs: written.pairs,
    warmPairs: writtenWarm.pairs,
    steadyPairs: writtenSteady.pairs,
  };
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, `${JSON.stringify(artifact, null, 2)}\n`);
  fs.writeFileSync(out.replace(/\.json$/, '.md'), renderMarkdown(artifact));
  for (const s of summaries) {
    const l = s.arms.legacy;
    const b = s.arms.bm25;
    console.log(
      `[r13] ${s.source}: legacy ${l.hitsAtK}/${l.scored} (MRR ${l.mrrAtK.toFixed(3)}) vs bm25 ${b.hitsAtK}/${b.scored} ` +
        `(MRR ${b.mrrAtK.toFixed(3)}) -> ${s.verdict}: ${s.reasons.join('; ')}; ` +
        `cold paired BM25 p95 ${b.latencyP95Ms ?? '-'} ms, warm-repeat p95 ${s.warmRepeat?.latencyP95Ms ?? '-'} ms ` +
        `(repeats with block reads: ${s.warmRepeatReadCalls ?? 'unknown'}), steady p95 ${s.steady?.latencyP95Ms ?? '-'} ms (reported only); ` +
        `dump overlap ${s.dumpOverlap === undefined ? 'unchecked' : String(s.dumpOverlap)}; ` +
        `latency ${s.latency.verdict}: ${s.latency.reason}`,
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
  host: { atStart: HostSnapshot; atEnd: HostSnapshot };
  steadyPass: { host: Record<string, { beforeWarmup: HostSnapshot; afterSteady: HostSnapshot }>; warmupPerSource: Record<string, number> };
  statementStats: { paired: StatementDelta[] | string; steady: Record<string, StatementDelta[] | string> };
}): string {
  const steadyRows = a.sources.map((s) => {
    const ceiling = LATENCY_P95_CEILING_MS[s.source];
    const coldCeiling = COLD_LATENCY_P95_CEILING_MS[s.source];
    return `| ${s.source} | ${s.warmRepeat?.scored ?? 0} | ${s.warmRepeat?.latencyP50Ms ?? '-'} | ${s.warmRepeat?.latencyP95Ms ?? '-'} | ${s.warmRepeatReadCalls ?? '?'} | ${ceiling ?? '-'} | ${s.arms.bm25.latencyP95Ms ?? '-'} | ${coldCeiling ?? '-'} | ${s.steady?.latencyP95Ms ?? '-'} | ${s.latency.verdict} |`;
  });
  const stmtRows = (label: string, d: StatementDelta[] | string) =>
    typeof d === 'string'
      ? [`| ${label} | - | - | - | - | ${d} |`]
      : d.slice(0, 8).map((x) =>
          `| ${label} | ${x.calls} | ${x.meanExecMs ?? '-'} | ${x.sharedBlksRead} | ${x.readTimeShare == null ? '-' : `${Math.round(x.readTimeShare * 100)}%`} | \`${x.query.slice(0, 100).replace(/\|/g, '\\|')}\` |`,
        );
  const legRows = a.sources.flatMap((s) =>
    (['legacy', 'bm25'] as Arm[]).flatMap((arm) =>
      Object.entries(s.arms[arm].legP95Ms).map(([leg, ms]) => `| ${s.source} | ${arm} | ${leg} | ${ms ?? '-'} |`),
    ),
  );
  const host = (h: HostSnapshot) =>
    `${h.at}: loadavg ${h.loadavg ?? '?'}; io ${h.psiIoSome ?? '?'}; cpu ${h.psiCpuSome ?? '?'}; active backends ${h.activeBackends ?? '?'}`;
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
    `Latency (R-18; D-019, D-020, D-021, D-028, D-029) is the p95 of the whole hybrid call with every timed query embedded before timing. ` +
      `On the paired cold pass the BM25 arm must not exceed legacy and must stay under its cold ceiling ` +
      `(${Object.entries(COLD_LATENCY_P95_CEILING_MS).map(([s, ms]) => `${s} ${ms} ms`).join(', ')}); the warm-repeat pass ` +
      `(each paired query's BM25-arm call run untimed, then timed) must stay under its source ceiling ` +
      `(${Object.entries(LATENCY_P95_CEILING_MS).map(([s, ms]) => `${s} ${ms} ms`).join(', ')}). The ` +
      `steady pass (D-024, D-025: novel queries on a disjoint sample) is reported, not judged. Verdict: **${a.latencyVerdict}**.`,
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
    `## Warm-repeat pass (D-028) and the reported passes`,
    ``,
    `Repeats with block reads is an upper bound from pg_stat_statements deltas (peers running the same statement also count).`,
    ``,
    `| source | warm repeats | warm p50 ms | warm p95 ms | repeats with block reads | ceiling ms | cold paired BM25 p95 ms | cold ceiling ms | steady p95 ms | R-18 |`,
    `|---|---|---|---|---|---|---|---|---|`,
    ...steadyRows,
    ``,
    ...Object.entries(a.steadyPass.host).flatMap(([s, h]) => [
      `- ${s} before warm-up: ${host(h.beforeWarmup)}`,
      `- ${s} after steady pass: ${host(h.afterSteady)}`,
    ]),
    ``,
    `## Lexical statements (pg_stat_statements deltas, slowest first)`,
    ``,
    `Cluster-wide: a delta also counts concurrent calls of the same normalized statement by other sessions. Read share = time reading blocks not in shared buffers / execution time.`,
    ``,
    `| pass | calls | mean ms | blocks read | read share | statement |`,
    `|---|---|---|---|---|---|`,
    ...stmtRows('paired', a.statementStats.paired),
    ...Object.entries(a.statementStats.steady).flatMap(([s, d]) => stmtRows(`steady ${s}`, d)),
    ``,
    `## Where the time goes (attribution only; R-18 judges the whole call)`,
    ``,
    `p95 of each leg's own duration, from the engine's \`legs.*.sourceCalls[].durationMs\`. Legs run concurrently, so they do not add up to the call.`,
    ``,
    `| source | arm | leg | p95 ms |`,
    `|---|---|---|---|`,
    ...(legRows.length ? legRows : [`| - | - | not recorded | - |`]),
    ``,
    `Host at start: ${host(a.host.atStart)}`,
    ``,
    `Host at end: ${host(a.host.atEnd)}`,
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
