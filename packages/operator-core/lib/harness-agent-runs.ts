/**
 * Agent-run metadata helpers — shared scan of `.papercusp/logs/` + PG mirror.
 *
 *   probeRunLiveness   — cheap "is this jsonl still being written?" check (tails last 4 KB for a terminal `{type:"result"}` line + mtime guard).
 *   scanAgentRuns      — walks the logs dir, parses filename + tail-reads the last `result` line for cost/tokens; returns full agent_runs row shape.
 *   scanAgentRunsCached — 2 s memoization keyed on dir mtime+size; the dashboard polls /agents every 5 s, so multiple concurrent panels share the file-walk cost.
 *   syncAgentRunsToPg  — fire-and-forget mirror of the scan results into `harness_<slug>.agent_runs` (INSERT … ON CONFLICT … + DELETE-not-in to keep the table in sync with the filesystem).
 *
 * Relocated from `app/api/_hono/harness.ts` (endpoint-hono-elimination-2026-05-21
 * A4 batch 35 — prereq for `/agents`, `/usage`, `/streams` route migrations
 * which all share these helpers).
 */
import { closeSync, existsSync, openSync, readdirSync, readSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { getHarnessPg } from '@papercusp/db-org';
import { harnessDir } from './harness-core';
import { type ProjectEntry } from './harness-registry';

// A run is "live" when its jsonl has no terminal `{type:"result"}` line AND
// its mtime is recent. The mtime guard prevents orphaned runs (harness
// SIGKILLed mid-stream) from being reported as forever-running.
const LIVE_MTIME_GRACE_MS = 10 * 60_000;

export function probeRunLiveness(jsonlPath: string, now: number): { running: boolean; lastEventTs: number } {
  if (!existsSync(jsonlPath)) return { running: false, lastEventTs: 0 };
  const stat = statSync(jsonlPath);
  const lastEventTs = stat.mtimeMs;
  const size = stat.size;
  if (size === 0) {
    return { running: now - lastEventTs < LIVE_MTIME_GRACE_MS, lastEventTs };
  }
  const tailSize = Math.min(size, 4096);
  const fd = openSync(jsonlPath, 'r');
  try {
    const buf = Buffer.allocUnsafe(tailSize);
    readSync(fd, buf, 0, tailSize, size - tailSize);
    const tail = buf.toString('utf8');
    const lines = tail.split('\n').map((l) => l.trim()).filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i--) {
      if (lines[i].includes('"type":"result"')) {
        return { running: false, lastEventTs };
      }
    }
    return { running: now - lastEventTs < LIVE_MTIME_GRACE_MS, lastEventTs };
  } finally {
    closeSync(fd);
  }
}

export interface AgentRunFull {
  runId: string;
  role: string;
  featureId: string | null;
  ts: number;
  sizeBytes: number;
  durationMs: number;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  running: boolean;
  lastEventTs: number;
}

export function scanAgentRuns(project: ProjectEntry): AgentRunFull[] {
  const logDir = join(harnessDir(project), 'logs');
  if (!existsSync(logDir)) return [];
  const now = Date.now();
  const out: AgentRunFull[] = [];
  for (const f of readdirSync(logDir)) {
    if (!f.endsWith('.jsonl')) continue;
    const base = f.replace(/\.jsonl$/, '');
    // Filename: <ts>-<role>[-<featureId>] e.g. 1777000000-worker-F-FIX-009
    const match = base.match(/^(\d+)-([a-z]+)(?:-(F-[A-Z0-9-]+))?$/);
    const jsonlPath = join(logDir, f);
    let jsonlMtime = 0;
    try { jsonlMtime = Math.floor(statSync(jsonlPath).mtimeMs); } catch {}
    const outPath = join(logDir, `${base}.out`);
    let outSize = 0;
    try { if (existsSync(outPath)) outSize = statSync(outPath).size; } catch {}
    const { running, lastEventTs } = probeRunLiveness(jsonlPath, now);
    let costUsd = 0, inputTokens = 0, outputTokens = 0, cacheReadTokens = 0, cacheCreationTokens = 0, durationMs = 0;
    // Tail-read the last `result` line for cost/tokens instead of scanning
    // the whole file. 16 KB is enough headroom for one result line.
    try {
      const stat = statSync(jsonlPath);
      const tailSize = Math.min(stat.size, 16384);
      if (tailSize > 0) {
        const fd = openSync(jsonlPath, 'r');
        try {
          const buf = Buffer.allocUnsafe(tailSize);
          readSync(fd, buf, 0, tailSize, stat.size - tailSize);
          const lines = buf.toString('utf8').split('\n').filter(Boolean);
          for (let i = lines.length - 1; i >= 0; i--) {
            if (!lines[i].includes('"type":"result"')) continue;
            try {
              const obj = JSON.parse(lines[i]);
              if (obj.type === 'result') {
                costUsd = obj.total_cost_usd ?? 0;
                inputTokens = obj.usage?.input_tokens ?? 0;
                outputTokens = obj.usage?.output_tokens ?? 0;
                cacheReadTokens = obj.usage?.cache_read_input_tokens ?? 0;
                cacheCreationTokens = obj.usage?.cache_creation_input_tokens ?? 0;
                durationMs = obj.duration_ms ?? 0;
                break;
              }
            } catch {}
          }
        } finally { closeSync(fd); }
      }
    } catch {}
    out.push({
      runId: base,
      role: match ? match[2] : 'unknown',
      featureId: (match && match[3]) || null,
      ts: match ? Number(match[1]) * 1000 : jsonlMtime,
      sizeBytes: outSize,
      durationMs,
      costUsd, inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens,
      running,
      lastEventTs: Math.floor(lastEventTs || jsonlMtime),
    });
  }
  return out.sort((a, b) => b.ts - a.ts);
}

