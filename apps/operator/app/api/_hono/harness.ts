/**
 * Harness management API.
 *
 * Reads state from `.harness/` directories across registered project roots.
 * Inspired by Factory.ai's Mission Control, but driven by the shell-based
 * autonomous harness at `~/autonomous-harness/`.
 *
 * Projects are registered in harness_shared.harness_registry (PG, see
 * lib/harness-registry.ts), one row per workspace. Adding a project goes
 * through POST /api/harness/projects, which provisions the per-harness
 * PG schema in-process via lib/scaffold-harness-schema.ts.
 */
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { readFileSync, readlinkSync, existsSync, readdirSync, statSync, openSync, readSync, closeSync, constants as fsConstants } from 'node:fs';
import { getKnownRoles } from '@/lib/known-roles';
import { getKnownHooks } from '@/lib/known-hooks';
import {
  PROJECT_FILES_TO_COPY, STATE_FILES_FOR_RESET, STATE_FILES_FOR_BACKUP,
  TEMPLATE_DETECT_FILES, SOURCE_FILES_FOR_FORK, SNAPSHOT_FILES,
} from '@/lib/harness-state-files';
import { recordUserAction } from '@/lib/user-actions';
import { papercuspPath } from '@/lib/papercusp-root';
import { DECISION_VERBS } from '@papercusp/orchestrator/decision-parse';
import { readFile, writeFile, appendFile, unlink, mkdir, chmod, rename, access, copyFile } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { homedir } from 'node:os';
import { harnessPackageDir, harnessPath, orchestratorRunBin } from './harness-paths';
import { firePluginLifecycle, firePluginEvent } from '../../../lib/plugin-host-runtime';
import { spawn, execFile } from 'node:child_process';
import { runClaudeChat } from '@/lib/claude-chat-stream';
import { promisify } from 'node:util';
import {
  getLegacyClient,
  slugToSchemaName,
  getOrgPg,
  getHarnessPg,
  listUnconsumedEvents,
  consumeEvents,
  getFeatureLineage,
  formatLineageForPrompt,
  withWorkspaceLegacy,
} from '@restart/db-org';
import {
  ensureSnapshotFeaturesTable,
  ensureHarnessStatusTable,
  ensureHarnessLanesTable,
  ensureAdaptiveTelemetryTable,
} from '@/lib/ensure-schema';
import { activeWorkspaceId } from '@/lib/workspace-registry';
import { type Phase, phasePath, phasePhaseLabel, ALL_PHASES } from '@/lib/harness-phases';
const getOrgDbClient = () => getLegacyClient();
const dbcFor = (slug: string) => getLegacyClient(slug);

const execFileP = promisify(execFile);

import { papercuspRoot } from '@/lib/papercusp-root';
import {
  loadHarnessRegistry,
  saveHarnessRegistry,
  type HarnessRegistry as RegistryFile,
  type ProjectEntry,
} from '@/lib/harness-registry';

/* ─────────────────────────────────────────────────────────────────────
 * Performance helpers (added 2026-05-01).
 *
 * `/api/harness/<slug>/{status,phases,git/log}` were the three slowest
 * endpoints in the harness UI; together they accounted for ~3s mean
 * response time per dashboard render. Three changes:
 *
 *   1. tailLastResultLine() reads the last ~8KB of a .jsonl file instead
 *      of the whole file. Cost-aggregation is O(file count) instead of
 *      O(total bytes).
 *   2. aggregateCostFromLogDir() caches the aggregated cost / token
 *      counts per logDir for ttlMs (default 5s), invalidated by the
 *      directory's mtime. Both /status and /phases share the cache.
 *   3. cachedGitLog() caches `git log --format=...` output keyed on
 *      project path + HEAD sha + limit, TTL 3s. Skips the subprocess
 *      spawn when HEAD hasn't moved.
 * ───────────────────────────────────────────────────────────────────── */

function tailLastResultLine(filePath: string, lookbackBytes = 8 * 1024): { obj: Record<string, unknown> | null } {
  let fd = -1;
  try {
    const st = statSync(filePath);
    if (st.size === 0) return { obj: null };
    const start = Math.max(0, st.size - lookbackBytes);
    const len = st.size - start;
    fd = openSync(filePath, 'r');
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, start);
    const text = buf.toString('utf8');
    // Walk lines backwards to find the last `"type":"result"` JSON object.
    const lines = text.split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim();
      if (!line.startsWith('{')) continue;
      try {
        const obj = JSON.parse(line) as Record<string, unknown>;
        if (obj.type === 'result') return { obj };
      } catch { /* partial line at the start of the window — skip */ }
    }
    return { obj: null };
  } catch {
    return { obj: null };
  } finally {
    if (fd >= 0) try { closeSync(fd); } catch {}
  }
}

// Pulse counter — total `── iteration N ──` lines across the entire run.log.
// `── iteration N ──` resets to 1 on every bin/run.sh invocation, so the
// last-match-in-tail pattern undercounts lifetime pulses. We count
// incrementally: cache (mtimeMs, size, count) and only re-scan the bytes
// appended since the last cache hit. Eviction happens implicitly when
// mtime moves backwards (log rotation / harness rescaffold) by re-counting
// from byte 0.
type PulseCacheEntry = { mtimeMs: number; size: number; count: number };
const __pulseCacheKey = '__papercuspPulseCache';
type PulseGlobals = { [__pulseCacheKey]?: Map<string, PulseCacheEntry> };
const __pulseCache: Map<string, PulseCacheEntry> = (() => {
  const g = globalThis as PulseGlobals;
  if (!g[__pulseCacheKey]) g[__pulseCacheKey] = new Map();
  return g[__pulseCacheKey]!;
})();
const PULSE_RE = /── iteration \d+ ──/g;

export function countPulsesFromRunLog(path: string): number {
  if (!existsSync(path)) return 0;
  let st: { mtimeMs: number; size: number };
  try { st = statSync(path); } catch { return 0; }
  if (st.size === 0) return 0;

  const cached = __pulseCache.get(path);
  // Reuse: file is unchanged, or grew without truncation.
  if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) {
    return cached.count;
  }

  // Truncation / rewrite: rescan from the start.
  const startOffset =
    cached && cached.mtimeMs <= st.mtimeMs && cached.size <= st.size
      ? cached.size
      : 0;

  let fd = -1;
  let count = startOffset === 0 ? 0 : cached!.count;
  try {
    fd = openSync(path, 'r');
    const CHUNK = 64 * 1024;
    const buf = Buffer.alloc(CHUNK);
    let leftover = '';
    let pos = startOffset;
    while (pos < st.size) {
      const len = Math.min(CHUNK, st.size - pos);
      readSync(fd, buf, 0, len, pos);
      const text = leftover + buf.subarray(0, len).toString('utf8');
      const nl = text.lastIndexOf('\n');
      const scan = nl >= 0 ? text.slice(0, nl) : '';
      leftover = nl >= 0 ? text.slice(nl + 1) : text;
      const m = scan.match(PULSE_RE);
      if (m) count += m.length;
      pos += len;
    }
    const tail = leftover.match(PULSE_RE);
    if (tail) count += tail.length;
  } catch { /* ignore */ } finally {
    if (fd >= 0) try { closeSync(fd); } catch {}
  }

  __pulseCache.set(path, { mtimeMs: st.mtimeMs, size: st.size, count });
  return count;
}

interface CostAggregate { cost: number; inputTokens: number; outputTokens: number }

// Pinned to globalThis (see __costPerFileCache below for rationale).
type CostCacheEntry = { sig: string; expires: number; value: CostAggregate };
const __costCacheKey = '__papercuspCostCache';
type CostCacheGlobals = { [__costCacheKey]?: Map<string, CostCacheEntry> };
const __costCache: Map<string, CostCacheEntry> = (() => {
  const g = globalThis as CostCacheGlobals;
  if (!g[__costCacheKey]) g[__costCacheKey] = new Map();
  return g[__costCacheKey]!;
})();

// Per-file mtime-keyed cache. Old log files NEVER change after the run
// finishes — re-tailing them on every request is pure waste. We tail
// each file ONCE per mtime; only files newer than the cached mtime get
// re-read. With 220 jsonl files across a 178 MiB log dir, this turns
// a 5-10 second per-call cost into "tail only the actively-running runs."
//
// Pinned to `globalThis` because Next.js dev re-evaluates the catch-all
// route module across requests (visible in the dev log as repeated
// [plugin-mount] lines), which would otherwise reset module-local caches
// every request. See /docs/performance #A5.
type CostPerFileEntry = { mtimeMs: number; size: number; cost: number; inputTokens: number; outputTokens: number };
const __costPerFileCacheKey = '__papercuspCostPerFileCache';
type CostGlobals = { [__costPerFileCacheKey]?: Map<string, CostPerFileEntry> };
const __costPerFileCache: Map<string, CostPerFileEntry> = (() => {
  const g = globalThis as CostGlobals;
  if (!g[__costPerFileCacheKey]) g[__costPerFileCacheKey] = new Map();
  return g[__costPerFileCacheKey]!;
})();

export function aggregateCostFromLogDir(logDir: string, ttlMs = 5000): CostAggregate {
  const now = Date.now();
  let sig = 'no-dir';
  try {
    if (existsSync(logDir)) {
      const st = statSync(logDir);
      sig = `${st.mtimeMs}:${st.size}`;
    }
  } catch {}
  const cached = __costCache.get(logDir);
  if (cached && cached.sig === sig && cached.expires > now) return cached.value;

  const out: CostAggregate = { cost: 0, inputTokens: 0, outputTokens: 0 };
  try {
    if (existsSync(logDir)) {
      for (const f of readdirSync(logDir)) {
        if (!f.endsWith('.jsonl')) continue;
        const fp = join(logDir, f);
        let st: { mtimeMs: number; size: number };
        try { st = statSync(fp); } catch { continue; }
        const perFile = __costPerFileCache.get(fp);
        let row: { cost: number; inputTokens: number; outputTokens: number };
        if (perFile && perFile.mtimeMs === st.mtimeMs && perFile.size === st.size) {
          // File hasn't changed since we last tailed it; reuse the
          // cached aggregate row instead of re-reading 8 KiB of tail.
          row = perFile;
        } else {
          const { obj } = tailLastResultLine(fp);
          row = {
            cost: obj ? (Number(obj.total_cost_usd ?? 0) || 0) : 0,
            inputTokens: 0,
            outputTokens: 0,
          };
          if (obj) {
            const usage = obj.usage as { input_tokens?: number; output_tokens?: number } | undefined;
            if (usage) {
              row.inputTokens = Number(usage.input_tokens ?? 0) || 0;
              row.outputTokens = Number(usage.output_tokens ?? 0) || 0;
            }
          }
          __costPerFileCache.set(fp, { mtimeMs: st.mtimeMs, size: st.size, ...row });
        }
        out.cost += row.cost;
        out.inputTokens += row.inputTokens;
        out.outputTokens += row.outputTokens;
      }
    }
  } catch {}
  __costCache.set(logDir, { sig, expires: now + ttlMs, value: out });
  return out;
}

interface GitCommit {
  sha: string; parents: string[]; subject: string; author: string; ts: number; refs: string[];
}

const __gitLogCache = new Map<string, { headSig: string; expires: number; commits: GitCommit[] }>();

async function cachedGitLog(projectPath: string, limit: number, ttlMs = 3000): Promise<GitCommit[]> {
  const key = `${projectPath}:${limit}`;
  const now = Date.now();
  let headSig = '';
  try {
    const headPath = join(projectPath, '.git', 'HEAD');
    const st = statSync(headPath);
    headSig = `${st.mtimeMs}:${st.size}`;
    // Follow `ref: refs/heads/<branch>` indirection so a commit on the
    // current branch (which doesn't touch HEAD itself) still busts cache.
    try {
      const ref = readFileSync(headPath, 'utf8').trim();
      if (ref.startsWith('ref: ')) {
        const refPath = join(projectPath, '.git', ref.slice(5).trim());
        if (existsSync(refPath)) {
          const rs = statSync(refPath);
          headSig += `|${rs.mtimeMs}`;
        }
      }
    } catch {}
  } catch {}
  const cached = __gitLogCache.get(key);
  if (cached && cached.headSig === headSig && cached.expires > now) return cached.commits;

  const SEP = '\x1f';
  const { stdout } = await execFileP(
    'git',
    [
      '-C', projectPath,
      'log', '--all', '--date-order',
      `--format=%H${SEP}%P${SEP}%s${SEP}%an${SEP}%at${SEP}%D`,
      '-n', String(limit),
    ],
    { maxBuffer: 16 * 1024 * 1024, timeout: 15_000 },
  );
  const commits: GitCommit[] = stdout
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [sha, parents, subject, author, ts, refs] = line.split(SEP);
      return {
        sha,
        parents: parents ? parents.split(' ').filter(Boolean) : [],
        subject: subject ?? '',
        author: author ?? '',
        ts: Number(ts) * 1000,
        refs: refs ? refs.split(', ').filter(Boolean) : [],
      };
    });
  __gitLogCache.set(key, { headSig, expires: now + ttlMs, commits });
  return commits;
}

// Single source of truth: harness_shared.harness_registry (PG).
// Per-workspace scoping via the workspace_id PK column.
const loadRegistry = loadHarnessRegistry;
const saveRegistry = saveHarnessRegistry;

export async function resolveProject(slug: string): Promise<ProjectEntry | null> {
  const reg = await loadRegistry();
  return reg.projects.find((p) => p.slug === slug) ?? null;
}

export function harnessDir(project: ProjectEntry): string {
  return join(project.path, '.harness');
}

export function safeRead(path: string): string | null {
  try { return readFileSync(path, 'utf8'); } catch { return null; }
}

/**
 * Check whether any run.sh process is alive for the given project path.
 *
 * Walks /proc to find a process whose cwd starts with `projectPath` and
 * whose cmdline references run.sh. /proc/<pid>/cwd is a symlink — must
 * use readlinkSync, not readFileSync (which throws EISDIR and gets
 * silently swallowed).
 *
 * Cached for 2 s with a single shared map keyed on project path. The
 * dashboard polls /status every 3 s and frequently fans out across
 * multiple panels at once; under c=10 contention the un-cached version
 * went from 75 ms p50 (c=1) to 581 ms p50 (c=10) because each request
 * walked /proc independently. With the cache, concurrent requests share
 * one walk and per-request cost drops to ~0 ms on a hit.
 */
const __aliveCacheKey = Symbol.for('papercusp.harnessAliveCache');
type AliveCacheGlobals = typeof globalThis & {
  [__aliveCacheKey]?: Map<string, { value: boolean; expires: number; pending: Promise<boolean> | null }>;
};
const __aliveCache: Map<string, { value: boolean; expires: number; pending: Promise<boolean> | null }> = (() => {
  const g = globalThis as AliveCacheGlobals;
  if (!g[__aliveCacheKey]) g[__aliveCacheKey] = new Map();
  return g[__aliveCacheKey]!;
})();

function scanForRunShCwd(projectPath: string): boolean {
  try {
    const procs = readdirSync('/proc');
    for (const pid of procs) {
      if (!/^\d+$/.test(pid)) continue;
      try {
        const cwd = readlinkSync(`/proc/${pid}/cwd`);
        if (!cwd.startsWith(projectPath)) continue;
        const cmdline = readFileSync(`/proc/${pid}/cmdline`, 'utf8');
        if (cmdline.includes('autonomous-harness/run.sh') || cmdline.includes('/harness/run.sh')) return true;
      } catch { /* perm-denied PID — skip */ }
    }
  } catch { /* /proc unreadable — fall through */ }
  return false;
}

export function isProjectAlive(projectPath: string, ttlMs = 2000): boolean {
  const now = Date.now();
  const cached = __aliveCache.get(projectPath);
  if (cached && cached.expires > now) return cached.value;
  // Cache miss — synchronous scan, then memoize.
  const value = scanForRunShCwd(projectPath);
  __aliveCache.set(projectPath, { value, expires: now + ttlMs, pending: null });
  return value;
}

/**
 * Layer A/B (2026-04-26): features now live in SQLite, not features.json.
 * This helper queries the harness_features table for a given project.
 * Returns the same shape callers expect: array of {id, title, status, attempts, claims, ...}.
 */
export async function parseFeatures(project: ProjectEntry): Promise<any[]> {
  try {
    const c = dbcFor(project.slug);
    const rows = await c.prepare(`
      SELECT * FROM harness_features WHERE harness_slug = ? ORDER BY feature_id
    `).all(project.slug) as any[];
    return rows.map(rowToFeature);
  } catch {
    return [];
  }
}

function rowToFeature(r: any): any {
  // metadata and tags are now jsonb (auto-parsed by postgres-js).
  // claims and notes remain text — keep JSON.parse for claims when present.
  // attempts is now bigint — postgres-js returns it as a JS number when small.
  return {
    id: r.feature_id,
    title: r.title,
    summary: r.summary ?? undefined,
    status: r.status,
    attempts: typeof r.attempts === 'bigint' ? Number(r.attempts) : r.attempts,
    claims: r.claims ? (typeof r.claims === 'string' ? JSON.parse(r.claims) : r.claims) : undefined,
    notes: r.notes ?? undefined,
    metadata: r.metadata ?? undefined,
    kind: r.kind ?? undefined,
    project_id: r.project_id ?? undefined,
    expected_cost_cents: r.expected_cost_cents == null ? undefined : (typeof r.expected_cost_cents === 'bigint' ? Number(r.expected_cost_cents) : r.expected_cost_cents),
    tags: r.tags ?? undefined,
    needs_human_review: !!r.needs_human_review,
    ts: r.ts == null ? undefined : (typeof r.ts === 'bigint' ? Number(r.ts) : r.ts),
    deprecation_reason: r.deprecation_reason ?? undefined,
  };
}

/** Append an audit row for a feature mutation. Fire-and-forget.
 *  Writes directly to harness_shared.feature_audit_consolidated
 *  (un-hardcode plan item #6: drop per-harness feature_audit). */
function auditFeatureChange(harnessSlug: string, featureId: string, field: string, oldValue: any, newValue: any, actor: string): void {
  (async () => {
    try {
      const { db } = (await import('@restart/db-org')).getOrgPg();
      const { generated } = await import('@restart/db-org');
      const { activeWorkspaceId } = await import('@/lib/workspace-registry');
      const ws = activeWorkspaceId();
      await db.insert(generated.feature_audit_consolidatedInHarness_shared).values({
        workspace_id: ws,
        harness_slug: harnessSlug,
        feature_id: featureId,
        ts: Date.now(),
        field,
        old_value: oldValue === undefined ? null : JSON.stringify(oldValue),
        new_value: newValue === undefined ? null : JSON.stringify(newValue),
        actor,
      });
      const { notifySyncInvalidate } = await import('@/lib/sync-sse');
      await notifySyncInvalidate('featureAudit.byHarness', { harnessSlug });
      // Keep the legacy per-harness table happy for any read paths we
      // haven't migrated yet; mirror lazily so a transient write failure
      // doesn't block the canonical write.
      try {
        const c = dbcFor(harnessSlug);
        await c.prepare(`INSERT INTO feature_audit (ts, harness_slug, feature_id, field, old_value, new_value, actor) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
          Date.now(),
          harnessSlug,
          featureId,
          field,
          oldValue === undefined ? null : JSON.stringify(oldValue),
          newValue === undefined ? null : JSON.stringify(newValue),
          actor,
        );
      } catch { /* per-harness mirror best-effort, not load-bearing */ }
      return;
    } catch {
      // Fall through to the legacy-only path below
    }
    try {
      const c = dbcFor(harnessSlug);
      await c.prepare(`INSERT INTO feature_audit (ts, harness_slug, feature_id, field, old_value, new_value, actor) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
        Date.now(),
        harnessSlug,
        featureId,
        field,
        oldValue === undefined ? null : JSON.stringify(oldValue),
        newValue === undefined ? null : JSON.stringify(newValue),
        actor,
      );
    } catch (e) {
      console.warn('[harness] feature audit insert failed:', (e as Error)?.message);
    }
  })();
}

export function tailFile(path: string, maxBytes = 64 * 1024): string {
  // Read only the last `maxBytes` of the file via openSync+readSync(offset).
  // Previously did `readFileSync(path).slice(...)` which read the WHOLE file
  // then sliced the tail in memory — on a 12 MB run.log that's 12 MB of
  // alloc per call, called 3× per /phases request × multiple harnesses on
  // the dashboard. Same pattern as the /log/stream fix (see /docs/performance
  // — A1 family + the streaming-log discussion).
  let fd = -1;
  try {
    const stat = statSync(path);
    if (stat.size === 0) return '';
    if (stat.size <= maxBytes) return readFileSync(path, 'utf8');
    const len = maxBytes;
    const start = stat.size - len;
    fd = openSync(path, 'r');
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, start);
    return buf.toString('utf8');
  } catch {
    return '';
  } finally {
    if (fd >= 0) try { closeSync(fd); } catch {}
  }
}

/**
 * Background-invoke a single scoper mode (proposal | replan) without
 * going through run.sh's full pre-loop. Used by /product-review (manual
 * "Propose now" — runs scoper MODE=proposal; legacy URL kept for
 * external compat) and the accept handler's replanOnAccept path.
 *
 * Sources only the helper functions from run.sh — does NOT enter the
 * orchestrator loop or run plan-review. So it can't accidentally exit 7
 * mid-replan, and it never respawns experts. Detached background spawn;
 * caller does not block on the agent invocation.
 */
function invokeScoperBackground(
  project: ProjectEntry,
  mode: 'proposal' | 'replan' | 'cleanup',
): { invocationId: string } {
  const { spawn } = require('node:child_process');
  const invocationId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const resultsDir = join(harnessDir(project), 'scoper-results');
  const resultPath = join(resultsDir, `${mode}-${invocationId}.log`);
  const wrapper = `
    set -e
    export PROJECT_DIR="${project.path}"
    export STATE_DIR="${project.path}/.harness"
    export HARNESS_DIR="${harnessPackageDir()}"
    export LOG_DIR="$STATE_DIR/logs"
    export SCOPER_INVOCATION_ID="${invocationId}"
    mkdir -p "$STATE_DIR/proposals" "$LOG_DIR" "${resultsDir}"
    source <(awk '/^(log|config_get|invoke|run_hook|snapshot_state|notify_event|harness_slug|fire_plugin_hook|auto_screenshot_post_worker|check_cost_cap|prune_logs)\\(\\)/,/^}/' "$HARNESS_DIR/run.sh")
    invoke scoper "MODE=${mode}" 2>&1 | tee "${resultPath}"
    echo "__INVOCATION_DONE__" >> "${resultPath}"
  `;
  const child = spawn('bash', ['-c', wrapper], {
    cwd: project.path,
    env: { ...process.env, CLAUDE: process.env.AGENT_CMD ?? process.env.CLAUDE ?? 'omp -p' },
    detached: true,
    stdio: ['ignore', 'ignore', 'ignore'],
  });
  child.unref();
  return { invocationId };
}

