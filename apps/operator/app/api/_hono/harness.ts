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
  PROJECT_FILES_TO_COPY, STATE_FILES_FOR_RESET,
  TEMPLATE_DETECT_FILES, SOURCE_FILES_FOR_FORK, SNAPSHOT_FILES,
} from '@/lib/harness-state-files';
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
import { scanAgentRunsCached, syncAgentRunsToPg } from '@/lib/harness-agent-runs';
import { activeStreams, HARNESS_STREAM_TOTAL_CAP, type StreamToken } from '@/lib/harness-active-streams';

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