// 2 s memoization keyed on logDir + dir-mtime + dir-size. The dashboard
// polls /agents every 5 s and frequently fans out across panels
// concurrently; raw scanAgentRuns walks 200+ jsonl files per call (4 KB
// tail-read each). With this cache, the first concurrent caller pays the
// file-walk cost; the rest reuse the result. Invalidation: dir
// mtime/size signature; appending to an existing jsonl does NOT bump
// mtime (we tolerate a 2 s lag on liveness/cost in exchange for
// throughput).
const __agentScanCacheKey = Symbol.for('papercusp.harnessAgentScanCache');
type AgentScanCacheGlobals = typeof globalThis & {
  [__agentScanCacheKey]?: Map<string, { sig: string; expires: number; value: AgentRunFull[] }>;
};
const __agentScanCache: Map<string, { sig: string; expires: number; value: AgentRunFull[] }> = (() => {
  const g = globalThis as AgentScanCacheGlobals;
  if (!g[__agentScanCacheKey]) g[__agentScanCacheKey] = new Map();
  return g[__agentScanCacheKey]!;
})();

export function scanAgentRunsCached(project: ProjectEntry, ttlMs = 2000): AgentRunFull[] {
  const logDir = join(harnessDir(project), 'logs');
  let sig = 'no-dir';
  try {
    if (existsSync(logDir)) {
      const st = statSync(logDir);
      sig = `${st.mtimeMs}:${st.size}`;
    }
  } catch {}
  const now = Date.now();
  const cached = __agentScanCache.get(logDir);
  if (cached && cached.sig === sig && cached.expires > now) return cached.value;
  const value = scanAgentRuns(project);
  __agentScanCache.set(logDir, { sig, expires: now + ttlMs, value });
  return value;
}

/**
 * Mirror agent-run metadata into `harness_<slug>.agent_runs`. Cheap
 * because row count is bounded by .jsonl file count (~200). Fire-and-forget.
 */
export async function syncAgentRunsToPg(project: ProjectEntry, runs: AgentRunFull[]): Promise<void> {
  const { sql } = getHarnessPg(project.slug);
  const now = Date.now();
  const ids = runs.map((r) => r.runId);
  if (runs.length > 0) {
    const rows = runs.map((r) => ({
      harness_slug: project.slug,
      run_id: r.runId,
      role: r.role,
      feature_id: r.featureId ?? null,
      ts: r.ts,
      size_bytes: r.sizeBytes,
      duration_ms: r.durationMs,
      cost_usd: r.costUsd,
      input_tokens: r.inputTokens,
      output_tokens: r.outputTokens,
      cache_read_tokens: r.cacheReadTokens,
      cache_creation_tokens: r.cacheCreationTokens,
      running: r.running,
      last_event_ts: r.lastEventTs,
      created_ts: now,
      updated_ts: now,
    }));
    await sql`
      INSERT INTO agent_runs ${sql(rows, 'harness_slug', 'run_id', 'role', 'feature_id', 'ts', 'size_bytes', 'duration_ms', 'cost_usd', 'input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_creation_tokens', 'running', 'last_event_ts', 'created_ts', 'updated_ts')}
      ON CONFLICT (harness_slug, run_id) DO UPDATE SET
        role                    = EXCLUDED.role,
        feature_id              = EXCLUDED.feature_id,
        ts                      = EXCLUDED.ts,
        size_bytes              = EXCLUDED.size_bytes,
        duration_ms             = EXCLUDED.duration_ms,
        cost_usd                = EXCLUDED.cost_usd,
        input_tokens            = EXCLUDED.input_tokens,
        output_tokens           = EXCLUDED.output_tokens,
        cache_read_tokens       = EXCLUDED.cache_read_tokens,
        cache_creation_tokens   = EXCLUDED.cache_creation_tokens,
        running                 = EXCLUDED.running,
        last_event_ts           = EXCLUDED.last_event_ts,
        updated_ts              = EXCLUDED.updated_ts
    `;
    await sql`
      DELETE FROM agent_runs
      WHERE harness_slug = ${project.slug}
        AND run_id NOT IN ${sql(ids)}
    `;
  } else {
    await sql`DELETE FROM agent_runs WHERE harness_slug = ${project.slug}`;
  }
}
