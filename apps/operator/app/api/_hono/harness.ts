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
import { sseResponse } from '@restart/sse';
// Side-effect: registers architect:chat + brainstorm:chat etc. so the
// projected-tool catch-all at /api/agent-tools/[...path] can resolve
// them. The 2 Hono shims at /:slug/architect/chat and
// /:slug/brainstorm/chat were retired in Phase 4 T1.2; consumers
// (useHarnessChatRuntime) now POST the projected URL directly with
// harnessSlug in the body.
import '@/lib/agent-tools/index';
import { readFileSync, readlinkSync, existsSync, readdirSync, statSync, openSync, readSync, closeSync, constants as fsConstants } from 'node:fs';
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
import { harnessPackageDir, harnessPath, orchestratorRunBin, tsxBin } from '@/lib/harness-paths';
import { firePluginLifecycle, firePluginEvent } from '../../../lib/plugin-host-runtime';
import { spawn, execFile } from 'node:child_process';
import { runAgentChat } from '@/lib/agent-chat-stream';
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
import {
  countPulsesFromRunLog,
  aggregateCostFromLogDir,
  resolveProject,
  harnessDir,
  safeRead,
  isHarnessDriverCmdline,
  isProjectAlive,
  parseFeatures,
  tailFile,
  resolvePhasedProject,
  getHarnessStatusFull,
  rowToFeature,
} from '@/lib/harness-core';
const getOrgDbClient = () => getLegacyClient();
const dbcFor = (slug: string) => getLegacyClient(slug);

const execFileP = promisify(execFile);

import { papercuspRoot } from '@/lib/papercusp-root';
import { getHarnessAdminUrl } from '@/lib/embedded-pg-discovery';
import {
  loadHarnessRegistry,
  saveHarnessRegistry,
  type HarnessRegistry as RegistryFile,
  type ProjectEntry,
} from '@/lib/harness-registry';