async function launchRun(project: ProjectEntry, extra?: string): Promise<{ ok: true; logPath: string } | { ok: false; error: string }> {
  // Canonical path: spawn the TS orchestrator entry. The bash run.sh
  // remains on disk as a function library for legacy sourcing call
  // sites (invokeScoperBackground etc.) but is no longer the iteration
  // driver. The previous `bash run.sh` invocation is preserved under
  // `PAPERCUSP_USE_TS_ORCHESTRATOR=0` for emergency rollback only.
  const orchBin = orchestratorRunBin();
  if (!existsSync(orchBin)) return { ok: false, error: 'orchestrator bin missing' };
  const logPath = `/tmp/harness-${project.slug}.log`;
  const cmd = `nohup npx --no-install tsx ${orchBin} >> ${logPath} 2>&1 &`;

  // Decrypt search-provider keys from PG (Migration 047) and pass them
  // through as env vars so OMP's web_search providers can see them.
  // Each spawned worker/validator/etc. inherits these from the
  // orchestrator's env. Best-effort: if PG is down or no keys are
  // configured, the orchestrator simply runs without them.
  let searchProviderEnv: Record<string, string> = {};
  try {
    const { buildSpawnEnv } = await import('@/lib/search-provider-credentials');
    searchProviderEnv = await buildSpawnEnv();
  } catch {
    // PG unavailable / encryption key missing — proceed with no keys.
  }

  const child = spawn('bash', ['-c', cmd], {
    cwd: project.path,
    env: {
      ...process.env,
      AGENT_CMD: process.env.AGENT_CMD ?? process.env.CLAUDE ?? 'omp -p',
      // Legacy CLAUDE alias kept for any hooks that read it.
      CLAUDE: process.env.AGENT_CMD ?? process.env.CLAUDE ?? 'omp -p',
      HARNESS_DIR: harnessPackageDir(),
      PROJECT_DIR: project.path,
      HARNESS_SLUG: project.slug,
      ...searchProviderEnv,
      ...(extra ? Object.fromEntries(extra.split(/\s+/).filter(Boolean).map((kv: string) => kv.split('='))) : {}),
    },
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
  return { ok: true, logPath };
}

export const harness = new Hono();

// ─── registry ─────────────────────────────────────────────────────────

// Lightweight listing — registry + cheap filesystem checks (existsSync),
// but no per-slug Postgres pool creation. The full /projects endpoint
// is ~50× slower because it opens a connection per harness to query
// harness_features for each one. Sufficient for surfaces that just need
// to render a picker / dashboard (slug, path, hasSpec, hasState
// approximated from disk).
//
// Cached with a 1-second TTL pinned to globalThis. /projects/lite is the
// SSR self-fetch site for /harness/<slug>/page.tsx — every page render
// fans through here. On dev, Turbopack's per-request route re-eval flaps
// it 14ms-2.3s; under page-load contention the cold path lands at the
// 2s end and dominates TTFB. Diagnostic 2026-05-06 finding G:
// `/api/harness/projects/lite` 1.1s/14ms/2.3s/30ms/1.1s. Cached now.
interface LiteCacheEntry {
  ts: number;
  payload: unknown;
}
const __liteKey = Symbol.for('papercusp.harnessProjectsLiteCache');
type LiteGlobals = typeof globalThis & { [__liteKey]?: LiteCacheEntry };
const LITE_TTL_MS = 1000;

harness.get('/projects/lite', async (c) => {
  const g = globalThis as LiteGlobals;
  const now = Date.now();
  const hit = g[__liteKey];
  if (hit && now - hit.ts < LITE_TTL_MS) {
    return c.json(hit.payload as object);
  }
  const reg = await loadRegistry();
  const projects = reg.projects.map((p) => {
    const hDir = harnessDir(p);
    return {
      slug: p.slug,
      path: p.path,
      harness_kind: (p as { harness_kind?: string }).harness_kind ?? null,
      hasState: existsSync(hDir),
      hasSpec: existsSync(join(p.path, 'SPEC.md')),
      harnessDir: hDir,
    };
  });
  const payload = { projects };
  g[__liteKey] = { ts: Date.now(), payload };
  return c.json(payload);
});

// Cache the /projects payload — the underlying data (registry contents,
// SPEC.md presence, parent_slug, hasState) only changes when a harness is
// spawned/forked/deleted, which is rare relative to dashboard polling.
// Without this, /projects opens N per-slug PG connections per call (one
// `SELECT 1 FROM harness_features` each); under c=10 that's 10×70 ≈ 700
// connections in flight, dragging p50 to ~500 ms even on prod. With a 5 s
// TTL keyed on the registry mtime, concurrent callers share one walk; the
// cache busts when the registry file is rewritten (spawn/delete).
interface ProjectsCacheEntry {
  sig: string;
  expires: number;
  inflight: Promise<unknown[]> | null;
  value: unknown[] | null;
}
const __projectsCacheKey = Symbol.for('papercusp.harnessProjectsCache');
type ProjectsCacheGlobals = typeof globalThis & {
  [__projectsCacheKey]?: ProjectsCacheEntry;
};
const __projectsCache: ProjectsCacheEntry = (() => {
  const g = globalThis as ProjectsCacheGlobals;
  if (!g[__projectsCacheKey]) {
    g[__projectsCacheKey] = { sig: '', expires: 0, inflight: null, value: null };
  }
  return g[__projectsCacheKey]!;
})();

harness.get('/projects', async (c) => {
  const reg = await loadRegistry();
  const filterParentSlug = c.req.query('parent_slug');

  // Build a signature from (registry path mtime + project count + slug list)
  // so changes to the registry file invalidate the cache instantly.
  let sig = `n=${reg.projects.length}|slugs=${reg.projects.map((p) => p.slug).join(',')}`;
  try {
    // Workspace registry is the primary source; legacy
    // ~/.restart-harness-projects.json is honored as a fallback so
    // pre-workspace harnesses still bust the cache when edited.
    const wsPath = join(homedir(), '.papercusp-workspaces', 'registry.json');
    const legacyPath = join(homedir(), '.restart-harness-projects.json');
    if (existsSync(wsPath)) sig += `|m=${statSync(wsPath).mtimeMs}`;
    if (existsSync(legacyPath)) sig += `|lm=${statSync(legacyPath).mtimeMs}`;
  } catch {}

  const now = Date.now();
  const TTL_MS = 5_000;

  let enriched = __projectsCache.value;
  if (!(enriched && __projectsCache.sig === sig && __projectsCache.expires > now)) {
    // Cache miss or stale: do the walk, but de-dup concurrent callers via
    // a shared in-flight promise so 10 simultaneous requests don't all
    // open 70 PG connections each.
    if (!__projectsCache.inflight || __projectsCache.sig !== sig) {
      __projectsCache.sig = sig;
      __projectsCache.inflight = (async () => {
        const list = await Promise.all(reg.projects.map(async (p) => {
          const hDir = harnessDir(p);
          const cfgPath = join(p.path, '.harness', 'config.json');
          const specPath = join(p.path, 'SPEC.md');
          const [parentSlug, hasState, hasSpec] = await Promise.all([
            (async (): Promise<string | null> => {
              try {
                if (!existsSync(cfgPath)) return null;
                const txt = await readFile(cfgPath, 'utf8');
                const j = JSON.parse(txt);
                return typeof j?.parent_slug === 'string' && j.parent_slug ? j.parent_slug : null;
              } catch {
                return null;
              }
            })(),
            (async (): Promise<boolean> => {
              try {
                const c2 = dbcFor(p.slug);
                const row = await c2.prepare('SELECT 1 AS x FROM harness_features WHERE harness_slug = ? LIMIT 1').get(p.slug);
                return !!row;
              } catch {
                return false;
              }
            })(),
            (async (): Promise<boolean> => existsSync(specPath))(),
          ]);
          return { ...p, hasState, hasSpec, harnessDir: hDir, parent_slug: parentSlug };
        }));
        __projectsCache.value = list;
        __projectsCache.expires = Date.now() + TTL_MS;
        __projectsCache.inflight = null;
        return list;
      })();
    }
    enriched = await __projectsCache.inflight;
  }

  const filtered = filterParentSlug
    ? (enriched as Array<{ parent_slug: string | null }>).filter((p) => p.parent_slug === filterParentSlug)
    : enriched;
  return c.json({ projects: filtered });
});

harness.post('/projects', async (c) => {
  const body = await c.req.json();
  const slug = String(body.slug ?? '').trim();
  const rawPath = String(body.path ?? '').trim();
  if (!slug || !rawPath) return c.json({ error: 'slug and path required' }, 400);
  const path = resolve(rawPath);
  if (!existsSync(path)) return c.json({ error: 'path does not exist' }, 400);
  const reg = await loadRegistry();
  if (reg.projects.some((p) => p.slug === slug)) {
    return c.json({ error: 'slug already exists' }, 409);
  }
  reg.projects.push({ slug, path });
  await saveRegistry(reg);

  // Provision per-harness PG schema (config_token + 7 misc tables + 4 views
  // over the consolidated tables). See lib/scaffold-harness-schema.ts.
  let provisioning: { ok: true } | { ok: false; error: string };
  try {
    const { scaffoldHarnessSchema } = await import('@/lib/scaffold-harness-schema');
    await scaffoldHarnessSchema(slug);
    provisioning = { ok: true };
  } catch (e: any) {
    provisioning = { ok: false, error: String(e?.message ?? e).slice(0, 300) };
  }

  return c.json({ ok: true, project: { slug, path }, provisioning });
});

harness.delete('/projects/:slug', async (c) => {
  const slug = c.req.param('slug');
  const reg = await loadRegistry();
  const before = reg.projects.length;
  reg.projects = reg.projects.filter((p) => p.slug !== slug);
  if (reg.projects.length === before) return c.json({ error: 'not found' }, 404);
  await saveRegistry(reg);
  return c.json({ ok: true });
});

// ─── per-project status ──────────────────────────────────────────────

harness.get('/:slug/status', async (c) => {
  const project = await resolvePhasedProject(c.req.param('slug'), phasePhaseLabel(c.req.query('phase')));
  if (!project) return c.json({ error: 'unknown project' }, 404);

  const features = await parseFeatures(project);
  const counts = features.reduce((acc, f) => {
    acc[f.status] = (acc[f.status] ?? 0) + 1;
    return acc;
  }, {} as Record<string, number>);

  // Last-decision heuristic: read tail of run.log
  const runLogPath = join(harnessDir(project), 'logs', 'run.log');
  const runLog = tailFile(runLogPath, 16 * 1024);
  const decisionMatch = [...runLog.matchAll(/ORCH decision: (\S[^\n]*)/g)];
  const lastDecision = decisionMatch.length ? decisionMatch[decisionMatch.length - 1][1] : null;
  // `iteration` is total pulses across all bin/run.sh invocations — the
  // counter resets per-run, so we count `── iteration N ──` markers
  // incrementally rather than reading the highest visible number.
  const iteration = countPulsesFromRunLog(runLogPath);

  // Escalation
  const escalation = safeRead(join(harnessDir(project), 'escalation.md'));

  // Aggregate cost + tokens across all .jsonl files via the cached helper
  // (tail-reads each file's last 8KB, memoizes per logDir for ~5s with
  // mtime invalidation — see aggregateCostFromLogDir at the top of this
  // file). Replaces the previous full-file readFileSync + split scan that
  // ran on every dashboard poll.
  const __agg = aggregateCostFromLogDir(join(harnessDir(project), 'logs'));
  const missionCostUsd = __agg.cost;
  const missionInputTokens = __agg.inputTokens;
  const missionOutputTokens = __agg.outputTokens;

  // Process liveness: look for a run.sh process whose cwd is the project.
  // /proc/<pid>/cwd is a symlink to a directory — must use readlinkSync,
  // not readFileSync (which throws EISDIR and gets silently swallowed).
  //
  // Walking /proc on every /status hit is expensive on a busy system
  // (~hundreds of PIDs × 2 syscalls per pid). The dashboard polls
  // /status every 3s and frequently fans out across multiple panels at
  // once — under c=10 contention this endpoint went from 75ms p50 (c=1)
  // to 581ms p50 (c=10). A 2s TTL cache hides the redundant proc walks
  // without making liveness stale; concurrent requests reuse one walk.
  const alive = isProjectAlive(project.path);

  // Count pending (ungranted) checkpoints — for dashboard badge.
  let pendingCheckpoints = 0;
  let activeCompetitions = 0;
  let smokeFail = false;
  try {
    const hd = harnessDir(project);
    if (existsSync(hd)) {
      for (const f of readdirSync(hd)) {
        if (/^checkpoint-[A-Za-z0-9_.-]+\.md$/.test(f) && !existsSync(join(hd, `${f}.granted`))) {
          pendingCheckpoints += 1;
        }
        if (/^competition-[A-Za-z0-9_.-]+\.json$/.test(f)) {
          activeCompetitions += 1;
        }
      }
      smokeFail = existsSync(join(hd, 'smoke-failure.md'));
    }
  } catch {}

  return c.json({
    project: { slug: project.slug, path: project.path },
    features,
    counts,
    iteration,
    lastDecision,
    alive,
    escalated: escalation != null,
    pendingCheckpoints,
    activeCompetitions,
    smokeFail,
    missionCostUsd,
    missionInputTokens,
    missionOutputTokens,
  });
});

// ─── read-only content views ──────────────────────────────────────────

// Migration 034: SPEC.md / AGENTS.md / validation-contract.md / config.json
// are PG-canonical via harness_shared.harness_project_files. The disk copies
// are best-effort mirrors written on each PUT for editor convenience.
async function loadProjectFiles(slug: string): Promise<{ spec: string | null; agents: string | null; contract: string | null; config: string | null }> {
  const { ensureProjectFilesTable } = await import('@/lib/ensure-schema');
  await ensureProjectFilesTable();
  const { db } = (await import('@restart/db-org')).getOrgPg();
  const { generated } = await import('@restart/db-org');
  const { eq } = await import('drizzle-orm');
  const pf = generated.harness_project_filesInHarness_shared;
  const rows = await db
    .select({ spec: pf.spec, agents: pf.agents, contract: pf.contract, config: pf.config })
    .from(pf)
    .where(eq(pf.harness_slug, slug))
    .limit(1);
  return rows[0] ?? { spec: null, agents: null, contract: null, config: null };
}

async function saveProjectFiles(slug: string, patch: { spec?: string; agents?: string; contract?: string; config?: string }): Promise<void> {
  const { ensureProjectFilesTable } = await import('@/lib/ensure-schema');
  await ensureProjectFilesTable();
  const { db } = (await import('@restart/db-org')).getOrgPg();
  const { generated } = await import('@restart/db-org');
  const { sql: dsql } = await import('drizzle-orm');
  const pf = generated.harness_project_filesInHarness_shared;
  const now = Date.now();
  await db
    .insert(pf)
    .values({
      harness_slug: slug,
      spec: patch.spec ?? null,
      agents: patch.agents ?? null,
      contract: patch.contract ?? null,
      config: patch.config ?? null,
      updated_at: now,
    })
    .onConflictDoUpdate({
      target: pf.harness_slug,
      set: {
        spec: dsql`COALESCE(${patch.spec ?? null}, ${pf.spec})`,
        agents: dsql`COALESCE(${patch.agents ?? null}, ${pf.agents})`,
        contract: dsql`COALESCE(${patch.contract ?? null}, ${pf.contract})`,
        config: dsql`COALESCE(${patch.config ?? null}, ${pf.config})`,
        updated_at: now,
      },
    });
  const { notifySyncInvalidate } = await import('@/lib/sync-sse');
  await notifySyncInvalidate('harnessProjectFiles.byHarness', { harnessSlug: slug });
}

harness.get('/:slug/spec', async (c) => {
  const slug = c.req.param('slug');
  const project = await resolvePhasedProject(slug, phasePhaseLabel(c.req.query('phase')));
  if (!project) return c.json({ error: 'unknown project' }, 404);
  // PG canonical with FS fallback for harnesses pre-Migration-034.
  const pg = await loadProjectFiles(slug);
  return c.json({
    spec: pg.spec ?? safeRead(join(project.path, 'SPEC.md')),
    agents: pg.agents ?? safeRead(join(project.path, 'AGENTS.md')),
    contract: pg.contract ?? safeRead(join(harnessDir(project), 'validation-contract.md')),
    config: pg.config ?? safeRead(join(harnessDir(project), 'config.json')),
  });
});

/**
 * Write SPEC.md, AGENTS.md, validation-contract.md, or config.json. Accepts
 * any subset of { spec, agents, contract, config }. PG is canonical; disk
 * is mirrored via temp-file + rename so partial writes don't corrupt state.
 */
harness.put('/:slug/spec', async (c) => {
  const slug = c.req.param('slug');
  const project = await resolvePhasedProject(slug, phasePhaseLabel(c.req.query('phase')));
  if (!project) return c.json({ error: 'unknown project' }, 404);
  const body = await c.req.json() as { spec?: string; agents?: string; contract?: string; config?: string };

  await saveProjectFiles(slug, body);

  const targets: Array<{ path: string; content: string | undefined; label: string }> = [
    { path: join(project.path, 'SPEC.md'), content: body.spec, label: 'spec' },
    { path: join(project.path, 'AGENTS.md'), content: body.agents, label: 'agents' },
    { path: join(harnessDir(project), 'validation-contract.md'), content: body.contract, label: 'contract' },
    { path: join(harnessDir(project), 'config.json'), content: body.config, label: 'config' },
  ];

  const written: string[] = [];
  const { rename } = await import('node:fs/promises');
  for (const t of targets) {
    if (typeof t.content !== 'string') continue;
    const tmp = `${t.path}.tmp.${Date.now()}`;
    try {
      await writeFile(tmp, t.content, 'utf8');
      await rename(tmp, t.path);
      written.push(t.label);
    } catch { /* mirror is best-effort; PG already has it */ }
  }
  return c.json({ ok: true, written });
});

harness.get('/:slug/issues', async (c) => {
  const slug = c.req.param('slug');
  const project = await resolvePhasedProject(slug, phasePhaseLabel(c.req.query('phase')));
  if (!project) return c.json({ error: 'unknown project' }, 404);
  // PG canonical (Migration 035) with FS fallback for harnesses pre-035.
  const { loadTextArtifact } = await import('@/lib/text-artifacts');
  const pg = await loadTextArtifact(slug, 'issues.md');
  return c.json({ issues: pg ?? safeRead(join(harnessDir(project), 'issues.md')) });
});

harness.get('/:slug/summary', async (c) => {
  const slug = c.req.param('slug');
  const project = await resolvePhasedProject(slug, phasePhaseLabel(c.req.query('phase')));
  if (!project) return c.json({ error: 'unknown project' }, 404);
  // PG canonical (Migration 035) with FS fallback for harnesses pre-035.
  const { loadTextArtifact } = await import('@/lib/text-artifacts');
  const pg = await loadTextArtifact(slug, 'summary.md');
  return c.json({ summary: pg ?? safeRead(join(harnessDir(project), 'summary.md')) });
});

harness.get('/:slug/logs/run', async (c) => {
  const project = await resolvePhasedProject(c.req.param('slug'), phasePhaseLabel(c.req.query('phase')));
  if (!project) return c.json({ error: 'unknown project' }, 404);
  const tail = tailFile(join(harnessDir(project), 'logs', 'run.log'), 128 * 1024);
  return c.json({ log: tail });
});

// ─── agent runs (per-invocation I/O) ─────────────────────────────────

// A run is "live" when its jsonl has no terminal `{type:"result"}` line AND its
// mtime is recent. The mtime guard prevents orphaned runs (harness SIGKILLed
// mid-stream) from being reported as forever-running.
const LIVE_MTIME_GRACE_MS = 10 * 60_000;

function probeRunLiveness(jsonlPath: string, now: number): { running: boolean; lastEventTs: number } {
  if (!existsSync(jsonlPath)) return { running: false, lastEventTs: 0 };
  const stat = statSync(jsonlPath);
  const lastEventTs = stat.mtimeMs;
  // Read the last 4KB to find the terminal event cheaply.
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

/**
 * Shared scan of `.harness/logs/` — produces the full agent_runs row shape
 * (filename-parsed metadata + .out size + liveness probe + last-result-line
 * cost/tokens). Used by both /agents (lightweight list) and /usage
 * (aggregates over the same dataset). Parsing every .jsonl on each call is
 * O(files × 4KB read) — fine at current scale (~200 files).
 */
interface AgentRunFull {
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

function scanAgentRuns(project: ProjectEntry): AgentRunFull[] {
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
    // Parse the last `result` line for cost/tokens — single tail read instead
    // of full file scan. We re-use the probeRunLiveness pattern but extract
    // the result object too.
    try {
      const stat = statSync(jsonlPath);
      const tailSize = Math.min(stat.size, 16384); // 16KB is enough for one result line
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

/**
 * Cached version of scanAgentRuns. Same shape, but memoizes the result
 * for ~2 s keyed on logDir + dir-mtime + dir-size. The dashboard polls
 * /agents every 5 s and frequently fans out across panels concurrently;
 * raw scanAgentRuns walks 200+ jsonl files per call (4 KB tail-read
 * each) which dominates the response time under c=10. With this cache,
 * the first concurrent caller pays the file-walk cost; the rest reuse
 * the result.
 *
 * Invalidation: dir mtime/size signature. Adding/removing a jsonl in the
 * logs dir bumps mtime; appending to an existing jsonl does NOT (which
 * is fine — we tolerate a 2 s lag on liveness/cost numbers in exchange
 * for the throughput win).
 */
const __agentScanCacheKey = Symbol.for('papercusp.harnessAgentScanCache');
type AgentScanCacheGlobals = typeof globalThis & {
  [__agentScanCacheKey]?: Map<string, { sig: string; expires: number; value: AgentRunFull[] }>;
};
const __agentScanCache: Map<string, { sig: string; expires: number; value: AgentRunFull[] }> = (() => {
  const g = globalThis as AgentScanCacheGlobals;
  if (!g[__agentScanCacheKey]) g[__agentScanCacheKey] = new Map();
  return g[__agentScanCacheKey]!;
})();

function scanAgentRunsCached(project: ProjectEntry, ttlMs = 2000): AgentRunFull[] {
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
 * Mirror agent-run metadata into `harness_<slug>.agent_runs`. Cheap because
 * the row count is bounded by .jsonl file count (~200). Fire-and-forget.
 */
async function syncAgentRunsToPg(project: ProjectEntry, runs: AgentRunFull[]): Promise<void> {
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

harness.get('/:slug/agents', async (c) => {
  const project = await resolvePhasedProject(c.req.param('slug'), phasePhaseLabel(c.req.query('phase')));
  if (!project) return c.json({ error: 'unknown project' }, 404);
  const all = scanAgentRunsCached(project);
  // Fire-and-forget PG mirror — Zero subscribers see updates within one poll.
  syncAgentRunsToPg(project, all).catch((err) => {
    console.warn(`[agents] PG sync failed for ${project.slug}:`, err?.message ?? err);
  });
  // Backwards-compatible response shape.
  const runs = all.slice(0, 200).map((r) => ({
    runId: r.runId,
    role: r.role,
    ts: r.ts,
    sizeBytes: r.sizeBytes,
    running: r.running,
    lastEventTs: r.lastEventTs,
  }));
  return c.json({ runs });
});

harness.get('/:slug/agents/:runId', async (c) => {
  const project = await resolvePhasedProject(c.req.param('slug'), phasePhaseLabel(c.req.query('phase')));
  if (!project) return c.json({ error: 'unknown project' }, 404);
  const runId = c.req.param('runId').replace(/[^A-Za-z0-9_.-]/g, ''); // sanitize
  const logDir = join(harnessDir(project), 'logs');
  const jsonlPath = join(logDir, `${runId}.jsonl`);

  // Prefer PG-canonical body from harness_run_output (Phase 4); fall
  // back to disk for runs that completed before activation or in
  // CLI-only mode where no PG row exists.
  let jsonlRaw: string | null = null;
  try {
    const { sql } = (await import('@restart/db-org')).getOrgPg();
    const rows = await sql<{ jsonl_body: string }[]>`
      SELECT jsonl_body FROM harness_shared.harness_run_output
       WHERE harness_slug = ${project.slug} AND run_id = ${runId}
       LIMIT 1
    `;
    if (rows.length > 0 && rows[0].jsonl_body) {
      jsonlRaw = rows[0].jsonl_body;
    }
  } catch { /* fall through to disk */ }
  if (jsonlRaw === null) {
    jsonlRaw = safeRead(jsonlPath);
  }

  // Parse stream-json events into a compact timeline the UI can render.
  const timeline: Array<{
    kind: 'text' | 'tool_use' | 'tool_result' | 'status' | 'result' | 'error';
    text?: string;
    toolName?: string;
    toolInput?: unknown;
    toolId?: string;
    ts?: number;
    costUsd?: number;
    inputTokens?: number;
    outputTokens?: number;
    durationMs?: number;
  }> = [];
  let accumulatedText = '';
  let totalCostUsd = 0;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;

  if (jsonlRaw) {
    for (const rawLine of jsonlRaw.split('\n')) {
      const line = rawLine.trim();
      if (!line) continue;
      try {
        const obj = JSON.parse(line);
        const type = obj.type;

        if (type === 'stream_event' && obj.event?.type === 'content_block_delta') {
          const delta = obj.event?.delta;
          if (delta?.type === 'text_delta' && typeof delta.text === 'string') {
            accumulatedText += delta.text;
          }
        } else if (type === 'assistant' && obj.message?.content) {
          // Flush accumulated partial text as one text entry
          if (accumulatedText) {
            timeline.push({ kind: 'text', text: accumulatedText });
            accumulatedText = '';
          }
          for (const block of obj.message.content) {
            if (block.type === 'text') {
              timeline.push({ kind: 'text', text: block.text });
            } else if (block.type === 'tool_use') {
              timeline.push({ kind: 'tool_use', toolName: block.name, toolInput: block.input, toolId: block.id });
            }
          }
        } else if (type === 'user' && obj.message?.content) {
          for (const block of obj.message.content) {
            if (block.type === 'tool_result') {
              const contentStr = typeof block.content === 'string'
                ? block.content
                : Array.isArray(block.content)
                  ? block.content.map((p: any) => p.text ?? '').join('')
                  : '';
              timeline.push({ kind: 'tool_result', toolId: block.tool_use_id, text: contentStr });
            }
          }
        } else if (type === 'result') {
          totalCostUsd += obj.total_cost_usd ?? 0;
          totalInputTokens += obj.usage?.input_tokens ?? 0;
          totalOutputTokens += obj.usage?.output_tokens ?? 0;
          timeline.push({
            kind: 'result',
            text: obj.result ?? '',
            costUsd: obj.total_cost_usd,
            inputTokens: obj.usage?.input_tokens,
            outputTokens: obj.usage?.output_tokens,
            durationMs: obj.duration_ms,
          });
        } else if (type === 'system' && obj.subtype === 'status') {
          timeline.push({ kind: 'status', text: obj.status });
        }
      } catch {
        // Skip malformed line
      }
    }
    // Flush any remaining partial text
    if (accumulatedText) timeline.push({ kind: 'text', text: accumulatedText });
  }

  return c.json({
    runId,
    stdout: safeRead(join(logDir, `${runId}.out`)),
    stderr: safeRead(join(logDir, `${runId}.err`)),
    jsonlBytes: jsonlRaw?.length ?? 0,
    timeline,
    totalCostUsd,
    totalInputTokens,
    totalOutputTokens,
  });
});

/**
 * SSE: live stream of one agent run's "thinking" — text deltas, tool
 * uses, tool results, and the terminal `result` event.
 *
 * Powers the hover popover on Now-running agent pills. Uses fs.watch
 * (no polling) on `<runId>.jsonl`; on connect, replays the parsed
 * timeline so the popover paints immediately, then appends new events
 * as the file grows. Closes when the agent emits its `result` event
 * or the client disconnects.
 *
 * Reuses the global activeStreams cap + per-IP eviction pattern from
 * /:slug/log/stream so a fast hover-back-and-forth doesn't accumulate
 * connections.
 */
harness.get('/:slug/agents/:runId/stream', async (c) => {
  const project = await resolvePhasedProject(c.req.param('slug'), phasePhaseLabel(c.req.query('phase')));
  if (!project) return c.json({ error: 'unknown project' }, 404);
  const runId = c.req.param('runId').replace(/[^A-Za-z0-9_.-]/g, '');
  const logDir = join(harnessDir(project), 'logs');
  const jsonlPath = join(logDir, `${runId}.jsonl`);

  const remoteIP = (c.req.header('x-forwarded-for')?.split(',')[0].trim())
    ?? c.req.header('x-real-ip')
    ?? c.req.header('cf-connecting-ip')
    ?? 'unknown';
  const streamKey = `agent|${remoteIP}|${project.slug}|${runId}`;
  if (!activeStreams.has(streamKey) && activeStreams.size >= HARNESS_STREAM_TOTAL_CAP) {
    return c.json({ error: 'too many active streams', cap: HARNESS_STREAM_TOTAL_CAP }, 503);
  }
  const previous = activeStreams.get(streamKey);
  if (previous) previous.abort();

  // Inline parser — emits zero or more compact timeline entries per
  // raw stream-json line. Mirrors the shape used by /:slug/agents/:runId
  // so the UI can reuse the same renderer.
  const fs = require('node:fs') as typeof import('node:fs');
  type TimelineEntry = {
    kind: 'text' | 'tool_use' | 'tool_result' | 'status' | 'result';
    text?: string;
    toolName?: string;
    toolInput?: unknown;
    toolId?: string;
    costUsd?: number;
    inputTokens?: number;
    outputTokens?: number;
    durationMs?: number;
  };
  // Two formats supported:
  //   - claude-code stream-json: type=stream_event/assistant/user/result
  //   - omp:                     type=message_update (assistantMessageEvent
  //                              with text/thinking deltas) + turn_end +
  //                              tool_execution_start/end
  // The popover doesn't care which backend wrote the file — it just
  // wants the user-visible "what's the agent doing right now" stream.
  let pendingText = '';
  let pendingThinking = '';
  const flushText = (out: TimelineEntry[]) => {
    if (pendingText) { out.push({ kind: 'text', text: pendingText }); pendingText = ''; }
  };
  const flushThinking = (out: TimelineEntry[]) => {
    if (pendingThinking) {
      out.push({ kind: 'status', text: `[thinking] ${pendingThinking}` });
      pendingThinking = '';
    }
  };
  const parseLine = (raw: string): TimelineEntry[] => {
    const out: TimelineEntry[] = [];
    let obj: any;
    try { obj = JSON.parse(raw); } catch { return out; }
    const type = obj.type;

    // ── claude-code stream-json ──────────────────────────────
    if (type === 'stream_event' && obj.event?.type === 'content_block_delta') {
      const delta = obj.event?.delta;
      if (delta?.type === 'text_delta' && typeof delta.text === 'string') {
        pendingText += delta.text;
      }
    } else if (type === 'assistant' && obj.message?.content) {
      flushText(out);
      for (const block of obj.message.content) {
        if (block.type === 'text') out.push({ kind: 'text', text: block.text });
        else if (block.type === 'tool_use') out.push({ kind: 'tool_use', toolName: block.name, toolInput: block.input, toolId: block.id });
      }
    } else if (type === 'user' && obj.message?.content) {
      for (const block of obj.message.content) {
        if (block.type === 'tool_result') {
          const contentStr = typeof block.content === 'string'
            ? block.content
            : Array.isArray(block.content)
              ? block.content.map((p: any) => p.text ?? '').join('')
              : '';
          out.push({ kind: 'tool_result', toolId: block.tool_use_id, text: contentStr });
        }
      }
    } else if (type === 'result') {
      flushText(out);
      out.push({
        kind: 'result',
        text: obj.result ?? '',
        costUsd: obj.total_cost_usd,
        inputTokens: obj.usage?.input_tokens,
        outputTokens: obj.usage?.output_tokens,
        durationMs: obj.duration_ms,
      });
    } else if (type === 'system' && obj.subtype === 'status') {
      out.push({ kind: 'status', text: obj.status });
    }

    // ── omp (oh-my-pi) format ────────────────────────────────
    else if (type === 'message_update' && obj.assistantMessageEvent) {
      const ev = obj.assistantMessageEvent;
      // Text delta → accumulate
      if (ev.type === 'text_delta' && typeof ev.delta === 'string') {
        flushThinking(out);
        pendingText += ev.delta;
      } else if (ev.type === 'thinking_delta' && typeof ev.delta === 'string') {
        pendingThinking += ev.delta;
      } else if (ev.type === 'thinking_end') {
        flushThinking(out);
      }
      // Other event subtypes (tool_use_start etc.) are surfaced via the
      // separate tool_execution_start lines, so we don't double-count.
    } else if (type === 'tool_execution_start') {
      flushText(out);
      flushThinking(out);
      out.push({
        kind: 'tool_use',
        toolName: obj.toolName ?? 'tool',
        toolInput: obj.args,
        toolId: obj.toolCallId,
      });
    } else if (type === 'tool_execution_end') {
      const result = obj.result;
      const text = typeof result === 'string'
        ? result
        : Array.isArray(result)
          ? result.map((p: any) => (typeof p === 'string' ? p : (p?.text ?? JSON.stringify(p)))).join('')
          : result != null
            ? JSON.stringify(result)
            : '';
      out.push({
        kind: 'tool_result',
        toolId: obj.toolCallId,
        text,
      });
    } else if (type === 'turn_end' && obj.message?.content) {
      flushText(out);
      flushThinking(out);
      // turn_end carries the full assistant content; emit any text or
      // thinking we haven't already streamed via deltas.
      const lastText: string[] = [];
      for (const block of obj.message.content) {
        if (block.type === 'text' && typeof block.text === 'string') {
          lastText.push(block.text);
        }
      }
      if (lastText.length > 0) {
        out.push({ kind: 'result', text: lastText.join('\n').slice(0, 500) });
      }
    } else if (type === 'message_end') {
      // Terminal end-of-message marker (often a user-side echo). Surface
      // as a status separator rather than spam the timeline.
      flushText(out);
      flushThinking(out);
    }
    return out;
  };

  return streamSSE(c, async (stream) => {
    let ownAborted = false;
    const token: StreamToken = {
      abort: () => { ownAborted = true; },
      createdAt: Date.now(),
      remoteIP,
      slug: project.slug,
    };
    activeStreams.set(streamKey, token);

    let lineBuf = '';
    let done = false;

    const emitChunk = async (chunk: string) => {
      lineBuf += chunk;
      let nl: number;
      while ((nl = lineBuf.indexOf('\n')) !== -1) {
        const line = lineBuf.slice(0, nl).trim();
        lineBuf = lineBuf.slice(nl + 1);
        if (!line) continue;
        const entries = parseLine(line);
        for (const e of entries) {
          await stream.writeSSE({ event: 'event', data: JSON.stringify(e) });
          if (e.kind === 'result') {
            done = true;
            await stream.writeSSE({ event: 'done', data: '{}' });
          }
        }
      }
    };

    try {
      // Backfill: prefer PG-canonical jsonl_body from harness_run_output
      // (Phase 4); fall back to disk for runs that completed before
      // activation or in CLI-only mode. parseLine mutates
      // pendingText/pendingThinking; that's intended — across many
      // lines, deltas accumulate and flush on assistant/turn_end/result
      // events the same as in tail mode.
      let backfillRaw: string | null = null;
      try {
        const { sql } = (await import('@restart/db-org')).getOrgPg();
        const rows = await sql<{ jsonl_body: string }[]>`
          SELECT jsonl_body FROM harness_shared.harness_run_output
           WHERE harness_slug = ${project.slug} AND run_id = ${runId}
           LIMIT 1
        `;
        if (rows.length > 0 && rows[0].jsonl_body) {
          backfillRaw = rows[0].jsonl_body;
        }
      } catch { /* fall through to disk */ }
      if (backfillRaw === null) {
        try {
          const stat = fs.statSync(jsonlPath);
          if (stat.size > 0) {
            backfillRaw = fs.readFileSync(jsonlPath, 'utf8');
          }
        } catch { /* no file yet either */ }
      }

      if (backfillRaw && backfillRaw.length > 0) {
        const backfill: TimelineEntry[] = [];
        for (const rawLine of backfillRaw.split('\n')) {
          const line = rawLine.trim();
          if (!line) continue;
          for (const e of parseLine(line)) {
            backfill.push(e);
            if (e.kind === 'result') done = true;
          }
        }
        if (pendingText) { backfill.push({ kind: 'text', text: pendingText }); pendingText = ''; }
        if (pendingThinking) { backfill.push({ kind: 'status', text: `[thinking] ${pendingThinking}` }); pendingThinking = ''; }
        const capped = backfill.length > 200 ? backfill.slice(-200) : backfill;
        await stream.writeSSE({ event: 'backfill', data: JSON.stringify(capped) });
        if (done) await stream.writeSSE({ event: 'done', data: '{}' });
      } else {
        await stream.writeSSE({ event: 'backfill', data: '[]' });
      }

      // Live mode: in-process bus only. Orchestrator's invoke.ts POSTs
      // each subprocess stdout chunk to /api/internal/run-chunk, which
      // publishes to the per-run channel; this subscriber emits one
      // SSE event per parsed line. The on-disk JSONL is no longer the
      // streaming path — invoke.ts writes it once at exit (or skips
      // entirely in PG-canonical mode), so fs.watch had nothing to
      // watch and was retired in this commit.
      const { subscribe: busSubscribe } = await import('@/lib/run-chunk-bus');
      const channelKey = `${project.slug}:${runId}`;
      const busSub = busSubscribe(channelKey, (env) => {
        void emitChunk(env.data);
      });
      // Replay anything in the recent ring buffer (subscriber joined
      // after publishing started).
      for (const env of busSub.recent) {
        await emitChunk(env.data);
      }
      // When the bus signals done, propagate to the SSE client.
      void busSub.whenDone.then(async () => {
        if (!done) {
          done = true;
          try { await stream.writeSSE({ event: 'done', data: '{}' }); } catch {}
        }
      });

      // Keepalive + abort check.
      while (!ownAborted && !stream.aborted && !done) {
        await stream.sleep(2000);
        await stream.writeSSE({ event: 'ping', data: '{}' });
      }
      busSub.unsubscribe();
    } finally {
      if (activeStreams.get(streamKey) === token) activeStreams.delete(streamKey);
    }
  });
});

// ─── feature-level controls (resets, skips) ──────────────────────────

/**
 * Phase 8: Goal-lineage for a feature.
 *
 * Workers fetch this before starting work to inject "## Why this matters"
 * into their context. Walks parent_id chain → goal_id via the
 * harness_shared.task_lineage() Postgres function (Phase 1 schema).
 *
 * `?format=md` (default) returns markdown text/plain.
 * `?format=json` returns the raw lineage row array.
 */
harness.get('/:slug/feature/:id/lineage', async (c) => {
  const project = await resolveProject(c.req.param('slug'));
  if (!project) return c.json({ error: 'unknown project' }, 404);
  const id = c.req.param('id');
  const format = c.req.query('format') ?? 'md';
  const schemaName = slugToSchemaName(project.slug);
  try {
    const { sql } = getHarnessPg(project.slug);
    const rows = await getFeatureLineage(sql, schemaName, project.slug, id);
    if (rows.length === 0) {
      return c.json({ error: 'feature not found or no lineage' }, 404);
    }
    if (format === 'json') {
      return c.json({ slug: project.slug, featureId: id, lineage: rows });
    }
    return c.text(formatLineageForPrompt(rows), 200, { 'content-type': 'text/markdown; charset=utf-8' });
  } catch (err: any) {
    return c.json({ error: 'lineage lookup failed', detail: String(err?.message ?? err) }, 500);
  }
});

harness.post('/:slug/features/:id/reset', async (c) => {
  const project = await resolvePhasedProject(c.req.param('slug'), phasePhaseLabel(c.req.query('phase')));
  if (!project) return c.json({ error: 'unknown project' }, 404);
  const id = c.req.param('id');
  const dbc = dbcFor(project.slug);
  const existing = await dbc.prepare('SELECT * FROM harness_features WHERE harness_slug = ? AND feature_id = ?').get(project.slug, id) as any;
  if (!existing) return c.json({ error: 'feature not found' }, 404);
  await dbc.transaction(async (tx) => {
    await tx.prepare('UPDATE harness_features SET status = ?, attempts = ?, updated_ts = ? WHERE harness_slug = ? AND feature_id = ?')
      .run('todo', 0, Date.now(), project.slug, id);
    auditFeatureChange(project.slug, id, 'status', existing.status, 'todo', 'api:reset');
    auditFeatureChange(project.slug, id, 'attempts', existing.attempts, 0, 'api:reset');
  });
  const feat = rowToFeature(await dbc.prepare('SELECT * FROM harness_features WHERE harness_slug = ? AND feature_id = ?').get(project.slug, id));

  // If worktree isolation is active and this feature has a stale worktree,
  // remove it so the next worker starts from a clean baseBranch.
  const hd = harnessDir(project);
  const wtPath = join(hd, 'worktrees', id);
  let worktreeRemoved = false;
  try {
    const cfg = JSON.parse(readFileSync(join(hd, 'config.json'), 'utf8'));
    const useWorktrees = cfg?.branchIsolation?.useWorktrees === true && cfg?.branchIsolation?.enabled === true;
    if (useWorktrees && existsSync(wtPath)) {
      const { spawnSync } = await import('node:child_process');
      spawnSync('git', ['worktree', 'remove', '--force', wtPath], { cwd: project.path });
      spawnSync('git', ['branch', '-D', `harness/${id}`], { cwd: project.path });
      worktreeRemoved = true;
    }
  } catch {}

  return c.json({ ok: true, feature: feat, worktreeRemoved });
});

// Layer A/B: VALID_STATUSES is now a hint for coding harnesses; non-coding
// harnesses (org/department) use their own enums per config.json.itemStates.
// The PATCH endpoint accepts any string status; UI/orchestrator validate.
const FEATURE_ID_RE = /^[A-Z][A-Z0-9-]+(-[A-Z0-9-]+)?$/;  // F-001, PROJ-sheets, DIR-D-001

harness.patch('/:slug/features/:id', async (c) => {
  const project = await resolvePhasedProject(c.req.param('slug'), phasePhaseLabel(c.req.query('phase')));
  if (!project) return c.json({ error: 'unknown project' }, 404);
  const id = c.req.param('id');
  const body = await c.req.json() as { title?: string; summary?: string; claims?: string[]; status?: string; attempts?: number; project_id?: string; expected_cost_cents?: number; tags?: string[]; needs_human_review?: boolean; metadata?: any; notes?: string; deprecation_reason?: string };
  const actor = c.req.header('x-actor') ?? 'api';
  // Ensure deprecation_reason column exists (idempotent; once per process per slug).

  const dbc = dbcFor(project.slug);
  const existing = await dbc.prepare('SELECT * FROM harness_features WHERE harness_slug = ? AND feature_id = ?').get(project.slug, id) as any;
  if (!existing) return c.json({ error: 'feature not found' }, 404);

  const updates: Record<string, any> = {};
  if (body.status !== undefined) {
    if (typeof body.status !== 'string' || !body.status) return c.json({ error: 'invalid status' }, 400);
    updates.status = body.status;
  }
  if (body.title !== undefined) {
    if (typeof body.title !== 'string' || body.title.trim() === '') return c.json({ error: 'title must be a non-empty string' }, 400);
    updates.title = body.title.trim();
  }
  if (body.claims !== undefined) {
    if (!Array.isArray(body.claims) || body.claims.some((v) => typeof v !== 'string')) return c.json({ error: 'claims must be string[]' }, 400);
    updates.claims = JSON.stringify(body.claims.map((s) => s.trim()).filter(Boolean));
  }
  if (body.attempts !== undefined) {
    if (typeof body.attempts !== 'number' || body.attempts < 0 || !Number.isInteger(body.attempts)) return c.json({ error: 'attempts must be a non-negative integer' }, 400);
    updates.attempts = body.attempts;
  }
  if (body.project_id !== undefined) updates.project_id = body.project_id || null;
  if (body.expected_cost_cents !== undefined) updates.expected_cost_cents = body.expected_cost_cents;
  if (body.tags !== undefined) updates.tags = body.tags == null ? null : JSON.stringify(body.tags); // jsonb — serialize for Postgres
  if (body.needs_human_review !== undefined) updates.needs_human_review = !!body.needs_human_review;
  if (body.metadata !== undefined) updates.metadata = body.metadata == null ? null : JSON.stringify(body.metadata); // jsonb
  if (body.summary !== undefined) {
    if (body.summary !== null && typeof body.summary !== 'string') return c.json({ error: 'summary must be a string or null' }, 400);
    updates.summary = body.summary;
  }
  if (body.notes !== undefined) {
    if (body.notes !== null && typeof body.notes !== 'string') return c.json({ error: 'notes must be a string or null' }, 400);
    updates.notes = body.notes;
  }
  if (body.deprecation_reason !== undefined) {
    if (body.deprecation_reason !== null && typeof body.deprecation_reason !== 'string') return c.json({ error: 'deprecation_reason must be a string or null' }, 400);
    updates.deprecation_reason = body.deprecation_reason;
  }
  // Auto-clear deprecation_reason when un-deprecating, auto-require when deprecating.
  if (updates.status === 'deprecated' && updates.deprecation_reason === undefined && !existing.deprecation_reason) {
    return c.json({ error: 'deprecation_reason required when transitioning to status=deprecated' }, 400);
  }
  if (updates.status !== undefined && updates.status !== 'deprecated' && existing.deprecation_reason && updates.deprecation_reason === undefined) {
    updates.deprecation_reason = null;
  }

  if (Object.keys(updates).length === 0) return c.json({ ok: true, feature: rowToFeature(existing), changes: 0 });

  await dbc.transaction(async (tx) => {
    const setClauses = Object.keys(updates).map((k) => `${k} = @${k}`).join(', ');
    await tx.prepare(`UPDATE harness_features SET ${setClauses}, updated_ts = @updated_ts WHERE harness_slug = @hslug AND feature_id = @fid`)
      .run({ ...updates, updated_ts: Date.now(), hslug: project.slug, fid: id });
    for (const [field, newVal] of Object.entries(updates)) {
      const oldVal = existing[field];
      auditFeatureChange(project.slug, id, field, oldVal, newVal, actor);
    }
  });

  // Phase B+ — Project Manager hook. When a feature transitions INTO 'passed'
  // (was not passed before; is passed now) AND has a project_id, enqueue a
  // pending_events row that the orchestrator's NEXT_PROJECT_MANAGER decision
  // verb will eventually consume. Coalescing happens at the orchestrator
  // (it picks one project per tick and PM consumes all pending events for
  // that project in a batch).
  const transitionedToPassed =
    updates.status === 'passed' && existing.status !== 'passed';
  const projectIdForPm = (updates.project_id ?? existing.project_id) as string | null | undefined;
  if (transitionedToPassed && projectIdForPm) {
    try {
      const eventId = `pm-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      // Workspace-scoped: pending_events insert tagged with the active
      // workspace so RLS predicates pass + the row is visible to listeners.
      await withWorkspaceLegacy(project.slug, activeWorkspaceId(), async (db) => {
        await db.prepare(`
          INSERT INTO harness_shared.pending_events
            (id, install_slug, kind, target_role, payload, due_at, workspace_id)
          VALUES (?, ?, 'pm_due', 'project_manager', ?::jsonb, now(), ?)
        `).run(eventId, project.slug, JSON.stringify({ project_id: projectIdForPm, feature_id: id, source: 'feature_passed' }), activeWorkspaceId());
      });
    } catch {
      // pending_events table absent or insert failed — best-effort, do not
      // fail the PATCH response over PM scheduling.
    }
  }

  if (transitionedToPassed) {
    void firePluginLifecycle('onFeaturePassed', {
      installSlug: project.slug,
      projectDir: project.path,
      stateDir: harnessDir(project),
    }, id);
    void firePluginEvent('task.passed', { taskId: id, installSlug: project.slug });
    void firePluginEvent('feature.completed', { featureId: id, installSlug: project.slug });
  }

  const updated = await dbc.prepare('SELECT * FROM harness_features WHERE harness_slug = ? AND feature_id = ?').get(project.slug, id) as any;
  return c.json({ ok: true, feature: rowToFeature(updated) });
});

/**
 * POST /:slug/features/import — bulk-import endpoint for the scoper.
 *
 * Replaces the run.sh `features.json → psql ON CONFLICT` shim that's been
 * the import path since 2026-04-26. Body matches the legacy features.json
 * shape: `{features: [{id, title, summary, status, attempts, claims, ...}]}`.
 *
 * INSERT ... ON CONFLICT DO UPDATE updates title/status/summary on existing
 * feature_id; new rows are inserted with caller-provided ts/created_ts/
 * updated_ts (defaulting to now). Returns counts.
 *
 * The scoper now POSTs here on MODE=initial / MODE=replan; run.sh's shim
 * stays as a transition fallback for harnesses whose scoper hasn't been
 * updated yet.
 */
harness.post('/:slug/features/import', async (c) => {
  const project = await resolvePhasedProject(c.req.param('slug'), phasePhaseLabel(c.req.query('phase')));
  if (!project) return c.json({ error: 'unknown project' }, 404);
  const body = await c.req.json().catch(() => null) as null | {
    features?: Array<{
      id: string;
      title: string;
      summary?: string;
      status?: string;
      attempts?: number;
      claims?: string[] | null;
      notes?: string | null;
      metadata?: Record<string, unknown> | null;
      kind?: string | null;
      project_id?: string | null;
      expected_cost_cents?: number | null;
      tags?: string[] | null;
      needs_human_review?: boolean;
      ts?: number | null;
    }>;
  };
  if (!body?.features || !Array.isArray(body.features) || body.features.length === 0) {
    return c.json({ error: 'features array required' }, 400);
  }
  const features = body.features;
  const invalid = features.find((f) => !f.id || !FEATURE_ID_RE.test(f.id) || !f.title);
  if (invalid) {
    return c.json({ error: `every feature requires a valid id (matching ${FEATURE_ID_RE.source}) and title; offender: ${JSON.stringify(invalid).slice(0, 200)}` }, 400);
  }

  const dbc = dbcFor(project.slug);
  const now = Date.now();
  let inserted = 0;
  let updated = 0;
  let skippedKindMismatch = 0;
  await dbc.transaction(async (tx) => {
    for (const f of features) {
      const existing = await tx.prepare(
        'SELECT kind FROM harness_features WHERE harness_slug = ? AND feature_id = ?',
      ).get(project.slug, f.id) as { kind: string | null } | undefined;
      if (existing) {
        // Cross-writer guard: if the existing row was authored by a non-product
        // writer (kind set to something other than null/'product'), only allow
        // updates from the same kind. Prevents scoper-replan from accidentally
        // overwriting an expert-authored infra feature when feature ids collide.
        // Treats null and 'product' as equivalent (legacy product rows pre-migration).
        const existingKind = existing.kind ?? 'product';
        const incomingKind = f.kind ?? 'product';
        if (existingKind !== 'product' && existingKind !== incomingKind) {
          skippedKindMismatch++;
          continue;
        }
        await tx.prepare(`
          UPDATE harness_features SET
            title = ?,
            summary = ?,
            status = ?,
            updated_ts = ?
          WHERE harness_slug = ? AND feature_id = ?
        `).run(f.title, f.summary ?? null, f.status ?? 'todo', now, project.slug, f.id);
        updated++;
      } else {
        await tx.prepare(`
          INSERT INTO harness_features
            (harness_slug, feature_id, title, summary, status, attempts, claims, notes, metadata,
             kind, project_id, expected_cost_cents, tags, needs_human_review,
             ts, created_ts, updated_ts)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          project.slug, f.id, f.title, f.summary ?? null, f.status ?? 'todo',
          f.attempts ?? 0,
          f.claims && f.claims.length > 0 ? JSON.stringify(f.claims) : null,
          f.notes ?? null,
          f.metadata ? JSON.stringify(f.metadata) : null,
          f.kind ?? null,
          f.project_id ?? null,
          f.expected_cost_cents ?? null,
          f.tags && f.tags.length > 0 ? JSON.stringify(f.tags) : null,
          Boolean(f.needs_human_review),
          f.ts ?? now, now, now,
        );
        inserted++;
      }
    }
  });
  return c.json({ ok: true, inserted, updated, total: features.length, skippedKindMismatch });
});

harness.post('/:slug/features', async (c) => {
  const project = await resolvePhasedProject(c.req.param('slug'), phasePhaseLabel(c.req.query('phase')));
  if (!project) return c.json({ error: 'unknown project' }, 404);
  const body = await c.req.json() as { id?: string; title?: string; claims?: string[]; status?: string; summary?: string; kind?: string; project_id?: string; expected_cost_cents?: number; tags?: string[]; needs_human_review?: boolean; metadata?: any };
  const actor = c.req.header('x-actor') ?? 'api';

  const id = (body.id ?? '').trim();
  const title = (body.title ?? '').trim();
  if (!FEATURE_ID_RE.test(id)) {
    return c.json({ error: `id must match ${FEATURE_ID_RE.source}` }, 400);
  }
  if (!title) return c.json({ error: 'title required' }, 400);

  const dbc = dbcFor(project.slug);
  const exists = await dbc.prepare('SELECT 1 AS x FROM harness_features WHERE harness_slug = ? AND feature_id = ?').get(project.slug, id);
  if (exists) return c.json({ error: `id already exists: ${id}` }, 409);

  // Item 6: budget enforcement at proposal-add time. If the feature has a
  // project_id AND the project has a non-null budget AND adding this feature's
  // expected_cost_cents would push committed-spend over the budget → reject.
  if (body.project_id && typeof body.expected_cost_cents === 'number' && body.expected_cost_cents > 0) {
    const project_row = await dbc.prepare('SELECT id, name, budget_cents FROM projects WHERE id = ?').get(body.project_id) as any;
    if (project_row && project_row.budget_cents !== null) {
      // Cross-harness committed sum: the same project can be referenced from
      // many harnesses, so we sum across the all_features view.
      const adminC = getLegacyClient();
      const committed = Number(((await adminC.prepare(`
        SELECT COALESCE(SUM(expected_cost_cents), 0) as total
        FROM all_features
        WHERE project_id = ? AND status NOT IN ('cancelled', 'launched', 'passed')
      `).get(body.project_id)) as any).total ?? 0);
      const proposed_total = committed + body.expected_cost_cents;
      if (proposed_total > Number(project_row.budget_cents)) {
        const now = Date.now();
        await dbc.prepare(`INSERT INTO harness_features
          (harness_slug, feature_id, title, summary, status, attempts, claims, notes, metadata, kind,
           project_id, expected_cost_cents, tags, needs_human_review, ts, created_ts, updated_ts)
          VALUES (?, ?, ?, ?, 'out_of_budget', 0, NULL, ?, NULL, ?, ?, ?, NULL, false, ?, ?, ?)`).run(
            project.slug, id, title,
            body.summary ?? `Auto-rejected: would push ${project_row.name} over budget. Committed: ${committed}, proposed cost: ${body.expected_cost_cents}, budget: ${project_row.budget_cents}`,
            `Budget exceeded: requested ${body.expected_cost_cents} cents on top of ${committed} already committed (cap ${project_row.budget_cents}).`,
            body.kind ?? null, body.project_id, body.expected_cost_cents,
            now, now, now,
          );
        auditFeatureChange(project.slug, id, '__rejected_budget', null, { project: project_row.id, budget: Number(project_row.budget_cents), committed, proposed: body.expected_cost_cents }, actor);
        return c.json({
          ok: false,
          error: 'out_of_budget',
          rejected: true,
          project_id: project_row.id,
          project_name: project_row.name,
          project_budget_cents: Number(project_row.budget_cents),
          already_committed_cents: committed,
          proposed_cost_cents: body.expected_cost_cents,
          would_total_cents: proposed_total,
        }, 409);
      }
    }
  }

  const status = body.status || 'todo';
  const claims = Array.isArray(body.claims) ? body.claims.map((s) => String(s).trim()).filter(Boolean) : [];
  const now = Date.now();

  await dbc.transaction(async (tx) => {
    await tx.prepare(`INSERT INTO harness_features
      (harness_slug, feature_id, title, summary, status, attempts, claims, notes, metadata, kind,
       project_id, expected_cost_cents, tags, needs_human_review, ts, created_ts, updated_ts)
      VALUES (?, ?, ?, ?, ?, 0, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        project.slug, id, title, body.summary ?? null, status,
        claims.length ? JSON.stringify(claims) : null,
        body.metadata == null ? null : JSON.stringify(body.metadata),  // jsonb
        body.kind ?? null,
        body.project_id ?? null,
        typeof body.expected_cost_cents === 'number' ? body.expected_cost_cents : null,
        Array.isArray(body.tags) ? JSON.stringify(body.tags) : null,    // jsonb
        !!body.needs_human_review,
        now, now, now,
      );
    auditFeatureChange(project.slug, id, '__created', null, { id, title, status }, actor);
  });

  const created = rowToFeature(await dbc.prepare('SELECT * FROM harness_features WHERE harness_slug = ? AND feature_id = ?').get(project.slug, id));
  return c.json({ ok: true, feature: created });
});

harness.delete('/:slug/features/:id', async (c) => {
  const project = await resolvePhasedProject(c.req.param('slug'), phasePhaseLabel(c.req.query('phase')));
  if (!project) return c.json({ error: 'unknown project' }, 404);
  const id = c.req.param('id');
  const actor = c.req.header('x-actor') ?? 'api';
  const dbc = dbcFor(project.slug);
  const existing = await dbc.prepare('SELECT * FROM harness_features WHERE harness_slug = ? AND feature_id = ?').get(project.slug, id) as any;
  if (!existing) return c.json({ error: 'feature not found' }, 404);
  await dbc.transaction(async (tx) => {
    await tx.prepare('DELETE FROM harness_features WHERE harness_slug = ? AND feature_id = ?').run(project.slug, id);
    auditFeatureChange(project.slug, id, '__deleted', rowToFeature(existing), null, actor);
  });
  return c.json({ ok: true, deleted: id });
});

// ─── SSE: tail run.log + push feature-diff heartbeats ───────────────

// SSE connection management (added 2026-04-26 to fix event-loop saturation
// from accumulating /stream connections that never close cleanly).
//
// Rules:
//  - Per (remote IP, slug) key: only one active stream. New connection
//    evicts the previous one for that key.
//  - Total cap across all clients: HARNESS_STREAM_TOTAL_CAP. Beyond cap,
//    new connections get 503.
//
// Diagnostics: GET /api/harness/streams/active returns the live registry.
type StreamToken = { abort: () => void; createdAt: number; remoteIP: string; slug: string };
const activeStreams: Map<string, StreamToken> =
  (globalThis as any).__papercupActiveStreams ?? new Map();
(globalThis as any).__papercupActiveStreams = activeStreams;
const HARNESS_STREAM_TOTAL_CAP = Number(process.env.HARNESS_STREAM_TOTAL_CAP ?? '64');

harness.get('/streams/active', (c) => {
  const now = Date.now();
  const out = Array.from(activeStreams.entries()).map(([key, t]) => ({
    key, slug: t.slug, remoteIP: t.remoteIP,
    ageMs: now - t.createdAt,
  }));
  return c.json({ count: activeStreams.size, cap: HARNESS_STREAM_TOTAL_CAP, streams: out });
});

harness.get('/:slug/stream', async (c) => {
  const project = await resolvePhasedProject(c.req.param('slug'), phasePhaseLabel(c.req.query('phase')));
  if (!project) return c.json({ error: 'unknown project' }, 404);
  const runLogPath = join(harnessDir(project), 'logs', 'run.log');

  // Identify caller. Behind cloudflared / next dev, x-forwarded-for is reliable.
  const remoteIP = (c.req.header('x-forwarded-for')?.split(',')[0].trim())
    ?? c.req.header('x-real-ip')
    ?? c.req.header('cf-connecting-ip')
    ?? 'unknown';
  const streamKey = `${remoteIP}|${project.slug}`;

  // Total cap: refuse new keys if at limit
  if (!activeStreams.has(streamKey) && activeStreams.size >= HARNESS_STREAM_TOTAL_CAP) {
    return c.json({ error: 'too many active streams', cap: HARNESS_STREAM_TOTAL_CAP }, 503);
  }

  // Per-key: evict any existing stream for this (ip, slug)
  const previous = activeStreams.get(streamKey);
  if (previous) previous.abort();

  return streamSSE(c, async (stream) => {
    let ownAborted = false;
    const token: StreamToken = {
      abort: () => { ownAborted = true; },
      createdAt: Date.now(),
      remoteIP,
      slug: project.slug,
    };
    activeStreams.set(streamKey, token);

    try {
      let lastFeatureState = '';

      // Backfill from disk once on connect — replays the tail so the
      // client has scrollback context. After this, live updates come
      // from the bus.
      try {
        const stat = statSync(runLogPath);
        const tailBytes = 256 * 1024;
        const start = Math.max(0, stat.size - tailBytes);
        const fd = readFileSync(runLogPath, 'utf8');
        const chunk = fd.slice(start);
        if (chunk) await stream.writeSSE({ event: 'log', data: chunk });
      } catch {}

      const { subscribe: logSubscribe } = await import('@/lib/harness-log-bus');
      const sub = logSubscribe(`${project.slug}:raw`, (env) => {
        void stream.writeSSE({ event: 'log', data: env.line + '\n' }).catch(() => {});
      });
      // Replay recent ring (small; pre-backfill covers history).
      for (const env of sub.recent) {
        void stream.writeSSE({ event: 'log', data: env.line + '\n' }).catch(() => {});
      }

      const pushFeatures = async () => {
        const feats = await parseFeatures(project);
        const state = JSON.stringify(feats.map((f) => [f.id, f.status, f.attempts]));
        if (state !== lastFeatureState) {
          lastFeatureState = state;
          await stream.writeSSE({ event: 'features', data: JSON.stringify(feats) });
        }
      };

      try {
        while (true) {
          if (stream.aborted || ownAborted) break;
          // Features come from PG (parseFeatures) — still polled because
          // they're not in the bus today. Lower frequency now that log
          // tailing is event-driven.
          await pushFeatures();
          await stream.sleep(3000);
        }
      } finally {
        sub.unsubscribe();
      }
    } finally {
      // Only remove if we're still the registered token (eviction may have replaced us).
      if (activeStreams.get(streamKey) === token) {
        activeStreams.delete(streamKey);
      }
    }
  });
});

// ─── SSE: structured JSONL log stream ──────────────────────────────
//
// Replaces the legacy text-stream `/:slug/stream` for the new LogView UI.
// Tails run.log.jsonl with fs.watch (no polling), parses each line into a
// LogEvent {ts, source, level, msg, corrId?, attrs?}, and emits one SSE
// event per line. On connect, backfills the last `tail` (default 500)
// events so the UI has scrollback.
//
// Old `/:slug/stream` stays around for any external consumers; the
// operator UI migrates to this endpoint.

/**
 * Paginated read into older log history. Reads run.log.jsonl plus its
 * rotated .N.gz peers, returns the chunk of `limit` events ending at
 * the given `before` timestamp (or the latest in current when omitted).
 *
 * Used by the LogView's "load more" button to backfill older events that
 * fell outside the SSE backfill window or live in rotations.
 *
 * Query: ?before=<ISO ts>&limit=N (default 500, capped at 5000).
 */
harness.get('/:slug/log/history', async (c) => {
  const project = await resolvePhasedProject(c.req.param('slug'), phasePhaseLabel(c.req.query('phase')));
  if (!project) return c.json({ error: 'unknown project' }, 404);
  const before = c.req.query('before') || null;
  const limit = Math.min(Math.max(parseInt(c.req.query('limit') ?? '500', 10) || 500, 1), 5000);
  const logsDir = join(harnessDir(project), 'logs');

  // Read the current run.log.jsonl + every rotated .N.gz, parse each
  // line into a LogEvent, sort descending by ts, slice the window.
  // O(n) over the union — fine for the 50 MB cap.
  const events: Array<{ ts: string; raw: string }> = [];
  const fs = require('node:fs') as typeof import('node:fs');
  const zlib = require('node:zlib') as typeof import('node:zlib');

  const sources: Array<{ path: string; gz: boolean }> = [];
  if (fs.existsSync(join(logsDir, 'run.log.jsonl'))) {
    sources.push({ path: join(logsDir, 'run.log.jsonl'), gz: false });
  }
  for (let i = 1; i <= 20; i++) {
    const p = join(logsDir, `run.log.jsonl.${i}.gz`);
    if (fs.existsSync(p)) sources.push({ path: p, gz: true });
  }

  for (const src of sources) {
    let content: string;
    try {
      const buf = fs.readFileSync(src.path);
      content = src.gz ? zlib.gunzipSync(buf).toString('utf8') : buf.toString('utf8');
    } catch {
      continue;
    }
    for (const line of content.split('\n')) {
      if (!line.trim()) continue;
      // Cheap ts extraction without full JSON parse — saves CPU on the 50 MB scan.
      const m = line.match(/"ts":"([^"]+)"/);
      if (!m) continue;
      events.push({ ts: m[1], raw: line });
    }
  }
  events.sort((a, b) => b.ts.localeCompare(a.ts));

  const filtered = before
    ? events.filter((e) => e.ts < before)
    : events;
  const slice = filtered.slice(0, limit).reverse(); // ascending for the UI prepend

  // Parse the slice fully now that we've scoped it.
  const parsed: unknown[] = [];
  for (const e of slice) {
    try { parsed.push(JSON.parse(e.raw)); } catch { /* skip malformed */ }
  }

  return c.json({
    events: parsed,
    hasMore: filtered.length > limit,
    oldest: parsed[0] && typeof (parsed[0] as { ts?: string }).ts === 'string'
      ? (parsed[0] as { ts: string }).ts
      : null,
  });
});

harness.get('/:slug/log/stream', async (c) => {
  const project = await resolvePhasedProject(c.req.param('slug'), phasePhaseLabel(c.req.query('phase')));
  if (!project) return c.json({ error: 'unknown project' }, 404);
  const jsonlPath = join(harnessDir(project), 'logs', 'run.log.jsonl');
  const tailSize = Math.min(Math.max(parseInt(c.req.query('tail') ?? '500', 10) || 500, 1), 5000);

  const remoteIP = (c.req.header('x-forwarded-for')?.split(',')[0].trim())
    ?? c.req.header('x-real-ip')
    ?? c.req.header('cf-connecting-ip')
    ?? 'unknown';
  const streamKey = `jsonl|${remoteIP}|${project.slug}`;
  if (!activeStreams.has(streamKey) && activeStreams.size >= HARNESS_STREAM_TOTAL_CAP) {
    return c.json({ error: 'too many active streams', cap: HARNESS_STREAM_TOTAL_CAP }, 503);
  }
  const previous = activeStreams.get(streamKey);
  if (previous) previous.abort();

  return streamSSE(c, async (stream) => {
    let ownAborted = false;
    const token: StreamToken = {
      abort: () => { ownAborted = true; },
      createdAt: Date.now(),
      remoteIP,
      slug: project.slug,
    };
    activeStreams.set(streamKey, token);

    let lastSize = 0;
    let lineBuf = '';

    // Emit each parseable JSONL line as one SSE event. Tolerates broken
    // lines silently (rotation can race with write).
    const emitLines = async (chunk: string) => {
      lineBuf += chunk;
      let nl: number;
      while ((nl = lineBuf.indexOf('\n')) >= 0) {
        const raw = lineBuf.slice(0, nl);
        lineBuf = lineBuf.slice(nl + 1);
        if (!raw.trim()) continue;
        try {
          const evt = JSON.parse(raw);
          await stream.writeSSE({ event: 'log', data: JSON.stringify(evt) });
        } catch {
          /* malformed line — skip rather than break the stream */
        }
      }
    };

    // Backfill: read the tail of the file and replay the last N lines so
    // the client has immediate context on connect.
    //
    // Two fixes vs the prior implementation (which took 6-7s for 500 lines):
    //   1. Read only the last 1 MiB via openSync + readSync(offset). The
    //      previous code did `readFileSync` of the whole file then sliced
    //      in memory — on a 50 MiB log that's 50 MiB of allocation per
    //      reconnect.
    //   2. Don't await per-line. SSE backpressure means each writeSSE in
    //      a loop can take tens of ms; 500 × 20ms = 10s of dead time. We
    //      build the multi-event payload as a single string, then issue
    //      one write. The browser sees no difference; the server stops
    //      blocking on its own backpressure.
    const backfill = async () => {
      try {
        const stat = statSync(jsonlPath);
        const tailBytes = 1024 * 1024;
        const start = Math.max(0, stat.size - tailBytes);
        const len = stat.size - start;
        const buf = Buffer.alloc(len);
        const fd = openSync(jsonlPath, 'r');
        try {
          readSync(fd, buf, 0, len, start);
        } finally {
          closeSync(fd);
        }
        lastSize = stat.size;
        // If we sliced into the middle of a line, drop the partial first one.
        let chunk = buf.toString('utf8');
        if (start > 0) {
          const firstNl = chunk.indexOf('\n');
          if (firstNl >= 0) chunk = chunk.slice(firstNl + 1);
        }
        const allLines = chunk.split('\n').filter(Boolean);
        const toReplay = allLines.slice(-tailSize);

        // Build the SSE payload in one pass, then issue ONE write. SSE
        // events are framed by `event: <name>\ndata: <text>\n\n`; we
        // emit all `log` events back-to-back followed by the
        // `backfill-done` event.
        let payload = '';
        let count = 0;
        for (const raw of toReplay) {
          try {
            // Validate the JSON lossily so we don't feed broken data to
            // the client, but reuse the original string to skip a stringify.
            JSON.parse(raw);
            payload += `event: log\ndata: ${raw}\n\n`;
            count++;
          } catch { /* skip malformed */ }
        }
        payload += `event: backfill-done\ndata: ${count}\n\n`;
        // Write the whole batch via the underlying response writer so
        // we bypass writeSSE's per-event flush logic.
        await stream.write(payload);
      } catch {
        await stream.writeSSE({ event: 'backfill-done', data: '0' });
      }
    };

    await backfill();

    // Live updates come from the in-process log bus. run.sh's log()
    // function POSTs each line to /api/internal/log-event; that handler
    // calls publish() on the harness-log-bus channel; this subscriber
    // emits one SSE event per line. Sub-ms latency, no fs.watch, no
    // periodic re-stat. The on-disk JSONL is still authoritative for
    // backfill-on-connect (above) and historical /log/history queries.
    const { subscribe: logSubscribe } = await import('@/lib/harness-log-bus');
    const sub = logSubscribe(`${project.slug}:log`, (env) => {
      // Validate JSON before forwarding — keeps the client surface
      // identical to the prior fs.watch path.
      try { JSON.parse(env.line); }
      catch { return; }
      void stream.writeSSE({ event: 'log', data: env.line }).catch(() => { /* client gone */ });
    });
    // Replay any recent ring-buffer entries the subscriber missed
    // between connect and subscribe — small in practice (≤256 lines)
    // because we already backfilled from disk above.
    for (const env of sub.recent) {
      try { JSON.parse(env.line); }
      catch { continue; }
      void stream.writeSSE({ event: 'log', data: env.line }).catch(() => { /* client gone */ });
    }

    try {
      while (true) {
        if (stream.aborted || ownAborted) break;
        await stream.sleep(15_000);
        await stream.writeSSE({ event: 'ping', data: '{}' });
      }
    } finally {
      sub.unsubscribe();
      if (activeStreams.get(streamKey) === token) {
        activeStreams.delete(streamKey);
      }
    }
  });
});

// ─── launch / stop (optional, safer to run manually for now) ─────────

harness.post('/:slug/launch', async (c) => {
  const project = await resolvePhasedProject(c.req.param('slug'), phasePhaseLabel(c.req.query('phase')));
  if (!project) return c.json({ error: 'unknown project' }, 404);
  // Pre-flight: SPEC.md is required for the scoper to produce features.
  // Without it, run.sh exits 2 with no useful explanation. Catching it
  // here gives the user an actionable error.
  const specPath = join(project.path, 'SPEC.md');
  if (!existsSync(specPath)) {
    return c.json({
      error: 'SPEC.md not found',
      hint: 'Create SPEC.md in the project directory describing what you want built. The scoper reads this to generate the work queue.',
      path: specPath,
    }, 400);
  }
  const body = await c.req.json().catch(() => ({}));
  const extra = typeof body.extra === 'string' ? body.extra : '';
  const result = await launchRun(project, extra);
  if (!result.ok) return c.json({ error: result.error }, 500);
  // Phase 6b — plugin lifecycle: fire `beforeMissionStart` (typed hook) +
  // `mission.start` (free-form event bus). Best-effort; never blocks the
  // launch response.
  void firePluginLifecycle('beforeMissionStart', {
    installSlug: project.slug,
    projectDir: project.path,
    stateDir: harnessDir(project),
  });
  void firePluginEvent('mission.start', { installSlug: project.slug });
  return c.json({ ok: true, logPath: result.logPath });
});

/**
 * Single-role invocation — used by NEXT_HARNESS dispatch from a parent
 * harness's coordinator. Synchronously runs `bash run.sh invoke <role>` in
 * the child harness's project dir and returns the captured stdout.
 *
 * This is the cross-harness primitive that makes harness-of-harnesses work:
 * a parent's coordinator emits `NEXT_HARNESS <child-slug> --role=<role>`,
 * the dispatcher POSTs here, the child's role runs once and returns.
 */
harness.post('/:slug/invoke', async (c) => {
  const project = await resolveProject(c.req.param('slug'));
  if (!project) return c.json({ error: 'unknown project' }, 404);
  const role = c.req.query('role') ?? 'orchestrator';
  if (!/^[A-Za-z0-9_-]+$/.test(role)) {
    return c.json({ error: 'invalid role name' }, 400);
  }
  const body = await c.req.json().catch(() => ({} as any));
  const timeoutMs = Math.max(5_000, Math.min(300_000, Number(body?.timeoutMs ?? 90_000)));
  const extra: string[] = Array.isArray(body?.extra) ? body.extra.filter((s: any) => typeof s === 'string') : [];

  const runScript = harnessPath('run.sh');
  if (!existsSync(runScript)) return c.json({ error: 'run.sh missing' }, 500);

  // Phase 7: write pending_events for the role to read at $STATE_DIR/pending-events.jsonl.
  // Eager-consume; sources retry/idempotent. Only the orchestrator reads this currently.
  if (role === 'orchestrator') {
    try {
      const { sql } = getOrgPg();
      const events = await listUnconsumedEvents(sql, project.slug, { onlyDue: true, limit: 25 });
      const stateDir = join(project.path, '.harness');
      const eventsFile = join(stateDir, 'pending-events.jsonl');
      const { writeFileSync, mkdirSync, rmSync } = await import('node:fs');
      mkdirSync(stateDir, { recursive: true });
      if (events.length > 0) {
        const jsonl = events
          .map((e) => JSON.stringify({
            id: e.id,
            kind: e.kind,
            target_role: e.targetRole,
            payload: e.payload,
            due_at: e.dueAt,
            source_id: e.sourceId,
          }))
          .join('\n');
        writeFileSync(eventsFile, jsonl + '\n', 'utf8');
        await consumeEvents(sql, events.map((e) => e.id), `papercusp-invoke:${project.slug}`);
      } else {
        try { rmSync(eventsFile, { force: true }); } catch {}
      }
    } catch {
      // pending_events table absent — proceed without
    }
  }

  const { spawn } = await import('node:child_process');
  // Source ONLY the function definitions (not run.sh's top-level orchestrator
  // loop). Pattern from the existing scoper invocation at line 1349 above.
  const harnessDirPath = harnessPackageDir();
  const escapedExtra = [role, ...extra]
    .map((s) => `'${String(s).replace(/'/g, "'\\''")}'`)
    .join(' ');
  const wrapper = `
    set -e
    export PROJECT_DIR="${project.path}"
    export STATE_DIR="${project.path}/.harness"
    export HARNESS_DIR="${harnessDirPath}"
    export LOG_DIR="$STATE_DIR/logs"
    mkdir -p "$STATE_DIR" "$LOG_DIR"
    # Layer 2: read HARNESS_PHASE from config.json so prompt resolution
    # picks the right per-phase prompt (department/orchestrator.md instead
    # of the generic coding orchestrator).
    if [ -f "$STATE_DIR/config.json" ]; then
      export HARNESS_PHASE="$(CONFIG="$STATE_DIR/config.json" python3 -c '
import json, os
try:
    d = json.load(open(os.environ["CONFIG"]))
    print(d.get("phase", "staging"))
except Exception:
    print("staging")
')"
    fi
    source <(awk '/^(log|config_get|invoke|run_hook|snapshot_state|notify_event|harness_slug|fire_plugin_hook|auto_screenshot_post_worker|notify_event|check_cost_cap|prune_logs)\\(\\)/,/^}/' $HARNESS_DIR/run.sh)
    invoke ${escapedExtra}
  `;
  return new Promise<Response>((resolve) => {
    const child = spawn('bash', ['-c', wrapper], {
      cwd: project.path,
      env: {
        ...process.env,
        CLAUDE: process.env.AGENT_CMD ?? process.env.CLAUDE ?? 'omp -p',
        MAX_ITERATIONS: '1',
      },
    });
    let stdout = '', stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; try { child.kill('SIGTERM'); } catch {} }, timeoutMs);
    child.stdout?.on('data', (d) => { stdout += String(d); });
    child.stderr?.on('data', (d) => { stderr += String(d); });
    child.on('close', (code) => {
      clearTimeout(timer);
      // Strip run.sh log lines (which start with `[<ISO timestamp>]`) so the
      // decision line is the actual agent output, not run.sh's own logging.
      const agentLines = stdout.split('\n').filter((l) => !/^\[20\d\d-\d\d-\d\dT/.test(l));
      const agentOutput = agentLines.join('\n').trim();
      const decisionLine = (agentOutput.split('\n')[0] ?? '').trim();

      // Post-process: if the role emitted an ```actions``` block, parse and
      // dispatch each action through /api/admin/execute-action with this
      // harness's bearer token. /invoke direct calls bypass run.sh's
      // process_actions_block, so we run the equivalent here.
      (async () => {
        let actionsResult: { count: number; results: any[] } | null = null;
        if (code === 0 && !timedOut) {
          try {
            actionsResult = await dispatchActionsBlockFromOutput(project.slug, project.path, agentOutput);
          } catch (e) {
            // eslint-disable-next-line no-console
            console.warn(`[invoke ${project.slug}/${role}] actions dispatch failed:`, e);
          }
        }

        resolve(c.json({
          ok: code === 0 && !timedOut,
          slug: project.slug,
          role,
          decisionLine,
          agentOutput,
          stdout,
          stderr,
          exitCode: code,
          timedOut,
          actions: actionsResult,
        }));
      })();
    });
  });
});

/**
 * Extract ```actions``` block from agent output and POST each entry to
 * /api/admin/execute-action with the harness's harness_token. Returns
 * a summary of dispatched actions or null if no block was present.
 *
 * `extractResult` from run.sh's invoke only returns the trailing summary
 * text, not the full streamed response — the actions block is typically
 * mid-response. We fall back to reassembling text from the latest
 * .jsonl file in the harness's logs dir.
 */
async function dispatchActionsBlockFromOutput(
  callerSlug: string,
  projectPath: string,
  output: string,
): Promise<{ count: number; results: any[] } | null> {
  let blockMatch = output.match(/```actions\s*\n([\s\S]*?)\n```/);
  if (!blockMatch) {
    // The invoke wrapper writes a "stdout: <path>" header line referencing
    // the .out file for THIS run. Parse the path, swap .out → .jsonl,
    // reassemble text from content_block_delta events.
    const pathMatch = output.match(/stdout:\s*(\S+\.out)/);
    let jsonlPath: string | null = null;
    if (pathMatch) {
      jsonlPath = pathMatch[1].replace(/\.out$/, '.jsonl');
    } else {
      // Fallback: most recent .jsonl in logs (last resort, can race with parallel runs).
      const logsDir = join(projectPath, '.harness', 'logs');
      if (existsSync(logsDir)) {
        const files = readdirSync(logsDir)
          .filter((f) => f.endsWith('.jsonl'))
          .map((f) => ({ path: join(logsDir, f), mt: statSync(join(logsDir, f)).mtimeMs }))
          .sort((a, b) => b.mt - a.mt);
        if (files.length > 0) jsonlPath = files[0].path;
      }
    }
    if (jsonlPath && existsSync(jsonlPath)) {
      try {
        const text = readFileSync(jsonlPath, 'utf8').split('\n').reduce((acc, line) => {
          try {
            const j = JSON.parse(line);
            const ev = j.event || j;
            if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta') {
              return acc + (ev.delta.text || '');
            }
          } catch { /* skip */ }
          return acc;
        }, '');
        blockMatch = text.match(/```actions\s*\n([\s\S]*?)\n```/);
      } catch { /* skip */ }
    }
  }
  if (!blockMatch) return null;
  let actions: any[];
  try {
    actions = JSON.parse(blockMatch[1]);
    if (!Array.isArray(actions)) return null;
  } catch {
    return { count: 0, results: [{ error: 'malformed JSON in actions block' }] };
  }
  if (actions.length === 0) return null;

  // Read the harness's bearer token.
  const cfgPath = join(projectPath, '.harness', 'config.json');
  if (!existsSync(cfgPath)) return null;
  let token: string;
  try {
    const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
    token = cfg.harness_token;
    if (!token) return null;
  } catch { return null; }

  const operatorBase = process.env.PAPERCUSP_OPERATOR_BASE ?? 'http://localhost:3055';
  const { randomUUID } = await import('node:crypto');
  const results: any[] = [];
  for (const action of actions) {
    const actionId = randomUUID();
    try {
      const r = await fetch(`${operatorBase}/api/admin/execute-action`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ actionId, action }),
        signal: AbortSignal.timeout(360_000), // 6 min — covers scaffold_harness's 5-min internal timeout + slack
      });
      const j = await r.json().catch(() => ({}));
      results.push({ op: action.op, ok: (j as any).ok === true, error: (j as any).error ?? null, status: r.status });
    } catch (e: any) {
      results.push({ op: action.op, ok: false, error: String(e?.message ?? e).slice(0, 200) });
    }
  }
  return { count: actions.length, results };
}

// ─── escalation handshake ────────────────────────────────────────────

/**
 * Layer 3 polish: list `runs/*.md` summaries written by `bash run.sh invoke`.
 * Replaces the old `director-runs/` reader for the new substrate. Returns
 * each run's filename + decision_line + ts + role parsed from the file.
 */
harness.get('/:slug/runs', async (c) => {
  const project = await resolveProject(c.req.param('slug'));
  if (!project) return c.json({ error: 'unknown project' }, 404);
  const runsDir = join(harnessDir(project), 'runs');
  if (!existsSync(runsDir)) return c.json({ runs: [] });
  const limit = Math.min(200, Math.max(1, Number(c.req.query('limit') ?? 50)));
  let files: string[] = [];
  try { files = readdirSync(runsDir).filter((f) => f.endsWith('.md')); } catch { return c.json({ runs: [] }); }
  const runs = files
    .map((name) => {
      const fullPath = join(runsDir, name);
      let mtimeMs = 0;
      try { mtimeMs = statSync(fullPath).mtimeMs; } catch {}
      // Parse the front-matter style header
      const content = safeRead(fullPath) ?? '';
      const tsMatch = content.match(/^- ts: (.+)$/m);
      const roleMatch = content.match(/^- role: (.+)$/m);
      const decisionMatch = content.match(/^- decision_line: `(.+?)`$/m);
      const exitMatch = content.match(/^- exit_code: (\d+)$/m);
      return {
        name,
        path: fullPath,
        mtimeMs,
        ts: tsMatch?.[1] ?? null,
        role: roleMatch?.[1] ?? null,
        decisionLine: decisionMatch?.[1] ?? null,
        exitCode: exitMatch ? Number(exitMatch[1]) : null,
      };
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, limit);
  return c.json({ runs });
});

/**
 * Layer 3 polish: read one specific runs/*.md file.
 */
harness.get('/:slug/runs/:name', async (c) => {
  const project = await resolveProject(c.req.param('slug'));
  if (!project) return c.json({ error: 'unknown project' }, 404);
  const name = c.req.param('name').replace(/[^A-Za-z0-9_.:-]/g, '');
  if (!name || !name.endsWith('.md')) return c.json({ error: 'invalid name' }, 400);
  const path = join(harnessDir(project), 'runs', name);
  if (!existsSync(path)) return c.json({ error: 'not found' }, 404);
  return c.json({ name, content: safeRead(path) });
});

harness.get('/:slug/escalation', async (c) => {
  const { getEscalation } = await import('@/lib/harness-readers');
  const result = await getEscalation(c.req.param('slug'), phasePhaseLabel(c.req.query('phase')));
  if (!result.ok) return c.json({ error: result.error }, result.status);
  return c.json(result.data);
});

// ─── competitions (Conductor-inspired same-feature races) ───────────

harness.get('/:slug/competitions', async (c) => {
  const project = await resolveProject(c.req.param('slug'));
  if (!project) return c.json({ error: 'unknown project' }, 404);
  const hd = harnessDir(project);
  if (!existsSync(hd)) return c.json({ competitions: [] });
  const out: Array<any> = [];
  for (const f of readdirSync(hd)) {
    const m = f.match(/^competition-([A-Za-z0-9_.-]+)\.json$/);
    if (!m) continue;
    try {
      const manifest = JSON.parse(readFileSync(join(hd, f), 'utf8'));
      // Per-lane state: does worktree dir still exist? does its branch have commits?
      const lanes = (manifest.lanes ?? []).map((lane: any) => {
        const wtExists = existsSync(lane.worktree);
        let lastCommitMs = 0;
        try {
          const headPath = join(lane.worktree, '.git');
          if (existsSync(headPath)) {
            const s = statSync(headPath);
            lastCommitMs = s.mtimeMs;
          }
        } catch {}
        return { ...lane, worktreeExists: wtExists, lastActivityMs: lastCommitMs };
      });
      let mtimeMs = 0;
      try { mtimeMs = statSync(join(hd, f)).mtimeMs; } catch {}
      out.push({
        parentFeatureId: manifest.parentFeatureId,
        n: manifest.n,
        lanes,
        startedMs: mtimeMs,
      });
    } catch {}
  }
  return c.json({ competitions: out });
});

// ─── smoke test (claudecode-orchestrator-inspired service gate) ─────

harness.post('/:slug/smoke-test/run', async (c) => {
  const project = await resolveProject(c.req.param('slug'));
  if (!project) return c.json({ error: 'unknown project' }, 404);
  const { spawn } = await import('node:child_process');
  const scriptPath = harnessPath('bin', 'service-smoke-test.sh');
  if (!existsSync(scriptPath)) return c.json({ error: 'smoke-test script not found' }, 500);
  return new Promise((resolve) => {
    let stdout = '';
    const p = spawn('bash', [scriptPath], {
      env: { ...process.env, PROJECT_DIR: project.path, STATE_DIR: join(project.path, '.harness') },
    });
    p.stdout.on('data', (d) => { stdout += d.toString(); });
    p.stderr.on('data', (d) => { stdout += d.toString(); });
    p.on('close', (code) => {
      resolve(c.json({ ok: code === 0, rc: code, output: stdout }) as unknown as void);
    });
  });
});

// SSE pilot: emit a 'change' event whenever any of the smoke-test files
// change. Client subscribes and refetches /smoke-test on each event,
// replacing the 5s polling loop. Heartbeat every 30s so proxies don't
// timeout the connection.

// ─── orchestrator-writes-status (Phase 3) ─────────────────────────────
//
// These endpoints accept writes from `run.sh` (via the pg-status.sh helper).
// Together with the harness-status-sweep, they replace the /proc-walk +
// 5s-poll path that drove the dashboard's status/lanes tiles.
//
// Authentication: `run.sh` runs in the same process tree as the operator
// (spawned by the Node sidecar), so we trust loopback callers — same trust
// model the existing /lanes and /agents read endpoints use.

harness.post('/:slug/orchestrator/status', async (c) => {
  const project = await resolveProject(c.req.param('slug'));
  if (!project) return c.json({ error: 'unknown project' }, 404);
  let body: {
    phase?: string;
    status?: string;
    iteration?: number;
    totalFeatures?: number;
    passedCount?: number;
    todoCount?: number;
    blockedCount?: number;
    lastActiveTs?: number;
    costUsd?: number;
  };
  try {
    body = (await c.req.json()) as typeof body;
  } catch {
    return c.json({ error: 'invalid JSON' }, 400);
  }
  const phase = body.phase === 'testing' || body.phase === 'production'
    ? body.phase : 'staging';
  const allowed = new Set(['idle', 'running', 'stalled', 'paused', 'error']);
  if (!body.status || !allowed.has(body.status)) {
    return c.json({ error: 'status must be one of idle/running/stalled/paused/error' }, 400);
  }
  await ensureHarnessStatusTable();
  const { db } = getOrgPg();
  const { generated } = await import('@restart/db-org');
  const { sql: dsql } = await import('drizzle-orm');
  const hs = generated.harness_statusInHarness_shared;
  const ws = activeWorkspaceId();
  const STATUS_LEASE_MS = 5 * 60_000;
  const now = Date.now();
  const expiresAt = now + STATUS_LEASE_MS;
  await db
    .insert(hs)
    .values({
      harness_slug: project.slug,
      phase,
      status: body.status,
      iteration: Number(body.iteration) || 0,
      total_features: Number(body.totalFeatures) || 0,
      passed_count: Number(body.passedCount) || 0,
      todo_count: Number(body.todoCount) || 0,
      blocked_count: Number(body.blockedCount) || 0,
      last_active_ts: body.lastActiveTs ?? null,
      cost_usd: body.costUsd ?? null,
      workspace_id: ws,
      updated_at: now,
      expires_at: new Date(expiresAt) as any,
    })
    .onConflictDoUpdate({
      target: [hs.harness_slug, hs.phase],
      set: {
        status: dsql`EXCLUDED.status`,
        iteration: dsql`EXCLUDED.iteration`,
        total_features: dsql`EXCLUDED.total_features`,
        passed_count: dsql`EXCLUDED.passed_count`,
        todo_count: dsql`EXCLUDED.todo_count`,
        blocked_count: dsql`EXCLUDED.blocked_count`,
        last_active_ts: dsql`EXCLUDED.last_active_ts`,
        cost_usd: dsql`EXCLUDED.cost_usd`,
        workspace_id: dsql`EXCLUDED.workspace_id`,
        updated_at: dsql`EXCLUDED.updated_at`,
        expires_at: dsql`EXCLUDED.expires_at`,
      },
    });
  const { notifySyncInvalidate } = await import('@/lib/sync-sse');
  await notifySyncInvalidate('harnessStatus.byHarness', { harnessSlug: project.slug });
  return c.json({ ok: true });
});

harness.post('/:slug/orchestrator/lane', async (c) => {
  const project = await resolveProject(c.req.param('slug'));
  if (!project) return c.json({ error: 'unknown project' }, 404);
  let body: { phase?: string; role?: string; featureId?: string | null; pid?: number | null };
  try {
    body = (await c.req.json()) as typeof body;
  } catch {
    return c.json({ error: 'invalid JSON' }, 400);
  }
  const phase = body.phase === 'testing' || body.phase === 'production'
    ? body.phase : 'staging';
  if (!body.role || typeof body.role !== 'string') {
    return c.json({ error: 'role required' }, 400);
  }
  await ensureHarnessLanesTable();
  const { db } = getOrgPg();
  const { generated } = await import('@restart/db-org');
  const { and, eq, sql: dsql } = await import('drizzle-orm');
  const hl = generated.harness_lanesInHarness_shared;
  const ws = activeWorkspaceId();
  await db
    .insert(hl)
    .values({
      harness_slug: project.slug,
      phase,
      role: body.role,
      feature_id: body.featureId ?? null,
      pid: body.pid ?? null,
      started_at: Date.now(),
      workspace_id: ws,
    })
    .onConflictDoUpdate({
      target: [hl.harness_slug, hl.phase, hl.role],
      set: {
        feature_id: dsql`EXCLUDED.feature_id`,
        pid: dsql`EXCLUDED.pid`,
        started_at: dsql`EXCLUDED.started_at`,
        workspace_id: dsql`EXCLUDED.workspace_id`,
      },
    });
  return c.json({ ok: true });
});

harness.delete('/:slug/orchestrator/lanes', async (c) => {
  const project = await resolveProject(c.req.param('slug'));
  if (!project) return c.json({ error: 'unknown project' }, 404);
  const phase = c.req.query('phase') === 'testing' || c.req.query('phase') === 'production'
    ? c.req.query('phase') : 'staging';
  await ensureHarnessLanesTable();
  const { db } = getOrgPg();
  const { generated } = await import('@restart/db-org');
  const { and, eq } = await import('drizzle-orm');
  const hl = generated.harness_lanesInHarness_shared;
  await db.delete(hl).where(and(eq(hl.harness_slug, project.slug), eq(hl.phase, phase)));
  return c.json({ ok: true });
});

/**
 * Adaptive-mode telemetry endpoints.
 *
 * Two operations:
 *   POST   /:slug/orchestrator/adaptive-telemetry        — record a NEXT_WORKER
 *          decision in adaptive mode. Returns { id } so the caller can
 *          later attach an outcome.
 *   PATCH  /:slug/orchestrator/adaptive-telemetry/:id    — attach an outcome
 *          ('pass' | 'fail' | 'cancelled') and duration to a previously
 *          recorded decision.
 *
 * The orchestrator main-loop calls these from within handleNextWorker
 * (decision insert) and from the validator post-hook (outcome patch).
 * Failures are best-effort — telemetry must never block agent dispatch.
 */
harness.get('/:slug/orchestrator/adaptive-telemetry', async (c) => {
  const project = await resolveProject(c.req.param('slug'));
  if (!project) return c.json({ error: 'unknown project' }, 404);
  const limitRaw = Number(c.req.query('limit') ?? 200);
  const limit = Math.max(1, Math.min(1000, Number.isFinite(limitRaw) ? limitRaw : 200));
  await ensureAdaptiveTelemetryTable();
  const { sql } = getOrgPg();
  const rows = await sql`
    SELECT id, ts, feature_id, requested_n, actual_n,
           tier_label, available_at_decision, max_slots,
           outcome, outcome_ts, duration_ms
      FROM harness_shared.adaptive_telemetry
     WHERE harness_slug = ${project.slug}
     ORDER BY ts DESC
     LIMIT ${limit}
  `;
  return c.json({ rows });
});

harness.post('/:slug/orchestrator/adaptive-telemetry', async (c) => {
  const project = await resolveProject(c.req.param('slug'));
  if (!project) return c.json({ error: 'unknown project' }, 404);
  let body: {
    featureId?: string;
    requestedN?: number;
    actualN?: number;
    tierLabel?: string | null;
    availableAtDecision?: number | null;
    maxSlots?: number | null;
  };
  try {
    body = (await c.req.json()) as typeof body;
  } catch {
    return c.json({ error: 'invalid JSON' }, 400);
  }
  if (!body.featureId || typeof body.featureId !== 'string') {
    return c.json({ error: 'featureId required' }, 400);
  }
  const requestedN = Number(body.requestedN);
  const actualN = Number(body.actualN);
  if (!Number.isInteger(requestedN) || !Number.isInteger(actualN) || actualN < 1) {
    return c.json({ error: 'requestedN/actualN must be positive integers' }, 400);
  }
  await ensureAdaptiveTelemetryTable();
  const { sql } = getOrgPg();
  const ws = activeWorkspaceId();
  const rows = await sql<{ id: number }[]>`
    INSERT INTO harness_shared.adaptive_telemetry
      (harness_slug, ts, feature_id, requested_n, actual_n,
       tier_label, available_at_decision, max_slots, workspace_id)
    VALUES (
      ${project.slug}, ${Date.now()}, ${body.featureId},
      ${requestedN}, ${actualN},
      ${body.tierLabel ?? null}, ${body.availableAtDecision ?? null},
      ${body.maxSlots ?? null}, ${ws}
    )
    RETURNING id
  `;
  return c.json({ ok: true, id: rows[0]?.id ?? null });
});

harness.patch('/:slug/orchestrator/adaptive-telemetry/:id', async (c) => {
  const project = await resolveProject(c.req.param('slug'));
  if (!project) return c.json({ error: 'unknown project' }, 404);
  const id = Number(c.req.param('id'));
  if (!Number.isInteger(id) || id < 1) return c.json({ error: 'invalid id' }, 400);
  let body: { outcome?: string; durationMs?: number | null };
  try {
    body = (await c.req.json()) as typeof body;
  } catch {
    return c.json({ error: 'invalid JSON' }, 400);
  }
  if (!body.outcome || !['pass', 'fail', 'cancelled'].includes(body.outcome)) {
    return c.json({ error: "outcome must be one of 'pass'|'fail'|'cancelled'" }, 400);
  }
  await ensureAdaptiveTelemetryTable();
  const { sql } = getOrgPg();
  await sql`
    UPDATE harness_shared.adaptive_telemetry
       SET outcome = ${body.outcome},
           outcome_ts = ${Date.now()},
           duration_ms = ${body.durationMs ?? null}
     WHERE id = ${id} AND harness_slug = ${project.slug}
  `;
  return c.json({ ok: true });
});

harness.post('/:slug/orchestrator/clear-running', async (c) => {
  const project = await resolveProject(c.req.param('slug'));
  if (!project) return c.json({ error: 'unknown project' }, 404);
  // agent_runs lives in the per-harness schema, not harness_shared.
  const { sql } = getHarnessPg(project.slug);
  await sql`UPDATE agent_runs SET running = false WHERE running = true`;
  return c.json({ ok: true });
});

// ─── identity files (Agent-Swarm-inspired cross-mission memory) ─────

harness.get('/identity', async (c) => {
  // PG-canonical-for-reads (Migration 041). Files at ~/autonomous-harness/
  // identity/<role>.md remain the source of truth for the orchestrator
  // subprocess (prompt-build.ts:87 reads them on every role invocation);
  // the operator-side watcher mirrors them in so the UI doesn't readdir
  // per request and Zero subscribers wake up on changes.
  const { ensureIdentityFilesTable } = await import('@/lib/ensure-schema');
  await ensureIdentityFilesTable();
  const { sql } = (await import('@restart/db-org')).getOrgPg();
  const rows = await sql<{ role: string; content: string; bytes: number; mtime_ms: string | number }[]>`
    SELECT role, content, bytes, mtime_ms
      FROM harness_shared.identity_files
     ORDER BY role ASC
  `;
  // FS fallback for the brief window before the watcher's initialSync
  // populates PG on a fresh install.
  if (rows.length === 0) {
    const dir = harnessPath('identity');
    if (existsSync(dir)) {
      const out: Array<{ role: string; content: string; bytes: number; mtimeMs: number }> = [];
      for (const f of readdirSync(dir)) {
        if (!f.endsWith('.md')) continue;
        const p = join(dir, f);
        const role = f.replace(/\.md$/, '');
        try {
          const s = statSync(p);
          out.push({ role, content: readFileSync(p, 'utf8'), bytes: s.size, mtimeMs: s.mtimeMs });
        } catch {}
      }
      out.sort((a, b) => a.role.localeCompare(b.role));
      return c.json({ identities: out });
    }
  }
  return c.json({
    identities: rows.map((r) => ({
      role: r.role,
      content: r.content,
      bytes: r.bytes,
      mtimeMs: Number(r.mtime_ms) || 0,
    })),
  });
});

// ─── checkpoints (Hermes-inspired named human-gated pauses) ──────────

// SSE: emit 'change' when any checkpoint file's mtime/size changes,
// or when a *.granted sibling appears/disappears. Same pattern as
// smoke-test SSE.

harness.post('/:slug/checkpoint/:name/request', async (c) => {
  // Manually create a pending checkpoint (human asks the harness to pause).
  const project = await resolveProject(c.req.param('slug'));
  if (!project) return c.json({ error: 'unknown project' }, 404);
  const name = c.req.param('name').replace(/[^A-Za-z0-9_.-]/g, '');
  if (!name) return c.json({ error: 'invalid name' }, 400);
  const body = (await c.req.json().catch(() => ({}))) as { message?: string };
  const hd = harnessDir(project);
  const cpPath = join(hd, `checkpoint-${name}.md`);
  if (existsSync(cpPath)) return c.json({ error: 'checkpoint already pending', path: cpPath }, 409);
  const { writeFileSync } = await import('node:fs');
  writeFileSync(cpPath, `# Checkpoint: ${name} (manual request)

Requested at: ${new Date().toISOString()}
By: human operator via UI

${body.message ?? ''}

## How to grant
- UI: click "Grant" in the CheckpointBanner, or POST /api/harness/${c.req.param('slug')}/checkpoint/${name}/grant
- CLI: touch ${cpPath}.granted; then re-run the harness
`);
  return c.json({ ok: true, requested: name });
});

harness.post('/:slug/checkpoint/:name/grant', async (c) => {
  const project = await resolveProject(c.req.param('slug'));
  if (!project) return c.json({ error: 'unknown project' }, 404);
  const name = c.req.param('name').replace(/[^A-Za-z0-9_.-]/g, '');
  if (!name) return c.json({ error: 'invalid name' }, 400);
  const hd = harnessDir(project);
  const cpPath = join(hd, `checkpoint-${name}.md`);

  // Phase 3 PG path: flip granted=true directly + emit sync_invalidate
  // so the UI's harnessCheckpoints query refetches in real time. The
  // bash run.sh on the orchestrator side reads .granted files at
  // pre-loop time, so we keep the file write for back-compat — bash
  // sees the file, TS orchestrator's checkpoints-pg sees the row.
  let pgGranted = false;
  try {
    const { sql } = (await import('@restart/db-org')).getOrgPg();
    const ws = activeWorkspaceId();
    const rows = await sql<{ updated: boolean }[]>`
      UPDATE harness_shared.harness_checkpoints
         SET granted = true
       WHERE harness_slug = ${project.slug}
         AND workspace_id = ${ws}
         AND name         = ${name}
         AND granted      = false
         AND consumed     = false
      RETURNING TRUE AS updated
    `;
    if (rows.length > 0) {
      pgGranted = true;
      await sql`
        SELECT pg_notify('sync_invalidate',
          ${JSON.stringify({
            name: 'harnessCheckpoints.byHarness',
            args: { harnessSlug: project.slug },
          })})
      `;
    }
  } catch {
    /* fall through; file write below still works */
  }

  // File path is the source of truth for bash run.sh. Orchestrator-TS
  // mode reads PG directly via the row above. Skip the file when the
  // checkpoint .md file isn't on disk (the orchestrator-TS path doesn't
  // create files; only PG rows).
  if (existsSync(cpPath)) {
    const grantPath = `${cpPath}.granted`;
    const { writeFileSync } = await import('node:fs');
    writeFileSync(grantPath, `granted at ${new Date().toISOString()}\n`);
  } else if (!pgGranted) {
    return c.json({ error: 'no such checkpoint' }, 404);
  }

  return c.json({
    ok: true,
    granted: name,
    via: pgGranted ? 'pg' : 'file',
    next: pgGranted
      ? 'Orchestrator will pick up the grant on next pre-loop pass.'
      : 'Re-run the harness to consume the grant.',
  });
});

harness.get('/:slug/health', async (c) => {
  const { getHealth } = await import('@/lib/harness-readers');
  const result = await getHealth(c.req.param('slug'));
  if (!result.ok) return c.json({ error: result.error }, result.status);
  return c.json(result.data);
});

/**
 * Item 0 + 10: list features awaiting human review across all harnesses.
 * Returns features where needs_human_review=true, with their linked project
 * info (so the UI can show budget context for adjustment).
 */
harness.get('/needs-human-review', async (c) => {
  try {
    const dbc = getLegacyClient();
    const rows = await dbc.prepare(`
      SELECT f.*, p.name as project_name, p.budget_cents as project_budget_cents
      FROM all_features f
      LEFT JOIN projects p ON p.id = f.project_id
      WHERE f.needs_human_review = true
      ORDER BY f.created_ts DESC
    `).all() as any[];
    return c.json({
      count: rows.length,
      features: rows.map((r) => ({
        ...rowToFeature(r),
        harness_slug: r.harness_slug,
        project_name: r.project_name,
        project_budget_cents: r.project_budget_cents == null ? null : Number(r.project_budget_cents),
      })),
    });
  } catch (e) {
    return c.json({ error: `query failed: ${(e as Error).message}` }, 500);
  }
});

/**
 * Item 0 + 10: human approval action — clears needs_human_review and optionally
 * adjusts the project's budget (item 10's "editable budget at approval time").
 * If the proposal is also a project proposal (kind:'project' from R&D, item 10),
 * spinning up the project happens here too.
 */
harness.post('/:slug/features/:id/approve-human', async (c) => {
  const project = await resolveProject(c.req.param('slug'));
  if (!project) return c.json({ error: 'unknown project' }, 404);
  const id = c.req.param('id');
  const body = await c.req.json().catch(() => ({})) as { adjust_budget_cents?: number; create_project?: boolean; project_id?: string };
  const actor = c.req.header('x-actor') ?? 'human';

  const dbc = dbcFor(project.slug);
  const existing = await dbc.prepare('SELECT * FROM harness_features WHERE harness_slug = ? AND feature_id = ?').get(project.slug, id) as any;
  if (!existing) return c.json({ error: 'feature not found' }, 404);
  if (!existing.needs_human_review) return c.json({ error: 'feature does not need human review' }, 400);

  await dbc.transaction(async (tx) => {
    // Item 10: if create_project=true, create the project from the feature.
    let createdProject: any = null;
    if (body.create_project) {
      const projectId = body.project_id ?? `PROJ-${id.replace(/^[A-Z]+-/, '').toLowerCase()}`;
      const now = Date.now();
      await tx.prepare(`INSERT INTO projects (id, name, status, budget_cents, created_ts, updated_ts) VALUES (?, ?, ?, ?, ?, ?)`).run(
        projectId, existing.title, 'in_progress',
        typeof body.adjust_budget_cents === 'number' ? body.adjust_budget_cents : null,
        now, now,
      );
      createdProject = { id: projectId, budget_cents: body.adjust_budget_cents ?? null };
      auditFeatureChange(project.slug, id, '__project_created', null, createdProject, actor);
      await tx.prepare('UPDATE harness_features SET project_id = ?, updated_ts = ? WHERE harness_slug = ? AND feature_id = ?')
        .run(projectId, now, project.slug, id);
      auditFeatureChange(project.slug, id, 'project_id', existing.project_id, projectId, actor);
    } else if (typeof body.adjust_budget_cents === 'number' && existing.project_id) {
      const oldProj = await tx.prepare('SELECT budget_cents FROM projects WHERE id = ?').get(existing.project_id) as any;
      await tx.prepare('UPDATE projects SET budget_cents = ?, updated_ts = ? WHERE id = ?')
        .run(body.adjust_budget_cents, Date.now(), existing.project_id);
      auditFeatureChange(project.slug, id, '__project_budget_adjusted', oldProj?.budget_cents == null ? null : Number(oldProj.budget_cents), body.adjust_budget_cents, actor);
    }

    await tx.prepare('UPDATE harness_features SET needs_human_review = false, updated_ts = ? WHERE harness_slug = ? AND feature_id = ?')
      .run(Date.now(), project.slug, id);
    auditFeatureChange(project.slug, id, 'needs_human_review', true, false, actor);
  });

  const updated = rowToFeature(await dbc.prepare('SELECT * FROM harness_features WHERE harness_slug = ? AND feature_id = ?').get(project.slug, id));
  return c.json({ ok: true, feature: updated, approvedBy: actor });
});

/**
 * Item 6 + 8: budget + commitment summary for a project.
 * Returns: budget_cents (null = unlimited), committed (open features),
 * spent (terminal features), available (= budget - committed when limited).
 */
harness.get('/projects/:id/budget', async (c) => {
  const projectId = c.req.param('id');
  try {
    const dbc = getLegacyClient();
    const project = await dbc.prepare('SELECT id, name, budget_cents FROM projects WHERE id = ?').get(projectId) as any;
    if (!project) return c.json({ error: 'project not found' }, 404);
    const budget = project.budget_cents == null ? null : Number(project.budget_cents);

    const committed = Number(((await dbc.prepare(`
      SELECT COALESCE(SUM(expected_cost_cents), 0) as total
      FROM all_features
      WHERE project_id = ? AND status NOT IN ('cancelled', 'launched', 'passed')
    `).get(projectId)) as any).total ?? 0);
    const spent = Number(((await dbc.prepare(`
      SELECT COALESCE(SUM(expected_cost_cents), 0) as total
      FROM all_features
      WHERE project_id = ? AND status = 'launched'
    `).get(projectId)) as any).total ?? 0);

    return c.json({
      project_id: project.id,
      name: project.name,
      budget_cents: budget,
      unlimited: budget === null,
      committed_cents: committed,
      spent_cents: spent,
      available_cents: budget === null ? null : budget - committed,
    });
  } catch (e) {
    return c.json({ error: `budget query failed: ${(e as Error).message}` }, 500);
  }
});

/**
 * Item 8: per-project stats. Returns features grouped by status + per-dept
 * breakdown (counts and committed cost), plus the budget summary.
 */
harness.get('/projects/:id/stats', async (c) => {
  const projectId = c.req.param('id');
  try {
    const dbc = getLegacyClient();
    const project = await dbc.prepare('SELECT * FROM projects WHERE id = ?').get(projectId) as any;
    if (!project) return c.json({ error: 'project not found' }, 404);
    const budget = project.budget_cents == null ? null : Number(project.budget_cents);

    const featureCounts = (await dbc.prepare(`
      SELECT status, COUNT(*)::int as n, COALESCE(SUM(expected_cost_cents), 0)::bigint as total_cost
      FROM all_features WHERE project_id = ? GROUP BY status
    `).all(projectId) as any[]).map((r) => ({ status: r.status, n: Number(r.n), total_cost: Number(r.total_cost) }));

    const perHarness = (await dbc.prepare(`
      SELECT harness_slug, COUNT(*)::int as features, COALESCE(SUM(expected_cost_cents), 0)::bigint as total_cost
      FROM all_features WHERE project_id = ? GROUP BY harness_slug ORDER BY harness_slug
    `).all(projectId) as any[]).map((r) => ({ harness_slug: r.harness_slug, features: Number(r.features), total_cost: Number(r.total_cost) }));

    const committed = Number(((await dbc.prepare(`
      SELECT COALESCE(SUM(expected_cost_cents), 0) as total FROM all_features
      WHERE project_id = ? AND status NOT IN ('cancelled', 'launched', 'passed')
    `).get(projectId)) as any).total ?? 0);
    const spent = Number(((await dbc.prepare(`
      SELECT COALESCE(SUM(expected_cost_cents), 0) as total FROM all_features
      WHERE project_id = ? AND status = 'launched'
    `).get(projectId)) as any).total ?? 0);

    return c.json({
      project: {
        id: project.id, name: project.name, status: project.status,
        budget_cents: budget,
        unlimited: budget === null,
        owning_dept: project.owning_dept,
        vertical: project.vertical,
      },
      budget: {
        budget_cents: budget,
        committed_cents: committed,
        spent_cents: spent,
        available_cents: budget === null ? null : budget - committed,
        utilization: budget === null ? null : Math.round(100 * committed / budget),
      },
      featureCounts,
      perHarness,
    });
  } catch (e) {
    return c.json({ error: `stats query failed: ${(e as Error).message}` }, 500);
  }
});

/**
 * Layer A audit: feature change history (compensates for git-history loss
 * when features moved from JSON to SQL). Returns chronological log of
 * mutations to a feature.
 */
harness.get('/:slug/features/:id/audit', async (c) => {
  const project = await resolveProject(c.req.param('slug'));
  if (!project) return c.json({ error: 'unknown project' }, 404);
  const id = c.req.param('id');
  // PG-canonical via harness_shared.feature_audit_consolidated
  // (un-hardcode plan item #6). Falls back to per-harness table for
  // any rows that pre-date the consolidation cutover.
  try {
    const { sql } = (await import('@restart/db-org')).getOrgPg();
    const rows = await sql<{ ts: number; field: string; old_value: string | null; new_value: string | null; actor: string }[]>`
      SELECT ts, field, old_value, new_value, actor
        FROM harness_shared.feature_audit_consolidated
       WHERE harness_slug = ${project.slug} AND feature_id = ${id}
       ORDER BY ts DESC LIMIT 200
    `;
    if (rows.length > 0) {
      return c.json({
        slug: project.slug, feature_id: id, count: rows.length,
        audit: rows.map((r) => ({
          ts: typeof r.ts === 'bigint' ? Number(r.ts) : r.ts,
          field: r.field,
          old: r.old_value ? JSON.parse(r.old_value) : null,
          new: r.new_value ? JSON.parse(r.new_value) : null,
          actor: r.actor,
        })),
      });
    }
  } catch { /* fall through to per-harness */ }
  try {
    const dbc = dbcFor(project.slug);
    const rows = await dbc.prepare(`
      SELECT * FROM feature_audit
      WHERE harness_slug = ? AND feature_id = ?
      ORDER BY ts DESC LIMIT 200
    `).all(project.slug, id) as any[];
    return c.json({
      slug: project.slug, feature_id: id, count: rows.length,
      audit: rows.map((r) => ({
        ts: typeof r.ts === 'bigint' ? Number(r.ts) : r.ts,
        field: r.field,
        old: r.old_value ? JSON.parse(r.old_value) : null,
        new: r.new_value ? JSON.parse(r.new_value) : null,
        actor: r.actor,
      })),
    });
  } catch (e) {
    return c.json({ error: `audit query failed: ${(e as Error).message}` }, 500);
  }
});

harness.get('/:slug/features/:id/timeline', async (c) => {
  const project = await resolveProject(c.req.param('slug'));
  if (!project) return c.json({ error: 'unknown project' }, 404);
  const fid = c.req.param('id').replace(/[^A-Za-z0-9_-]/g, '');
  if (!fid) return c.json({ error: 'invalid feature id' }, 400);

  type Event = { ts: number; iso: string; kind: string; detail: string };
  const events: Event[] = [];

  // 1. Status transitions from snapshots/
  const snapDir = join(harnessDir(project), 'snapshots');
  if (existsSync(snapDir)) {
    let prevStatus: string | null = null;
    const snaps = readdirSync(snapDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort(); // lexical = chronological (filename starts with unix ts)
    for (const snapName of snaps) {
      const featPath = join(snapDir, snapName, 'features.json');
      try {
        const raw = readFileSync(featPath, 'utf8');
        const parsed = JSON.parse(raw);
        const feats = (parsed.features ?? parsed) as any[];
        const f = feats.find((x) => x.id === fid);
        if (!f) continue;
        if (prevStatus !== null && f.status !== prevStatus) {
          const match = snapName.match(/^(\d+)-iter-(\d+)$/);
          const ts = match ? Number(match[1]) * 1000 : 0;
          events.push({
            ts,
            iso: new Date(ts).toISOString(),
            kind: 'status_change',
            detail: `${prevStatus} → ${f.status}`,
          });
        }
        prevStatus = f.status;
      } catch {}
    }
  }

  // 2. Agent runs for this feature (filename contains -<FID>)
  const logDir = join(harnessDir(project), 'logs');
  if (existsSync(logDir)) {
    for (const f of readdirSync(logDir)) {
      if (!f.endsWith('.out')) continue;
      const stem = f.replace(/\.out$/, '');
      const match = stem.match(/^(\d+)-([a-z]+)(?:-(F-[A-Z0-9-]+))?$/);
      if (!match) continue;
      if (match[3] !== fid) continue;
      const ts = Number(match[1]) * 1000;
      events.push({
        ts,
        iso: new Date(ts).toISOString(),
        kind: `agent_run`,
        detail: `${match[2]} invoked`,
      });
    }
  }

  // 3. Debug note creation
  const debugPath = join(harnessDir(project), 'debug', `${fid}.md`);
  if (existsSync(debugPath)) {
    try {
      const s = statSync(debugPath);
      events.push({
        ts: s.mtimeMs,
        iso: new Date(s.mtimeMs).toISOString(),
        kind: 'debug_note',
        detail: 'debugger role investigated',
      });
    } catch {}
  }

  // 4. PR URL creation
  try {
    const prs = JSON.parse(readFileSync(join(harnessDir(project), 'prs.json'), 'utf8'));
    const entry = prs?.prs?.[fid];
    if (entry?.url && typeof entry.created_at === 'number') {
      events.push({
        ts: entry.created_at * 1000,
        iso: new Date(entry.created_at * 1000).toISOString(),
        kind: 'pr_opened',
        detail: entry.url,
      });
    }
  } catch {}

  events.sort((a, b) => a.ts - b.ts);
  return c.json({ featureId: fid, events });
});

// SSE: emit 'change' on logs/run.log mtime/size shifts (decisions are
// derived from the tail of run.log).

harness.get('/:slug/lanes', async (c) => {
  const project = await resolvePhasedProject(c.req.param('slug'), phasePhaseLabel(c.req.query('phase')));
  if (!project) return c.json({ error: 'unknown project' }, 404);
  const p = join(harnessDir(project), 'lanes.json');
  if (!existsSync(p)) return c.json({ lanes: [], max: 1 });
  let raw: any;
  try { raw = JSON.parse(readFileSync(p, 'utf8')); } catch { return c.json({ lanes: [], max: 1 }); }
  const nowMs = Date.now();
  const lanes: Array<{ pid: number; featureId: string; startedAt: number; elapsedSeconds: number; alive: boolean }> = [];
  for (const l of raw.lanes ?? []) {
    if (typeof l.pid !== 'number' || typeof l.feature_id !== 'string') continue;
    let alive = false;
    try { process.kill(l.pid, 0); alive = true; } catch {}
    const ts = typeof l.started_at === 'number' ? l.started_at * 1000 : nowMs;
    lanes.push({ pid: l.pid, featureId: l.feature_id, startedAt: ts, elapsedSeconds: Math.max(0, Math.floor((nowMs - ts) / 1000)), alive });
  }
  // Read max from config.json
  let max = 1;
  try {
    const cfg = JSON.parse(readFileSync(join(harnessDir(project), 'config.json'), 'utf8'));
    if (cfg?.parallelWorkers?.max && typeof cfg.parallelWorkers.max === 'number') max = cfg.parallelWorkers.max;
  } catch {}
  return c.json({ lanes, max });
});

harness.get('/:slug/features/:id/diff', async (c) => {
  const project = await resolvePhasedProject(c.req.param('slug'), phasePhaseLabel(c.req.query('phase')));
  if (!project) return c.json({ error: 'unknown project' }, 404);
  const id = c.req.param('id').replace(/[^A-Za-z0-9_-]/g, '');
  if (!id) return c.json({ error: 'invalid feature id' }, 400);
  const branch = `harness/${id}`;
  // Determine base branch — check config.json then auto-detect.
  let base = 'main';
  try {
    const cfg = JSON.parse(readFileSync(join(harnessDir(project), 'config.json'), 'utf8'));
    if (cfg?.branchIsolation?.baseBranch) base = String(cfg.branchIsolation.baseBranch);
  } catch {}
  // Run `git diff <base>...harness/<id>` in project dir via child_process
  return new Promise((resolve) => {
    const { execFile } = require('node:child_process');
    execFile('git', ['diff', '--stat=200', `${base}...${branch}`], { cwd: project.path, maxBuffer: 4 * 1024 * 1024 }, (err: any, stat: string) => {
      if (err) {
        resolve(c.json({ error: `branch not found or git error: ${String(err.message || err).slice(0, 200)}` }, 404));
        return;
      }
      execFile('git', ['diff', `${base}...${branch}`], { cwd: project.path, maxBuffer: 8 * 1024 * 1024 }, (err2: any, diff: string) => {
        if (err2) {
          resolve(c.json({ stat, diff: '', error: 'diff too large' }, 200));
          return;
        }
        resolve(c.json({ stat, diff, base, branch }));
      });
    });
  }) as Promise<Response>;
});

// ─── product proposals ─────────────────────────────────────────────────

interface ProposalListEntry {
  id: string;
  sizeBytes: number;
  ts: number;
  status: 'pending' | 'applied' | 'rejected';
  reviewVerdict: 'accept' | 'reject' | 'defer' | null;
  reviewedAt: number | null;
  reviewSummary: string | null;
  appliedAt: number | null;
  rejectedAt: number | null;
}

function parseFooterTs(body: string, key: 'appliedAt' | 'rejectedAt'): number | null {
  const m = body.match(new RegExp(`^${key}:\\s*(\\S+)`, 'm'));
  if (!m) return null;
  const t = Date.parse(m[1]);
  return Number.isNaN(t) ? null : t;
}

function scanProposalsDir(project: ProjectEntry): ProposalListEntry[] {
  const dir = join(harnessDir(project), 'proposals');
  if (!existsSync(dir)) return [];
  const allFiles = readdirSync(dir);
  const reviewSet = new Set(allFiles.filter((f) => f.endsWith('.review.md')));
  return allFiles
    .filter((f) => f.endsWith('.md') && !f.endsWith('.review.md'))
    .map((f): ProposalListEntry => {
      const full = join(dir, f);
      let size = 0, ts = 0;
      try { const s = statSync(full); size = s.size; ts = Math.floor(s.mtimeMs); } catch {}
      const body = safeRead(full) ?? '';
      const applied = /^applied:\s*true/m.test(body);
      const rejected = /^rejected:\s*true/m.test(body);
      const status: ProposalListEntry['status'] = applied ? 'applied' : rejected ? 'rejected' : 'pending';
      const appliedAt = applied ? (parseFooterTs(body, 'appliedAt') ?? ts) : null;
      const rejectedAt = rejected ? (parseFooterTs(body, 'rejectedAt') ?? ts) : null;

      const reviewName = `${f.replace(/\.md$/, '')}.review.md`;
      let reviewVerdict: ProposalListEntry['reviewVerdict'] = null;
      let reviewedAt: number | null = null;
      let reviewSummary: string | null = null;
      if (reviewSet.has(reviewName)) {
        const reviewPath = join(dir, reviewName);
        const reviewBody = safeRead(reviewPath) ?? '';
        const verdictMatch = reviewBody.match(/^VERDICT:\s*(accept|reject|defer)\b/im);
        if (verdictMatch) {
          const v = verdictMatch[1].toLowerCase();
          if (v === 'accept' || v === 'reject' || v === 'defer') reviewVerdict = v;
        }
        try { reviewedAt = Math.floor(statSync(reviewPath).mtimeMs); } catch {}
        const summaryLine = reviewBody
          .split(/\r?\n/)
          .map((l) => l.trim())
          .find((l) => l.length > 0 && !/^VERDICT:/i.test(l) && !/^#/.test(l));
        reviewSummary = summaryLine ? summaryLine.slice(0, 240) : null;
      }
      return { id: f, sizeBytes: size, ts, status, reviewVerdict, reviewedAt, reviewSummary, appliedAt, rejectedAt };
    })
    .sort((a, b) => b.ts - a.ts);
}

harness.get('/:slug/proposals', async (c) => {
  const project = await resolveProject(c.req.param('slug'));
  if (!project) return c.json({ error: 'unknown project' }, 404);
  const dir = join(harnessDir(project), 'proposals');
  if (!existsSync(dir)) return c.json({ proposals: [], replanOnAccept: true });

  // ProposalsPanel reads via Zero (harness_proposals_shared) since Phase
  // 2.5; this endpoint exists for back-compat + the replanOnAccept flag
  // ProposalsPanel reads once at mount. The PG dual-write to per-schema
  // harness_proposals (syncProposalsToPg) was removed in Item 1 — the
  // FS watcher is the only PG writer for proposals now.
  const items = scanProposalsDir(project);

  let replanOnAccept = true;
  try {
    const cfgRaw = safeRead(join(harnessDir(project), 'config.json'));
    if (cfgRaw) {
      const cfg = JSON.parse(cfgRaw);
      if (cfg?.reviewer?.replanOnAccept === false) replanOnAccept = false;
    }
  } catch {}

  return c.json({ proposals: items, replanOnAccept });
});

harness.get('/:slug/proposals/:id', async (c) => {
  const project = await resolveProject(c.req.param('slug'));
  if (!project) return c.json({ error: 'unknown project' }, 404);
  const id = c.req.param('id').replace(/[^A-Za-z0-9_.-]/g, '');
  if (!id || !id.endsWith('.md')) return c.json({ error: 'invalid id' }, 400);
  const p = join(harnessDir(project), 'proposals', id);
  if (!existsSync(p)) return c.json({ error: 'not found' }, 404);
  return c.json({ id, content: safeRead(p) });
});

harness.post('/:slug/proposals/:id/accept', async (c) => {
  const project = await resolveProject(c.req.param('slug'));
  if (!project) return c.json({ error: 'unknown project' }, 404);
  const id = c.req.param('id').replace(/[^A-Za-z0-9_.-]/g, '');
  if (!id || !id.endsWith('.md')) return c.json({ error: 'invalid id' }, 400);
  const proposalPath = join(harnessDir(project), 'proposals', id);
  if (!existsSync(proposalPath)) return c.json({ error: 'not found' }, 404);

  const body = safeRead(proposalPath) ?? '';
  // Extract acceptance bullets (same heuristic as run.sh product_auto_apply_latest)
  const bullets: string[] = [];
  const lines = body.split('\n');
  let inBar = false;
  for (const ln of lines) {
    if (/(\*\*Acceptance bar\*\*|Acceptance bar.*\*\*)/.test(ln)) { inBar = true; continue; }
    if (inBar) {
      if (ln.startsWith('- ') || ln.startsWith('  - ')) bullets.push(ln.replace(/^\s*-\s*/, '- '));
      else if (ln.startsWith('**') || ln.startsWith('#')) inBar = false;
    }
  }
  const specPath = join(project.path, 'SPEC.md');
  if (!existsSync(specPath)) return c.json({ error: 'SPEC.md not found' }, 404);
  if (bullets.length === 0) return c.json({ ok: false, error: 'no acceptance bullets found in proposal' }, 400);

  const append = `\n<!-- accepted from proposals/${id} at ${new Date().toISOString()} -->\n${bullets.join('\n')}\n`;
  await appendFile(specPath, append, 'utf8');
  // Stamp the proposal — file is the source-of-truth invariant. The
  // harness FS watcher mirrors this change into harness_proposals_shared
  // (which ProposalsPanel reads) automatically; no explicit PG write
  // needed. Per-schema harness_proposals dual-write removed in Item 1.
  await appendFile(proposalPath, `\n---\napplied: true\nappliedAt: ${new Date().toISOString()}\n`, 'utf8');

  // Phase 6b — plugin lifecycle: fire `onProposalAccepted` (typed) +
  // `proposal.accepted` (free-form). Best-effort.
  void firePluginLifecycle('onProposalAccepted', {
    installSlug: project.slug,
    projectDir: project.path,
    stateDir: harnessDir(project),
  }, `proposals/${id}`);
  void firePluginEvent('proposal.accepted', { proposalId: id, installSlug: project.slug });

  // Optional auto-replan: if config.reviewer.replanOnAccept is true,
  // delta-merge the new bullets via scoper MODE=replan. Fire-and-forget;
  // the API does NOT block on replan (it's a multi-minute agent invocation).
  let replanFired = false;
  try {
    const cfg = JSON.parse(readFileSync(join(harnessDir(project), 'config.json'), 'utf8'));
    // Default true: accept means accept. The legacy false default existed
    // when replan was destructive (forced MODE=initial, respawned experts);
    // the unified MODE=replan path is non-destructive, so there's no reason
    // to gate it. Set explicitly to false to opt out.
    const wantReplan = cfg?.reviewer?.replanOnAccept !== false;
    if (wantReplan) {
      // Non-destructive: invoke scoper MODE=replan to delta-merge the new
      // SPEC.md bullets into the existing harness_features queue without
      // disturbing in-flight features. Matches run.sh's review_pending_
      // proposals replan path; replaces the prior MAX_ITERATIONS=0 hack
      // that respawned experts.
      invokeScoperBackground(project, 'replan');
      replanFired = true;
    }
  } catch {}

  return c.json({ ok: true, bulletsAdded: bullets.length, replanFired });
});

harness.post('/:slug/proposals/:id/reject', async (c) => {
  const project = await resolveProject(c.req.param('slug'));
  if (!project) return c.json({ error: 'unknown project' }, 404);
  const id = c.req.param('id').replace(/[^A-Za-z0-9_.-]/g, '');
  if (!id || !id.endsWith('.md')) return c.json({ error: 'invalid id' }, 400);
  const proposalPath = join(harnessDir(project), 'proposals', id);
  if (!existsSync(proposalPath)) return c.json({ error: 'not found' }, 404);
  // File is the source-of-truth invariant — watcher mirrors to PG.
  await appendFile(proposalPath, `\n---\nrejected: true\nrejectedAt: ${new Date().toISOString()}\n`, 'utf8');
  return c.json({ ok: true });
});

harness.post('/:slug/product-review', async (c) => {
  const project = await resolveProject(c.req.param('slug'));
  if (!project) return c.json({ error: 'unknown project' }, 404);
  const specPath = join(project.path, 'SPEC.md');
  if (!existsSync(specPath)) {
    return c.json({ error: 'SPEC.md not found in project root' }, 400);
  }

  const { invocationId } = invokeScoperBackground(project, 'proposal');
  return c.json({ ok: true, invocationId, mode: 'proposal' });
});

/**
 * Manual scope-replan trigger. Invokes scoper MODE=replan in the
 * background to delta-merge any new SPEC.md bullets into the work queue
 * without restarting the harness. Useful when the user has hand-edited
 * SPEC.md and wants the queue updated without waiting for the next
 * orchestrator tick.
 */
harness.post('/:slug/replan', async (c) => {
  const slug = c.req.param('slug');
  const project = await resolveProject(slug);
  if (!project) return c.json({ error: 'unknown project' }, 404);
  // Logged in harness_shared.user_actions; surfaced via /api/user-actions/<slug>
  // and the OperatorActionLog component. The action represents the *kickoff*;
  // the replan's completion is observable via /scoper-result/<invocationId>.
  const invocationId = await recordUserAction(slug, 'replan', async () => {
    const r = invokeScoperBackground(project, 'replan');
    return {
      summary: `Replan kicked off (invocation ${r.invocationId})`,
      invocationId: r.invocationId,
      result: r.invocationId,
    };
  });
  return c.json({ ok: true, invocationId, mode: 'replan' });
});

/**
 * Cleanup pass — the inverse of replan. Reads SPEC.md and the existing
 * work queue, then PATCHes features to better match the spec:
 *   - features whose claims have no SPEC support → status='deprecated'
 *     with a deprecation_reason
 *   - features whose claims partially match → modified (title/claims/notes)
 *     to align with the SPEC; status preserved
 *   - features that match cleanly → left alone
 * Never adds features (that's /replan's job). Code is not auto-removed;
 * deprecation is metadata-only.
 */
/**
 * GET /:slug/scoper-result/:invocationId
 *
 * Polled by the operator panel to detect when a replan / cleanup /
 * proposal scoper run has finished. The wrapper script
 * tees stdout to scoper-results/<mode>-<id>.log and appends the
 * sentinel "__INVOCATION_DONE__" on the last line.
 *
 * Returns:
 *   - 404 if the file doesn't exist yet (caller keeps polling)
 *   - { done: false } if the sentinel hasn't appeared
 *   - { done: true, summary, counts? } once the sentinel is present.
 *     summary is the last few lines of the log (the scoper's own
 *     verdict). counts is best-effort parse of "added: N deprecated: M"
 *     style markers if the scoper emits them.
 */
harness.get('/:slug/scoper-result/:invocationId', async (c) => {
  const slug = c.req.param('slug');
  const invocationId = c.req.param('invocationId');
  const project = await resolveProject(slug);
  if (!project) return c.json({ error: 'unknown project' }, 404);
  const dir = join(harnessDir(project), 'scoper-results');
  // The mode prefix isn't passed in the path; scan for the matching file.
  // Files are <mode>-<id>.log and ids are unique per millisecond+rand.
  const fs = await import('node:fs/promises');
  let logPath: string | null = null;
  try {
    const entries = await fs.readdir(dir);
    const match = entries.find((e) => e.endsWith(`-${invocationId}.log`));
    if (match) logPath = join(dir, match);
  } catch { /* dir missing → 404 below */ }
  if (!logPath) return c.json({ done: false }, 404);
  const text = await fs.readFile(logPath, 'utf8').catch(() => '');
  const done = text.includes('__INVOCATION_DONE__');
  if (!done) return c.json({ done: false });
  // Trim the sentinel + take last ~20 lines as the summary.
  const lines = text.replace(/__INVOCATION_DONE__\s*$/m, '').trim().split(/\r?\n/);
  const tail = lines.slice(-20).join('\n');
  // Best-effort counts parse — the scoper sometimes emits "Added: 3" style.
  const counts: Record<string, number> = {};
  for (const m of tail.matchAll(/\b(added|deprecated|modified|consolidated|skipped)\s*:\s*(\d+)/gi)) {
    counts[m[1].toLowerCase()] = parseInt(m[2], 10);
  }
  return c.json({
    done: true,
    summary: tail.slice(0, 1200),
    counts: Object.keys(counts).length ? counts : undefined,
  });
});

harness.post('/:slug/cleanup', async (c) => {
  const slug = c.req.param('slug');
  const project = await resolveProject(slug);
  if (!project) return c.json({ error: 'unknown project' }, 404);
  const invocationId = await recordUserAction(slug, 'cleanup', async () => {
    const r = invokeScoperBackground(project, 'cleanup');
    return {
      summary: `Cleanup kicked off (invocation ${r.invocationId})`,
      invocationId: r.invocationId,
      result: r.invocationId,
    };
  });
  return c.json({ ok: true, invocationId, mode: 'cleanup' });
});

// (Removed POST /:slug/consolidate — scoper has no MODE=consolidate prompt
// section, so the route invoked the agent with no mode-specific instructions.
// `cleanup` covers the same intent (PATCH-only queue tidying) with an actual
// prompt section behind it. Use POST /:slug/cleanup instead.)

// SSE: emit 'change' on plan-review.md mtime/size shifts.

harness.get('/:slug/debug-notes/:id', async (c) => {
  const project = await resolveProject(c.req.param('slug'));
  if (!project) return c.json({ error: 'unknown project' }, 404);
  const id = c.req.param('id').replace(/[^A-Za-z0-9_-]/g, '');
  if (!id) return c.json({ error: 'invalid feature id' }, 400);
  const p = join(harnessDir(project), 'debug', `${id}.md`);
  let mtimeMs: number | null = null;
  try { mtimeMs = statSync(p).mtimeMs; } catch {}
  return c.json({ content: safeRead(p), mtimeMs });
});

harness.get('/:slug/debug-notes', async (c) => {
  const project = await resolveProject(c.req.param('slug'));
  if (!project) return c.json({ error: 'unknown project' }, 404);
  const dir = join(harnessDir(project), 'debug');
  if (!existsSync(dir)) return c.json({ notes: [] });
  const notes = readdirSync(dir)
    .filter((f) => f.endsWith('.md'))
    .map((f) => {
      const full = join(dir, f);
      let size = 0, ts = 0;
      try { const s = statSync(full); size = s.size; ts = s.mtimeMs; } catch {}
      return { featureId: f.replace(/\.md$/, ''), sizeBytes: size, ts };
    })
    .sort((a, b) => b.ts - a.ts);
  return c.json({ notes });
});

harness.get('/:slug/knowledge', async (c) => {
  const slug = c.req.param('slug');
  const project = await resolvePhasedProject(slug, phasePhaseLabel(c.req.query('phase')));
  if (!project) return c.json({ error: 'unknown project' }, 404);
  // PG-canonical (Phase 0d). Disk fallback for harnesses pre-migration.
  const { loadTextArtifact } = await import('@/lib/text-artifacts');
  const p = join(harnessDir(project), 'knowledge.md');
  const fromPg = await loadTextArtifact(slug, 'knowledge.md');
  let mtimeMs: number | null = null;
  try { mtimeMs = statSync(p).mtimeMs; } catch {}
  return c.json({ content: fromPg ?? safeRead(p), mtimeMs });
});

harness.put('/:slug/knowledge', async (c) => {
  const slug = c.req.param('slug');
  const project = await resolvePhasedProject(slug, phasePhaseLabel(c.req.query('phase')));
  if (!project) return c.json({ error: 'unknown project' }, 404);
  const body = await c.req.json().catch(() => ({})) as { content?: string };
  if (typeof body.content !== 'string') return c.json({ error: 'content required' }, 400);
  // PG-canonical via text-artifacts; helper handles disk mirror.
  const { saveTextArtifact } = await import('@/lib/text-artifacts');
  await saveTextArtifact(slug, 'knowledge.md', body.content);
  return c.json({ ok: true });
});

harness.get('/:slug/diff/working', async (c) => {
  const project = await resolvePhasedProject(c.req.param('slug'), phasePhaseLabel(c.req.query('phase')));
  if (!project) return c.json({ error: 'unknown project' }, 404);
  return new Promise((resolve) => {
    const { execFile } = require('node:child_process');
    execFile('git', ['diff', '--stat=200', 'HEAD'], { cwd: project.path, maxBuffer: 4 * 1024 * 1024 }, (err: any, stat: string) => {
      if (err) {
        resolve(c.json({ error: `git error: ${String(err.message || err).slice(0, 200)}` }, 500));
        return;
      }
      execFile('git', ['diff', 'HEAD'], { cwd: project.path, maxBuffer: 8 * 1024 * 1024 }, (err2: any, diff: string) => {
        if (err2) {
          resolve(c.json({ stat, diff: '', error: 'diff too large' }, 200));
          return;
        }
        execFile('git', ['status', '--porcelain'], { cwd: project.path, maxBuffer: 1024 * 1024 }, (err3: any, status: string) => {
          resolve(c.json({ stat, diff, status: err3 ? '' : status, branch: '' }));
        });
      });
    });
  }) as Promise<Response>;
});

// SSE: emit 'change' on archives/*.tar.gz add/remove/grow.

harness.post('/:slug/archives/:id/restore', async (c) => {
  const project = await resolvePhasedProject(c.req.param('slug'), phasePhaseLabel(c.req.query('phase')));
  if (!project) return c.json({ error: 'unknown project' }, 404);
  const id = c.req.param('id').replace(/[^A-Za-z0-9_.\-]/g, '');
  if (!id || !id.endsWith('.tar.gz') || !/^\d+\.tar\.gz$/.test(id)) {
    return c.json({ error: 'invalid archive id' }, 400);
  }
  const archivePath = join(harnessDir(project), 'archives', id);
  if (!existsSync(archivePath)) return c.json({ error: 'archive not found' }, 404);

  const body = await c.req.json().catch(() => ({})) as { confirm?: boolean };
  if (!body.confirm) {
    return c.json({ error: 'confirm: true required — this overwrites current .harness/ state' }, 400);
  }

  const dir = harnessDir(project);
  // Snapshot current state pre-restore (so restore is itself reversible).
  const preSnapName = `${Date.now()}-pre-restore.tar.gz`;
  return new Promise((resolve) => {
    const { execFile } = require('node:child_process');
    execFile('tar', ['czf', join(dir, 'archives', preSnapName), '-C', dir, '--exclude=archives', '--exclude=./archives', '.'], { cwd: project.path, maxBuffer: 8 * 1024 * 1024 }, (err1: any, _o: string, e1: string) => {
      if (err1) {
        resolve(c.json({ ok: false, error: `pre-restore snapshot failed: ${String(err1.message || err1).slice(0, 300)}`, stderr: e1?.slice(0, 500) ?? '' }, 500));
        return;
      }
      // Remove everything except archives/ before extracting (so restore is clean).
      (async () => {
        try {
          const { rm } = await import('node:fs/promises');
          for (const entry of readdirSync(dir)) {
            if (entry === 'archives') continue;
            await rm(join(dir, entry), { recursive: true, force: true });
          }
        } catch (e) {
          resolve(c.json({ ok: false, error: `pre-restore cleanup failed: ${String(e).slice(0, 300)}` }, 500));
          return;
        }
        execFile('tar', ['xzf', archivePath, '-C', dir], { cwd: project.path, maxBuffer: 8 * 1024 * 1024 }, (err2: any, _o: string, e2: string) => {
          if (err2) {
            resolve(c.json({ ok: false, error: `restore failed: ${String(err2.message || err2).slice(0, 300)}`, stderr: e2?.slice(0, 500) ?? '', undoSnapshot: preSnapName }, 500));
            return;
          }
          resolve(c.json({ ok: true, restored: id, undoSnapshot: preSnapName }));
        });
      })();
    });
  }) as Promise<Response>;
});

harness.post('/:slug/archive', async (c) => {
  const project = await resolvePhasedProject(c.req.param('slug'), phasePhaseLabel(c.req.query('phase')));
  if (!project) return c.json({ error: 'unknown project' }, 404);
  const body = await c.req.json().catch(() => ({})) as { reset?: boolean };

  const dir = harnessDir(project);
  const archivesDir = join(dir, 'archives');
  await mkdir(archivesDir, { recursive: true });
  const ts = Date.now();
  const archiveName = `${ts}.tar.gz`;
  const archivePath = join(archivesDir, archiveName);

  // Tar up everything in .harness except the archives dir itself.
  return new Promise((resolve) => {
    const { execFile } = require('node:child_process');
    execFile('tar', ['czf', archivePath, '-C', dir, '--exclude=archives', '--exclude=./archives', '.'], { cwd: project.path, maxBuffer: 8 * 1024 * 1024 }, async (err: any, _stdout: string, stderr: string) => {
      if (err) {
        resolve(c.json({ ok: false, error: `tar failed: ${String(err.message || err).slice(0, 300)}`, stderr: stderr?.slice(0, 500) ?? '' }, 500));
        return;
      }
      let resetRemoved: string[] = [];
      if (body.reset) {
        // Remove features.json, validation-contract.md, issues.md, worker-log.md,
        // escalation.md, supervisor-notes.md, lanes.json, prs.json, logs/*, snapshots/*,
        // screenshots/*. Keep config.json, hooks/, knowledge.md, archives/.
        for (const f of STATE_FILES_FOR_RESET) {
          try { await unlink(join(dir, f)); resetRemoved.push(f); } catch {}
        }
        const { rm } = await import('node:fs/promises');
        for (const d of ['logs', 'snapshots', 'screenshots']) {
          try { await rm(join(dir, d), { recursive: true, force: true }); resetRemoved.push(`${d}/`); } catch {}
        }
      }
      let sizeBytes = 0;
      try { sizeBytes = statSync(archivePath).size; } catch {}
      resolve(c.json({ ok: true, id: archiveName, sizeBytes, reset: !!body.reset, resetRemoved }));
    });
  }) as Promise<Response>;
});

harness.post('/:slug/replan', async (c) => {
  const project = await resolvePhasedProject(c.req.param('slug'), phasePhaseLabel(c.req.query('phase')));
  if (!project) return c.json({ error: 'unknown project' }, 404);
  const specPath = join(project.path, 'SPEC.md');
  if (!existsSync(specPath)) return c.json({ error: 'SPEC.md not found' }, 400);

  // Allow overwriting existing plan only when body.overwrite: true. Otherwise reject
  // if features.json exists (avoids blowing away active mission state).
  const body = await c.req.json().catch(() => ({})) as { overwrite?: boolean };
  const featuresPath = join(harnessDir(project), 'features.json');
  const contractPath = join(harnessDir(project), 'validation-contract.md');
  if ((existsSync(featuresPath) || existsSync(contractPath)) && !body.overwrite) {
    return c.json({ error: 'scoper output already exists; pass {overwrite: true} to replan' }, 409);
  }

  // Ensure harness dir exists, then temporarily move existing scoper output so
  // run.sh's plan step (scoper MODE=initial) fires.
  await mkdir(harnessDir(project), { recursive: true });
  const backupDir = join(harnessDir(project), `.replan-backup-${Date.now()}`);
  if (body.overwrite) {
    await mkdir(backupDir, { recursive: true });
    for (const f of STATE_FILES_FOR_BACKUP) {
      const p = join(harnessDir(project), f);
      if (existsSync(p)) {
        const { rename } = await import('node:fs/promises');
        await rename(p, join(backupDir, f));
      }
    }
  }

  const orchBin = orchestratorRunBin();
  const logPath = `/tmp/harness-replan-${project.slug}.log`;
  // We don't want to run the full orchestration loop — just the
  // pre-loop / initial scoper. The TS orchestrator's pre-loop gate
  // ("if missing features.json + contract, invoke scoper MODE=initial")
  // runs before the main iteration loop; MAX_ITERATIONS=0 prevents the
  // loop body from entering.
  return new Promise((resolve) => {
    const { execFile } = require('node:child_process');
    execFile('bash', ['-c', `MAX_ITERATIONS=0 npx --no-install tsx ${orchBin} >> ${logPath} 2>&1; echo "DONE rc=$?"`], {
      cwd: project.path,
      env: {
        ...process.env,
        AGENT_CMD: process.env.AGENT_CMD ?? process.env.CLAUDE ?? 'omp -p',
        CLAUDE: process.env.AGENT_CMD ?? process.env.CLAUDE ?? 'omp -p',
        HARNESS_DIR: harnessPackageDir(),
        PROJECT_DIR: project.path,
        HARNESS_SLUG: project.slug,
      },
      maxBuffer: 1024 * 1024,
      timeout: 5 * 60_000,
    }, (err: any, stdout: string, stderr: string) => {
      const produced = existsSync(featuresPath) && existsSync(contractPath);
      if (err && !produced) {
        resolve(c.json({ ok: false, error: String(err.message || err).slice(0, 400), stderr, logPath }, 500));
        return;
      }
      resolve(c.json({ ok: true, produced, logPath, stdout: stdout.slice(-2048), stderr: stderr.slice(-1024), backupDir: body.overwrite ? backupDir : null }));
    });
  }) as Promise<Response>;
});

harness.post('/:slug/supervisor', async (c) => {
  const project = await resolvePhasedProject(c.req.param('slug'), phasePhaseLabel(c.req.query('phase')));
  if (!project) return c.json({ error: 'unknown project' }, 404);
  const script = harnessPath('bin', 'supervisor.sh');
  if (!existsSync(script)) return c.json({ error: 'supervisor.sh not found' }, 500);
  return new Promise((resolve) => {
    const { execFile } = require('node:child_process');
    execFile('bash', [script], { cwd: project.path, maxBuffer: 4 * 1024 * 1024, env: { ...process.env, CLAUDE: process.env.AGENT_CMD ?? process.env.CLAUDE ?? 'omp -p' } }, (err: any, stdout: string, stderr: string) => {
      if (err) {
        resolve(c.json({ ok: false, error: String(err.message || err), stderr: stderr ?? '', stdout: stdout ?? '' }, 500));
        return;
      }
      // Extract the decision line "SUPERVISOR: <outcome>" from stdout
      const last = (stdout ?? '').trim().split('\n').reverse().find((l) => l.startsWith('SUPERVISOR:')) ?? '';
      resolve(c.json({ ok: true, outcome: last, stdout, stderr }));
    });
  }) as Promise<Response>;
});

harness.get('/:slug/prs', async (c) => {
  const project = await resolvePhasedProject(c.req.param('slug'), phasePhaseLabel(c.req.query('phase')));
  if (!project) return c.json({ error: 'unknown project' }, 404);
  const p = join(harnessDir(project), 'prs.json');
  if (!existsSync(p)) return c.json({ prs: {} });
  try {
    const raw = JSON.parse(readFileSync(p, 'utf8'));
    return c.json({ prs: raw.prs ?? {} });
  } catch {
    return c.json({ prs: {} });
  }
});

// SSE: emit 'change' on supervisor-notes.md mtime/size shifts.

// ─── usage / cost aggregation ─────────────────────────────────────────

harness.get('/:slug/usage', async (c) => {
  const project = await resolvePhasedProject(c.req.param('slug'), phasePhaseLabel(c.req.query('phase')));
  if (!project) return c.json({ error: 'unknown project' }, 404);
  const all = scanAgentRuns(project);
  // Force-sync to PG so usage and agents endpoints stay coherent.
  syncAgentRunsToPg(project, all).catch((err) => {
    console.warn(`[usage] PG sync failed for ${project.slug}:`, err?.message ?? err);
  });
  // Only count runs with a result line (cost > 0 OR duration > 0 OR tokens > 0)
  // — the rest are still in-flight or aborted before producing usage.
  const runs = all.filter((r) =>
    r.costUsd > 0 || r.durationMs > 0 || r.inputTokens > 0 || r.outputTokens > 0
  );
  if (runs.length === 0 && all.length === 0) {
    return c.json({ totals: zeroUsage(), byRole: [], recent: [] });
  }

  // Totals
  const totals = runs.reduce((acc, r) => {
    acc.runs += 1;
    acc.costUsd += r.costUsd;
    acc.inputTokens += r.inputTokens;
    acc.outputTokens += r.outputTokens;
    acc.cacheReadTokens += r.cacheReadTokens;
    acc.cacheCreationTokens += r.cacheCreationTokens;
    acc.durationMs += r.durationMs;
    return acc;
  }, zeroUsage());

  // By role
  const rolesMap = new Map<string, ReturnType<typeof zeroRoleSummary>>();
  for (const r of runs) {
    let entry = rolesMap.get(r.role);
    if (!entry) { entry = zeroRoleSummary(r.role); rolesMap.set(r.role, entry); }
    entry.runs += 1;
    entry.costUsd += r.costUsd;
    entry.inputTokens += r.inputTokens;
    entry.outputTokens += r.outputTokens;
    entry.cacheReadTokens += r.cacheReadTokens;
    entry.cacheCreationTokens += r.cacheCreationTokens;
    entry.durationMs += r.durationMs;
  }
  const byRole = Array.from(rolesMap.values())
    .map((e) => ({
      ...e,
      avgCostUsd: e.runs ? e.costUsd / e.runs : 0,
      avgDurationMs: e.runs ? e.durationMs / e.runs : 0,
    }))
    .sort((a, b) => b.costUsd - a.costUsd);

  // By feature (only runs that have a featureId embedded in filename)
  const featuresMap = new Map<string, { featureId: string; runs: number; costUsd: number; inputTokens: number; outputTokens: number; durationMs: number; byRole: Record<string, number> }>();
  for (const r of runs) {
    if (!r.featureId) continue;
    let entry = featuresMap.get(r.featureId);
    if (!entry) { entry = { featureId: r.featureId, runs: 0, costUsd: 0, inputTokens: 0, outputTokens: 0, durationMs: 0, byRole: {} }; featuresMap.set(r.featureId, entry); }
    entry.runs += 1;
    entry.costUsd += r.costUsd;
    entry.inputTokens += r.inputTokens;
    entry.outputTokens += r.outputTokens;
    entry.durationMs += r.durationMs;
    entry.byRole[r.role] = (entry.byRole[r.role] ?? 0) + r.costUsd;
  }
  const byFeature = Array.from(featuresMap.values())
    .map((e) => ({ ...e, avgCostUsd: e.runs ? e.costUsd / e.runs : 0 }))
    .sort((a, b) => b.costUsd - a.costUsd);

  const recent = runs
    .slice()
    .sort((a, b) => b.ts - a.ts)
    .slice(0, 20);

  return c.json({ totals, byRole, byFeature, recent });
});

function zeroUsage() {
  return { runs: 0, costUsd: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, durationMs: 0 };
}
function zeroRoleSummary(role: string) {
  return { role, runs: 0, costUsd: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, durationMs: 0 };
}

// ─── mission templates (~/autonomous-harness/templates/projects/*) ────

const TEMPLATES_DIR = harnessPath('templates', 'projects');

harness.get('/templates', (c) => {
  if (!existsSync(TEMPLATES_DIR)) return c.json({ templates: [] });
  const entries = readdirSync(TEMPLATES_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory());
  const templates = entries.map((d) => {
    const dir = join(TEMPLATES_DIR, d.name);
    let meta: any = { id: d.name, name: d.name };
    try {
      const raw = safeRead(join(dir, 'meta.json'));
      if (raw) meta = { ...meta, ...JSON.parse(raw) };
    } catch {}
    const files: string[] = [];
    for (const f of TEMPLATE_DETECT_FILES) {
      if (existsSync(join(dir, f))) files.push(f);
    }
    return {
      id: d.name,
      name: meta.name ?? d.name,
      description: meta.description ?? '',
      tags: meta.tags ?? [],
      files,
    };
  });
  return c.json({ templates });
});

harness.get('/templates/:id/file', (c) => {
  const id = c.req.param('id').replace(/[^A-Za-z0-9_-]/g, '');
  if (!id) return c.json({ error: 'invalid id' }, 400);
  const name = (c.req.query('name') ?? '').replace(/[^A-Za-z0-9_.-]/g, '');
  if (!name) return c.json({ error: 'name query required' }, 400);
  const p = join(TEMPLATES_DIR, id, name);
  if (!existsSync(p)) return c.json({ error: 'not found' }, 404);
  const content = safeRead(p);
  if (content === null) return c.json({ error: 'unreadable' }, 500);
  return new Response(content, { headers: { 'content-type': 'text/plain; charset=utf-8' } });
});

harness.post('/:slug/bootstrap-from-template', async (c) => {
  const project = await resolvePhasedProject(c.req.param('slug'), phasePhaseLabel(c.req.query('phase')));
  if (!project) return c.json({ error: 'unknown project' }, 404);
  const body = await c.req.json().catch(() => ({})) as { templateId?: string; overwrite?: boolean };
  const tid = (body.templateId ?? '').replace(/[^A-Za-z0-9_-]/g, '');
  if (!tid) return c.json({ error: 'templateId required' }, 400);
  const tdir = join(TEMPLATES_DIR, tid);
  if (!existsSync(tdir)) return c.json({ error: `template not found: ${tid}` }, 404);

  const overwrite = body.overwrite === true;
  const copied: string[] = [];
  const skipped: string[] = [];
  for (const f of PROJECT_FILES_TO_COPY) {
    const src = join(tdir, f);
    if (!existsSync(src)) continue;
    const dest = join(project.path, f);
    if (existsSync(dest) && !overwrite) { skipped.push(f); continue; }
    const tmp = `${dest}.tmp.${Date.now()}`;
    await copyFile(src, tmp);
    await rename(tmp, dest);
    copied.push(f);
  }
  // config.json goes into .harness/
  const configSrc = join(tdir, 'config.json');
  if (existsSync(configSrc)) {
    await mkdir(harnessDir(project), { recursive: true });
    const dest = join(harnessDir(project), 'config.json');
    if (existsSync(dest) && !overwrite) {
      skipped.push('.harness/config.json');
    } else {
      const tmp = `${dest}.tmp.${Date.now()}`;
      await copyFile(configSrc, tmp);
      await rename(tmp, dest);
      copied.push('.harness/config.json');
    }
  }

  return c.json({ ok: true, copied, skipped });
});

// ─── screenshots (.harness/screenshots/*.{png,jpg,jpeg,gif,webp}) ─────

const SCREENSHOT_EXTS = ['.png', '.jpg', '.jpeg', '.gif', '.webp'] as const;

// SSE: emit 'change' when files in .harness/screenshots/ are
// added/removed/grow.

harness.get('/:slug/screenshots/:id', async (c) => {
  const project = await resolvePhasedProject(c.req.param('slug'), phasePhaseLabel(c.req.query('phase')));
  if (!project) return c.json({ error: 'unknown project' }, 404);
  const id = c.req.param('id').replace(/[^A-Za-z0-9_.\-]/g, '');
  if (!id || !SCREENSHOT_EXTS.some((ext) => id.toLowerCase().endsWith(ext))) {
    return c.json({ error: 'invalid screenshot id' }, 400);
  }
  const full = join(harnessDir(project), 'screenshots', id);
  if (!existsSync(full)) return c.json({ error: 'not found' }, 404);
  const buf = readFileSync(full);
  const ext = id.toLowerCase().slice(id.lastIndexOf('.'));
  const contentType =
    ext === '.png'  ? 'image/png'  :
    ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' :
    ext === '.gif'  ? 'image/gif'  :
    ext === '.webp' ? 'image/webp' : 'application/octet-stream';
  return new Response(buf, { headers: { 'content-type': contentType, 'cache-control': 'no-cache' } });
});

harness.post('/:slug/screenshots', async (c) => {
  const phase = phasePhaseLabel(c.req.query('phase'));
  const project = await resolvePhasedProject(c.req.param('slug'), phase);
  if (!project) return c.json({ error: 'unknown project' }, 404);
  const form = await c.req.formData();
  const file = form.get('file');
  const rawName = form.get('name');
  if (!(file instanceof File)) return c.json({ error: 'file field required (multipart)' }, 400);

  const givenName = typeof rawName === 'string' && rawName ? rawName : file.name;
  const safeName = givenName.replace(/[^A-Za-z0-9_.\-]/g, '_');
  if (!SCREENSHOT_EXTS.some((ext) => safeName.toLowerCase().endsWith(ext))) {
    return c.json({ error: `file must end with one of ${SCREENSHOT_EXTS.join(', ')}` }, 400);
  }

  const dir = join(harnessDir(project), 'screenshots');
  await mkdir(dir, { recursive: true });
  const dest = join(dir, safeName);
  const tmp = `${dest}.tmp.${Date.now()}`;
  const ab = await file.arrayBuffer();
  await writeFile(tmp, Buffer.from(ab));
  await rename(tmp, dest);
  // Producer-time PG write — replaces the chokidar replace-all mirror
  // that re-scanned the dir on every fs event.
  {
    const { db } = getOrgPg();
    const { generated } = await import('@restart/db-org');
    const { sql: dsql } = await import('drizzle-orm');
    const hsh = generated.harness_screenshotsInHarness_shared;
    const ws = activeWorkspaceId();
    await db
      .insert(hsh)
      .values({
        harness_slug: project.slug,
        phase,
        id: safeName,
        size_bytes: ab.byteLength,
        ts: Date.now(),
        workspace_id: ws,
      })
      .onConflictDoUpdate({
        target: [hsh.harness_slug, hsh.phase, hsh.id],
        set: {
          size_bytes: dsql`EXCLUDED.size_bytes`,
          ts: dsql`EXCLUDED.ts`,
          workspace_id: dsql`EXCLUDED.workspace_id`,
        },
      });
    const { notifySyncInvalidate } = await import('@/lib/sync-sse');
    void notifySyncInvalidate('harnessScreenshots.byHarness', { harnessSlug: project.slug, phase }).catch(() => {});
  }
  return c.json({ ok: true, id: safeName, sizeBytes: ab.byteLength });
});

harness.delete('/:slug/screenshots/:id', async (c) => {
  const phase = phasePhaseLabel(c.req.query('phase'));
  const project = await resolvePhasedProject(c.req.param('slug'), phase);
  if (!project) return c.json({ error: 'unknown project' }, 404);
  const id = c.req.param('id').replace(/[^A-Za-z0-9_.\-]/g, '');
  if (!id || !SCREENSHOT_EXTS.some((ext) => id.toLowerCase().endsWith(ext))) {
    return c.json({ error: 'invalid screenshot id' }, 400);
  }
  let deleted = false;
  try {
    await unlink(join(harnessDir(project), 'screenshots', id));
    deleted = true;
  } catch (err: any) {
    if (err?.code !== 'ENOENT') return c.json({ error: String(err) }, 500);
  }
  // Drop the PG row regardless; if the file was already gone, the row
  // may still be lingering from a previous fs.watch race.
  {
    const { db } = getOrgPg();
    const { generated } = await import('@restart/db-org');
    const { and, eq } = await import('drizzle-orm');
    const hsh = generated.harness_screenshotsInHarness_shared;
    await db
      .delete(hsh)
      .where(and(eq(hsh.harness_slug, project.slug), eq(hsh.phase, phase), eq(hsh.id, id)));
    const { notifySyncInvalidate } = await import('@/lib/sync-sse');
    void notifySyncInvalidate('harnessScreenshots.byHarness', { harnessSlug: project.slug, phase }).catch(() => {});
  }
  return c.json({ ok: true, deleted });
});

// ─── snapshots (.harness/snapshots/<id>/) ─────────────────────────────

// SNAPSHOT_FILES imported from @/lib/harness-state-files at top.

interface SnapshotMeta {
  id: string;
  ts: number;
  iterNum: number;
  files: string[];
  featureCounts: Record<string, number>;
}

async function scanSnapshots(project: ProjectEntry): Promise<SnapshotMeta[]> {
  const snapDir = join(harnessDir(project), 'snapshots');
  if (!existsSync(snapDir)) return [];
  // Aggregate featureCounts from harness_shared.snapshot_features in one
  // query rather than per-snapshot. Snapshots without PG rows get an
  // empty count map (legacy snapshots, or ones recorded before the PG
  // mirror was wired up — these will only have FS state).
  let countsBySnapshot: Map<string, Record<string, number>> = new Map();
  try {
    await ensureSnapshotFeaturesTable();
    const { sql } = getOrgPg();
    const rows = await sql<{ snapshot_id: string; status: string; n: string }[]>`
      SELECT snapshot_id, status, COUNT(*)::text AS n
      FROM harness_shared.snapshot_features
      WHERE harness_slug = ${project.slug}
      GROUP BY snapshot_id, status
    `;
    for (const r of rows) {
      const m = countsBySnapshot.get(r.snapshot_id) ?? {};
      m[r.status] = Number(r.n);
      countsBySnapshot.set(r.snapshot_id, m);
    }
  } catch { /* PG unavailable — snapshots still listable from FS */ }
  return readdirSync(snapDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => {
      const id = d.name;
      const match = id.match(/^(\d+)-iter-(\d+)$/);
      const ts = match ? Number(match[1]) * 1000 : 0;
      const iterNum = match ? Number(match[2]) : 0;
      const dirPath = join(snapDir, id);
      const files: string[] = [];
      for (const f of SNAPSHOT_FILES) {
        if (existsSync(join(dirPath, f))) files.push(f);
      }
      const featureCounts: Record<string, number> = countsBySnapshot.get(id) ?? {};
      return { id, ts, iterNum, files, featureCounts };
    })
    .filter((s) => s.ts > 0)
    .sort((a, b) => b.ts - a.ts);
}

/**
 * Mirror snapshot metadata into harness_<slug>.harness_snapshots.
 * Bulk upsert + tombstone for missing rows. Files/featureCounts go to
 * JSONB; the directory itself stays on disk.
 */
async function syncSnapshotsToPg(project: ProjectEntry, snaps: SnapshotMeta[]): Promise<void> {
  const { sql } = getHarnessPg(project.slug);
  const now = Date.now();
  if (snaps.length > 0) {
    const rows = snaps.map((s) => ({
      harness_slug: project.slug,
      snapshot_id: s.id,
      ts: s.ts,
      iter_num: s.iterNum,
      files: JSON.stringify(s.files),
      feature_counts: JSON.stringify(s.featureCounts),
      created_ts: now,
      updated_ts: now,
    }));
    await sql`
      INSERT INTO harness_snapshots ${sql(rows, 'harness_slug', 'snapshot_id', 'ts', 'iter_num', 'files', 'feature_counts', 'created_ts', 'updated_ts')}
      ON CONFLICT (harness_slug, snapshot_id) DO UPDATE SET
        ts = EXCLUDED.ts,
        iter_num = EXCLUDED.iter_num,
        files = EXCLUDED.files,
        feature_counts = EXCLUDED.feature_counts,
        updated_ts = EXCLUDED.updated_ts
    `;
    const ids = snaps.map((s) => s.id);
    await sql`
      DELETE FROM harness_snapshots
      WHERE harness_slug = ${project.slug}
        AND snapshot_id NOT IN ${sql(ids)}
    `;
  } else {
    await sql`DELETE FROM harness_snapshots WHERE harness_slug = ${project.slug}`;
  }
}

harness.get('/:slug/snapshots', async (c) => {
  const project = await resolvePhasedProject(c.req.param('slug'), phasePhaseLabel(c.req.query('phase')));
  if (!project) return c.json({ error: 'unknown project' }, 404);
  const snapshots = await scanSnapshots(project);
  syncSnapshotsToPg(project, snapshots).catch((err) => {
    console.error(`[snapshots] PG sync failed for ${project.slug}:`, err);
  });
  return c.json({ snapshots });
});

/**
 * POST /:slug/snapshots/:id/record-pg-state — invoked by run.sh's
 * snapshot_state after the FS copy. Captures the current
 * `harness_features` rows under the given snapshot_id so restore can
 * round-trip the work queue. Idempotent — re-running for the same id
 * deletes prior rows and re-inserts.
 */
harness.post('/:slug/snapshots/:id/record-pg-state', async (c) => {
  const project = await resolvePhasedProject(c.req.param('slug'), phasePhaseLabel(c.req.query('phase')));
  if (!project) return c.json({ error: 'unknown project' }, 404);
  const id = c.req.param('id').replace(/[^A-Za-z0-9_-]/g, '');
  if (!id || !/^\d+-iter-\d+$/.test(id)) {
    return c.json({ error: 'invalid snapshot id' }, 400);
  }
  // Ensure the cross-harness table + per-harness deprecation_reason column.
  // Both are idempotent IF NOT EXISTS DDL; once-per-process per slug.
  await ensureSnapshotFeaturesTable();
  try {
    const { sql } = getHarnessPg(project.slug);
    const now = Date.now();
    // search_path is set on this client to the harness's own schema first,
    // then harness_shared. Both unqualified `harness_features` (per-harness)
    // and qualified `harness_shared.snapshot_features` resolve correctly.
    await sql.begin(async (tx) => {
      await tx`DELETE FROM harness_shared.snapshot_features WHERE harness_slug = ${project.slug} AND snapshot_id = ${id}`;
      await tx`
        INSERT INTO harness_shared.snapshot_features (
          harness_slug, snapshot_id, feature_id,
          title, summary, status, attempts, claims, notes, metadata, kind,
          project_id, expected_cost_cents, tags, needs_human_review,
          deprecation_reason, parent_id, goal_id, ts, created_ts
        )
        SELECT
          harness_slug, ${id}::TEXT, feature_id,
          title, summary, status, attempts, claims, notes, metadata, kind,
          project_id, expected_cost_cents, tags, needs_human_review,
          deprecation_reason, parent_id, goal_id, ts, ${now}::BIGINT
        FROM harness_features
      `;
    });
    return c.json({ ok: true });
  } catch (e: any) {
    return c.json({ ok: false, error: String(e?.message ?? e) }, 500);
  }
});

/**
 * POST /:slug/save-as-template — create a reusable template from a running harness.
 *
 * A template is a recipe (manifest + scaffolding files) that can be
 * `papercusp init`'d into a fresh harness. Distinct from a snapshot
 * (which freezes mid-mission state). This endpoint:
 *
 *   1. Reads the harness's .harness/config.json (models, timeouts, phases).
 *   2. Reads ~/.papercusp/.../harnesses/<slug>/enabled-plugins.json for the
 *      plugin recommendations to bake into the template.
 *   3. Copies SPEC.md, AGENTS.md, .harness/validation-contract.md verbatim
 *      to the template's source dir.
 *   4. Synthesizes a papercusp.json manifest with:
 *        - kind: "template"
 *        - name (from body.slug, default <harness-slug>-template)
 *        - version (from body.version, default 0.1.0)
 *        - description, author, license, icon (from body, optional)
 *        - models (lifted from .harness/config.json)
 *        - plugins[] (recommendations from enabled-plugins.json)
 *        - configFiles[] (the standard set: SPEC.md, AGENTS.md,
 *          .harness/config.json, .harness/validation-contract.md)
 *
 * The template lands at ~/.papercusp/templates/<new-slug>/<version>/.
 * Returns the path so callers can navigate to /installed/templates/<slug>/edit
 * (the editor page is a follow-up; for now the user can edit files manually
 * or run `papercusp publish` from the dir).
 */
harness.post('/:slug/save-as-template', async (c) => {
  const project = await resolveProject(c.req.param('slug'));
  if (!project) return c.json({ error: 'unknown project' }, 404);

  const body = (await c.req.json().catch(() => ({}))) as {
    slug?: string;
    version?: string;
    description?: string;
    author?: string;
    license?: string;
    icon?: string;
  };

  const newSlug = (body.slug ?? `${project.slug}-template`).trim();
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(newSlug) && !/^@[a-z0-9][a-z0-9._-]+\/[a-z0-9][a-z0-9._-]+$/.test(newSlug)) {
    return c.json({ error: `invalid slug "${newSlug}" (lowercase alphanumeric + ._- ; or scoped @owner/name)` }, 400);
  }
  const version = (body.version ?? '0.1.0').trim();
  if (!/^\d+\.\d+\.\d+(-[a-z0-9.-]+)?$/.test(version)) {
    return c.json({ error: `invalid version "${version}" (expected semver, e.g. 0.1.0)` }, 400);
  }

  const rootDir = papercuspRoot();
  const templateDir = join(rootDir, 'templates', newSlug, version);
  if (existsSync(templateDir)) {
    return c.json({ error: `template already exists at ${templateDir} — bump version or pick a different slug` }, 409);
  }
  await mkdir(templateDir, { recursive: true });

  // Source files to copy verbatim (canonical list — see lib/harness-state-files.ts)
  const sourceFiles = SOURCE_FILES_FOR_FORK;
  const copied: string[] = [];
  const skipped: string[] = [];
  for (const rel of sourceFiles) {
    const src = join(project.path, rel);
    if (!existsSync(src)) { skipped.push(rel); continue; }
    const dst = join(templateDir, rel);
    await mkdir(dirname(dst), { recursive: true });
    await copyFile(src, dst);
    copied.push(rel);
  }

  // Read .harness/config.json so we can lift its `models` into the manifest.
  let configModels: Record<string, unknown> | undefined;
  try {
    const cfgRaw = await readFile(join(project.path, '.harness', 'config.json'), 'utf8');
    const cfg = JSON.parse(cfgRaw) as { models?: Record<string, unknown> };
    if (cfg.models && typeof cfg.models === 'object') configModels = cfg.models;
  } catch {}

  // Read enabled-plugins.json for plugin recommendations.
  type EnabledPlugins = { enabled?: Record<string, { version?: string }> };
  const enabledPath = join(rootDir, 'harnesses', project.slug, 'enabled-plugins.json');
  let pluginRecs: Array<{ slug: string; autoEnable: boolean; version?: string }> = [];
  try {
    if (existsSync(enabledPath)) {
      const enabled = JSON.parse(await readFile(enabledPath, 'utf8')) as EnabledPlugins;
      pluginRecs = Object.entries(enabled.enabled ?? {}).map(([slug, info]) => ({
        slug,
        autoEnable: true,
        version: info.version,
      }));
    }
  } catch {}

  // Standard configFiles list — what the operator's Config tab will surface
  // when the template is instantiated. Mirrors papercup-coding's manifest.
  const configFiles = [
    { path: 'SPEC.md', label: 'SPEC.md', language: 'markdown', description: 'What this project should accomplish — read by every role on every iteration.' },
    { path: 'AGENTS.md', label: 'AGENTS.md', language: 'markdown', description: 'Coding conventions, libraries to prefer, idioms to avoid — applied by the worker.' },
    { path: '.harness/config.json', label: 'config.json', language: 'json', description: 'Phase, model preferences per role, timeouts, cost cap.' },
    { path: '.harness/validation-contract.md', label: 'validation-contract.md', language: 'markdown', description: 'What "passing" means — the validator enforces this against every worker proposal.' },
  ];

  const manifest = {
    name: newSlug,
    version,
    kind: 'template' as const,
    description: body.description ?? `Template forked from ${project.slug}`,
    author: body.author,
    license: body.license ?? 'MIT',
    icon: body.icon,
    papercusp: '^0.1.0',
    ...(configModels ? { models: configModels } : {}),
    ...(pluginRecs.length > 0 ? { plugins: pluginRecs } : {}),
    configFiles,
    forkedFrom: { harness: project.slug, at: new Date().toISOString() },
  };
  await writeFile(
    join(templateDir, 'papercusp.json'),
    JSON.stringify(manifest, null, 2) + '\n',
    'utf8',
  );

  // Scaffold a README so the marketplace page has Overview content from
  // the moment the template is published. The user can edit it via the
  // /installed/templates/<slug>/edit page before publishing.
  const readmePath = join(templateDir, 'README.md');
  if (!existsSync(readmePath)) {
    const desc = body.description?.trim() || `Template forked from ${project.slug}.`;
    const pluginLines = pluginRecs.length > 0
      ? pluginRecs.map((p) => `- \`${p.slug}\`${p.version ? ` v${p.version}` : ''}${p.autoEnable ? ' (auto-enable)' : ''}`).join('\n')
      : '_(no plugins bundled)_';
    const modelLines = configModels && Object.keys(configModels).length > 0
      ? Object.entries(configModels)
          .map(([role, conf]) => `- **${role}** — \`${(conf as { preferred?: string })?.preferred ?? '—'}\``)
          .join('\n')
      : '_(no role overrides — uses framework defaults)_';
    const configFileLines = configFiles
      .map((f) => `- \`${f.path}\` — ${f.description ?? ''}`)
      .join('\n');

    const readme = `# ${newSlug}\n\n${desc}\n\nForked from harness \`${project.slug}\` on ${new Date().toISOString().slice(0, 10)}.\n\n## Install\n\n\`\`\`\npapercusp install ${newSlug}@${version}\n\`\`\`\n\nOr install via the marketplace site at :3060.\n\n## What's in this template\n\n### Config files\n\nEditable after install (and via the operator's Config tab):\n\n${configFileLines}\n\n### Models\n\n${modelLines}\n\n### Plugins\n\n${pluginLines}\n\n## Customising\n\nEdit \`SPEC.md\` to point at your project's goals, then \`papercusp run\` to start the loop.\n\nSee \`AGENTS.md\` for the conventions every role applies, and \`.harness/validation-contract.md\` for what \"passing\" means in this template.\n`;
    await writeFile(readmePath, readme, 'utf8');
    copied.push('README.md');
  }

  return c.json({
    ok: true,
    slug: newSlug,
    version,
    path: templateDir,
    copied,
    skipped,
    pluginRecs: pluginRecs.length,
    editPath: `/installed/templates/${encodeURIComponent(newSlug)}/edit`,
  });
});

harness.post('/:slug/snapshots/:id/restore', async (c) => {
  const project = await resolvePhasedProject(c.req.param('slug'), phasePhaseLabel(c.req.query('phase')));
  if (!project) return c.json({ error: 'unknown project' }, 404);
  const id = c.req.param('id').replace(/[^A-Za-z0-9_-]/g, '');
  if (!id || !/^\d+-iter-\d+$/.test(id)) {
    return c.json({ error: 'invalid snapshot id' }, 400);
  }
  const snapDir = join(harnessDir(project), 'snapshots', id);
  if (!existsSync(snapDir)) return c.json({ error: 'snapshot not found' }, 404);
  await ensureSnapshotFeaturesTable();

  const body = await c.req.json().catch(() => ({})) as { includeSupervisorNotes?: boolean; includeConfig?: boolean; includeFeatures?: boolean };
  const includeSupervisorNotes = body.includeSupervisorNotes !== false;
  const includeConfig = body.includeConfig !== false;
  // Default true: features are the main thing users want to roll back.
  // Set explicitly false to restore only contract+notes+config.
  const includeFeatures = body.includeFeatures !== false;

  const restored: string[] = [];
  for (const f of SNAPSHOT_FILES) {
    if (f === 'supervisor-notes.md' && !includeSupervisorNotes) continue;
    if (f === 'config.json' && !includeConfig) continue;
    if (f === 'features.json') continue; // legacy — superseded by PG restore below
    const src = join(snapDir, f);
    if (!existsSync(src)) continue;
    const dest = join(harnessDir(project), f);
    const tmp = `${dest}.tmp.${Date.now()}`;
    await copyFile(src, tmp);
    await rename(tmp, dest);
    restored.push(f);
  }

  // PG round-trip for the work queue. Wrapped in a transaction so a
  // mid-restore failure leaves the queue intact.
  let featuresRestored = 0;
  if (includeFeatures) {
    try {
      const { sql } = getHarnessPg(project.slug);
      await sql.begin(async (tx) => {
        const exists = await tx<{ n: number }[]>`
          SELECT COUNT(*)::int AS n
          FROM harness_shared.snapshot_features
          WHERE harness_slug = ${project.slug} AND snapshot_id = ${id}
        `;
        if (exists[0].n === 0) {
          // Legacy snapshot (created before PG mirror landed). Leave the
          // queue alone — restoring would clear it without replacing.
          return;
        }
        await tx`DELETE FROM harness_features WHERE harness_slug = ${project.slug}`;
        await tx`
          INSERT INTO harness_features (
            harness_slug, feature_id,
            title, summary, status, attempts, claims, notes, metadata, kind,
            project_id, expected_cost_cents, tags, needs_human_review,
            deprecation_reason, parent_id, goal_id, ts, created_ts, updated_ts
          )
          SELECT
            harness_slug, feature_id,
            title, summary, status, attempts, claims, notes, metadata, kind,
            project_id, expected_cost_cents, tags, needs_human_review,
            deprecation_reason, parent_id, goal_id, ts, created_ts, ${Date.now()}::BIGINT
          FROM harness_shared.snapshot_features
          WHERE harness_slug = ${project.slug} AND snapshot_id = ${id}
        `;
        featuresRestored = exists[0].n;
      });
      if (featuresRestored > 0) restored.push(`harness_features (${featuresRestored} rows)`);
    } catch (e) {
      console.error(`[snapshots] PG restore failed for ${project.slug}:${id}:`, e);
      return c.json({ ok: false, error: 'work queue restore failed; FS files restored', restored }, 500);
    }
  }

  return c.json({ ok: true, restored, featuresRestored });
});

harness.delete('/:slug/snapshots/:id', async (c) => {
  const project = await resolvePhasedProject(c.req.param('slug'), phasePhaseLabel(c.req.query('phase')));
  if (!project) return c.json({ error: 'unknown project' }, 404);
  const id = c.req.param('id').replace(/[^A-Za-z0-9_-]/g, '');
  if (!id || !/^\d+-iter-\d+$/.test(id)) {
    return c.json({ error: 'invalid snapshot id' }, 400);
  }
  const snapDir = join(harnessDir(project), 'snapshots', id);
  if (!existsSync(snapDir)) return c.json({ ok: true, deleted: false });
  for (const f of SNAPSHOT_FILES) {
    try { await unlink(join(snapDir, f)); } catch {}
  }
  try { const { rmdir } = await import('node:fs/promises'); await rmdir(snapDir); } catch {}
  // Also drop any PG rows for this snapshot (no-op for legacy ones).
  try {
    const { sql } = getHarnessPg(project.slug);
    await sql`DELETE FROM harness_shared.snapshot_features WHERE harness_slug = ${project.slug} AND snapshot_id = ${id}`;
  } catch (e) {
    console.warn(`[snapshots] PG cleanup failed for ${project.slug}:${id}:`, (e as Error)?.message);
  }
  return c.json({ ok: true, deleted: true });
});

harness.post('/:slug/escalation/resolve', async (c) => {
  const project = await resolvePhasedProject(c.req.param('slug'), phasePhaseLabel(c.req.query('phase')));
  if (!project) return c.json({ error: 'unknown project' }, 404);
  const body = await c.req.json().catch(() => ({}));
  const response = typeof body.response === 'string' ? body.response.trim() : '';
  const action = body.action === 'clear' ? 'clear' : 'keep';

  const slug = c.req.param('slug');
  const supervisorNotesPath = join(harnessDir(project), 'supervisor-notes.md');
  const { appendTextArtifact, loadTextArtifact, deleteTextArtifact } = await import('@/lib/text-artifacts');
  if (response) {
    const block = `\n## Human response ${new Date().toISOString()}\n\n${response}\n`;
    await appendTextArtifact(slug, 'supervisor-notes.md', block);
    try { await appendFile(supervisorNotesPath, block, 'utf8'); } catch {}
  }

  if (action === 'clear') {
    await deleteTextArtifact(slug, 'escalation.md');
    try { await unlink(join(harnessDir(project), 'escalation.md')); } catch {}
  }

  const pgNotes = await loadTextArtifact(slug, 'supervisor-notes.md');
  return c.json({
    ok: true,
    supervisorNotes: pgNotes ?? safeRead(supervisorNotesPath),
    cleared: action === 'clear',
  });
});

harness.post('/:slug/resume', async (c) => {
  const project = await resolvePhasedProject(c.req.param('slug'), phasePhaseLabel(c.req.query('phase')));
  if (!project) return c.json({ error: 'unknown project' }, 404);
  try { await unlink(join(harnessDir(project), 'escalation.md')); } catch {}
  const result = await launchRun(project);
  if (!result.ok) return c.json({ error: result.error }, 500);
  return c.json({ ok: true, logPath: result.logPath });
});

// ─── hooks (.harness/hooks/<name>.sh) ─────────────────────────────────

// Hook list comes from getKnownHooks() in lib/known-hooks.ts, which
// greps `run_hook <name>` invocations out of run.sh. The script is the
// source of truth — the UI fetches hook names via GET /:slug/hooks
// rather than maintaining a parallel client copy.

function hookPath(project: ProjectEntry, name: string): string {
  return join(harnessDir(project), 'hooks', `${name}.sh`);
}

harness.get('/:slug/hooks', async (c) => {
  const project = await resolvePhasedProject(c.req.param('slug'), phasePhaseLabel(c.req.query('phase')));
  if (!project) return c.json({ error: 'unknown project' }, 404);
  const hooks = getKnownHooks().map((name) => {
    const path = hookPath(project, name);
    let exists = false;
    let executable = false;
    let content: string | null = null;
    try {
      const s = statSync(path);
      exists = s.isFile();
      executable = (s.mode & 0o111) !== 0;
      content = safeRead(path);
    } catch {}
    return { name, exists, executable, content };
  });
  return c.json({ hooks });
});

harness.put('/:slug/hooks/:name', async (c) => {
  const project = await resolvePhasedProject(c.req.param('slug'), phasePhaseLabel(c.req.query('phase')));
  if (!project) return c.json({ error: 'unknown project' }, 404);
  const name = c.req.param('name');
  if (!getKnownHooks().includes(name)) {
    return c.json({ error: `unknown hook: ${name}` }, 400);
  }
  const body = await c.req.json() as { content?: string };
  if (typeof body.content !== 'string') {
    return c.json({ error: 'content required' }, 400);
  }
  const dir = join(harnessDir(project), 'hooks');
  await mkdir(dir, { recursive: true });
  const dest = hookPath(project, name);
  const tmp = `${dest}.tmp.${Date.now()}`;
  await writeFile(tmp, body.content, 'utf8');
  await chmod(tmp, 0o755);
  await rename(tmp, dest);
  return c.json({ ok: true, path: dest, executable: true });
});

harness.delete('/:slug/hooks/:name', async (c) => {
  const project = await resolvePhasedProject(c.req.param('slug'), phasePhaseLabel(c.req.query('phase')));
  if (!project) return c.json({ error: 'unknown project' }, 404);
  const name = c.req.param('name');
  if (!getKnownHooks().includes(name)) {
    return c.json({ error: `unknown hook: ${name}` }, 400);
  }
  try {
    await unlink(hookPath(project, name));
    return c.json({ ok: true, deleted: true });
  } catch (err: any) {
    if (err?.code === 'ENOENT') return c.json({ ok: true, deleted: false });
    return c.json({ error: String(err) }, 500);
  }
});

// SSE: emit 'change' when *.log files in logs/hooks/ are added/removed/grow.

harness.get('/:slug/hook-logs/:logId', async (c) => {
  const project = await resolvePhasedProject(c.req.param('slug'), phasePhaseLabel(c.req.query('phase')));
  if (!project) return c.json({ error: 'unknown project' }, 404);
  const logId = c.req.param('logId').replace(/[^A-Za-z0-9_.-]/g, '');
  if (!logId) return c.json({ error: 'invalid logId' }, 400);
  const full = join(harnessDir(project), 'logs', 'hooks', `${logId}.log`);
  const content = safeRead(full);
  if (content === null) return c.json({ error: 'log not found' }, 404);
  return c.json({ logId, content });
});

harness.get('/:slug/git/show/:sha', async (c) => {
  const project = await resolvePhasedProject(c.req.param('slug'), phasePhaseLabel(c.req.query('phase')));
  if (!project) return c.json({ error: 'unknown project' }, 404);
  const sha = c.req.param('sha');
  if (!/^[0-9a-f]{4,64}$/i.test(sha)) return c.json({ error: 'bad sha' }, 400);
  try {
    const [meta, patch] = await Promise.all([
      execFileP(
        'git',
        ['-C', project.path, 'show', '--no-patch', '--format=%H%n%an%n%ae%n%at%n%P%n%s%n%n%b', sha],
        { maxBuffer: 4 * 1024 * 1024, timeout: 10_000 },
      ).then((r) => r.stdout),
      execFileP(
        'git',
        ['-C', project.path, 'show', '--format=', '--patch', '--stat', '-M', sha],
        { maxBuffer: 32 * 1024 * 1024, timeout: 15_000 },
      ).then((r) => r.stdout),
    ]);
    const [hash, author, email, ts, parents, subject, ...bodyLines] = meta.split('\n');
    return c.json({
      sha: hash,
      author,
      email,
      ts: Number(ts) * 1000,
      parents: parents ? parents.split(' ').filter(Boolean) : [],
      subject,
      body: bodyLines.join('\n').trim(),
      patch,
    });
  } catch (err: any) {
    return c.json({ error: err?.message ?? String(err) }, 500);
  }
});

harness.get('/:slug/git/log', async (c) => {
  const project = await resolvePhasedProject(c.req.param('slug'), phasePhaseLabel(c.req.query('phase')));
  if (!project) return c.json({ error: 'unknown project' }, 404);

  // Org-kind harnesses (and any harness whose root isn't a git checkout)
  // legitimately have no git history. Return an empty list instead of 500ing.
  if (!existsSync(join(project.path, '.git'))) {
    return c.json({ commits: [], notAGitRepo: true });
  }

  const limit = Math.min(2000, Math.max(1, Number(c.req.query('limit') ?? 300)));
  try {
    const commits = await cachedGitLog(project.path, limit);
    return c.json({ commits });
  } catch (err: any) {
    return c.json({ error: err?.message ?? String(err) }, 500);
  }
});

// Find all PIDs of run.sh running for this project + their descendants.
function findHarnessPids(projectPath: string): number[] {
  const pids: number[] = [];
  try {
    for (const pid of readdirSync('/proc').filter((d) => /^\d+$/.test(d))) {
      try {
        const cwd = readlinkSync(`/proc/${pid}/cwd`);
        if (!cwd.startsWith(projectPath)) continue;
        const cmdline = readFileSync(`/proc/${pid}/cmdline`, 'utf8');
        if ((cmdline.includes('autonomous-harness/run.sh') || cmdline.includes('/harness/run.sh')) || cmdline.includes('claude') || cmdline.includes('python3')) {
          pids.push(Number(pid));
        }
      } catch {}
    }
  } catch {}
  return pids;
}

harness.post('/:slug/pause', async (c) => {
  const project = await resolvePhasedProject(c.req.param('slug'), phasePhaseLabel(c.req.query('phase')));
  if (!project) return c.json({ error: 'unknown project' }, 404);
  const pids = findHarnessPids(project.path);
  const paused: number[] = [];
  for (const pid of pids) {
    try { process.kill(pid, 'SIGSTOP'); paused.push(pid); } catch {}
  }
  return c.json({ ok: true, paused });
});

harness.post('/:slug/unpause', async (c) => {
  const project = await resolvePhasedProject(c.req.param('slug'), phasePhaseLabel(c.req.query('phase')));
  if (!project) return c.json({ error: 'unknown project' }, 404);
  const pids = findHarnessPids(project.path);
  const resumed: number[] = [];
  for (const pid of pids) {
    try { process.kill(pid, 'SIGCONT'); resumed.push(pid); } catch {}
  }
  return c.json({ ok: true, resumed });
});

harness.post('/:slug/stop', async (c) => {
  const project = await resolvePhasedProject(c.req.param('slug'), phasePhaseLabel(c.req.query('phase')));
  if (!project) return c.json({ error: 'unknown project' }, 404);
  try {
    const procs = readdirSync('/proc').filter((d) => /^\d+$/.test(d));
    const killed: number[] = [];
    for (const pid of procs) {
      try {
        const cwd = readlinkSync(`/proc/${pid}/cwd`);
        if (!cwd.startsWith(project.path)) continue;
        const cmdline = readFileSync(`/proc/${pid}/cmdline`, 'utf8');
        if ((cmdline.includes('autonomous-harness/run.sh') || cmdline.includes('/harness/run.sh'))) {
          process.kill(Number(pid), 'SIGTERM');
          killed.push(Number(pid));
        }
      } catch {}
    }
    return c.json({ ok: true, killed });
  } catch (err) {
    return c.json({ error: String(err) }, 500);
  }
});

// ─── Issues tracker (structured) ─────────────────────────────────────
// `.harness/issues.json` is the structured companion to issues.md.
// If missing, we synthesize it on read by parsing issues.md (read-only
// migration — the file isn't persisted until a mutation happens).
// Types imported from the shared issues/types module so the API and the
// dashboard panel stay in sync — adding a new severity/status here used
// to require editing both files.
import type {
  Issue, IssueNote, IssueSeverity, IssueSource, IssueStatus,
} from '@/app/harness/issues/types';
interface IssuesFile { issues: Issue[]; nextId: number }

function issuesJsonPath(project: ProjectEntry): string {
  return join(harnessDir(project), 'issues.json');
}

function loadIssuesRaw(project: ProjectEntry): IssuesFile | null {
  const raw = safeRead(issuesJsonPath(project));
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as IssuesFile;
    if (!parsed.issues) parsed.issues = [];
    if (!parsed.nextId) parsed.nextId = parsed.issues.length + 1;
    return parsed;
  } catch {
    return null;
  }
}

async function saveIssues(project: ProjectEntry, file: IssuesFile): Promise<void> {
  await writeFile(issuesJsonPath(project), JSON.stringify(file, null, 2), 'utf8');
  await syncIssuesToPg(project, file).catch((err) => {
    // PG is the read-side replica via Zero; JSON remains authoritative for now.
    // Don't fail the request if Zero replication target is unavailable.
    console.warn(`[issues] PG sync failed for ${project.slug}:`, err?.message ?? err);
  });
}

/**
 * Bulk-mirror the JSON state to `harness_<slug>.harness_issues`. The whole
 * issue set is upserted; rows in PG that no longer exist in JSON are deleted.
 * Cheap because issue counts are O(100s).
 */
async function syncIssuesToPg(project: ProjectEntry, file: IssuesFile): Promise<void> {
  const { sql } = getHarnessPg(project.slug);
  const now = Date.now();
  const ids = file.issues.map((i) => i.id);
  if (ids.length > 0) {
    const rows = file.issues.map((i) => ({
      harness_slug: project.slug,
      issue_id: i.id,
      title: i.title,
      severity: i.severity,
      source: i.source,
      status: i.status,
      found_at: i.foundAt,
      found_during: i.foundDuring ?? null,
      repro: i.repro ?? null,
      evidence: i.evidence ?? null,
      suggested_fix: i.suggestedFix ?? null,
      code_pointer: i.codePointer ?? null,
      linked_feature_id: i.linkedFeatureId ?? null,
      attempts: i.attempts ?? 0,
      notes: JSON.stringify(i.notes ?? []),
      created_ts: now,
      updated_ts: now,
    }));
    await sql`
      INSERT INTO harness_issues ${sql(rows, 'harness_slug', 'issue_id', 'title', 'severity', 'source', 'status', 'found_at', 'found_during', 'repro', 'evidence', 'suggested_fix', 'code_pointer', 'linked_feature_id', 'attempts', 'notes', 'created_ts', 'updated_ts')}
      ON CONFLICT (harness_slug, issue_id) DO UPDATE SET
        title             = EXCLUDED.title,
        severity          = EXCLUDED.severity,
        source            = EXCLUDED.source,
        status            = EXCLUDED.status,
        found_at          = EXCLUDED.found_at,
        found_during      = EXCLUDED.found_during,
        repro             = EXCLUDED.repro,
        evidence          = EXCLUDED.evidence,
        suggested_fix     = EXCLUDED.suggested_fix,
        code_pointer      = EXCLUDED.code_pointer,
        linked_feature_id = EXCLUDED.linked_feature_id,
        attempts          = EXCLUDED.attempts,
        notes             = EXCLUDED.notes,
        updated_ts        = EXCLUDED.updated_ts
    `;
    await sql`
      DELETE FROM harness_issues
      WHERE harness_slug = ${project.slug}
        AND issue_id <> ALL(${ids})
    `;
  } else {
    await sql`
      DELETE FROM harness_issues
      WHERE harness_slug = ${project.slug}
    `;
  }
}

// Call the parser from the harness UI code to seed issues when json is absent.
// (Inline re-implementation to avoid a build-time dependency on the app-router
// side. Keep in sync with apps/web/app/harness/issues/parse-md.ts.)
function parseIssuesMdLocal(md: string): Issue[] {
  if (!md || !md.trim()) return [];
  const out: Issue[] = [];
  const seen = new Set<string>();

  const shortHash = (s: string): string => {
    let h = 5381;
    for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
    return (h >>> 0).toString(36).padStart(7, '0').slice(-7);
  };

  const headerRe = /^## (F-[A-Z0-9-]+)\s+—\s+Validation round (\d+)\s+—\s+(\S+)\s*$/gm;
  const matches = [...md.matchAll(headerRe)];

  for (let i = 0; i < matches.length; i++) {
    const m = matches[i];
    const start = m.index! + m[0].length;
    const end = i + 1 < matches.length ? matches[i + 1].index! : md.length;
    const body = md.slice(start, end).trim();
    const feature = m[1];
    const ts = m[3];

    const sectRe = /###\s+OUT-OF-SCOPE[^\n]*\n([\s\S]*?)(?=\n### |\n---|\n## |$)/gi;
    let sm;
    while ((sm = sectRe.exec(body)) !== null) {
      const section = sm[1].trim();
      const items: string[] = [];
      const lines = section.split('\n');
      let cur = '';
      for (const line of lines) {
        if (/^\d+\.\s+/.test(line) || /^[-*]\s+\*\*/.test(line)) {
          if (cur.trim()) items.push(cur.trim());
          cur = line.replace(/^\d+\.\s+|^[-*]\s+/, '');
        } else {
          cur += '\n' + line;
        }
      }
      if (cur.trim()) items.push(cur.trim());

      for (const raw of items) {
        if (raw.length < 10) continue;
        const bold = raw.match(/\*\*(.+?)\*\*/);
        const title = bold
          ? bold[1].trim().replace(/[.:]\s*$/, '')
          : raw.split('\n')[0].split(/(?<=[.!?])\s/)[0].slice(0, 140).trim();
        const codeM = raw.match(/([a-zA-Z0-9_./+-]+(?:\.[a-zA-Z0-9]+)?):(\d+)(?::\d+)?/);
        const codePointer = codeM?.[0];
        const severity: IssueSeverity =
          /\bcrash|panic|corrupt|data loss|security|inject|RCE|auth bypass/i.test(raw) ? 'critical'
          : /\bblock|break|broken|fail\b|5\d\d|500\b|hang|deadlock|preflight\b/i.test(raw) ? 'major'
          : /\bnit|typo|style|nitpick|cosmetic|wording/i.test(raw) ? 'nit'
          : 'minor';
        const id = `I-${shortHash(`${feature}|${title}|${codePointer ?? ''}`)}`;
        if (seen.has(id)) continue;
        seen.add(id);

        const reproM = raw.match(/Repro[s]?:\s*\n?((?:.+\n?)+?)(?=\n\n|\nObserved:|\nRoot cause:|\nImpact|\nSuggested|\nVerified|$)/i);
        const evidenceM = raw.match(/(?:Observed|Evidence):\s*\n?((?:.+\n?)+?)(?=\n\n|\nRoot cause:|\nImpact|\nSuggested|\nVerified|$)/i);
        const fixM = raw.match(/Suggested fix:\s*\n?((?:.+\n?)+?)(?=\n\n|\nFiled|$)/i);

        out.push({
          id, title, severity,
          source: 'validator',
          foundAt: ts,
          foundDuring: feature,
          status: 'open',
          repro: reproM?.[1]?.trim(),
          evidence: evidenceM?.[1]?.trim() ?? raw.slice(0, 400),
          suggestedFix: fixM?.[1]?.trim(),
          codePointer,
          attempts: 0,
          notes: [],
        });
      }
    }
  }
  return out;
}

function loadIssuesOrSeed(project: ProjectEntry): IssuesFile {
  const existing = loadIssuesRaw(project);
  if (existing) return existing;
  const md = safeRead(join(harnessDir(project), 'issues.md')) ?? '';
  const parsed = parseIssuesMdLocal(md);
  return { issues: parsed, nextId: parsed.length + 1 };
}

// Read the validator's un-merged structured findings from PG (mirror of
// .harness/pending-issues.jsonl, populated by harness-fs-watcher). Lines
// lacking an explicit `id` get the same `PENDING-<n>` synthesis the
// fs-watcher applies, so the row set matches what the disk reader used
// to produce. These entries are read-only from the UI's perspective —
// promotion/mutation goes through the curator.
async function readPendingIssues(project: ProjectEntry): Promise<Issue[]> {
  const { ensureHarnessPendingIssuesTable } = await import('@/lib/ensure-schema');
  await ensureHarnessPendingIssuesTable();
  const { sql } = (await import('@restart/db-org')).getOrgPg();
  const rows = await sql<{ issue_id: string; payload: Record<string, unknown>; ts: string | number }[]>`
    SELECT issue_id, payload, ts
      FROM harness_shared.harness_pending_issues
     WHERE harness_slug = ${project.slug}
     ORDER BY ts ASC
  `;
  const out: Issue[] = [];
  for (const r of rows) {
    const p = r.payload ?? {};
    if (!p.title || !p.severity) continue;
    out.push({
      id: r.issue_id,
      title: String(p.title),
      severity: p.severity as Issue['severity'],
      source: 'validator',
      foundAt: (p.foundAt as string) ?? new Date(Number(r.ts) || 0).toISOString(),
      foundDuring: p.foundDuring as string | undefined,
      status: 'open',
      repro: p.repro as string | undefined,
      evidence: p.evidence as string | undefined,
      suggestedFix: p.suggestedFix as string | undefined,
      codePointer: p.codePointer as string | undefined,
      attempts: 0,
      notes: [],
    });
  }
  return out;
}

harness.get('/:slug/issues-list', async (c) => {
  const project = await resolvePhasedProject(c.req.param('slug'), phasePhaseLabel(c.req.query('phase')));
  if (!project) return c.json({ error: 'unknown project' }, 404);
  const file = loadIssuesOrSeed(project);
  const pending = await readPendingIssues(project);
  return c.json({ ...file, pending });
});

harness.post('/:slug/issues', async (c) => {
  const project = await resolvePhasedProject(c.req.param('slug'), phasePhaseLabel(c.req.query('phase')));
  if (!project) return c.json({ error: 'unknown project' }, 404);
  const body = await c.req.json().catch(() => ({}));
  if (!body.title || typeof body.title !== 'string') {
    return c.json({ error: 'title required' }, 400);
  }
  const file = loadIssuesOrSeed(project);
  const id = `I-${String(file.nextId).padStart(4, '0')}`;
  const issue: Issue = {
    id,
    title: body.title,
    severity: body.severity ?? 'minor',
    source: 'human',
    foundAt: new Date().toISOString(),
    status: 'open',
    evidence: body.evidence,
    repro: body.repro,
    suggestedFix: body.suggestedFix,
    codePointer: body.codePointer,
    attempts: 0,
    notes: [],
  };
  file.issues.unshift(issue);
  file.nextId += 1;
  await saveIssues(project, file);
  return c.json(issue);
});

/**
 * POST /:slug/issues/append-pending — validator-facing.
 *
 * Replaces the validator's direct write to `.harness/pending-issues.jsonl`.
 * Body matches one line of pending-issues.jsonl (the validator's existing
 * structured-finding shape). The operator appends a JSONL line server-side
 * and the next /triage call merges it into issues.json + harness_issues.
 *
 * Why an endpoint and not direct DB insert: the curator's merge algorithm
 * (jaccard + codePointer dedup) is already in /triage. Routing through the
 * pending queue keeps that dedup pass intact while removing the validator's
 * dependency on the harness filesystem layout.
 *
 * Phase-3 follow-up: when the curator's merge moves into operator code
 * (replacing /triage's file flow with a pure-DB pass), this endpoint
 * graduates to a direct INSERT into harness_issues with status='pending'.
 */
harness.post('/:slug/issues/append-pending', async (c) => {
  const project = await resolvePhasedProject(c.req.param('slug'), phasePhaseLabel(c.req.query('phase')));
  if (!project) return c.json({ error: 'unknown project' }, 404);
  const body = await c.req.json().catch(() => null) as null | {
    title?: string;
    severity?: 'critical' | 'major' | 'minor' | 'nit';
    foundDuring?: string;
    repro?: string;
    evidence?: string;
    suggestedFix?: string;
    codePointer?: string;
    linkedFeatureId?: string;
  };
  if (!body || typeof body.title !== 'string' || !body.title.trim()) {
    return c.json({ error: 'title required' }, 400);
  }
  const payload = {
    title: body.title.trim(),
    severity: body.severity ?? 'minor',
    source: 'validator',
    foundAt: new Date().toISOString(),
    foundDuring: body.foundDuring,
    repro: body.repro,
    evidence: body.evidence,
    suggestedFix: body.suggestedFix,
    codePointer: body.codePointer,
    linkedFeatureId: body.linkedFeatureId,
    status: 'open',
    attempts: 1,
    notes: [],
  };
  // PG-canonical: INSERT directly into harness_pending_issues (the same
  // table the harness-fs-watcher mirrors disk writes to). The watcher's
  // upsert pattern is preserved; this just bypasses the file.
  const { ensureHarnessPendingIssuesTable } = await import('@/lib/ensure-schema');
  await ensureHarnessPendingIssuesTable();
  const { db } = (await import('@restart/db-org')).getOrgPg();
  const { generated } = await import('@restart/db-org');
  const hpi = generated.harness_pending_issuesInHarness_shared;
  const issueId = `PENDING-${Date.now()}`;
  const ts = Date.now();
  await db
    .insert(hpi)
    .values({
      harness_slug: project.slug,
      phase: project.phase ?? 'staging',
      issue_id: issueId,
      feature_id: body.linkedFeatureId ?? null,
      title: payload.title,
      severity: payload.severity,
      source: 'validator',
      payload: payload as any,
      ts,
      mtime_ms: ts,
      workspace_id: activeWorkspaceId(),
    })
    .onConflictDoNothing();
  void notifySyncInvalidate('harnessPendingIssues.byHarness', { harnessSlug: project.slug });
  return c.json({ ok: true });
});

harness.post('/:slug/issues/:id/update', async (c) => {
  const project = await resolvePhasedProject(c.req.param('slug'), phasePhaseLabel(c.req.query('phase')));
  if (!project) return c.json({ error: 'unknown project' }, 404);
  const id = c.req.param('id');
  const body = await c.req.json().catch(() => ({}));
  const file = loadIssuesOrSeed(project);
  const issue = file.issues.find((i) => i.id === id);
  if (!issue) return c.json({ error: 'issue not found' }, 404);

  if (typeof body.status === 'string') issue.status = body.status as IssueStatus;
  if (typeof body.severity === 'string') issue.severity = body.severity as IssueSeverity;
  if (typeof body.title === 'string') issue.title = body.title;
  if (typeof body.linkedFeatureId === 'string' || body.linkedFeatureId === null) {
    issue.linkedFeatureId = body.linkedFeatureId ?? undefined;
  }
  if (typeof body.note === 'string' && body.note.trim()) {
    issue.notes.push({ ts: new Date().toISOString(), by: body.by ?? 'human', text: body.note });
  }
  await saveIssues(project, file);
  return c.json(issue);
});

// Manual triage: merge pending-issues.jsonl → issues.json using the same
// algorithm the curator runs, then truncate the jsonl. Useful when a human
// wants to surface fresh findings without waiting for the next DONE/ESCALATE.
harness.post('/:slug/triage', async (c) => {
  const project = await resolvePhasedProject(c.req.param('slug'), phasePhaseLabel(c.req.query('phase')));
  if (!project) return c.json({ error: 'unknown project' }, 404);

  const pending = await readPendingIssues(project);
  if (pending.length === 0) return c.json({ ok: true, merged: 0, deduped: 0 });

  const file = loadIssuesOrSeed(project);

  const tokenize = (s: string): Set<string> =>
    new Set(s.toLowerCase().split(/[^a-z0-9]+/i).filter((w) => w.length > 2));
  const jaccard = (a: Set<string>, b: Set<string>): number => {
    if (a.size === 0 || b.size === 0) return 0;
    let inter = 0;
    for (const w of a) if (b.has(w)) inter++;
    return inter / (a.size + b.size - inter);
  };

  let merged = 0;
  let deduped = 0;

  for (const p of pending) {
    const ptok = tokenize(p.title);
    const dup = file.issues.find((e) => {
      if (e.status === 'closed' || e.status === 'wontfix') return false;
      const samePtr = p.codePointer && e.codePointer && p.codePointer === e.codePointer;
      const nameMatch = jaccard(ptok, tokenize(e.title)) >= 0.85;
      return samePtr || nameMatch;
    });
    if (dup) {
      dup.attempts += 1;
      dup.notes.push({
        ts: new Date().toISOString(),
        by: 'validator',
        text: `Resurfaced during ${p.foundDuring ?? 'validation'}`,
      });
      const sevOrder = ['nit', 'minor', 'major', 'critical'];
      if (sevOrder.indexOf(p.severity) > sevOrder.indexOf(dup.severity)) {
        dup.severity = p.severity;
      }
      deduped++;
    } else {
      const id = `I-${String(file.nextId).padStart(4, '0')}`;
      file.nextId += 1;
      file.issues.unshift({ ...p, id });
      merged++;
    }
  }

  await saveIssues(project, file);
  // Clear the pending queue: DELETE rows from harness_pending_issues +
  // truncate the on-disk feed for any bash run.sh that might still
  // append to it. The watcher will mirror the empty file → DELETE
  // (idempotent with our explicit DELETE here).
  {
    const { ensureHarnessPendingIssuesTable } = await import('@/lib/ensure-schema');
    await ensureHarnessPendingIssuesTable();
    const { db } = (await import('@restart/db-org')).getOrgPg();
    const { generated } = await import('@restart/db-org');
    const { and, eq } = await import('drizzle-orm');
    const hpi = generated.harness_pending_issuesInHarness_shared;
    await db
      .delete(hpi)
      .where(and(eq(hpi.harness_slug, project.slug), eq(hpi.phase, project.phase ?? 'staging')));
    void notifySyncInvalidate('harnessPendingIssues.byHarness', { harnessSlug: project.slug });
  }
  const pendingPath = join(harnessDir(project), 'pending-issues.jsonl');
  if (existsSync(pendingPath)) await writeFile(pendingPath, '', 'utf8');

  return c.json({ ok: true, merged, deduped });
});

harness.post('/:slug/issues/:id/promote', async (c) => {
  const project = await resolvePhasedProject(c.req.param('slug'), phasePhaseLabel(c.req.query('phase')));
  if (!project) return c.json({ error: 'unknown project' }, 404);
  const id = c.req.param('id');
  const file = loadIssuesOrSeed(project);
  const issue = file.issues.find((i) => i.id === id);
  if (!issue) return c.json({ error: 'issue not found' }, 404);
  if (issue.linkedFeatureId) return c.json({ error: 'already linked to ' + issue.linkedFeatureId }, 400);

  // Append a F-FIX-### entry to harness_features (PG). Other feature
  // endpoints (POST /:slug/features, bulk upsert, etc) already use the
  // table; this promotion path was the last operator endpoint still
  // doing a direct features.json read-modify-write.
  const dbc = dbcFor(project.slug);
  const fixRows = await dbc.prepare(`
    SELECT feature_id FROM harness_features
     WHERE harness_slug = ? AND feature_id LIKE 'F-FIX-%'
  `).all(project.slug) as Array<{ feature_id: string }>;
  const existingFixIds = fixRows
    .map((r) => Number(r.feature_id.slice(6)))
    .filter((n) => Number.isFinite(n));
  const nextFixId = (existingFixIds.length ? Math.max(...existingFixIds) : 0) + 1;
  const featureId = `F-FIX-${String(nextFixId).padStart(3, '0')}`;
  const claims = issue.codePointer ? [`VAL-FIX-${nextFixId} @ ${issue.codePointer}`] : [];
  const featureNotes = [issue.evidence ?? '', issue.suggestedFix ? `Suggested fix: ${issue.suggestedFix}` : '']
    .filter(Boolean)
    .join('\n\n');
  const featureTs = Date.now();
  await dbc.prepare(`
    INSERT INTO harness_features
      (harness_slug, feature_id, title, summary, status, attempts, claims, notes, metadata,
       kind, project_id, expected_cost_cents, tags, needs_human_review,
       ts, created_ts, updated_ts)
    VALUES (?, ?, ?, NULL, 'todo', 0, ?, ?, ?, NULL, NULL, NULL, NULL, false, ?, ?, ?)
  `).run(
    project.slug, featureId, issue.title,
    claims.length ? JSON.stringify(claims) : null,
    featureNotes || null,
    JSON.stringify({ sourceIssueId: issue.id }),
    featureTs, featureTs, featureTs,
  );
  auditFeatureChange(project.slug, featureId, '__created', null, { id: featureId, title: issue.title, sourceIssueId: issue.id }, c.req.header('x-actor') ?? 'issue-promote');
  const newFeature = {
    id: featureId,
    title: issue.title,
    claims,
    status: 'todo',
    attempts: 0,
    sourceIssueId: issue.id,
    notes: featureNotes,
  };

  issue.linkedFeatureId = featureId;
  issue.status = 'fixing';
  issue.notes.push({
    ts: new Date().toISOString(),
    by: 'human',
    text: `Promoted to ${featureId}`,
  });
  await saveIssues(project, file);

  return c.json({ ok: true, issue, feature: newFeature });
});

// ─── Architect reviews + chat ────────────────────────────────────────

interface PendingReview {
  id: string;
  featureId: string;
  kind: string;
  question: string;
  recommendedAnswer?: string;
  tradeoff?: string;
  context?: string;
  ts: number;
  claim?: string;
  resolved?: boolean;
  userResponse?: string;
}

function reviewsDir(project: ProjectEntry): string {
  return join(harnessDir(project), 'pending-reviews');
}

harness.get('/:slug/reviews', async (c) => {
  const { listPendingReviews } = await import('@/lib/harness-readers');
  const result = await listPendingReviews(
    c.req.param('slug'),
    phasePhaseLabel(c.req.query('phase')),
  );
  return c.json(result);
});

harness.get('/:slug/reviews/:id', async (c) => {
  const slug = c.req.param('slug');
  const phase = phasePhaseLabel(c.req.query('phase'));
  const id = c.req.param('id').replace(/[^A-Za-z0-9_.-]/g, '');
  const { sql } = getOrgPg();
  const rows = await sql<{ payload: PendingReview; review_id: string; resolved: boolean; ts: number }[]>`
    SELECT payload, review_id, resolved, ts
      FROM harness_shared.pending_reviews
     WHERE harness_slug = ${slug}
       AND phase = ${phase}
       AND review_id = ${id}
     LIMIT 1
  `;
  if (!rows.length) return c.json({ error: 'not found' }, 404);
  return c.json({ ...rows[0].payload, id: rows[0].review_id, resolved: rows[0].resolved, ts: rows[0].ts });
});

harness.post('/:slug/reviews/:id/resolve', async (c) => {
  const slug = c.req.param('slug');
  const phase = phasePhaseLabel(c.req.query('phase'));
  const project = await resolvePhasedProject(slug, phase);
  if (!project) return c.json({ error: 'unknown project' }, 404);
  const id = c.req.param('id').replace(/[^A-Za-z0-9_.-]/g, '');
  const body = await c.req.json() as { response?: string; accept?: boolean };

  // PG canonical: read from the mirrored row.
  const { db } = getOrgPg();
  const { generated } = await import('@restart/db-org');
  const { and, eq } = await import('drizzle-orm');
  const prev = generated.pending_reviewsInHarness_shared;
  const rows = await db
    .select({ payload: prev.payload })
    .from(prev)
    .where(and(eq(prev.harness_slug, slug), eq(prev.phase, phase), eq(prev.review_id, id)))
    .limit(1);
  if (!rows.length) return c.json({ error: 'not found' }, 404);
  const review: PendingReview = { ...(rows[0].payload as PendingReview) };
  review.resolved = true;
  review.userResponse = body.response ?? (body.accept ? review.recommendedAnswer : '');

  // Update PG immediately so GET /reviews and Zero subscriptions reflect
  // the resolution before the watcher catches the FS move.
  await db
    .update(prev)
    .set({ resolved: true, payload: review as any })
    .where(and(eq(prev.harness_slug, slug), eq(prev.phase, phase), eq(prev.review_id, id)));

  // Append the response to supervisor-notes.md (PG canonical, FS mirror).
  const notesPath = join(harnessDir(project), 'supervisor-notes.md');
  const block = `\n## human ${new Date().toISOString()}\n\nReview ${review.id} resolved for ${review.featureId} (${review.kind}):\n\n> ${review.question}\n\nAnswer: ${review.userResponse || '(no text)'}\n`;
  const { appendTextArtifact } = await import('@/lib/text-artifacts');
  await appendTextArtifact(slug, 'supervisor-notes.md', block);
  try { await appendFile(notesPath, block, 'utf8'); } catch {}

  // Mirror to FS for backward-compat: orchestrator/architect may still
  // read .harness/pending-reviews/. Overwrite the file in place with
  // resolved:true rather than move+delete — the watcher's deleteReview
  // is unconditional and would clear our just-updated PG row. The
  // watcher's upsertReview will re-mirror the resolved=true state.
  const path = join(reviewsDir(project), `${id}.json`);
  if (existsSync(path)) {
    await writeFile(path, JSON.stringify(review, null, 2), 'utf8');
  }

  // Unblock the feature in features.json so the orchestrator can pick it up again.
  if (review.featureId) {
    try {
      const fp = join(harnessDir(project), 'features.json');
      const rawF = safeRead(fp);
      if (rawF) {
        const parsed = JSON.parse(rawF);
        const feats = parsed.features ?? [];
        const feat = feats.find((f: any) => f.id === review.featureId);
        if (feat && feat.status === 'blocked') {
          feat.status = 'todo';
        }
        await writeFile(fp, JSON.stringify(parsed, null, 2), 'utf8');
      }
    } catch {}
  }

  return c.json({ ok: true, review });
});

// Architect chat — streams a single turn via runClaudeChat (backend-aware:
// `omp -p` by default, `claude -p` when AGENT_BACKEND=claude-code).
// Body: { history: [{role:'user'|'assistant',content:string}], message: string, reviewId?: string }
// Response: text/event-stream; events are `delta` with a text chunk, then `done`.

harness.post('/:slug/architect/chat', async (c) => {
  const project = await resolvePhasedProject(c.req.param('slug'), phasePhaseLabel(c.req.query('phase')));
  if (!project) return c.json({ error: 'unknown project' }, 404);
  const body = await c.req.json() as {
    history?: Array<{ role: 'user' | 'assistant'; content: string }>;
    message: string;
    reviewId?: string;
  };
  if (!body.message || typeof body.message !== 'string') {
    return c.json({ error: 'message required' }, 400);
  }

  // Compose a compact prompt: system instructions + current spec grounding +
  // conversation history + the new user message. The assistant is told to
  // stream text and, when ready, emit a diff block with a special marker.
  const spec = safeRead(join(project.path, 'SPEC.md')) ?? '';
  const contract = safeRead(join(harnessDir(project), 'validation-contract.md')) ?? '';
  // Features live in Postgres (harness_features) post-2026-04-27 migration.
  // Render a compact summary for the prompt — same shape the agents used to
  // read out of features.json, just sourced from the DB now.
  const featuresList = await parseFeatures(project);
  const features = JSON.stringify(
    { features: featuresList.map((f) => ({ id: f.id, title: f.title, status: f.status, attempts: f.attempts })) },
    null,
    2,
  );
  const issues = safeRead(join(harnessDir(project), 'issues.md')) ?? '';
  let reviewContext = '';
  if (body.reviewId) {
    const rpath = join(reviewsDir(project), `${body.reviewId.replace(/[^A-Za-z0-9_.-]/g, '')}.json`);
    const rraw = safeRead(rpath);
    if (rraw) reviewContext = `\n\n## Pending review in context\n\n${rraw}\n`;
  }

  const systemPrompt = `You are the ARCHITECT in an autonomous coding harness, chatting with the human supervisor through the /harness Inbox.

Your job is to help them clarify the spec: ask Socratic questions about any vagueness until the user's intent is precise and testable, then propose a concrete change to SPEC.md or .harness/validation-contract.md.

Current state:

## SPEC.md
${spec.slice(0, 8000)}

## validation-contract.md
${contract.slice(0, 6000)}

## features (harness_features in Postgres — summary)
${features.slice(0, 3000)}

## issues.md tail
${issues.slice(-3000)}
${reviewContext}

Rules:
- Prefer short, pointed clarifying questions over long speeches.
- When you're ready to propose a change, emit a fenced block. The UI shows the user a summary + Accept button; they trust you on the mechanical details.

Format for file replacements:
\`\`\`proposal:SPEC.md
SUMMARY: <1–3 sentences in plain English: what will change and why. This is the ONLY text the user reads by default.>
---
<complete replacement file contents — verbatim, nothing elided>
\`\`\`

Use \`proposal:SPEC.md\` or \`proposal:contract\` as the fence language. First line after the fence MUST start with \`SUMMARY:\` then human-facing text; then a line \`---\`; then the full replacement body.

For a supervisor note (short message appended, not replacing a file):
\`\`\`note:supervisor
<text that appends to supervisor-notes.md>
\`\`\`

Rules for proposals:
- The summary is what the user sees. Make it precise and plain-English. No jargon without definition.
- The body must be complete — do not elide. The UI writes it verbatim on Accept.
- Be decisive but never fabricate facts. If you don't know a constraint, ask instead of proposing.`;

  const history = (body.history ?? []).slice(-10);
  const fullPrompt = [
    ...history.map((m) => `${m.role === 'user' ? 'User' : 'Architect'}: ${m.content}`),
    `User: ${body.message}`,
    'Architect:',
  ].join('\n\n');

  // Stream the response via runClaudeChat (backend-aware: claude-code
  // or omp). Uses Hono's streamSSE for write-time flushing — the prior
  // raw-ReadableStream approach buffered the whole response under
  // Next/Turbopack, blocking client receipt until omp finished (60s+
  // for an architect-sized prompt). Matches the oracle/chat shape.
  return streamSSE(c, async (stream) => {
    const send = (event: string, data: string) =>
      stream.writeSSE({ event, data: data.replace(/\n/g, '\\n') });

    try {
      for await (const ev of runClaudeChat({
        promptText: `${systemPrompt}\n\n---\n\n${fullPrompt}\n`,
        cwd: project.path,
      })) {
        if (ev.type === 'delta') await send('delta', ev.text);
        else if (ev.type === 'result') {
          await send('done', JSON.stringify({ cost: ev.costUsd, input: ev.tokensIn, output: ev.tokensOut }));
        } else if (ev.type === 'error') {
          await send('error', `${ev.message}${ev.stderr ? `: ${ev.stderr.slice(0, 500)}` : ''}`);
        }
      }
    } catch (err) {
      await send('error', `architect chat failed: ${(err as Error).message}`);
    }
  });
});

// Accept an Architect-proposed patch — write it to the target file.
// Body: { target: 'SPEC.md' | 'contract' | 'supervisor-notes', content: string }
harness.post('/:slug/architect/apply', async (c) => {
  const project = await resolvePhasedProject(c.req.param('slug'), phasePhaseLabel(c.req.query('phase')));
  if (!project) return c.json({ error: 'unknown project' }, 404);
  const body = await c.req.json() as { target: string; content: string };
  if (!body.content) return c.json({ error: 'content required' }, 400);

  let path: string;
  switch (body.target) {
    case 'SPEC.md': path = join(project.path, 'SPEC.md'); break;
    case 'contract': path = join(harnessDir(project), 'validation-contract.md'); break;
    case 'supervisor-notes': {
      const notesPath = join(harnessDir(project), 'supervisor-notes.md');
      const block = `\n## architect ${new Date().toISOString()}\n\n${body.content}\n`;
      const { appendTextArtifact } = await import('@/lib/text-artifacts');
      await appendTextArtifact(c.req.param('slug'), 'supervisor-notes.md', block);
      try { await appendFile(notesPath, block, 'utf8'); } catch {}
      return c.json({ ok: true, appended: 'supervisor-notes.md' });
    }
    default: return c.json({ error: 'unknown target' }, 400);
  }

  const tmp = `${path}.tmp.${Date.now()}`;
  await writeFile(tmp, body.content, 'utf8');
  await rename(tmp, path);
  return c.json({ ok: true, written: path });
});

// ─── Brainstorm — scratchpad + canvas + chat + promote ──────────────

function brainstormPath(project: ProjectEntry): string {
  return join(harnessDir(project), 'brainstorm.md');
}
function brainstormCanvasPath(project: ProjectEntry): string {
  return join(harnessDir(project), 'brainstorm.canvas.json');
}
function brainstormMindmapPath(project: ProjectEntry): string {
  return join(harnessDir(project), 'brainstorm.mindmap.json');
}

// Phase 2 (Migration 033): brainstorm.{md,canvas.json,mindmap.json} are now
// PG-canonical via harness_shared.harness_brainstorm. Filesystem is a
// best-effort mirror written on each PUT for editor convenience. If the
// PG row exists it's authoritative; otherwise we fall back to the FS file
// (legacy harnesses pre-Migration-033 may still have FS-only data).
async function loadBrainstorm(slug: string): Promise<{ content: string; canvas: unknown; mindmap: unknown }> {
  const { ensureBrainstormTable } = await import('@/lib/ensure-schema');
  await ensureBrainstormTable();
  const { sql } = (await import('@restart/db-org')).getOrgPg();
  const rows = await sql<{ content: string; canvas: unknown; mindmap: unknown }[]>`
    SELECT content, canvas, mindmap FROM harness_shared.harness_brainstorm
     WHERE harness_slug = ${slug} AND phase = 'staging' LIMIT 1
  `;
  return rows[0] ?? { content: '', canvas: null, mindmap: null };
}

async function saveBrainstorm(slug: string, patch: { content?: string; canvas?: unknown; mindmap?: unknown }): Promise<void> {
  const { ensureBrainstormTable } = await import('@/lib/ensure-schema');
  await ensureBrainstormTable();
  const { sql } = (await import('@restart/db-org')).getOrgPg();
  const now = Date.now();
  // Use JSON.stringify + ::jsonb cast instead of sql.json(): the latter
  // throws 'Received an instance of Object' inside postgres-js 3.4.9 when
  // the value contains nested objects (the React Flow tree has nodes
  // with `measured`/`position`/`data` sub-objects). Explicit serialize +
  // cast is unambiguous.
  const canvasJson = patch.canvas !== undefined ? JSON.stringify(patch.canvas) : null;
  const mindmapJson = patch.mindmap !== undefined ? JSON.stringify(patch.mindmap) : null;
  await sql`
    INSERT INTO harness_shared.harness_brainstorm (harness_slug, phase, content, canvas, mindmap, updated_at)
    VALUES (
      ${slug}, 'staging',
      ${patch.content ?? ''},
      ${canvasJson}::jsonb,
      ${mindmapJson}::jsonb,
      ${now}
    )
    ON CONFLICT (harness_slug, phase) DO UPDATE SET
      content    = COALESCE(${patch.content ?? null}, harness_brainstorm.content),
      canvas     = COALESCE(${canvasJson}::jsonb, harness_brainstorm.canvas),
      mindmap    = COALESCE(${mindmapJson}::jsonb, harness_brainstorm.mindmap),
      updated_at = ${now}
  `;
  const { notifySyncInvalidate } = await import('@/lib/sync-sse');
  await notifySyncInvalidate('harnessBrainstorm.byHarness', { harnessSlug: slug });
}

harness.get('/:slug/brainstorm', async (c) => {
  const slug = c.req.param('slug');
  const project = await resolvePhasedProject(slug, phasePhaseLabel(c.req.query('phase')));
  if (!project) return c.json({ error: 'unknown project' }, 404);
  const row = await loadBrainstorm(slug);
  // Fallback to FS for harnesses that pre-date Migration 033 and have not
  // yet had a PUT to seed PG.
  const content = row.content || (safeRead(brainstormPath(project)) ?? '');
  return c.json({ content });
});

harness.put('/:slug/brainstorm', async (c) => {
  const slug = c.req.param('slug');
  const project = await resolvePhasedProject(slug, phasePhaseLabel(c.req.query('phase')));
  if (!project) return c.json({ error: 'unknown project' }, 404);
  const body = await c.req.json().catch(() => ({}));
  if (typeof body.content !== 'string') return c.json({ error: 'content required' }, 400);
  await saveBrainstorm(slug, { content: body.content });
  // FS mirror — best-effort. If the project directory has been moved
  // (the very thing PG-canonical was designed to survive), this throws
  // and we just skip; PG already has the data.
  await writeFile(brainstormPath(project), body.content, 'utf8').catch(() => {});
  return c.json({ ok: true, bytes: body.content.length });
});

harness.get('/:slug/brainstorm-canvas', async (c) => {
  const slug = c.req.param('slug');
  const project = await resolvePhasedProject(slug, phasePhaseLabel(c.req.query('phase')));
  if (!project) return c.json({ error: 'unknown project' }, 404);
  const row = await loadBrainstorm(slug);
  if (row.canvas) return c.json({ scene: row.canvas });
  const raw = safeRead(brainstormCanvasPath(project));
  if (!raw) return c.json({ scene: null });
  try { return c.json({ scene: JSON.parse(raw) }); }
  catch { return c.json({ scene: null }); }
});

harness.put('/:slug/brainstorm-canvas', async (c) => {
  const slug = c.req.param('slug');
  const project = await resolvePhasedProject(slug, phasePhaseLabel(c.req.query('phase')));
  if (!project) return c.json({ error: 'unknown project' }, 404);
  const body = await c.req.json().catch(() => ({}));
  if (!body.scene) return c.json({ error: 'scene required' }, 400);
  await saveBrainstorm(slug, { canvas: body.scene });
  await writeFile(brainstormCanvasPath(project), JSON.stringify(body.scene, null, 2), 'utf8').catch(() => {});
  return c.json({ ok: true });
});

harness.get('/:slug/brainstorm-mindmap', async (c) => {
  const slug = c.req.param('slug');
  const project = await resolvePhasedProject(slug, phasePhaseLabel(c.req.query('phase')));
  if (!project) return c.json({ error: 'unknown project' }, 404);
  const row = await loadBrainstorm(slug);
  if (row.mindmap) return c.json({ tree: row.mindmap });
  const raw = safeRead(brainstormMindmapPath(project));
  if (!raw) return c.json({ tree: null });
  try { return c.json({ tree: JSON.parse(raw) }); }
  catch { return c.json({ tree: null }); }
});

harness.put('/:slug/brainstorm-mindmap', async (c) => {
  const slug = c.req.param('slug');
  const project = await resolvePhasedProject(slug, phasePhaseLabel(c.req.query('phase')));
  if (!project) return c.json({ error: 'unknown project' }, 404);
  const body = await c.req.json().catch(() => ({}));
  if (!body.tree) return c.json({ error: 'tree required' }, 400);
  await saveBrainstorm(slug, { mindmap: body.tree });
  await writeFile(brainstormMindmapPath(project), JSON.stringify(body.tree, null, 2), 'utf8').catch(() => {});
  return c.json({ ok: true });
});

// Brainstorm chat — reuses the same Claude CLI pipe as architect/chat
// but with a different system prompt focused on expansive ideation.
harness.post('/:slug/brainstorm/chat', async (c) => {
  const project = await resolvePhasedProject(c.req.param('slug'), phasePhaseLabel(c.req.query('phase')));
  if (!project) return c.json({ error: 'unknown project' }, 404);
  const body = await c.req.json() as {
    history?: Array<{ role: 'user' | 'assistant'; content: string }>;
    message: string;
  };
  if (!body.message || typeof body.message !== 'string') {
    return c.json({ error: 'message required' }, 400);
  }

  const spec = safeRead(join(project.path, 'SPEC.md')) ?? '';
  const brainstorm = safeRead(brainstormPath(project)) ?? '';
  // Same as the Architect chat: features live in harness_features (PG).
  const featuresList = await parseFeatures(project);
  const features = JSON.stringify(
    { features: featuresList.map((f) => ({ id: f.id, title: f.title, status: f.status })) },
    null,
    2,
  );

  const systemPrompt = `You are a BRAINSTORM PARTNER for a software project. You're chatting with the human supervisor of a coding harness to help them explore ideas before they become features.

Your job: expand the space of possibilities. Suggest analogues, probe "have you considered…", challenge hidden assumptions. You are expansive, not reductive. This is pre-SPEC ideation — nothing needs to be final yet.

Current state:

## SPEC.md
${spec.slice(0, 6000)}

## Existing features (harness_features in Postgres — summary)
${features.slice(0, 2000)}

## Brainstorm scratchpad (what the user is working on)
${brainstorm.slice(0, 8000)}

Rules:
- Lead with ideas, tradeoffs, analogues from other domains. Be concrete.
- When an idea matures enough to be acted on, emit a fenced action block:
  - \`\`\`promote:feature — create a new todo feature in harness_features. Put a short title on the first line, then markdown body explaining intent + optional claims.
  - \`\`\`promote:spec — insert into SPEC.md under a "## Brainstormed" section.
  - \`\`\`promote:issue — file as an issue in issues.json. First line is title; rest is evidence/context.
- Don't promote too eagerly. Wait until the user signals the idea is ready, or ask them first.
- Keep responses short and punchy. Long speeches kill brainstorming.`;

  const history = (body.history ?? []).slice(-10);
  const fullPrompt = [
    ...history.map((m) => `${m.role === 'user' ? 'User' : 'Partner'}: ${m.content}`),
    `User: ${body.message}`,
    'Partner:',
  ].join('\n\n');

  // Same fix as architect chat above: streamSSE flushes per-write,
  // raw ReadableStream buffers under Next/Turbopack.
  return streamSSE(c, async (stream) => {
    const send = (event: string, data: string) =>
      stream.writeSSE({ event, data: data.replace(/\n/g, '\\n') });

    try {
      for await (const ev of runClaudeChat({
        promptText: `${systemPrompt}\n\n---\n\n${fullPrompt}\n`,
        cwd: project.path,
      })) {
        if (ev.type === 'delta') await send('delta', ev.text);
        else if (ev.type === 'result') {
          await send('done', JSON.stringify({ cost: ev.costUsd }));
        } else if (ev.type === 'error') {
          await send('error', `${ev.message}${ev.stderr ? `: ${ev.stderr.slice(0, 500)}` : ''}`);
        }
      }
    } catch (err) {
      await send('error', `brainstorm chat failed: ${(err as Error).message}`);
    }
  });
});

// Brainstorm promote — takes content from chat or a selection and
// routes it into features.json, SPEC.md, or issues.json.
harness.post('/:slug/brainstorm/promote', async (c) => {
  const project = await resolvePhasedProject(c.req.param('slug'), phasePhaseLabel(c.req.query('phase')));
  if (!project) return c.json({ error: 'unknown project' }, 404);
  const body = await c.req.json().catch(() => ({}));
  const target = body.target as 'feature' | 'spec' | 'issue';
  const content = typeof body.content === 'string' ? body.content : '';
  if (!target || !content.trim()) return c.json({ error: 'target + content required' }, 400);

  if (target === 'feature') {
    // PG-canonical: query existing F-IDEA-* ids from harness_features
    // and INSERT a new row. Same shape as the issue-promote path
    // (commit fcffc94) — every other feature endpoint goes through
    // harness_features.
    const dbc = dbcFor(project.slug);
    const ideaRows = await dbc.prepare(`
      SELECT feature_id FROM harness_features
       WHERE harness_slug = ? AND feature_id LIKE 'F-IDEA-%'
    `).all(project.slug) as Array<{ feature_id: string }>;
    const existingIdeaIds = ideaRows
      .map((r) => Number(r.feature_id.slice(7)))
      .filter((n) => Number.isFinite(n));
    const n = (existingIdeaIds.length ? Math.max(...existingIdeaIds) : 0) + 1;
    const id = `F-IDEA-${String(n).padStart(3, '0')}`;
    const [firstLine, ...rest] = content.trim().split('\n');
    const title = firstLine.trim().slice(0, 200);
    const notes = rest.join('\n').trim() || null;
    const ts = Date.now();
    await dbc.prepare(`
      INSERT INTO harness_features
        (harness_slug, feature_id, title, summary, status, attempts, claims, notes, metadata,
         kind, project_id, expected_cost_cents, tags, needs_human_review,
         ts, created_ts, updated_ts)
      VALUES (?, ?, ?, NULL, 'todo', 0, NULL, ?, ?, NULL, NULL, NULL, NULL, false, ?, ?, ?)
    `).run(
      project.slug, id, title,
      notes,
      JSON.stringify({ source: 'brainstorm' }),
      ts, ts, ts,
    );
    auditFeatureChange(project.slug, id, '__created', null, { id, title, source: 'brainstorm' }, c.req.header('x-actor') ?? 'brainstorm-promote');
    return c.json({ ok: true, id, target });
  }

  if (target === 'spec') {
    const specPath = join(project.path, 'SPEC.md');
    const existing = safeRead(specPath) ?? '';
    const SECTION = '## Brainstormed';
    const stamp = new Date().toISOString();
    const block = `\n\n### ${stamp}\n\n${content.trim()}\n`;
    let next: string;
    if (existing.includes(SECTION)) {
      const idx = existing.indexOf(SECTION);
      const nextSectionIdx = existing.indexOf('\n## ', idx + SECTION.length);
      const insertAt = nextSectionIdx === -1 ? existing.length : nextSectionIdx;
      next = existing.slice(0, insertAt) + block + existing.slice(insertAt);
    } else {
      next = existing.replace(/\s*$/, '') + `\n\n${SECTION}\n${block}`;
    }
    await writeFile(specPath, next, 'utf8');
    return c.json({ ok: true, target, sectionAdded: !existing.includes(SECTION) });
  }

  if (target === 'issue') {
    const file = loadIssuesOrSeed(project);
    const id = `I-${String(file.nextId).padStart(4, '0')}`;
    const [firstLine, ...rest] = content.trim().split('\n');
    file.issues.unshift({
      id,
      title: firstLine.trim().slice(0, 200),
      severity: 'minor',
      source: 'human',
      foundAt: new Date().toISOString(),
      status: 'open',
      evidence: rest.join('\n').trim(),
      attempts: 0,
      notes: [],
    });
    file.nextId += 1;
    await saveIssues(project, file);
    return c.json({ ok: true, id, target });
  }

  return c.json({ error: 'unknown target' }, 400);
});

// ─── Memory map + editable memory files ──────────────────────────────
//
// The harness has many artifacts that function as memory. This surface lets
// the UI list them, view tier/size/mtime, and edit the safe ones.

type MemoryTier = 'green' | 'yellow' | 'red';

interface MemoryFileMeta {
  path: string;           // relative to projectPath (e.g. 'SPEC.md' or '.harness/features.json')
  purpose: string;
  writtenBy: string[];
  readBy: string[];
  tier: MemoryTier;       // enforcement level for edits
  language: 'markdown' | 'json' | 'text' | 'jsonl';
  optional?: boolean;     // file may legitimately not exist
}

const MEMORY_MAP: MemoryFileMeta[] = [
  // Project-root, human-authored
  { path: 'SPEC.md',                              purpose: 'User intent — source of truth',            writtenBy: ['human', 'architect', 'reviewer'], readBy: ['scoper', 'architect', 'worker', 'validator'], tier: 'green',  language: 'markdown' },
  { path: 'AGENTS.md',                            purpose: 'Project conventions',                      writtenBy: ['human'],                     readBy: ['scoper', 'worker', 'validator', 'architect'], tier: 'green',  language: 'markdown', optional: true },

  // Harness state
  { path: '.harness/config.json',                 purpose: 'Models, timeouts, cost cap, memory map',   writtenBy: ['human'],                     readBy: ['run.sh'],                                       tier: 'green',  language: 'json' },
  { path: '.harness/validation-contract.md',      purpose: 'Binding contract of claims',               writtenBy: ['scoper', 'architect'],       readBy: ['orchestrator', 'worker', 'validator', 'architect'], tier: 'yellow', language: 'markdown' },

  // NOTE: features.json, issues.md, issues.json, pending-issues.jsonl all
  // moved to Postgres (harness_<slug>.{harness_features,harness_issues}) in
  // the 2026-04-26 → 2026-04-27 filesystem→PG migration arc. The dashboard's
  // dedicated panels (FeatureList, IssuesList, ProposalsPanel) read from
  // Zero/PG directly, so the Memory tab no longer surfaces those entries.
  // The files may still appear on disk as transient agent output until the
  // scoper/validator/curator prompts are migrated to call the DB endpoints
  // directly (see /docs/spec/state.mdx).

  // Durable memory
  { path: '.harness/memory/MEMORY.md',            purpose: 'Curated durable memory (seed)',            writtenBy: ['curator', 'human'],          readBy: ['scoper', 'worker', 'orchestrator', 'reviewer'], tier: 'green',  language: 'markdown' },
  { path: '.harness/memory/raw.md',               purpose: 'Append-only observations from agents',     writtenBy: ['all'],                       readBy: ['curator'],                                     tier: 'yellow', language: 'markdown' },
  { path: '.harness/memory/summary.md',           purpose: 'One-line run summaries',                   writtenBy: ['curator'],                   readBy: ['UI'],                                          tier: 'green',  language: 'markdown' },

  // Human loop
  { path: '.harness/supervisor-notes.md',         purpose: 'Human/architect guidance to orchestrator', writtenBy: ['human', 'architect'],        readBy: ['orchestrator', 'architect'],                   tier: 'green',  language: 'markdown', optional: true },
  { path: '.harness/escalation.md',               purpose: 'Escalation state — resolve via UI flow',   writtenBy: ['orchestrator'],              readBy: ['human', 'curator'],                            tier: 'red',    language: 'markdown', optional: true },

  // Scratch / user-authored
  { path: '.harness/worker-log.md',               purpose: 'Worker scratchpad',                        writtenBy: ['worker'],                    readBy: ['worker'],                                      tier: 'yellow', language: 'markdown', optional: true },
  { path: '.harness/knowledge.md',                purpose: 'Long-term domain notes for workers',       writtenBy: ['human'],                     readBy: ['worker'],                                      tier: 'green',  language: 'markdown', optional: true },
  { path: '.harness/brainstorm.md',               purpose: 'Freeform user brainstorm',                 writtenBy: ['human'],                     readBy: [],                                              tier: 'green',  language: 'markdown', optional: true },
];

// Non-role attributions allowed in MEMORY_MAP.writtenBy / readBy. Anything
// else must be a real role (i.e. have a prompt file on disk) or the
// operator refuses to boot. The actual fail-closed check runs after
// getKnownRoles() is defined further down the file.
const MEMORY_ATTRIBUTION_META = new Set(['human', 'all', 'run.sh', 'UI']);

function resolveMemoryPath(project: ProjectEntry, rel: string): { abs: string } | null {
  // Sanitize: normalize, reject .., only allow within projectPath
  const normalized = rel.replace(/\\/g, '/').replace(/\/+/g, '/').replace(/^\/+/, '');
  if (normalized.includes('..')) return null;
  if (normalized.length === 0) return null;
  const abs = join(project.path, normalized);
  // Ensure abs stays inside project root
  const root = resolve(project.path);
  const target = resolve(abs);
  if (target !== root && !target.startsWith(root + '/')) return null;
  return { abs: target };
}

function detectTier(rel: string): { tier: MemoryTier; meta: MemoryFileMeta | null } {
  // Normalize the relative path so matches work with or without leading ./
  const norm = rel.replace(/^\.\//, '').replace(/\\/g, '/');
  const exact = MEMORY_MAP.find((m) => m.path === norm);
  if (exact) return { tier: exact.tier, meta: exact };
  // Unknown files default to yellow (soft-warn) if under .harness, otherwise green
  if (norm.startsWith('.harness/')) return { tier: 'yellow', meta: null };
  return { tier: 'green', meta: null };
}

function isHarnessAlive(project: ProjectEntry): boolean {
  // Mirror of the liveness probe in /:slug/status — we check for run.sh procs
  // with cwd inside project.path.
  try {
    const procs = readdirSync('/proc').filter((d) => /^\d+$/.test(d));
    for (const pid of procs) {
      try {
        const cwd = readFileSync(`/proc/${pid}/cwd`, 'utf8').trim();
        if (!cwd.startsWith(project.path)) continue;
        const cmdline = readFileSync(`/proc/${pid}/cmdline`, 'utf8');
        if ((cmdline.includes('autonomous-harness/run.sh') || cmdline.includes('/harness/run.sh'))) return true;
      } catch {}
    }
  } catch {}
  return false;
}

harness.get('/:slug/memory', async (c) => {
  const project = await resolvePhasedProject(c.req.param('slug'), phasePhaseLabel(c.req.query('phase')));
  if (!project) return c.json({ error: 'unknown project' }, 404);

  // Extras from config.json.memory.files[] (optional); merge non-duplicate paths
  let extras: MemoryFileMeta[] = [];
  try {
    const raw = safeRead(join(harnessDir(project), 'config.json'));
    if (raw) {
      const cfg = JSON.parse(raw);
      const cfgFiles = cfg?.memory?.files;
      if (Array.isArray(cfgFiles)) {
        for (const e of cfgFiles) {
          if (typeof e?.path !== 'string') continue;
          if (MEMORY_MAP.some((m) => m.path === e.path)) continue;
          extras.push({
            path: e.path,
            purpose: String(e.purpose ?? ''),
            writtenBy: Array.isArray(e.writtenBy) ? e.writtenBy : [],
            readBy: Array.isArray(e.readBy) ? e.readBy : [],
            tier: ['green', 'yellow', 'red'].includes(e.tier) ? e.tier : 'yellow',
            language: ['markdown', 'json', 'jsonl', 'text'].includes(e.language) ? e.language : 'text',
            optional: true,
          });
        }
      }
    }
  } catch {}

  const all = [...MEMORY_MAP, ...extras];
  const alive = isHarnessAlive(project);
  const files = all.map((m) => {
    const r = resolveMemoryPath(project, m.path);
    let size = 0;
    let mtimeMs = 0;
    let exists = false;
    if (r) {
      try {
        const s = statSync(r.abs);
        exists = true;
        size = s.size;
        mtimeMs = s.mtimeMs;
      } catch {}
    }
    return {
      ...m,
      exists,
      size,
      mtimeMs,
      editable: m.tier === 'green' || (m.tier === 'yellow') || (m.tier === 'red' && !alive),
      locked: m.tier === 'red' && alive,
    };
  });

  return c.json({ alive, files });
});

harness.get('/:slug/memory-file', async (c) => {
  const slug = c.req.param('slug');
  const project = await resolvePhasedProject(slug, phasePhaseLabel(c.req.query('phase')));
  if (!project) return c.json({ error: 'unknown project' }, 404);
  const path = c.req.query('path');
  if (!path) return c.json({ error: 'path required' }, 400);
  const r = resolveMemoryPath(project, path);
  if (!r) return c.json({ error: 'invalid path' }, 400);
  const { tier, meta } = detectTier(path);

  // PG canonical (Migration 035) with FS fallback for harnesses pre-035.
  const { loadTextArtifact } = await import('@/lib/text-artifacts');
  let content: string | null = await loadTextArtifact(slug, path);
  let mtimeMs: number | null = null;
  let size = 0;
  if (content === null) {
    try {
      content = readFileSync(r.abs, 'utf8');
      const s = statSync(r.abs);
      mtimeMs = s.mtimeMs;
      size = s.size;
    } catch {}
  } else {
    size = Buffer.byteLength(content, 'utf8');
  }
  return c.json({
    path,
    content,
    exists: content !== null,
    size,
    mtimeMs,
    tier,
    language: meta?.language ?? 'text',
  });
});

harness.put('/:slug/memory-file', async (c) => {
  const project = await resolvePhasedProject(c.req.param('slug'), phasePhaseLabel(c.req.query('phase')));
  if (!project) return c.json({ error: 'unknown project' }, 404);
  const body = await c.req.json().catch(() => ({})) as { path?: string; content?: string };
  if (typeof body.path !== 'string') return c.json({ error: 'path required' }, 400);
  if (typeof body.content !== 'string') return c.json({ error: 'content required' }, 400);
  const r = resolveMemoryPath(project, body.path);
  if (!r) return c.json({ error: 'invalid path' }, 400);

  const { tier, meta } = detectTier(body.path);
  if (tier === 'red' && isHarnessAlive(project)) {
    return c.json({
      error: 'harness is running; stop it before editing this file',
      tier,
      path: body.path,
    }, 423); // Locked
  }

  // JSON validation for .json files
  if (body.path.endsWith('.json')) {
    try { JSON.parse(body.content); }
    catch (e: any) { return c.json({ error: `invalid JSON: ${e.message}` }, 400); }
  }

  // PG canonical (Migration 035).
  const slug = c.req.param('slug');
  const { saveTextArtifact } = await import('@/lib/text-artifacts');
  await saveTextArtifact(slug, body.path, body.content);

  // FS mirror — best-effort.
  try {
    const dir = r.abs.split('/').slice(0, -1).join('/');
    await mkdir(dir, { recursive: true });
    const tmp = `${r.abs}.tmp.${Date.now()}`;
    await writeFile(tmp, body.content, 'utf8');
    await rename(tmp, r.abs);
  } catch { /* mirror is best-effort */ }

  return c.json({ ok: true, path: body.path, tier, wroteBytes: body.content.length });
});

// ─── MCP servers (.mcp.json at project root) ────────────────────────

function mcpPath(project: ProjectEntry): string {
  return join(project.path, '.mcp.json');
}

harness.get('/:slug/mcp', async (c) => {
  const slug = c.req.param('slug');
  const project = await resolvePhasedProject(slug, phasePhaseLabel(c.req.query('phase')));
  if (!project) return c.json({ error: 'unknown project' }, 404);
  // PG-canonical (Phase 0d). Disk fallback for harnesses pre-migration.
  const { loadTextArtifact } = await import('@/lib/text-artifacts');
  const fromPg = await loadTextArtifact(slug, 'mcp.json');
  return c.json({ content: fromPg ?? safeRead(mcpPath(project)) ?? '' });
});

harness.put('/:slug/mcp', async (c) => {
  const slug = c.req.param('slug');
  const project = await resolvePhasedProject(slug, phasePhaseLabel(c.req.query('phase')));
  if (!project) return c.json({ error: 'unknown project' }, 404);
  const body = await c.req.json().catch(() => ({}));
  if (typeof body.content !== 'string') return c.json({ error: 'content required' }, 400);
  // Validate JSON before writing (empty string → delete file).
  if (body.content.trim()) {
    try { JSON.parse(body.content); }
    catch (e: any) { return c.json({ error: `invalid JSON: ${e.message}` }, 400); }
  }
  const path = mcpPath(project);
  if (!body.content.trim()) {
    try { await unlink(path); } catch {}
    // Also clear PG row to keep the two in sync.
    const { saveTextArtifact } = await import('@/lib/text-artifacts');
    await saveTextArtifact(slug, 'mcp.json', '', { customDiskPath: path });
    return c.json({ ok: true, deleted: true });
  }
  // PG-canonical with custom mirror — .mcp.json lives at project root,
  // not under .harness/ (the default text-artifacts mirror location).
  const { saveTextArtifact } = await import('@/lib/text-artifacts');
  await saveTextArtifact(slug, 'mcp.json', body.content, { customDiskPath: path });
  return c.json({ ok: true });
});

// ─── Skills (.claude/skills/*.md) ────────────────────────────────────

function skillsDir(project: ProjectEntry): string {
  return join(project.path, '.claude', 'skills');
}
function safeName(name: string): string | null {
  if (!/^[A-Za-z0-9_.-]+$/.test(name)) return null;
  if (name.includes('..') || name.startsWith('.')) return null;
  return name.replace(/\.md$/i, '') + '.md';
}

harness.get('/:slug/skills', async (c) => {
  const project = await resolvePhasedProject(c.req.param('slug'), phasePhaseLabel(c.req.query('phase')));
  if (!project) return c.json({ error: 'unknown project' }, 404);
  const dir = skillsDir(project);
  let files: string[] = [];
  try {
    if (existsSync(dir)) {
      files = readdirSync(dir).filter((f) => f.endsWith('.md')).sort();
    }
  } catch {}
  return c.json({ skills: files });
});

harness.get('/:slug/skills/:name', async (c) => {
  const project = await resolvePhasedProject(c.req.param('slug'), phasePhaseLabel(c.req.query('phase')));
  if (!project) return c.json({ error: 'unknown project' }, 404);
  const name = safeName(c.req.param('name'));
  if (!name) return c.json({ error: 'bad name' }, 400);
  const content = safeRead(join(skillsDir(project), name)) ?? '';
  return c.json({ name, content });
});

harness.put('/:slug/skills/:name', async (c) => {
  const project = await resolvePhasedProject(c.req.param('slug'), phasePhaseLabel(c.req.query('phase')));
  if (!project) return c.json({ error: 'unknown project' }, 404);
  const name = safeName(c.req.param('name'));
  if (!name) return c.json({ error: 'bad name' }, 400);
  const body = await c.req.json().catch(() => ({}));
  if (typeof body.content !== 'string') return c.json({ error: 'content required' }, 400);
  const dir = skillsDir(project);
  if (!existsSync(dir)) {
    const { mkdir } = await import('node:fs/promises');
    await mkdir(dir, { recursive: true });
  }
  await writeFile(join(dir, name), body.content, 'utf8');
  return c.json({ ok: true, name });
});

harness.delete('/:slug/skills/:name', async (c) => {
  const project = await resolvePhasedProject(c.req.param('slug'), phasePhaseLabel(c.req.query('phase')));
  if (!project) return c.json({ error: 'unknown project' }, 404);
  const name = safeName(c.req.param('name'));
  if (!name) return c.json({ error: 'bad name' }, 400);
  try { await unlink(join(skillsDir(project), name)); } catch {}
  return c.json({ ok: true });
});

// ─── Supervisor notes (.harness/supervisor-notes.md) ─────────────────

function supervisorPath(project: ProjectEntry): string {
  return join(harnessDir(project), 'supervisor-notes.md');
}

harness.get('/:slug/supervisor-notes', async (c) => {
  const slug = c.req.param('slug');
  const project = await resolvePhasedProject(slug, phasePhaseLabel(c.req.query('phase')));
  if (!project) return c.json({ error: 'unknown project' }, 404);
  // PUT/POST/append already route through saveTextArtifact (round 18 fix).
  // GET prefers PG; falls back to disk for harnesses pre-migration.
  const { loadTextArtifact } = await import('@/lib/text-artifacts');
  const fromPg = await loadTextArtifact(slug, 'supervisor-notes.md');
  return c.json({ content: fromPg ?? safeRead(supervisorPath(project)) ?? '' });
});

harness.put('/:slug/supervisor-notes', async (c) => {
  const project = await resolvePhasedProject(c.req.param('slug'), phasePhaseLabel(c.req.query('phase')));
  if (!project) return c.json({ error: 'unknown project' }, 404);
  const body = await c.req.json().catch(() => ({}));
  if (typeof body.content !== 'string') return c.json({ error: 'content required' }, 400);
  // Route via text-artifacts so PG and disk stay in sync (the older
  // direct writeFile path bypassed PG; round 18 fix).
  const { saveTextArtifact } = await import('@/lib/text-artifacts');
  await saveTextArtifact(c.req.param('slug'), 'supervisor-notes.md', body.content);
  return c.json({ ok: true });
});

harness.post('/:slug/supervisor-notes/append', async (c) => {
  const project = await resolvePhasedProject(c.req.param('slug'), phasePhaseLabel(c.req.query('phase')));
  if (!project) return c.json({ error: 'unknown project' }, 404);
  const body = await c.req.json().catch(() => ({}));
  const text = typeof body.text === 'string' ? body.text.trim() : '';
  if (!text) return c.json({ error: 'text required' }, 400);
  const speaker = typeof body.by === 'string' && body.by.trim() ? body.by.trim() : 'human';
  const block = `\n## ${speaker} ${new Date().toISOString()}\n\n${text}\n`;
  // Route via text-artifacts (PG canonical, disk mirror).
  const { appendTextArtifact } = await import('@/lib/text-artifacts');
  await appendTextArtifact(c.req.param('slug'), 'supervisor-notes.md', block);
  return c.json({ ok: true });
});

// ─── Per-project prompt overrides (.harness/prompts/<role>.md) ──────
// Role list lives in lib/known-roles.ts (single source of truth, used
// by every server-side surface that validates a role name).

// Fail-closed guard: every role mentioned in MEMORY_MAP.writtenBy/readBy
// must either be a real role (prompt file on disk) or a meta-actor in
// MEMORY_ATTRIBUTION_META. Otherwise the operator refuses to boot —
// drift can never reach the Memory tab silently.
(function validateMemoryMapAttributions() {
  const validRoles = new Set(getKnownRoles());
  const offenders: { path: string; field: 'writtenBy' | 'readBy'; role: string }[] = [];
  for (const entry of MEMORY_MAP) {
    for (const field of ['writtenBy', 'readBy'] as const) {
      for (const role of entry[field]) {
        if (validRoles.has(role) || MEMORY_ATTRIBUTION_META.has(role)) continue;
        offenders.push({ path: entry.path, field, role });
      }
    }
  }
  if (offenders.length > 0) {
    const lines = offenders.map((o) => `  - ${o.path} ${o.field}: '${o.role}'`).join('\n');
    throw new Error(
      `MEMORY_MAP references roles that don't exist on disk (${offenders.length} bad reference${offenders.length === 1 ? '' : 's'}):\n${lines}\n` +
      `Either add the missing prompt file at libs/papercusp/packages/harness/prompts/<role>.md, ` +
      `remove the attribution, or add the value to MEMORY_ATTRIBUTION_META if it's a non-role meta-actor.`,
    );
  }
})();

// Roles that should not appear in the chat-agent sidebar even though they
// have prompt files. `feedback` is ephemeral (one conversation, then exit) —
// there's nothing to chat with. Still listed in KNOWN_ROLES so the Prompts
// settings tab can show its global prompt.
const NON_CHAT_ROLES = new Set(['feedback']);

function promptsDir(project: ProjectEntry): string {
  return join(harnessDir(project), 'prompts');
}

function safeRole(role: string): string | null {
  if (!getKnownRoles().includes(role)) return null;
  return role;
}

harness.get('/:slug/prompts', async (c) => {
  const project = await resolvePhasedProject(c.req.param('slug'), phasePhaseLabel(c.req.query('phase')));
  if (!project) return c.json({ error: 'unknown project' }, 404);
  const dir = promptsDir(project);
  let overrides: string[] = [];
  try {
    if (existsSync(dir)) {
      overrides = readdirSync(dir)
        .filter((f) => f.endsWith('.md'))
        .map((f) => f.replace(/\.md$/, ''))
        .filter((r) => getKnownRoles().includes(r))
        .sort();
    }
  } catch {}
  return c.json({ roles: getKnownRoles(), overrides });
});

harness.get('/:slug/prompts/:role', async (c) => {
  const project = await resolvePhasedProject(c.req.param('slug'), phasePhaseLabel(c.req.query('phase')));
  if (!project) return c.json({ error: 'unknown project' }, 404);
  const role = safeRole(c.req.param('role'));
  if (!role) return c.json({ error: 'unknown role' }, 400);
  const overridePath = join(promptsDir(project), `${role}.md`);
  const globalPath = harnessPath('prompts', `${role}.md`);
  return c.json({
    role,
    content: safeRead(overridePath) ?? '',
    overrideExists: existsSync(overridePath),
    globalContent: safeRead(globalPath) ?? '',
  });
});

harness.put('/:slug/prompts/:role', async (c) => {
  const project = await resolvePhasedProject(c.req.param('slug'), phasePhaseLabel(c.req.query('phase')));
  if (!project) return c.json({ error: 'unknown project' }, 404);
  const role = safeRole(c.req.param('role'));
  if (!role) return c.json({ error: 'unknown role' }, 400);
  const body = await c.req.json().catch(() => ({}));
  if (typeof body.content !== 'string') return c.json({ error: 'content required' }, 400);

  const dir = promptsDir(project);
  if (!existsSync(dir)) {
    const { mkdir } = await import('node:fs/promises');
    await mkdir(dir, { recursive: true });
  }
  const overridePath = join(dir, `${role}.md`);
  await writeFile(overridePath, body.content, 'utf8');

  // Register the override in .harness/config.json so run.sh's invoke() picks
  // it up via promptOverrides[role] = "prompts/<role>.md"
  const configPath = join(harnessDir(project), 'config.json');
  let cfg: any = {};
  try { cfg = JSON.parse(readFileSync(configPath, 'utf8')); } catch {}
  if (!cfg.promptOverrides) cfg.promptOverrides = {};
  cfg.promptOverrides[role] = `prompts/${role}.md`;
  await writeFile(configPath, JSON.stringify(cfg, null, 2), 'utf8');

  return c.json({ ok: true, role });
});

harness.delete('/:slug/prompts/:role', async (c) => {
  const project = await resolvePhasedProject(c.req.param('slug'), phasePhaseLabel(c.req.query('phase')));
  if (!project) return c.json({ error: 'unknown project' }, 404);
  const role = safeRole(c.req.param('role'));
  if (!role) return c.json({ error: 'unknown role' }, 400);
  try { await unlink(join(promptsDir(project), `${role}.md`)); } catch {}

  // Un-register
  const configPath = join(harnessDir(project), 'config.json');
  let cfg: any = {};
  try { cfg = JSON.parse(readFileSync(configPath, 'utf8')); } catch {}
  if (cfg.promptOverrides && cfg.promptOverrides[role]) {
    delete cfg.promptOverrides[role];
    if (Object.keys(cfg.promptOverrides).length === 0) delete cfg.promptOverrides;
    await writeFile(configPath, JSON.stringify(cfg, null, 2), 'utf8');
  }
  return c.json({ ok: true });
});

// ─── Claude settings (.claude/settings.json) ─────────────────────────

function claudeSettingsPath(project: ProjectEntry): string {
  return join(project.path, '.claude', 'settings.json');
}

harness.get('/:slug/claude-settings', async (c) => {
  const slug = c.req.param('slug');
  const project = await resolvePhasedProject(slug, phasePhaseLabel(c.req.query('phase')));
  if (!project) return c.json({ error: 'unknown project' }, 404);
  // PG-canonical (Phase 0d). Disk fallback for harnesses pre-migration.
  const { loadTextArtifact } = await import('@/lib/text-artifacts');
  const fromPg = await loadTextArtifact(slug, 'claude-settings.json');
  return c.json({ content: fromPg ?? safeRead(claudeSettingsPath(project)) ?? '' });
});

harness.put('/:slug/claude-settings', async (c) => {
  const slug = c.req.param('slug');
  const project = await resolvePhasedProject(slug, phasePhaseLabel(c.req.query('phase')));
  if (!project) return c.json({ error: 'unknown project' }, 404);
  const body = await c.req.json().catch(() => ({}));
  if (typeof body.content !== 'string') return c.json({ error: 'content required' }, 400);
  if (body.content.trim()) {
    try { JSON.parse(body.content); }
    catch (e: any) { return c.json({ error: `invalid JSON: ${e.message}` }, 400); }
  }
  const path = claudeSettingsPath(project);
  const { saveTextArtifact } = await import('@/lib/text-artifacts');
  if (!body.content.trim()) {
    try { await unlink(path); } catch {}
    await saveTextArtifact(slug, 'claude-settings.json', '', { customDiskPath: path });
    return c.json({ ok: true, deleted: true });
  }
  // PG-canonical with custom mirror — .claude/settings.json lives at the
  // project root, not under .harness/.
  await saveTextArtifact(slug, 'claude-settings.json', body.content, { customDiskPath: path });
  return c.json({ ok: true });
});

// ─── .env (read+write, with explicit confirmation header) ────────────
//
// Secrets pass through the wire and sit in browser memory when this tab is
// open. The UI includes a prominent warning. Value masking happens client-side.

function envPath(project: ProjectEntry): string {
  return join(project.path, '.env');
}

harness.get('/:slug/env', async (c) => {
  const project = await resolvePhasedProject(c.req.param('slug'), phasePhaseLabel(c.req.query('phase')));
  if (!project) return c.json({ error: 'unknown project' }, 404);
  return c.json({ content: safeRead(envPath(project)) ?? '' });
});

harness.put('/:slug/env', async (c) => {
  const project = await resolvePhasedProject(c.req.param('slug'), phasePhaseLabel(c.req.query('phase')));
  if (!project) return c.json({ error: 'unknown project' }, 404);
  const confirm = c.req.header('x-confirm-secrets');
  if (confirm !== 'yes') return c.json({ error: 'missing X-Confirm-Secrets: yes header' }, 400);
  const body = await c.req.json().catch(() => ({}));
  if (typeof body.content !== 'string') return c.json({ error: 'content required' }, 400);
  await writeFile(envPath(project), body.content, 'utf8');
  return c.json({ ok: true });
});

// ─── Phases + promotion pipeline ─────────────────────────────────────

import { execFileSync } from 'node:child_process';

// Phase type imported from @/lib/harness-phases (above).
const PHASE_ORDER: Phase[] = [...ALL_PHASES];

interface PhaseInfo {
  phase: Phase;
  path: string;
  branch: string;
  port: number | null;
  publicUrl: string | null;
  exists: boolean;
  alive: boolean;
  passed: number;
  total: number;
  cost: number;
  iteration: number;
  promotionInFlight: string | null;
}

// phasePath, phasePhaseLabel, Phase moved to @/lib/harness-phases so the
// FS watcher can share the resolution logic. See import at top of file.

// Override existing resolveProject fetches so ?phase= can route to a sibling
// worktree. The cleanest backwards-compatible path is a helper that returns
// a "virtual project" pointing at the right worktree.
export async function resolvePhasedProject(slug: string, phase: Phase | undefined): Promise<ProjectEntry | null> {
  const base = await resolveProject(slug);
  if (!base) return null;
  if (!phase || phase === 'staging') return base;
  const p = phasePath(base, phase);
  return { ...base, path: p };
}

/**
 * One-shot scan of /proc for run.sh harness processes. Returns an array
 * of (pid, cwd) pairs we'd otherwise stat for each phase independently.
 * Called once per /phases request and reused across all phases —
 * `Promise.all([3 phases])` previously did this scan 3× in parallel and
 * dominated the endpoint's app-code time on busy hosts (1000+ PIDs).
 */
// 5-second cache for the /proc walk: even when pgrep is empty, the walk
// itself is the dominant cost on /phases. Walking /proc 3+ times per
// /phases request × multiple harness pages adds up. Cache for 5s — alive
// state needs to be near-real-time but not fresher than a few seconds.
type ScanCacheEntry = { ts: number; value: Array<{ pid: string; cwd: string }> };
const __scanCacheKey = '__papercuspRunShScanCache';
type ScanCacheGlobals = { [__scanCacheKey]?: ScanCacheEntry | null };
function scanRunShProcesses(): Array<{ pid: string; cwd: string }> {
  const g = globalThis as ScanCacheGlobals;
  const now = Date.now();
  const cached = g[__scanCacheKey];
  if (cached && now - cached.ts < 5000) return cached.value;

  const out: Array<{ pid: string; cwd: string }> = [];
  try {
    for (const pid of readdirSync('/proc')) {
      if (!/^\d+$/.test(pid)) continue;
      try {
        const cmdline = readFileSync(`/proc/${pid}/cmdline`, 'utf8');
        if (!cmdline.includes('autonomous-harness/run.sh') && !cmdline.includes('/harness/run.sh')) continue;
        const cwd = readFileSync(`/proc/${pid}/cwd`, 'utf8').trim();
        out.push({ pid, cwd });
      } catch { /* proc went away or unreadable — skip */ }
    }
  } catch {}
  g[__scanCacheKey] = { ts: now, value: out };
  return out;
}

async function computePhaseInfo(
  project: ProjectEntry,
  phase: Phase,
  runShProcs?: Array<{ pid: string; cwd: string }>,
  /** Pre-fetched features for this slug. parseFeatures takes seconds in
   *  Next.js dev under load (per-harness PG pool max=1, queries serialize
   *  when the same slug is asked across phases). Hoist the fetch to the
   *  caller (single fetch shared across all phases) to cut /phases time
   *  by ~3×. See /docs/performance #A2/#A15. */
  preFetchedFeatures?: Array<{ status?: string }>,
): Promise<PhaseInfo> {
  const path = phasePath(project, phase);
  const branch = phase === 'staging'
    ? (safeRead(join(project.path, '.git', 'HEAD'))?.trim().replace(/^ref: refs\/heads\//, '') ?? 'main')
    : phase;
  const scopedProject: ProjectEntry = { ...project, path };
  const exists = existsSync(path);

  let port: number | null = null;
  let publicUrl: string | null = null;
  try {
    const raw = safeRead(join(project.path, '.harness', 'config.json'));
    if (raw) {
      const cfg = JSON.parse(raw);
      const p = cfg?.phases?.[phase]?.port;
      if (typeof p === 'number') port = p;
      const u = cfg?.phases?.[phase]?.publicUrl;
      if (typeof u === 'string' && u.length > 0) publicUrl = u;
    }
  } catch {}

  if (!exists) {
    return { phase, path, branch, port, publicUrl, exists: false, alive: false, passed: 0, total: 0, cost: 0, iteration: 0, promotionInFlight: null };
  }

  // Features: use pre-fetched if caller passed them (the /phases handler
  // does this — same slug, same data, no need to re-query per phase).
  const feats = preFetchedFeatures ?? await parseFeatures(scopedProject);
  const counts = feats.reduce((a: Record<string, number>, f) => { a[f.status ?? ''] = (a[f.status ?? ''] ?? 0) + 1; return a; }, {} as Record<string, number>);
  const passed = counts.passed ?? 0;
  const total = feats.length;

  // cost via the shared cached helper (same as /status uses).
  const cost = aggregateCostFromLogDir(join(path, '.harness', 'logs')).cost;

  // iteration = total pulses across all run.sh invocations.
  const iteration = countPulsesFromRunLog(join(path, '.harness', 'logs', 'run.log'));

  // alive: any pre-scanned run.sh proc whose cwd lies under this phase's path.
  const procs = runShProcs ?? scanRunShProcesses();
  const alive = procs.some((p) => p.cwd.startsWith(path));

  // promotion in-flight = any unresolved Promotion item in pending-reviews
  let promotionInFlight: string | null = null;
  try {
    const pr = join(path, '.harness', 'pending-reviews');
    if (existsSync(pr)) {
      for (const f of readdirSync(pr)) {
        if (!f.endsWith('.json')) continue;
        try {
          const obj = JSON.parse(readFileSync(join(pr, f), 'utf8'));
          if (obj.kind === 'promotion' && !obj.resolved) {
            promotionInFlight = obj.id;
            break;
          }
        } catch {}
      }
    }
  } catch {}

  return { phase, path, branch, port, publicUrl, exists, alive, passed, total, cost, iteration, promotionInFlight };
}

harness.get('/:slug/phases', async (c) => {
  const project = await resolvePhasedProject(c.req.param('slug'), phasePhaseLabel(c.req.query('phase')));
  if (!project) return c.json({ error: 'unknown project' }, 404);
  // Pre-fetch features ONCE (the slug is the same across all 3 phases —
  // querying 3× was costing 3× the per-harness PG pool's serialization
  // latency, ~15s on a busy day). Pre-scan procs ONCE (same logic).
  // See /docs/performance #A2 + #A15.
  const runShProcs = scanRunShProcesses();
  const features = await parseFeatures(project);
  const out = await Promise.all(PHASE_ORDER.map((p) => computePhaseInfo(project, p, runShProcs, features)));
  return c.json({ phases: out });
});

harness.post('/:slug/phases/setup', async (c) => {
  const project = await resolvePhasedProject(c.req.param('slug'), phasePhaseLabel(c.req.query('phase')));
  if (!project) return c.json({ error: 'unknown project' }, 404);
  const script = harnessPath('bin', 'setup-phases.sh');
  if (!existsSync(script)) return c.json({ error: 'setup-phases.sh missing' }, 500);
  try {
    const out = execFileSync('bash', [script, project.path], { encoding: 'utf8', timeout: 30_000 });
    return c.json({ ok: true, output: out });
  } catch (e: any) {
    return c.json({ error: String(e?.stderr ?? e?.message ?? e) }, 500);
  }
});

// Promotion — create a pending review in the `from` worktree.
harness.post('/:slug/promote', async (c) => {
  const project = await resolvePhasedProject(c.req.param('slug'), phasePhaseLabel(c.req.query('phase')));
  if (!project) return c.json({ error: 'unknown project' }, 404);
  const body = await c.req.json() as { from?: string; to?: string };
  const from = phasePhaseLabel(body.from);
  const to = phasePhaseLabel(body.to);
  if (from === to) return c.json({ error: 'from and to must differ' }, 400);

  const fromPath = phasePath(project, from);
  const toPath = phasePath(project, to);
  if (!existsSync(fromPath)) return c.json({ error: `worktree missing for ${from}` }, 400);
  if (!existsSync(toPath)) return c.json({ error: `worktree missing for ${to} — run /phases/setup` }, 400);

  const ts = Math.floor(Date.now() / 1000);
  const id = `promotion-${ts}-${from}-to-${to}`;
  const reviewsDir = join(fromPath, '.harness', 'pending-reviews');
  await mkdir(reviewsDir, { recursive: true });

  // Read existing criteria default from config.json if present
  let criteria: Record<string, unknown> = {
    allFeaturesPassed: true,
    noOpenReviews: true,
  };
  try {
    const cfgRaw = safeRead(join(project.path, '.harness', 'config.json'));
    if (cfgRaw) {
      const cfg = JSON.parse(cfgRaw);
      const key = `${from}_to_${to}`;
      const override = cfg?.promotion?.[key]?.criteria;
      if (override && typeof override === 'object') criteria = override;
    }
  } catch {}

  const item = {
    id,
    kind: 'promotion',
    from, to,
    criteria,
    status: 'feature-freeze',
    readinessScore: 0,
    readinessSummary: 'Freeze just initiated. Orchestrator updates this on each loop.',
    summary: `Promote ${from} → ${to}`,
    question: `Confirm promotion of ${from} branch into ${to} once criteria pass.`,
    ts,
    resolved: false,
  };
  // PG-canonical INSERT into harness_shared.pending_reviews. Watcher
  // would mirror disk → PG anyway; going direct skips the intermediate
  // file + watcher debounce. The file is also written below for back-
  // compat with bash run.sh's pre-loop scanner that reads pending-reviews/.
  {
    const { sql } = (await import('@restart/db-org')).getOrgPg();
    const tsMs = ts * 1000;
    await sql`
      INSERT INTO harness_shared.pending_reviews
        (harness_slug, phase, review_id, feature_id, kind, payload, ts, mtime_ms, workspace_id, resolved)
      VALUES (
        ${project.slug}, ${from}, ${id}, NULL, 'promotion',
        ${JSON.stringify(item)}, ${tsMs}, ${tsMs}, ${activeWorkspaceId()}, false
      )
      ON CONFLICT (harness_slug, phase, review_id) DO UPDATE
        SET payload  = EXCLUDED.payload,
            mtime_ms = EXCLUDED.mtime_ms,
            resolved = false
    `;
    void notifySyncInvalidate('pendingReviews.byHarness', { harnessSlug: project.slug });
  }
  await writeFile(join(reviewsDir, `${id}.json`), JSON.stringify(item, null, 2), 'utf8');

  // Signal the orchestrator via supervisor-notes.md
  const notesPath = join(fromPath, '.harness', 'supervisor-notes.md');
  const block = `\n## promotion ${new Date().toISOString()}\n\nFeature freeze initiated. Only process failing features. Emit promotion-handoff.md when all features passed.\nPromotion item: ${id}\n`;
  await appendFile(notesPath, block, 'utf8');

  return c.json({ ok: true, item });
});

harness.post('/:slug/promote/:id/confirm', async (c) => {
  const project = await resolvePhasedProject(c.req.param('slug'), phasePhaseLabel(c.req.query('phase')));
  if (!project) return c.json({ error: 'unknown project' }, 404);
  const id = c.req.param('id').replace(/[^A-Za-z0-9_.-]/g, '');

  // Find the promotion item in any of the phase worktrees' pending-reviews
  let found: { path: string; obj: any } | null = null;
  for (const phase of PHASE_ORDER) {
    const p = phasePath(project, phase);
    const f = join(p, '.harness', 'pending-reviews', `${id}.json`);
    const raw = safeRead(f);
    if (raw) { found = { path: f, obj: JSON.parse(raw) }; break; }
  }
  if (!found) return c.json({ error: 'promotion not found' }, 404);

  const { obj } = found;
  if (obj.kind !== 'promotion') return c.json({ error: 'not a promotion item' }, 400);
  if (obj.resolved) return c.json({ error: 'already resolved' }, 409);

  const from = phasePhaseLabel(obj.from);
  const to = phasePhaseLabel(obj.to);
  const fromPath = phasePath(project, from);
  const toPath = phasePath(project, to);
  const fromBranch = from === 'staging' ? 'main' : from;
  const toBranch = to === 'staging' ? 'main' : to;

  // Execute the merge
  try {
    execFileSync('git', ['-C', toPath, 'fetch', project.path, fromBranch], { encoding: 'utf8' });
    execFileSync('git', ['-C', toPath, 'merge', '--ff-only', `FETCH_HEAD`], { encoding: 'utf8' });
  } catch (e: any) {
    // Fall back: non-FF merge
    try {
      execFileSync('git', ['-C', toPath, 'merge', '--no-edit', fromBranch], { encoding: 'utf8' });
    } catch (e2: any) {
      return c.json({ error: `merge failed: ${String(e2?.stderr ?? e2?.message ?? e2)}` }, 500);
    }
  }

  // Layer 3 — pre-handoff smoke-build. Auto-enabled when the harness has
  // declared an infra-contract.json (signal that build-pipeline integrity
  // matters here). Opt out via .harness/config.json `promotion.smokeBuild.enabled: false`.
  // On failure, reset the destination worktree back to ORIG_HEAD (git's
  // auto-saved pre-merge SHA), create a fix-the-build feature tagged
  // kind='infra', and reject the promotion. Substrate-level safety net
  // for what scoper + infra-reviewer might miss at planning time.
  let smokeEnabled = false;
  try {
    const cfgRaw = safeRead(join(project.path, '.harness', 'config.json'));
    const cfg = cfgRaw ? JSON.parse(cfgRaw) : null;
    const explicit = cfg?.promotion?.smokeBuild?.enabled;
    if (typeof explicit === 'boolean') smokeEnabled = explicit;
    else smokeEnabled = existsSync(join(project.path, '.harness', 'infra-contract.json'));
  } catch { /* fall through with smokeEnabled=false */ }

  if (smokeEnabled) {
    try {
      const { runAction, listActions } = await import('@/lib/branch-actions');
      const harnessConfigsDir = papercuspPath('harnesses', project.slug);
      const globalPluginsDir = papercuspPath('global-plugins');
      // Pick the build action for the destination branch.
      const candidates = await listActions(project.path, to as 'staging' | 'testing' | 'production', {
        harnessConfigsDir, globalPluginsDir,
      });
      const buildAction = candidates.find((a) => a.name === 'build') ?? candidates[0];
      if (buildAction) {
        const handle = await runAction({
          stagingPath: project.path,
          phasePath: toPath,
          harness: project.slug,
          branch: to as 'staging' | 'testing' | 'production',
          name: buildAction.name,
          harnessConfigsDir, globalPluginsDir,
          skipEnvCheck: true,  // promotion shouldn't be blocked on missing keys; the run itself reports the failure
        });
        const meta = await handle.done;
        if (meta.status !== 'completed') {
          // Smoke failed — revert the merge in the destination worktree.
          try {
            execFileSync('git', ['-C', toPath, 'reset', '--hard', 'ORIG_HEAD'], { encoding: 'utf8' });
          } catch { /* reset failure is observable in the dest worktree's git status — log to user */ }
          // Best-effort: create a fix-the-build feature in the source phase
          // so the orchestrator knows what's blocking promotion.
          try {
            const dbcSlug = dbcFor(project.slug);
            const fid = `F-INFRA-FIX-PROMOTION-${Math.floor(Date.now() / 1000)}`;
            const tail = (() => {
              try {
                const log = safeRead(join(buildAction.scriptPath.replace(/\/[^/]+$/, ''), '..', '..', 'action-runs', to, buildAction.name, `${meta.runId}.log`));
                return (log ?? '').split('\n').slice(-30).join('\n').slice(0, 2000);
              } catch { return '(see action-runs log)'; }
            })();
            await dbcSlug.prepare(`
              INSERT INTO harness_features (harness_slug, feature_id, title, summary, status, attempts, kind, metadata, ts, created_ts, updated_ts)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `).run(
              project.slug, fid,
              `Fix broken build before re-promoting ${from} → ${to}`,
              `The destination worktree's build script failed during promotion (runId=${meta.runId}, exit=${meta.exitCode ?? '?'}, dur=${meta.durationMs ?? 0}ms). Last log lines:\n\n\`\`\`\n${tail}\n\`\`\`\n\nThe merge has been reverted. Fix the build on the ${from} branch (or update the build script accordingly) and re-attempt promotion.`,
              'todo',
              0,
              'infra',
              JSON.stringify({ proposed_by: 'promotion-smoke-build', smoke_run_id: meta.runId, blocked_promotion: id }),
              Date.now(), Date.now(), Date.now(),
            );
          } catch { /* feature creation is best-effort */ }

          return c.json({
            error: 'smoke-build failed',
            runId: meta.runId,
            exitCode: meta.exitCode,
            reverted: true,
            message: `The build for ${to} did not pass post-merge. The merge has been reverted; a fix-the-build feature was created. See OperatorActionLog for the run.`,
          }, 422);
        }
      }
      // No build action declared → silently skip; smoke-build only matters
      // when there's something to smoke.
    } catch (e) {
      // Smoke-build infrastructure failed (e.g. branch-actions module missing).
      // Don't block the promotion on infra issues with the smoke runner itself
      // — the merge succeeded, the user can deal with build issues separately.
      // (We don't return an error here because that would be more disruptive
      // than just letting the promotion proceed without the safety net.)
      console.warn(`[promotion] smoke-build skipped due to error: ${(e as Error).message}`);
    }
  }

  // Record promotion in PG (replaces per-worktree promotion-log.json).
  let newSha = '';
  try { newSha = execFileSync('git', ['-C', toPath, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(); } catch {}
  {
    const { ensureHarnessPromotionsTable } = await import('@/lib/ensure-schema');
    await ensureHarnessPromotionsTable();
    const { sql } = (await import('@restart/db-org')).getOrgPg();
    await sql`
      INSERT INTO harness_shared.harness_promotions
        (workspace_id, harness_slug, promotion_id, from_phase, to_phase, sha, ts)
      VALUES (
        ${activeWorkspaceId()}, ${project.slug}, ${obj.id}, ${from}, ${to},
        ${newSha || null}, ${Math.floor(Date.now() / 1000)}
      )
      ON CONFLICT (workspace_id, harness_slug, promotion_id) DO NOTHING
    `;
  }

  // Seed promotion-handoff.md in the dest from the source's validation-contract.md + features.
  try {
    const contract = safeRead(join(fromPath, '.harness', 'validation-contract.md')) ?? '';
    const feats = await parseFeatures({ ...project, path: fromPath });
    const passed = feats.filter((f: any) => f.status === 'passed');
    const handoff = [
      `# Promotion handoff: ${from} → ${to}`,
      ``,
      `Handed off at ${new Date().toISOString()}.`,
      ``,
      `## Features that passed in ${from}`,
      '',
      ...passed.map((f: any) => `- \`${f.id}\` — ${f.summary ?? f.title}`),
      ``,
      `## Validation contract (authoritative for this phase)`,
      ``,
      contract,
    ].join('\n');
    await writeFile(join(toPath, '.harness', 'promotion-handoff.md'), handoff, 'utf8');
  } catch {}

  // Mark the promotion item resolved (in-place where we found it)
  obj.resolved = true;
  obj.status = 'promoted';
  await writeFile(found.path, JSON.stringify(obj, null, 2), 'utf8');

  return c.json({ ok: true, sha: newSha, promotion: obj });
});

harness.post('/:slug/rollback', async (c) => {
  const project = await resolvePhasedProject(c.req.param('slug'), phasePhaseLabel(c.req.query('phase')));
  if (!project) return c.json({ error: 'unknown project' }, 404);
  const body = await c.req.json() as { phase?: string };
  const phase = phasePhaseLabel(body.phase);
  const path = phasePath(project, phase);
  if (!existsSync(path)) return c.json({ error: `no worktree for ${phase}` }, 400);

  // Read promotion history from PG, ordered most-recent first; need at
  // least two records so we can roll back to the second-most-recent SHA.
  // (Records are scoped to the destination phase: a rollback in 'production'
  // rewinds 'production' to the previous production SHA.)
  const { ensureHarnessPromotionsTable } = await import('@/lib/ensure-schema');
  await ensureHarnessPromotionsTable();
  const { sql } = (await import('@restart/db-org')).getOrgPg();
  const promotions = await sql<Array<{ promotion_id: string; sha: string | null; ts: number | bigint }>>`
    SELECT promotion_id, sha, ts FROM harness_shared.harness_promotions
     WHERE workspace_id = ${activeWorkspaceId()}
       AND harness_slug = ${project.slug}
       AND to_phase     = ${phase}
     ORDER BY ts DESC
     LIMIT 10
  `;
  if (promotions.length < 2) return c.json({ error: 'no previous promotion to roll back to' }, 400);
  const prior = promotions[1]; // [0] is the current promotion; [1] is the one we want
  if (!prior.sha) return c.json({ error: 'previous promotion has no sha' }, 400);

  try {
    execFileSync('git', ['-C', path, 'reset', '--hard', prior.sha], { encoding: 'utf8' });
  } catch (e: any) {
    return c.json({ error: `rollback failed: ${String(e?.stderr ?? e?.message ?? e)}` }, 500);
  }

  // Record the rollback as its own promotion row (sha = the SHA we
  // rolled back TO; from_phase == to_phase == phase). Future rollbacks
  // will see this in the history.
  await sql`
    INSERT INTO harness_shared.harness_promotions
      (workspace_id, harness_slug, promotion_id, from_phase, to_phase, sha, ts)
    VALUES (
      ${activeWorkspaceId()}, ${project.slug}, ${`rollback-${Date.now()}`},
      ${phase}, ${phase}, ${prior.sha}, ${Math.floor(Date.now() / 1000)}
    )
  `;

  return c.json({ ok: true, rolledBackTo: prior.sha });
});

// ─── Tests — first-class items ───────────────────────────────────────

interface TestItem {
  id: string;
  summary: string;
  file: string;
  framework: 'playwright' | 'vitest' | 'pytest';
  coversVALs: string[];
  status: 'passing' | 'failing' | 'skipped' | 'not_run';
  lastRunTs: number;
  durationMs: number;
  phase: Phase;
  kind?: 'contract' | 'edge';
}

function readTests(project: ProjectEntry, phase: Phase): TestItem[] {
  const p = phasePath(project, phase);
  const f = join(p, '.harness', 'tests.json');
  const raw = safeRead(f);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return parsed.tests ?? [];
  } catch { return []; }
}

async function writeTests(project: ProjectEntry, phase: Phase, tests: TestItem[]): Promise<void> {
  const p = phasePath(project, phase);
  const dir = join(p, '.harness');
  await mkdir(dir, { recursive: true });
  const f = join(dir, 'tests.json');
  const tmp = `${f}.tmp.${Date.now()}`;
  await writeFile(tmp, JSON.stringify({ tests }, null, 2), 'utf8');
  await rename(tmp, f);
}

harness.get('/:slug/tests', async (c) => {
  const project = await resolvePhasedProject(c.req.param('slug'), phasePhaseLabel(c.req.query('phase')));
  if (!project) return c.json({ error: 'unknown project' }, 404);
  const phase = phasePhaseLabel(c.req.query('phase'));
  return c.json({ tests: readTests(project, phase), phase });
});

harness.post('/:slug/tests/:id/run', async (c) => {
  const project = await resolvePhasedProject(c.req.param('slug'), phasePhaseLabel(c.req.query('phase')));
  if (!project) return c.json({ error: 'unknown project' }, 404);
  const phase = phasePhaseLabel(c.req.query('phase'));
  const id = c.req.param('id').replace(/[^A-Za-z0-9_.-]/g, '');
  const tests = readTests(project, phase);
  const t = tests.find((x) => x.id === id);
  if (!t) return c.json({ error: 'test not found' }, 404);

  const wtPath = phasePath(project, phase);
  const started = Date.now();
  let ok = false;
  let output = '';
  try {
    const cmd =
      t.framework === 'playwright' ? ['npx', ['playwright', 'test', t.file]]
      : t.framework === 'vitest'   ? ['npx', ['vitest', 'run', t.file]]
      :                              ['pytest', [t.file]];
    const [bin, args] = cmd as [string, string[]];
    output = execFileSync(bin, args, { cwd: wtPath, encoding: 'utf8', timeout: 120_000, stdio: ['ignore', 'pipe', 'pipe'] });
    ok = true;
  } catch (e: any) {
    output = String(e?.stdout ?? '') + String(e?.stderr ?? '');
    ok = false;
  }
  const durationMs = Date.now() - started;
  t.status = ok ? 'passing' : 'failing';
  t.lastRunTs = Math.floor(Date.now() / 1000);
  t.durationMs = durationMs;
  await writeTests(project, phase, tests);

  return c.json({ ok, test: t, output: output.slice(-4000) });
});