// Single source of truth: harness_shared.harness_registry (PG).
// Per-workspace scoping via the workspace_id PK column.
const loadRegistry = loadHarnessRegistry;
const saveRegistry = saveHarnessRegistry;




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
      await db.insert(generated.featureAuditConsolidatedInHarnessShared).values({
        workspaceId: ws,
        harnessSlug: harnessSlug,
        featureId: featureId,
        ts: Date.now(),
        field,
        oldValue: oldValue === undefined ? null : JSON.stringify(oldValue),
        newValue: newValue === undefined ? null : JSON.stringify(newValue),
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
  const cmd = `nohup node ${tsxBin()} ${orchBin} >> ${logPath} 2>&1 &`;

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
      // PG is the canonical feature store. Without this, the
      // orchestrator's in-memory fallback (designed for tests) yields
      // an empty store, pre-loop's featuresExist() returns false, and
      // the scoper-gate fails on every launch even though PG has the
      // feature queue.
      PAPERCUSP_USE_PG_STATE: '1',
      // spawn-mcp reads DATABASE_URL (or PAPERCUSP_PG_DSN) to load its
      // signing key from harness_shared.operator_secrets. Without it,
      // every tool invocation hits "no PG DSN in env" and the
      // orchestrator hits no-tools, decides it can't do anything, and
      // immediately escalates. We use the operator's own resolved
      // admin URL (env → discovery file → native fallback) so the
      // spawned orchestrator hits the exact same Postgres the operator
      // uses, not a stale hardcoded default.
      DATABASE_URL: getHarnessAdminUrl(),
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

  return sseResponse({
    signal: c.req.raw.signal,
    // Lib's heartbeat replaces the prior 2s 'ping' keepalive loop. 15s is
    // the spec-default for SSE keepalive and matches the rest of the app.
    heartbeatMs: 15_000,
    setup: async (sink) => {
      const token: StreamToken = {
        abort: () => { sink.close(); },
        createdAt: Date.now(),
        remoteIP,
        slug: project.slug,
      };
      activeStreams.set(streamKey, token);
      sink.onClose(() => {
        if (activeStreams.get(streamKey) === token) activeStreams.delete(streamKey);
      });

      let lineBuf = '';
      let done = false;

      const emitChunk = (chunk: string) => {
        lineBuf += chunk;
        let nl: number;
        while ((nl = lineBuf.indexOf('\n')) !== -1) {
          const line = lineBuf.slice(0, nl).trim();
          lineBuf = lineBuf.slice(nl + 1);
          if (!line) continue;
          const entries = parseLine(line);
          for (const e of entries) {
            sink.event('event', e);
            if (e.kind === 'result') {
              done = true;
              sink.event('done', {});
              sink.close();
              return;
            }
          }
        }
      };

      // Backfill: prefer PG-canonical jsonl_body from harness_run_output
      // (Phase 4); fall back to disk for runs that completed before
      // activation or in CLI-only mode.
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
        sink.event('backfill', capped);
        if (done) { sink.event('done', {}); sink.close(); return; }
      } else {
        sink.event('backfill', []);
      }

      // Live mode: in-process bus only. Orchestrator's invoke.ts POSTs
      // each subprocess stdout chunk to /api/internal/run-chunk, which
      // publishes to the per-run channel; this subscriber emits one
      // SSE event per parsed line.
      const { subscribe: busSubscribe } = await import('@/lib/run-chunk-bus');
      const channelKey = `${project.slug}:${runId}`;
      const busSub = busSubscribe(channelKey, (env) => {
        if (sink.closed) return;
        emitChunk(env.data);
      });
      // Replay anything in the recent ring buffer (subscriber joined
      // after publishing started).
      for (const env of busSub.recent) {
        emitChunk(env.data);
        if (sink.closed) break;
      }
      // When the bus signals done, propagate to the SSE client.
      void busSub.whenDone.then(() => {
        if (!done && !sink.closed) {
          done = true;
          sink.event('done', {});
          sink.close();
        }
      });
      sink.onClose(() => busSub.unsubscribe());
    },
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
      id?: string;
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
  // Allocate ids for any feature missing one (F-AUTO-{ts}{rand}, mirroring
  // doCreateFeature's autogen format so promote-style bulk imports can omit
  // ids and let the server allocate). The allocated ids are returned to
  // the caller so plans:promote can map them back to plan items.
  const allocatedIds: string[] = [];
  const features = body.features.map((raw) => {
    if (raw.id && raw.id.length > 0) {
      allocatedIds.push(raw.id);
      return raw as typeof raw & { id: string };
    }
    const ts = Date.now().toString(36).toUpperCase();
    const rand = Math.random().toString(36).slice(2, 6).toUpperCase();
    const id = `F-AUTO-${ts}${rand}`;
    allocatedIds.push(id);
    return { ...raw, id };
  });
  const invalid = features.find((f) => !FEATURE_ID_RE.test(f.id) || !f.title);
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
  return c.json({
    ok: true,
    inserted,
    updated,
    total: features.length,
    skippedKindMismatch,
    ids: allocatedIds,
  });
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

  return sseResponse({
    signal: c.req.raw.signal,
    heartbeatMs: 15_000,
    setup: async (sink) => {
      const token: StreamToken = {
        abort: () => { sink.close(); },
        createdAt: Date.now(),
        remoteIP,
        slug: project.slug,
      };
      activeStreams.set(streamKey, token);
      sink.onClose(() => {
        if (activeStreams.get(streamKey) === token) activeStreams.delete(streamKey);
      });

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
        if (chunk) sink.eventRaw('log', chunk);
      } catch { /* no log file yet */ }

      const { subscribe: logSubscribe } = await import('@/lib/harness-log-bus');
      const sub = logSubscribe(`${project.slug}:raw`, (env) => {
        if (sink.closed) return;
        sink.eventRaw('log', env.line + '\n');
      });
      // Replay recent ring (small; pre-backfill covers history).
      for (const env of sub.recent) {
        if (sink.closed) break;
        sink.eventRaw('log', env.line + '\n');
      }
      sink.onClose(() => sub.unsubscribe());

      // Features come from PG (parseFeatures) — still polled because
      // they're not in the bus today. 3s cadence; loop ends when sink closes.
      const pushFeatures = async () => {
        if (sink.closed) return;
        const feats = await parseFeatures(project);
        const state = JSON.stringify(feats.map((f) => [f.id, f.status, f.attempts]));
        if (state !== lastFeatureState) {
          lastFeatureState = state;
          sink.event('features', feats);
        }
      };
      while (!sink.closed) {
        await pushFeatures();
        if (sink.closed) break;
        await new Promise((r) => setTimeout(r, 3000));
      }
    },
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

  return sseResponse({
    signal: c.req.raw.signal,
    // Lib heartbeat replaces the prior 15s 'ping' keepalive loop.
    heartbeatMs: 15_000,
    setup: async (sink) => {
      const token: StreamToken = {
        abort: () => { sink.close(); },
        createdAt: Date.now(),
        remoteIP,
        slug: project.slug,
      };
      activeStreams.set(streamKey, token);
      sink.onClose(() => {
        if (activeStreams.get(streamKey) === token) activeStreams.delete(streamKey);
      });

      // Backfill: read the tail of the file and replay the last N lines.
      // Reads only the last 1 MiB (not the whole file) to keep cold
      // reconnect under ~1s even on a 50 MiB log. sink.eventRaw skips
      // JSON.stringify since the JSONL line is already a JSON string.
      try {
        const stat = statSync(jsonlPath);
        const tailBytes = 1024 * 1024;
        const start = Math.max(0, stat.size - tailBytes);
        const len = stat.size - start;
        const buf = Buffer.alloc(len);
        const fd = openSync(jsonlPath, 'r');
        try { readSync(fd, buf, 0, len, start); }
        finally { closeSync(fd); }
        let chunk = buf.toString('utf8');
        if (start > 0) {
          const firstNl = chunk.indexOf('\n');
          if (firstNl >= 0) chunk = chunk.slice(firstNl + 1);
        }
        const allLines = chunk.split('\n').filter(Boolean);
        const toReplay = allLines.slice(-tailSize);
        let count = 0;
        for (const raw of toReplay) {
          if (sink.closed) break;
          try { JSON.parse(raw); }
          catch { continue; /* skip malformed */ }
          sink.eventRaw('log', raw);
          count++;
        }
        sink.eventRaw('backfill-done', String(count));
      } catch {
        sink.eventRaw('backfill-done', '0');
      }

      // Live updates from the in-process log bus.
      const { subscribe: logSubscribe } = await import('@/lib/harness-log-bus');
      const sub = logSubscribe(`${project.slug}:log`, (env) => {
        if (sink.closed) return;
        try { JSON.parse(env.line); }
        catch { return; }
        sink.eventRaw('log', env.line);
      });
      // Replay recent ring entries that landed between backfill and subscribe.
      for (const env of sub.recent) {
        if (sink.closed) break;
        try { JSON.parse(env.line); }
        catch { continue; }
        sink.eventRaw('log', env.line);
      }
      sink.onClose(() => sub.unsubscribe());
    },
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



/**
 * Item 0 + 10: list features awaiting human review across all harnesses.
 * Returns features where needs_human_review=true, with their linked project
 * info (so the UI can show budget context for adjustment).
 */

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

/**
 * Item 8: per-project stats. Returns features grouped by status + per-dept
 * breakdown (counts and committed cost), plus the budget summary.
 */

/**
 * Layer A audit: feature change history (compensates for git-history loss
 * when features moved from JSON to SQL). Returns chronological log of
 * mutations to a feature.
 */


// SSE: emit 'change' on logs/run.log mtime/size shifts (decisions are
// derived from the tail of run.log).



// ─── product proposals ─────────────────────────────────────────────────


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
  // Two modes, distinguished by `{overwrite: true}` in the body:
  //   default — non-destructive: scoper MODE=replan as a background
  //     invocation. Delta-merges new SPEC.md bullets into the existing
  //     queue. Completion observable via /scoper-result/<invocationId>.
  //   overwrite — destructive: wipe features (PG) + validation-contract.md
  //     (file), then invoke scoper MODE=initial inline. Used by the
  //     proposals "Replan now" flow after the user accepts bullets that
  //     materially reshape the spec.
  const body = await c.req.json().catch(() => ({})) as { overwrite?: boolean };
  if (!body.overwrite) {
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
  }

  // Destructive path: wipe features in PG (with snapshot), move
  // validation-contract.md to a backup dir, then invoke scoper
  // MODE=initial inline (MAX_ITERATIONS=0 skips the orchestration loop).
  const specPath = join(project.path, 'SPEC.md');
  if (!existsSync(specPath)) return c.json({ error: 'SPEC.md not found' }, 400);
  const contractPath = join(harnessDir(project), 'validation-contract.md');

  await mkdir(harnessDir(project), { recursive: true });
  const backupDir = join(harnessDir(project), `.replan-backup-${Date.now()}`);
  await mkdir(backupDir, { recursive: true });
  for (const f of STATE_FILES_FOR_BACKUP) {
    const p = join(harnessDir(project), f);
    if (existsSync(p)) {
      const { rename } = await import('node:fs/promises');
      await rename(p, join(backupDir, f));
    }
  }
  try {
    const prior = await parseFeatures(project);
    if (prior.length > 0) {
      const { writeFile } = await import('node:fs/promises');
      await writeFile(join(backupDir, 'features.pg.json'), JSON.stringify(prior, null, 2));
      const dbc = dbcFor(project.slug);
      await dbc.prepare('DELETE FROM harness_features WHERE harness_slug = ?').run(project.slug);
    }
  } catch (e: any) {
    console.warn('[replan] PG feature clear failed:', e?.message ?? e);
  }

  const orchBin = orchestratorRunBin();
  const logPath = `/tmp/harness-replan-${project.slug}.log`;
  return new Promise((resolve) => {
    const { execFile } = require('node:child_process');
    execFile('bash', ['-c', `MAX_ITERATIONS=0 node ${tsxBin()} ${orchBin} >> ${logPath} 2>&1; echo "DONE rc=$?"`], {
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
    }, async (err: any, stdout: string, stderr: string) => {
      const produced = (await parseFeatures(project)).length > 0 && existsSync(contractPath);
      if (err && !produced) {
        resolve(c.json({ ok: false, error: String(err.message || err).slice(0, 400), stderr, logPath }, 500));
        return;
      }
      resolve(c.json({ ok: true, mode: 'initial', produced, logPath, stdout: stdout.slice(-2048), stderr: stderr.slice(-1024), backupDir }));
    });
  }) as Promise<Response>;
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
        // Remove validation-contract.md, issues.md, worker-log.md,
        // escalation.md, supervisor-notes.md, lanes.json, prs.json, logs/*, snapshots/*,
        // screenshots/*. Keep config.json, hooks/, knowledge.md, archives/.
        // features.json is in the list for legacy harnesses but features
        // moved to PG in 2026-04-26; we also DELETE from harness_features below.
        for (const f of STATE_FILES_FOR_RESET) {
          try { await unlink(join(dir, f)); resetRemoved.push(f); } catch {}
        }
        const { rm } = await import('node:fs/promises');
        for (const d of ['logs', 'snapshots', 'screenshots']) {
          try { await rm(join(dir, d), { recursive: true, force: true }); resetRemoved.push(`${d}/`); } catch {}
        }
        try {
          const dbc = dbcFor(project.slug);
          await dbc.prepare('DELETE FROM harness_features WHERE harness_slug = ?').run(project.slug);
          resetRemoved.push('harness_features (PG)');
        } catch (e: any) {
          console.warn('[archive-reset] PG features clear failed:', e?.message ?? e);
        }
      }
      let sizeBytes = 0;
      try { sizeBytes = statSync(archivePath).size; } catch {}
      resolve(c.json({ ok: true, id: archiveName, sizeBytes, reset: !!body.reset, resetRemoved }));
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
import {
  type IssuesFile,
  loadIssuesOrSeed,
  saveIssues,
  readPendingIssues,
} from '@/lib/harness-issues';

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
  const hpi = generated.harnessPendingIssuesInHarnessShared;
  const issueId = `PENDING-${Date.now()}`;
  const ts = Date.now();
  await db
    .insert(hpi)
    .values({
      harnessSlug: project.slug,
      phase: project.phase ?? 'staging',
      issueId: issueId,
      featureId: body.linkedFeatureId ?? null,
      title: payload.title,
      severity: payload.severity,
      source: 'validator',
      payload: payload as any,
      ts,
      mtimeMs: ts,
      workspaceId: activeWorkspaceId(),
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
    const hpi = generated.harnessPendingIssuesInHarnessShared;
    await db
      .delete(hpi)
      .where(and(eq(hpi.harnessSlug, project.slug), eq(hpi.phase, project.phase ?? 'staging')));
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




// ─── Phases + promotion pipeline ─────────────────────────────────────

import { execFileSync } from 'node:child_process';

// Phase type imported from @/lib/harness-phases (above).
const PHASE_ORDER: Phase[] = [...ALL_PHASES];


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
    const { db } = (await import('@restart/db-org')).getOrgPg();
    const { generated } = await import('@restart/db-org');
    const { sql: dsql } = await import('drizzle-orm');
    const prev = generated.pendingReviewsInHarnessShared;
    const tsMs = ts * 1000;
    await db
      .insert(prev)
      .values({
        harnessSlug: project.slug,
        phase: from,
        reviewId: id,
        featureId: null,
        kind: 'promotion',
        payload: item as any,
        ts: tsMs,
        mtimeMs: tsMs,
        workspaceId: activeWorkspaceId(),
        resolved: false,
      })
      .onConflictDoUpdate({
        target: [prev.harnessSlug, prev.phase, prev.reviewId],
        set: {
          payload: dsql`EXCLUDED.payload`,
          mtimeMs: dsql`EXCLUDED.mtime_ms`,
          resolved: false,
        },
      });
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
    const { db } = (await import('@restart/db-org')).getOrgPg();
    const { generated } = await import('@restart/db-org');
    const hp = generated.harnessPromotionsInHarnessShared;
    await db
      .insert(hp)
      .values({
        workspaceId: activeWorkspaceId(),
        harnessSlug: project.slug,
        promotionId: obj.id,
        fromPhase: from,
        toPhase: to,
        sha: newSha || null,
        ts: Math.floor(Date.now() / 1000),
      })
      .onConflictDoNothing();
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
  const { db } = (await import('@restart/db-org')).getOrgPg();
  const { generated } = await import('@restart/db-org');
  const { and, desc, eq } = await import('drizzle-orm');
  const hp = generated.harnessPromotionsInHarnessShared;
  const promotions = await db
    .select({ promotionId: hp.promotionId, sha: hp.sha, ts: hp.ts })
    .from(hp)
    .where(and(eq(hp.workspaceId, activeWorkspaceId()), eq(hp.harnessSlug, project.slug), eq(hp.toPhase, phase)))
    .orderBy(desc(hp.ts))
    .limit(10);
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
  await db.insert(hp).values({
    workspaceId: activeWorkspaceId(),
    harnessSlug: project.slug,
    promotionId: `rollback-${Date.now()}`,
    fromPhase: phase,
    toPhase: phase,
    sha: prior.sha,
    ts: Math.floor(Date.now() / 1000),
  });

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

// V1 ship-state gate: tests tab is phase-coupled (per harness-phases plan),
// so the /tests endpoints return 404 when FLAGS.HARNESS_PHASES is off.
harness.use('/:slug/tests/*', async (c, next) => {
  const { getFlag } = await import('@papercusp/flags/server');
  const { FLAGS } = await import('@papercusp/flags');
  const enabled = await getFlag(FLAGS.HARNESS_PHASES, 'system');
  if (!enabled) return c.notFound();
  return next();
});
harness.use('/:slug/tests', async (c, next) => {
  const { getFlag } = await import('@papercusp/flags/server');
  const { FLAGS } = await import('@papercusp/flags');
  const enabled = await getFlag(FLAGS.HARNESS_PHASES, 'system');
  if (!enabled) return c.notFound();
  return next();
});

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
