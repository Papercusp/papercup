/**
 * Harness management API.
 *
 * Reads state from `.harness/` directories across registered project roots.
 * Inspired by Factory.ai's Mission Control, but driven by the shell-based
 * autonomous harness at `~/autonomous-harness/`.
 *
 * Projects are registered via ~/.restart-harness-projects.json:
 *   { "projects": [{"slug":"sheets", "path":"/home/x/sheets-clone"}] }
 * Falls back to auto-discovering any HOME/{sheets-clone,restart} with .harness/.
 */
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { readFileSync, readlinkSync, existsSync, readdirSync, statSync, openSync, readSync, closeSync, constants as fsConstants } from 'node:fs';
import { getKnownRoles } from '@/lib/known-roles';
import { getKnownHooks } from '@/lib/known-hooks';
import { recordUserAction } from '@/lib/user-actions';
import { DECISION_VERBS } from '@papercusp/orchestrator/decision-parse';
import { readFile, writeFile, appendFile, unlink, mkdir, chmod, rename, access, copyFile } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { homedir } from 'node:os';
import { harnessPackageDir, harnessPath } from './harness-paths';
import { firePluginLifecycle, firePluginEvent } from '../../../lib/plugin-host-runtime';
import { spawn, execFile } from 'node:child_process';
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
import { activeWorkspaceId } from '@/lib/workspace-registry';
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

interface CostAggregate { cost: number; inputTokens: number; outputTokens: number }

const __costCache = new Map<string, { sig: string; expires: number; value: CostAggregate }>();

function aggregateCostFromLogDir(logDir: string, ttlMs = 5000): CostAggregate {
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
        const { obj } = tailLastResultLine(join(logDir, f));
        if (!obj) continue;
        out.cost += Number(obj.total_cost_usd ?? 0) || 0;
        const usage = obj.usage as { input_tokens?: number; output_tokens?: number } | undefined;
        if (usage) {
          out.inputTokens += Number(usage.input_tokens ?? 0) || 0;
          out.outputTokens += Number(usage.output_tokens ?? 0) || 0;
        }
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

// Single source of truth: the per-workspace registry at
// papercuspPath('registry.json'). NEVER read or write the legacy
// ~/.restart-harness-projects.json from operator code — see
// content/docs/spec/operator-architecture-decisions.mdx for the rule.
const loadRegistry = loadHarnessRegistry;
const saveRegistry = saveHarnessRegistry;

function resolveProject(slug: string): ProjectEntry | null {
  const reg = loadRegistry();
  return reg.projects.find((p) => p.slug === slug) ?? null;
}

function harnessDir(project: ProjectEntry): string {
  return join(project.path, '.harness');
}

function safeRead(path: string): string | null {
  try { return readFileSync(path, 'utf8'); } catch { return null; }
}

/**
 * Layer A/B (2026-04-26): features now live in SQLite, not features.json.
 * This helper queries the harness_features table for a given project.
 * Returns the same shape callers expect: array of {id, title, status, attempts, claims, ...}.
 */
async function parseFeatures(project: ProjectEntry): Promise<any[]> {
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

/** Append an audit row for a feature mutation. Fire-and-forget. */
function auditFeatureChange(harnessSlug: string, featureId: string, field: string, oldValue: any, newValue: any, actor: string): void {
  (async () => {
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

function tailFile(path: string, maxBytes = 64 * 1024): string {
  try {
    const stat = statSync(path);
    if (stat.size <= maxBytes) return readFileSync(path, 'utf8');
    const fd = readFileSync(path, 'utf8');
    return fd.slice(fd.length - maxBytes);
  } catch { return ''; }
}

/**
 * Background-invoke a single scoper mode (proposal | replan) without
 * going through run.sh's full pre-loop. Used by /product-review (manual
 * "Propose now") and the accept handler's replanOnAccept path.
 *
 * Sources only the helper functions from run.sh — does NOT enter the
 * orchestrator loop or run plan-review. So it can't accidentally exit 7
 * mid-replan, and it never respawns experts. Detached background spawn;
 * caller does not block on the agent invocation.
 */
function invokeScoperBackground(project: ProjectEntry, mode: 'proposal' | 'replan' | 'cleanup'): void {
  const { spawn } = require('node:child_process');
  const harnessScript = harnessPath('run.sh');
  const wrapper = `
    set -e
    export PROJECT_DIR="${project.path}"
    export STATE_DIR="${project.path}/.harness"
    export HARNESS_DIR="${harnessPackageDir()}"
    export LOG_DIR="$STATE_DIR/logs"
    mkdir -p "$STATE_DIR/proposals" "$LOG_DIR"
    source <(awk '/^(log|config_get|invoke|run_hook|snapshot_state|notify_event|harness_slug|fire_plugin_hook|auto_screenshot_post_worker|check_cost_cap|prune_logs)\\(\\)/,/^}/' "$HARNESS_DIR/run.sh")
    invoke scoper "MODE=${mode}"
  `;
  const child = spawn('bash', ['-c', wrapper], {
    cwd: project.path,
    env: { ...process.env, CLAUDE: process.env.CLAUDE ?? 'claude -p --dangerously-skip-permissions' },
    detached: true,
    stdio: ['ignore', 'ignore', 'ignore'],
  });
  child.unref();
}

function launchRun(project: ProjectEntry, extra?: string): { ok: true; logPath: string } | { ok: false; error: string } {
  const runScript = harnessPath('run.sh');
  if (!existsSync(runScript)) return { ok: false, error: 'run.sh missing' };
  const logPath = `/tmp/harness-${project.slug}.log`;
  const child = spawn('bash', ['-c', `nohup ${runScript} >> ${logPath} 2>&1 &`], {
    cwd: project.path,
    env: {
      ...process.env,
      CLAUDE: process.env.CLAUDE ?? 'claude -p --dangerously-skip-permissions',
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
harness.get('/projects/lite', async (c) => {
  const reg = loadRegistry();
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
  return c.json({ projects });
});

harness.get('/projects', async (c) => {
  const reg = loadRegistry();
  const filterParentSlug = c.req.query('parent_slug');
  // Best-effort: pull parent_slug for each registered slug from the
  // project's own .harness/config.json. The file registry doesn't carry
  // this field, so for newly-spawned children we read it back from disk.
  const parentSlugByConfigByPath = new Map<string, string | null>();
  for (const p of reg.projects) {
    const cfgPath = join(p.path, '.harness', 'config.json');
    let parentSlug: string | null = null;
    try {
      if (existsSync(cfgPath)) {
        const txt = await import('node:fs/promises').then((fs) => fs.readFile(cfgPath, 'utf8'));
        const j = JSON.parse(txt);
        if (typeof j?.parent_slug === 'string' && j.parent_slug) parentSlug = j.parent_slug;
      }
    } catch { /* ignore */ }
    parentSlugByConfigByPath.set(p.slug, parentSlug);
  }
  const enriched = await Promise.all(reg.projects.map(async (p) => {
    const hDir = harnessDir(p);
    let hasState = false;
    try {
      const c2 = dbcFor(p.slug);
      const row = await c2.prepare('SELECT 1 AS x FROM harness_features WHERE harness_slug = ? LIMIT 1').get(p.slug);
      hasState = !!row;
    } catch {}
    const hasSpec = existsSync(join(p.path, 'SPEC.md'));
    const parent_slug = parentSlugByConfigByPath.get(p.slug) ?? null;
    return { ...p, hasState, hasSpec, harnessDir: hDir, parent_slug };
  }));
  const filtered = filterParentSlug
    ? enriched.filter((p) => p.parent_slug === filterParentSlug)
    : enriched;
  return c.json({ projects: filtered });
});

harness.post('/projects', async (c) => {
  const body = await c.req.json();
  const slug = String(body.slug ?? '').trim();
  const path = resolve(String(body.path ?? '').trim());
  if (!slug || !path) return c.json({ error: 'slug and path required' }, 400);
  if (!existsSync(path)) return c.json({ error: 'path does not exist' }, 400);
  const reg = loadRegistry();
  if (reg.projects.some((p) => p.slug === slug)) {
    return c.json({ error: 'slug already exists' }, 409);
  }
  reg.projects.push({ slug, path });
  await saveRegistry(reg);

  // Provision the per-harness PG schema (tables, trigger for the consolidated
  // mirror, publication entries, harness_zero grants) and refresh the
  // cross-harness view so the new harness shows up everywhere immediately.
  const scaffoldOutputs: { stage: string; status: 'ok' | 'failed'; detail?: string }[] = [];
  try {
    const r = await execFileP('bin/scaffold-harness-schema.sh', [slug], {
      cwd: '/home/marsh-office/Restart',
      env: { ...process.env, PGUSER: 'postgres_app', PGPASSWORD: 'postgres', PGHOST: 'localhost', PGDATABASE: 'papercusp' },
      timeout: 30_000,
      maxBuffer: 4 * 1024 * 1024,
    });
    scaffoldOutputs.push({ stage: 'scaffold', status: 'ok', detail: r.stdout.split('\n').slice(-2).join(' ') });
  } catch (e) {
    scaffoldOutputs.push({ stage: 'scaffold', status: 'failed', detail: String((e as Error).message).slice(0, 300) });
  }
  try {
    const r = await execFileP('scripts/regenerate-harness-features-view.sh', [], {
      cwd: '/home/marsh-office/Restart',
      env: { ...process.env, PGUSER: 'harness_admin', PGPASSWORD: 'harness_admin_pwd', PGHOST: 'localhost' },
      timeout: 15_000,
      maxBuffer: 1 * 1024 * 1024,
    });
    scaffoldOutputs.push({ stage: 'view', status: 'ok', detail: r.stdout.split('\n').slice(-2).join(' ') });
  } catch (e) {
    scaffoldOutputs.push({ stage: 'view', status: 'failed', detail: String((e as Error).message).slice(0, 300) });
  }

  return c.json({ ok: true, project: { slug, path }, provisioning: scaffoldOutputs });
});

harness.delete('/projects/:slug', async (c) => {
  const slug = c.req.param('slug');
  const reg = loadRegistry();
  const before = reg.projects.length;
  reg.projects = reg.projects.filter((p) => p.slug !== slug);
  if (reg.projects.length === before) return c.json({ error: 'not found' }, 404);
  await saveRegistry(reg);
  return c.json({ ok: true });
});

// ─── per-project status ──────────────────────────────────────────────

harness.get('/:slug/status', async (c) => {
  const project = resolvePhasedProject(c.req.param('slug'), phasePhaseLabel(c.req.query('phase')));
  if (!project) return c.json({ error: 'unknown project' }, 404);

  const features = await parseFeatures(project);
  const counts = features.reduce((acc, f) => {
    acc[f.status] = (acc[f.status] ?? 0) + 1;
    return acc;
  }, {} as Record<string, number>);

  // Last-decision heuristic: read tail of run.log
  const runLog = tailFile(join(harnessDir(project), 'logs', 'run.log'), 16 * 1024);
  const decisionMatch = [...runLog.matchAll(/ORCH decision: (\S[^\n]*)/g)];
  const lastDecision = decisionMatch.length ? decisionMatch[decisionMatch.length - 1][1] : null;
  const iterationMatch = [...runLog.matchAll(/── iteration (\d+) ──/g)];
  const iteration = iterationMatch.length ? Number(iterationMatch[iterationMatch.length - 1][1]) : 0;

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
  let alive = false;
  try {
    const procs = readdirSync('/proc').filter((d) => /^\d+$/.test(d));
    for (const pid of procs) {
      try {
        const cwd = readlinkSync(`/proc/${pid}/cwd`);
        if (cwd.startsWith(project.path)) {
          const cmdline = readFileSync(`/proc/${pid}/cmdline`, 'utf8');
          if ((cmdline.includes('autonomous-harness/run.sh') || cmdline.includes('/harness/run.sh'))) {
            alive = true;
            break;
          }
        }
      } catch {}
    }
  } catch {}

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

harness.get('/:slug/spec', (c) => {
  const project = resolvePhasedProject(c.req.param('slug'), phasePhaseLabel(c.req.query('phase')));
  if (!project) return c.json({ error: 'unknown project' }, 404);
  return c.json({
    spec: safeRead(join(project.path, 'SPEC.md')),
    agents: safeRead(join(project.path, 'AGENTS.md')),
    contract: safeRead(join(harnessDir(project), 'validation-contract.md')),
    config: safeRead(join(harnessDir(project), 'config.json')),
  });
});

/**
 * Write SPEC.md, AGENTS.md, validation-contract.md, or config.json. Accepts
 * any subset of { spec, agents, contract, config }. Writes via temp-file +
 * rename so partial writes don't corrupt state.
 */
harness.put('/:slug/spec', async (c) => {
  const project = resolvePhasedProject(c.req.param('slug'), phasePhaseLabel(c.req.query('phase')));
  if (!project) return c.json({ error: 'unknown project' }, 404);
  const body = await c.req.json() as { spec?: string; agents?: string; contract?: string; config?: string };

  const targets: Array<{ path: string; content: string | undefined; label: string }> = [
    { path: join(project.path, 'SPEC.md'), content: body.spec, label: 'spec' },
    { path: join(project.path, 'AGENTS.md'), content: body.agents, label: 'agents' },
    { path: join(harnessDir(project), 'validation-contract.md'), content: body.contract, label: 'contract' },
    { path: join(harnessDir(project), 'config.json'), content: body.config, label: 'config' },
  ];

  const written: string[] = [];
  for (const t of targets) {
    if (typeof t.content !== 'string') continue;
    const tmp = `${t.path}.tmp.${Date.now()}`;
    await writeFile(tmp, t.content, 'utf8');
    const { rename } = await import('node:fs/promises');
    await rename(tmp, t.path);
    written.push(t.label);
  }
  return c.json({ ok: true, written });
});

harness.get('/:slug/issues', (c) => {
  const project = resolvePhasedProject(c.req.param('slug'), phasePhaseLabel(c.req.query('phase')));
  if (!project) return c.json({ error: 'unknown project' }, 404);
  return c.json({ issues: safeRead(join(harnessDir(project), 'issues.md')) });
});

harness.get('/:slug/summary', (c) => {
  const project = resolvePhasedProject(c.req.param('slug'), phasePhaseLabel(c.req.query('phase')));
  if (!project) return c.json({ error: 'unknown project' }, 404);
  return c.json({ summary: safeRead(join(harnessDir(project), 'summary.md')) });
});

harness.get('/:slug/logs/run', (c) => {
  const project = resolvePhasedProject(c.req.param('slug'), phasePhaseLabel(c.req.query('phase')));
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

harness.get('/:slug/agents', (c) => {
  const project = resolvePhasedProject(c.req.param('slug'), phasePhaseLabel(c.req.query('phase')));
  if (!project) return c.json({ error: 'unknown project' }, 404);
  const all = scanAgentRuns(project);
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

harness.get('/:slug/agents/:runId', (c) => {
  const project = resolvePhasedProject(c.req.param('slug'), phasePhaseLabel(c.req.query('phase')));
  if (!project) return c.json({ error: 'unknown project' }, 404);
  const runId = c.req.param('runId').replace(/[^A-Za-z0-9_.-]/g, ''); // sanitize
  const logDir = join(harnessDir(project), 'logs');
  const jsonlPath = join(logDir, `${runId}.jsonl`);
  const jsonlRaw = safeRead(jsonlPath);

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
  const project = resolveProject(c.req.param('slug'));
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
  const project = resolvePhasedProject(c.req.param('slug'), phasePhaseLabel(c.req.query('phase')));
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
  const project = resolvePhasedProject(c.req.param('slug'), phasePhaseLabel(c.req.query('phase')));
  if (!project) return c.json({ error: 'unknown project' }, 404);
  const id = c.req.param('id');
  const body = await c.req.json() as { title?: string; summary?: string; claims?: string[]; status?: string; attempts?: number; project_id?: string; expected_cost_cents?: number; tags?: string[]; needs_human_review?: boolean; metadata?: any; notes?: string; deprecation_reason?: string };
  const actor = c.req.header('x-actor') ?? 'api';

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
  const project = resolvePhasedProject(c.req.param('slug'), phasePhaseLabel(c.req.query('phase')));
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
  await dbc.transaction(async (tx) => {
    for (const f of features) {
      const existing = await tx.prepare('SELECT 1 AS x FROM harness_features WHERE harness_slug = ? AND feature_id = ?').get(project.slug, f.id);
      if (existing) {
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
  return c.json({ ok: true, inserted, updated, total: features.length });
});

harness.post('/:slug/features', async (c) => {
  const project = resolvePhasedProject(c.req.param('slug'), phasePhaseLabel(c.req.query('phase')));
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
  const project = resolvePhasedProject(c.req.param('slug'), phasePhaseLabel(c.req.query('phase')));
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

harness.get('/:slug/stream', (c) => {
  const project = resolvePhasedProject(c.req.param('slug'), phasePhaseLabel(c.req.query('phase')));
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
      let lastSize = 0;
      let lastFeatureState = '';

      const pushLog = async () => {
        try {
          const stat = statSync(runLogPath);
          if (stat.size > lastSize) {
            const fd = readFileSync(runLogPath, 'utf8');
            const chunk = fd.slice(lastSize);
            lastSize = stat.size;
            if (chunk) {
              await stream.writeSSE({ event: 'log', data: chunk });
            }
          }
        } catch {}
      };

      const pushFeatures = async () => {
        const feats = await parseFeatures(project);
        const state = JSON.stringify(feats.map((f) => [f.id, f.status, f.attempts]));
        if (state !== lastFeatureState) {
          lastFeatureState = state;
          await stream.writeSSE({ event: 'features', data: JSON.stringify(feats) });
        }
      };

      while (true) {
        if (stream.aborted || ownAborted) break;
        await pushLog();
        await pushFeatures();
        await stream.sleep(1500);
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
  const project = resolvePhasedProject(c.req.param('slug'), phasePhaseLabel(c.req.query('phase')));
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

harness.get('/:slug/log/stream', (c) => {
  const project = resolvePhasedProject(c.req.param('slug'), phasePhaseLabel(c.req.query('phase')));
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
    const backfill = async () => {
      try {
        const stat = statSync(jsonlPath);
        // Read up to last 1 MiB or whole file. Larger backfills risk
        // the SSE connection blocking on the initial flush.
        const start = Math.max(0, stat.size - 1024 * 1024);
        const fd = readFileSync(jsonlPath, 'utf8');
        lastSize = stat.size;
        const allLines = fd.slice(start).split('\n').filter(Boolean);
        const toReplay = allLines.slice(-tailSize);
        for (const raw of toReplay) {
          try {
            const evt = JSON.parse(raw);
            await stream.writeSSE({ event: 'log', data: JSON.stringify(evt) });
          } catch { /* skip malformed */ }
        }
        await stream.writeSSE({ event: 'backfill-done', data: String(toReplay.length) });
      } catch {
        // File doesn't exist yet — the harness hasn't run. That's fine;
        // signal an empty backfill so the client can render its empty state.
        await stream.writeSSE({ event: 'backfill-done', data: '0' });
      }
    };

    await backfill();

    // fs.watch fires per filesystem event. We re-stat + re-read the
    // delta on each event. Note: fs.watch doesn't guarantee one event per
    // append; back-to-back writes may coalesce or fire duplicates. The
    // size-tracking loop tolerates both.
    let watcher: import('node:fs').FSWatcher | null = null;
    const tickSinceLastEvent = setInterval(() => {
      // Belt-and-suspenders fallback: some filesystems (e.g. some
      // overlayfs setups, network mounts) drop fs.watch events. A 5s
      // poll guarantees we never go silent for longer than that.
      void readDelta();
    }, 5_000);
    tickSinceLastEvent.unref();

    const readDelta = async () => {
      try {
        const stat = statSync(jsonlPath);
        if (stat.size > lastSize) {
          const fd = readFileSync(jsonlPath, 'utf8');
          const chunk = fd.slice(lastSize);
          lastSize = stat.size;
          await emitLines(chunk);
        } else if (stat.size < lastSize) {
          // File rotated — restart from the beginning. Send a synthetic
          // event so the UI knows to clear its buffer of "old run" data.
          lastSize = 0;
          await stream.writeSSE({ event: 'rotated', data: 'true' });
          await readDelta();
        }
      } catch {
        // File disappeared mid-watch (rotation in progress); next tick
        // will pick it up.
      }
    };

    try {
      const fs = require('node:fs') as typeof import('node:fs');
      try {
        watcher = fs.watch(jsonlPath, () => { void readDelta(); });
      } catch {
        // File may not exist yet — fall through to polling.
      }
      while (true) {
        if (stream.aborted || ownAborted) break;
        // Lower-frequency tick than the legacy stream; fs.watch carries
        // most of the load. The 1.5s sleep is just a back-pressure pause.
        await stream.sleep(1500);
      }
    } finally {
      clearInterval(tickSinceLastEvent);
      try { watcher?.close(); } catch { /* ignore */ }
      if (activeStreams.get(streamKey) === token) {
        activeStreams.delete(streamKey);
      }
    }
  });
});

// ─── launch / stop (optional, safer to run manually for now) ─────────

harness.post('/:slug/launch', async (c) => {
  const project = resolvePhasedProject(c.req.param('slug'), phasePhaseLabel(c.req.query('phase')));
  if (!project) return c.json({ error: 'unknown project' }, 404);
  const body = await c.req.json().catch(() => ({}));
  const extra = typeof body.extra === 'string' ? body.extra : '';
  const result = launchRun(project, extra);
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
  const project = resolveProject(c.req.param('slug'));
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
        CLAUDE: process.env.CLAUDE ?? 'claude -p --dangerously-skip-permissions',
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
harness.get('/:slug/runs', (c) => {
  const project = resolveProject(c.req.param('slug'));
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
harness.get('/:slug/runs/:name', (c) => {
  const project = resolveProject(c.req.param('slug'));
  if (!project) return c.json({ error: 'unknown project' }, 404);
  const name = c.req.param('name').replace(/[^A-Za-z0-9_.:-]/g, '');
  if (!name || !name.endsWith('.md')) return c.json({ error: 'invalid name' }, 400);
  const path = join(harnessDir(project), 'runs', name);
  if (!existsSync(path)) return c.json({ error: 'not found' }, 404);
  return c.json({ name, content: safeRead(path) });
});

harness.get('/:slug/escalation', (c) => {
  const project = resolvePhasedProject(c.req.param('slug'), phasePhaseLabel(c.req.query('phase')));
  if (!project) return c.json({ error: 'unknown project' }, 404);
  const escalationPath = join(harnessDir(project), 'escalation.md');
  const supervisorNotesPath = join(harnessDir(project), 'supervisor-notes.md');
  let mtimeMs: number | null = null;
  try { mtimeMs = statSync(escalationPath).mtimeMs; } catch {}
  return c.json({
    escalation: safeRead(escalationPath),
    supervisorNotes: safeRead(supervisorNotesPath),
    mtimeMs,
  });
});

// ─── competitions (Conductor-inspired same-feature races) ───────────

harness.get('/:slug/competitions', (c) => {
  const project = resolveProject(c.req.param('slug'));
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

harness.get('/:slug/smoke-test', (c) => {
  const project = resolveProject(c.req.param('slug'));
  if (!project) return c.json({ error: 'unknown project' }, 404);
  const hd = harnessDir(project);
  const passPath = join(hd, 'smoke-pass.md');
  const failPath = join(hd, 'smoke-failure.md');
  const resultsPath = join(hd, 'smoke-results.json');
  const startupLogPath = join(hd, 'smoke-startup.log');
  let results: any = null;
  try { results = JSON.parse(readFileSync(resultsPath, 'utf8')); } catch {}
  let status: 'pass' | 'fail' | 'unknown' = 'unknown';
  let mtimeMs: number | null = null;
  if (existsSync(failPath)) {
    status = 'fail';
    try { mtimeMs = statSync(failPath).mtimeMs; } catch {}
  } else if (existsSync(passPath)) {
    status = 'pass';
    try { mtimeMs = statSync(passPath).mtimeMs; } catch {}
  }
  return c.json({
    status,
    mtimeMs,
    pass: safeRead(passPath),
    failure: safeRead(failPath),
    results,
    startupLog: safeRead(startupLogPath),
  });
});

harness.post('/:slug/smoke-test/run', async (c) => {
  const project = resolveProject(c.req.param('slug'));
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

// ─── identity files (Agent-Swarm-inspired cross-mission memory) ─────

harness.get('/identity', (c) => {
  const dir = harnessPath('identity');
  if (!existsSync(dir)) return c.json({ identities: [] });
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
});

// ─── checkpoints (Hermes-inspired named human-gated pauses) ──────────

harness.get('/:slug/checkpoints', (c) => {
  const project = resolveProject(c.req.param('slug'));
  if (!project) return c.json({ error: 'unknown project' }, 404);
  const hd = harnessDir(project);
  if (!existsSync(hd)) return c.json({ checkpoints: [] });
  const out: Array<{ name: string; content: string; waitingSinceMs: number; granted: boolean }> = [];
  for (const f of readdirSync(hd)) {
    const m = f.match(/^checkpoint-([A-Za-z0-9_.-]+)\.md$/);
    if (!m) continue;
    const name = m[1];
    const content = safeRead(join(hd, f)) ?? '';
    let waitingSinceMs = 0;
    try { waitingSinceMs = statSync(join(hd, f)).mtimeMs; } catch {}
    const granted = existsSync(join(hd, `${f}.granted`));
    out.push({ name, content, waitingSinceMs, granted });
  }
  out.sort((a, b) => a.waitingSinceMs - b.waitingSinceMs);
  return c.json({ checkpoints: out });
});

harness.post('/:slug/checkpoint/:name/request', async (c) => {
  // Manually create a pending checkpoint (human asks the harness to pause).
  const project = resolveProject(c.req.param('slug'));
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
  const project = resolveProject(c.req.param('slug'));
  if (!project) return c.json({ error: 'unknown project' }, 404);
  const name = c.req.param('name').replace(/[^A-Za-z0-9_.-]/g, '');
  if (!name) return c.json({ error: 'invalid name' }, 400);
  const hd = harnessDir(project);
  const cpPath = join(hd, `checkpoint-${name}.md`);
  if (!existsSync(cpPath)) return c.json({ error: 'no such checkpoint' }, 404);
  const grantPath = `${cpPath}.granted`;
  const { writeFileSync } = await import('node:fs');
  writeFileSync(grantPath, `granted at ${new Date().toISOString()}\n`);
  return c.json({ ok: true, granted: name, next: 'Re-run the harness to consume the grant.' });
});

harness.get('/:slug/health', async (c) => {
  const project = resolveProject(c.req.param('slug'));
  if (!project) return c.json({ error: 'unknown project' }, 404);

  // Features
  const features = await parseFeatures(project);
  const totalFeatures = features.length;
  const passed = features.filter((f: any) => f.status === 'passed').length;
  const failing = features.filter((f: any) => f.status === 'failing').length;
  const inProgress = features.filter((f: any) => f.status === 'in_progress' || f.status === 'validating').length;
  const blocked = features.filter((f: any) => f.status === 'blocked').length;

  // Escalation
  const escalated = existsSync(join(harnessDir(project), 'escalation.md'));

  // Alive check: scan /proc for run.sh with matching cwd
  let alive = false;
  try {
    for (const pid of readdirSync('/proc').filter((d) => /^\d+$/.test(d))) {
      try {
        const cwd = readlinkSync(`/proc/${pid}/cwd`);
        if (!cwd.startsWith(project.path)) continue;
        const cmdline = readFileSync(`/proc/${pid}/cmdline`, 'utf8');
        if ((cmdline.includes('autonomous-harness/run.sh') || cmdline.includes('/harness/run.sh'))) { alive = true; break; }
      } catch {}
    }
  } catch {}

  // Recent activity: most recent agent run mtime
  let lastRunMs = 0;
  try {
    const logDir = join(harnessDir(project), 'logs');
    if (existsSync(logDir)) {
      for (const f of readdirSync(logDir)) {
        if (!f.endsWith('.out') && !f.endsWith('.jsonl')) continue;
        try {
          const s = statSync(join(logDir, f));
          if (s.mtimeMs > lastRunMs) lastRunMs = s.mtimeMs;
        } catch {}
      }
    }
  } catch {}
  const lastRunAgeSeconds = lastRunMs ? Math.floor((Date.now() - lastRunMs) / 1000) : null;

  // Decision parser ghost rate
  const runLog = tailFile(join(harnessDir(project), 'logs', 'run.log'), 128 * 1024);
  const decLines = [...runLog.matchAll(/^\[[^\]]+\] ORCH decision:\s*(\S+)/gm)];
  const knownVerbs = new Set(['NEXT_WORKER', 'NEXT_VALIDATOR', 'NEXT_ARCHITECT', 'ESCALATE', 'CONVERTED', 'DONE']);
  const ghosts = decLines.filter((m) => !knownVerbs.has(m[1])).length;
  const ghostRate = decLines.length > 0 ? ghosts / decLines.length : 0;

  // Pending checkpoints
  let pendingCheckpoints = 0;
  try {
    for (const f of readdirSync(harnessDir(project))) {
      if (/^checkpoint-[A-Za-z0-9_.-]+\.md$/.test(f) && !existsSync(join(harnessDir(project), `${f}.granted`))) {
        pendingCheckpoints += 1;
      }
    }
  } catch {}

  // Smoke test result (if present)
  const smokeFail = existsSync(join(harnessDir(project), 'smoke-failure.md'));

  // Verdict
  const checks: Array<{ name: string; ok: boolean; detail?: string }> = [
    { name: 'spec_present',        ok: existsSync(join(project.path, 'SPEC.md')) },
    { name: 'features_present',    ok: existsSync(join(harnessDir(project), 'features.json')) },
    { name: 'contract_present',    ok: existsSync(join(harnessDir(project), 'validation-contract.md')) },
    { name: 'not_escalated',       ok: !escalated, detail: escalated ? 'see escalation.md' : undefined },
    { name: 'no_pending_checkpoints', ok: pendingCheckpoints === 0, detail: pendingCheckpoints > 0 ? `${pendingCheckpoints} awaiting grant` : undefined },
    { name: 'smoke_test_clean',    ok: !smokeFail, detail: smokeFail ? 'last smoke test failed' : undefined },
    { name: 'recent_activity',     ok: lastRunAgeSeconds !== null && lastRunAgeSeconds < 600, detail: lastRunAgeSeconds !== null ? `${lastRunAgeSeconds}s since last run` : 'no runs' },
    { name: 'low_ghost_rate',      ok: ghostRate < 0.1, detail: `${ghosts}/${decLines.length} parser ghosts` },
    { name: 'not_stuck',           ok: failing === 0 || inProgress > 0, detail: `${failing} failing, ${inProgress} in progress` },
  ];
  const overallOk = checks.every((c) => c.ok);

  return c.json({
    ok: overallOk,
    alive,
    escalated,
    features: { total: totalFeatures, passed, failing, inProgress, blocked },
    lastRunAgeSeconds,
    ghostRate,
    checks,
  });
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
  const project = resolveProject(c.req.param('slug'));
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
  const project = resolveProject(c.req.param('slug'));
  if (!project) return c.json({ error: 'unknown project' }, 404);
  const id = c.req.param('id');
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

harness.get('/:slug/features/:id/timeline', (c) => {
  const project = resolveProject(c.req.param('slug'));
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

harness.get('/:slug/decisions', (c) => {
  const project = resolveProject(c.req.param('slug'));
  if (!project) return c.json({ error: 'unknown project' }, 404);
  const runLog = tailFile(join(harnessDir(project), 'logs', 'run.log'), 256 * 1024);
  // Parse "[<iso>] ORCH decision: <verb> [args]"
  type Decision = { ts: number; iso: string; verb: string; args: string; iteration: number | null; isGhost: boolean };
  const decisions: Decision[] = [];
  let currentIter: number | null = null;
  const iterRe = /^\[([^\]]+)\] ── iteration (\d+) ──/;
  const decRe = /^\[([^\]]+)\] ORCH decision:\s*(\S*)\s*(.*)$/;
  const KNOWN_VERBS = new Set<string>(DECISION_VERBS);
  for (const line of runLog.split('\n')) {
    const im = line.match(iterRe);
    if (im) { currentIter = Number(im[2]); continue; }
    const dm = line.match(decRe);
    if (dm) {
      const iso = dm[1];
      const ts = Date.parse(iso);
      const verb = dm[2] || '(empty)';
      decisions.push({
        ts: Number.isNaN(ts) ? 0 : ts,
        iso,
        verb,
        args: dm[3].trim(),
        iteration: currentIter,
        isGhost: !KNOWN_VERBS.has(verb),
      });
    }
  }
  // Aggregate counts (recognized only, by verb)
  const byVerb: Record<string, number> = {};
  let ghosts = 0;
  for (const d of decisions) {
    if (d.isGhost) ghosts += 1;
    else byVerb[d.verb] = (byVerb[d.verb] ?? 0) + 1;
  }
  return c.json({
    decisions: decisions.slice(-200),
    total: decisions.length,
    recognized: decisions.length - ghosts,
    ghosts,
    ghostRate: decisions.length > 0 ? ghosts / decisions.length : 0,
    byVerb,
  });
});

harness.get('/:slug/lanes', (c) => {
  const project = resolvePhasedProject(c.req.param('slug'), phasePhaseLabel(c.req.query('phase')));
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
  const project = resolvePhasedProject(c.req.param('slug'), phasePhaseLabel(c.req.query('phase')));
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

/**
 * Mirror the filesystem-derived proposal metadata to
 * `harness_<slug>.harness_proposals` so Zero subscribers (ProposalsPanel)
 * see live updates instead of polling. Filesystem stays authoritative for
 * the body; PG only holds queryable metadata. Fire-and-forget; failures
 * don't break the GET response.
 */
async function syncProposalsToPg(project: ProjectEntry, items: ProposalListEntry[]): Promise<void> {
  const { sql } = getHarnessPg(project.slug);
  const now = Date.now();
  const ids = items.map((p) => p.id);
  if (items.length > 0) {
    const rows = items.map((p) => ({
      harness_slug: project.slug,
      proposal_id: p.id,
      size_bytes: p.sizeBytes,
      status: p.status,
      review_verdict: p.reviewVerdict ?? null,
      review_summary: p.reviewSummary ?? null,
      reviewed_at: p.reviewedAt ?? null,
      applied_at: p.appliedAt ?? null,
      rejected_at: p.rejectedAt ?? null,
      ts: p.ts,
      created_ts: now,
      updated_ts: now,
    }));
    await sql`
      INSERT INTO harness_proposals ${sql(rows, 'harness_slug', 'proposal_id', 'size_bytes', 'status', 'review_verdict', 'review_summary', 'reviewed_at', 'applied_at', 'rejected_at', 'ts', 'created_ts', 'updated_ts')}
      ON CONFLICT (harness_slug, proposal_id) DO UPDATE SET
        size_bytes      = EXCLUDED.size_bytes,
        status          = EXCLUDED.status,
        review_verdict  = EXCLUDED.review_verdict,
        review_summary  = EXCLUDED.review_summary,
        reviewed_at     = EXCLUDED.reviewed_at,
        applied_at      = EXCLUDED.applied_at,
        rejected_at     = EXCLUDED.rejected_at,
        ts              = EXCLUDED.ts,
        updated_ts      = EXCLUDED.updated_ts
    `;
    await sql`
      DELETE FROM harness_proposals
      WHERE harness_slug = ${project.slug}
        AND proposal_id <> ALL(${ids})
    `;
  } else {
    await sql`
      DELETE FROM harness_proposals
      WHERE harness_slug = ${project.slug}
    `;
  }
}

harness.get('/:slug/proposals', (c) => {
  const project = resolveProject(c.req.param('slug'));
  if (!project) return c.json({ error: 'unknown project' }, 404);
  const dir = join(harnessDir(project), 'proposals');
  if (!existsSync(dir)) return c.json({ proposals: [], replanOnAccept: true });
  const items = scanProposalsDir(project);
  // Fire-and-forget — don't block the GET response on PG.
  syncProposalsToPg(project, items).catch((err) => {
    console.warn(`[proposals] PG sync failed for ${project.slug}:`, err?.message ?? err);
  });

  // Tell the UI whether the harness is configured to auto-replan on
  // accept. Default true: accept means accept. Set explicitly to false
  // to opt out.
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

harness.get('/:slug/proposals/:id', (c) => {
  const project = resolveProject(c.req.param('slug'));
  if (!project) return c.json({ error: 'unknown project' }, 404);
  const id = c.req.param('id').replace(/[^A-Za-z0-9_.-]/g, '');
  if (!id || !id.endsWith('.md')) return c.json({ error: 'invalid id' }, 400);
  const p = join(harnessDir(project), 'proposals', id);
  if (!existsSync(p)) return c.json({ error: 'not found' }, 404);
  return c.json({ id, content: safeRead(p) });
});

harness.post('/:slug/proposals/:id/accept', async (c) => {
  const project = resolveProject(c.req.param('slug'));
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
  // Stamp the proposal
  await appendFile(proposalPath, `\n---\napplied: true\nappliedAt: ${new Date().toISOString()}\n`, 'utf8');
  // Refresh PG so Zero subscribers see the new status without waiting for a list poll.
  syncProposalsToPg(project, scanProposalsDir(project)).catch((err) => {
    console.warn(`[proposals] PG sync after accept failed for ${project.slug}:`, err?.message ?? err);
  });

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
  const project = resolveProject(c.req.param('slug'));
  if (!project) return c.json({ error: 'unknown project' }, 404);
  const id = c.req.param('id').replace(/[^A-Za-z0-9_.-]/g, '');
  if (!id || !id.endsWith('.md')) return c.json({ error: 'invalid id' }, 400);
  const proposalPath = join(harnessDir(project), 'proposals', id);
  if (!existsSync(proposalPath)) return c.json({ error: 'not found' }, 404);
  await appendFile(proposalPath, `\n---\nrejected: true\nrejectedAt: ${new Date().toISOString()}\n`, 'utf8');
  syncProposalsToPg(project, scanProposalsDir(project)).catch((err) => {
    console.warn(`[proposals] PG sync after reject failed for ${project.slug}:`, err?.message ?? err);
  });
  return c.json({ ok: true });
});

harness.post('/:slug/product-review', async (c) => {
  const project = resolveProject(c.req.param('slug'));
  if (!project) return c.json({ error: 'unknown project' }, 404);
  const specPath = join(project.path, 'SPEC.md');
  if (!existsSync(specPath)) {
    return c.json({ error: 'SPEC.md not found in project root' }, 400);
  }

  invokeScoperBackground(project, 'proposal');
  return c.json({ ok: true });
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
  const project = resolveProject(slug);
  if (!project) return c.json({ error: 'unknown project' }, 404);
  // Logged in harness_shared.user_actions; surfaced via /api/user-actions/<slug>
  // and the OperatorActionLog component. The action represents the *kickoff*;
  // the replan's completion is observable via /scoper-result/<invocationId>.
  await recordUserAction(slug, 'replan', async () => {
    invokeScoperBackground(project, 'replan');
    return { summary: 'Replan kicked off', result: undefined };
  });
  return c.json({ ok: true });
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
harness.post('/:slug/cleanup', (c) => {
  const project = resolveProject(c.req.param('slug'));
  if (!project) return c.json({ error: 'unknown project' }, 404);
  invokeScoperBackground(project, 'cleanup');
  return c.json({ ok: true });
});

harness.get('/:slug/plan-review', (c) => {
  const project = resolveProject(c.req.param('slug'));
  if (!project) return c.json({ error: 'unknown project' }, 404);
  const p = join(harnessDir(project), 'plan-review.md');
  let mtimeMs: number | null = null;
  try { mtimeMs = statSync(p).mtimeMs; } catch {}
  return c.json({ content: safeRead(p), mtimeMs });
});

harness.get('/:slug/debug-notes/:id', (c) => {
  const project = resolveProject(c.req.param('slug'));
  if (!project) return c.json({ error: 'unknown project' }, 404);
  const id = c.req.param('id').replace(/[^A-Za-z0-9_-]/g, '');
  if (!id) return c.json({ error: 'invalid feature id' }, 400);
  const p = join(harnessDir(project), 'debug', `${id}.md`);
  let mtimeMs: number | null = null;
  try { mtimeMs = statSync(p).mtimeMs; } catch {}
  return c.json({ content: safeRead(p), mtimeMs });
});

harness.get('/:slug/debug-notes', (c) => {
  const project = resolveProject(c.req.param('slug'));
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

harness.get('/:slug/knowledge', (c) => {
  const project = resolvePhasedProject(c.req.param('slug'), phasePhaseLabel(c.req.query('phase')));
  if (!project) return c.json({ error: 'unknown project' }, 404);
  const p = join(harnessDir(project), 'knowledge.md');
  let mtimeMs: number | null = null;
  try { mtimeMs = statSync(p).mtimeMs; } catch {}
  return c.json({ content: safeRead(p), mtimeMs });
});

harness.put('/:slug/knowledge', async (c) => {
  const project = resolvePhasedProject(c.req.param('slug'), phasePhaseLabel(c.req.query('phase')));
  if (!project) return c.json({ error: 'unknown project' }, 404);
  const body = await c.req.json().catch(() => ({})) as { content?: string };
  if (typeof body.content !== 'string') return c.json({ error: 'content required' }, 400);
  await mkdir(harnessDir(project), { recursive: true });
  const dest = join(harnessDir(project), 'knowledge.md');
  const tmp = `${dest}.tmp.${Date.now()}`;
  await writeFile(tmp, body.content, 'utf8');
  await rename(tmp, dest);
  return c.json({ ok: true });
});

harness.get('/:slug/diff/working', async (c) => {
  const project = resolvePhasedProject(c.req.param('slug'), phasePhaseLabel(c.req.query('phase')));
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

harness.get('/:slug/archives', (c) => {
  const project = resolvePhasedProject(c.req.param('slug'), phasePhaseLabel(c.req.query('phase')));
  if (!project) return c.json({ error: 'unknown project' }, 404);
  const dir = join(harnessDir(project), 'archives');
  if (!existsSync(dir)) return c.json({ archives: [] });
  const items = readdirSync(dir)
    .filter((f) => f.endsWith('.tar.gz'))
    .map((f) => {
      const full = join(dir, f);
      let size = 0, ts = 0;
      try { const s = statSync(full); size = s.size; ts = s.mtimeMs; } catch {}
      return { id: f, sizeBytes: size, ts };
    })
    .sort((a, b) => b.ts - a.ts);
  return c.json({ archives: items });
});

harness.post('/:slug/archives/:id/restore', async (c) => {
  const project = resolvePhasedProject(c.req.param('slug'), phasePhaseLabel(c.req.query('phase')));
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
  const project = resolvePhasedProject(c.req.param('slug'), phasePhaseLabel(c.req.query('phase')));
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
        const toRemove = [
          'features.json', 'validation-contract.md', 'issues.md', 'worker-log.md',
          'escalation.md', 'supervisor-notes.md', 'lanes.json', 'prs.json',
        ];
        for (const f of toRemove) {
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
  const project = resolvePhasedProject(c.req.param('slug'), phasePhaseLabel(c.req.query('phase')));
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
    for (const f of ['features.json', 'validation-contract.md']) {
      const p = join(harnessDir(project), f);
      if (existsSync(p)) {
        const { rename } = await import('node:fs/promises');
        await rename(p, join(backupDir, f));
      }
    }
  }

  const harnessScript = harnessPath('run.sh');
  const logPath = `/tmp/harness-replan-${project.slug}.log`;
  // We don't want to run the full orchestration loop — just the scoper.
  // run.sh has a gate: "if missing features.json + contract, invoke scoper MODE=initial".
  // It continues to the main loop after; setting MAX_ITERATIONS=0 prevents the loop body from running.
  return new Promise((resolve) => {
    const { execFile } = require('node:child_process');
    execFile('bash', ['-c', `MAX_ITERATIONS=0 ${harnessScript} >> ${logPath} 2>&1; echo "DONE rc=$?"`], {
      cwd: project.path,
      env: {
        ...process.env,
        CLAUDE: process.env.CLAUDE ?? 'claude -p --dangerously-skip-permissions',
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
  const project = resolvePhasedProject(c.req.param('slug'), phasePhaseLabel(c.req.query('phase')));
  if (!project) return c.json({ error: 'unknown project' }, 404);
  const script = harnessPath('bin', 'supervisor.sh');
  if (!existsSync(script)) return c.json({ error: 'supervisor.sh not found' }, 500);
  return new Promise((resolve) => {
    const { execFile } = require('node:child_process');
    execFile('bash', [script], { cwd: project.path, maxBuffer: 4 * 1024 * 1024, env: { ...process.env, CLAUDE: process.env.CLAUDE ?? 'claude -p --dangerously-skip-permissions' } }, (err: any, stdout: string, stderr: string) => {
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

harness.get('/:slug/prs', (c) => {
  const project = resolvePhasedProject(c.req.param('slug'), phasePhaseLabel(c.req.query('phase')));
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

harness.get('/:slug/notes', (c) => {
  const project = resolvePhasedProject(c.req.param('slug'), phasePhaseLabel(c.req.query('phase')));
  if (!project) return c.json({ error: 'unknown project' }, 404);
  const path = join(harnessDir(project), 'supervisor-notes.md');
  let mtimeMs: number | null = null;
  try { mtimeMs = statSync(path).mtimeMs; } catch {}
  return c.json({ content: safeRead(path), mtimeMs });
});

// ─── usage / cost aggregation ─────────────────────────────────────────

harness.get('/:slug/usage', (c) => {
  const project = resolvePhasedProject(c.req.param('slug'), phasePhaseLabel(c.req.query('phase')));
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
    for (const f of ['SPEC.md', 'AGENTS.md', 'config.json']) {
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
  const project = resolvePhasedProject(c.req.param('slug'), phasePhaseLabel(c.req.query('phase')));
  if (!project) return c.json({ error: 'unknown project' }, 404);
  const body = await c.req.json().catch(() => ({})) as { templateId?: string; overwrite?: boolean };
  const tid = (body.templateId ?? '').replace(/[^A-Za-z0-9_-]/g, '');
  if (!tid) return c.json({ error: 'templateId required' }, 400);
  const tdir = join(TEMPLATES_DIR, tid);
  if (!existsSync(tdir)) return c.json({ error: `template not found: ${tid}` }, 404);

  const overwrite = body.overwrite === true;
  const copied: string[] = [];
  const skipped: string[] = [];
  for (const f of ['SPEC.md', 'AGENTS.md']) {
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

harness.get('/:slug/screenshots', (c) => {
  const project = resolvePhasedProject(c.req.param('slug'), phasePhaseLabel(c.req.query('phase')));
  if (!project) return c.json({ error: 'unknown project' }, 404);
  const dir = join(harnessDir(project), 'screenshots');
  if (!existsSync(dir)) return c.json({ screenshots: [] });

  const items = readdirSync(dir)
    .filter((f) => SCREENSHOT_EXTS.some((ext) => f.toLowerCase().endsWith(ext)))
    .map((f) => {
      const full = join(dir, f);
      let size = 0, ts = 0;
      try { const s = statSync(full); size = s.size; ts = s.mtimeMs; } catch {}
      return { id: f, sizeBytes: size, ts };
    })
    .sort((a, b) => b.ts - a.ts)
    .slice(0, 200);

  return c.json({ screenshots: items });
});

harness.get('/:slug/screenshots/:id', async (c) => {
  const project = resolvePhasedProject(c.req.param('slug'), phasePhaseLabel(c.req.query('phase')));
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
  const project = resolvePhasedProject(c.req.param('slug'), phasePhaseLabel(c.req.query('phase')));
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
  return c.json({ ok: true, id: safeName, sizeBytes: ab.byteLength });
});

harness.delete('/:slug/screenshots/:id', async (c) => {
  const project = resolvePhasedProject(c.req.param('slug'), phasePhaseLabel(c.req.query('phase')));
  if (!project) return c.json({ error: 'unknown project' }, 404);
  const id = c.req.param('id').replace(/[^A-Za-z0-9_.\-]/g, '');
  if (!id || !SCREENSHOT_EXTS.some((ext) => id.toLowerCase().endsWith(ext))) {
    return c.json({ error: 'invalid screenshot id' }, 400);
  }
  try {
    await unlink(join(harnessDir(project), 'screenshots', id));
    return c.json({ ok: true, deleted: true });
  } catch (err: any) {
    if (err?.code === 'ENOENT') return c.json({ ok: true, deleted: false });
    return c.json({ error: String(err) }, 500);
  }
});

// ─── snapshots (.harness/snapshots/<id>/) ─────────────────────────────

const SNAPSHOT_FILES = ['features.json', 'validation-contract.md', 'supervisor-notes.md', 'config.json'] as const;

interface SnapshotMeta {
  id: string;
  ts: number;
  iterNum: number;
  files: string[];
  featureCounts: Record<string, number>;
}

function scanSnapshots(project: ProjectEntry): SnapshotMeta[] {
  const snapDir = join(harnessDir(project), 'snapshots');
  if (!existsSync(snapDir)) return [];
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
      const featureCounts: Record<string, number> = {};
      try {
        const raw = readFileSync(join(dirPath, 'features.json'), 'utf8');
        const parsed = JSON.parse(raw);
        for (const feat of parsed.features ?? []) {
          const s = feat.status ?? 'todo';
          featureCounts[s] = (featureCounts[s] ?? 0) + 1;
        }
      } catch {}
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

harness.get('/:slug/snapshots', (c) => {
  const project = resolvePhasedProject(c.req.param('slug'), phasePhaseLabel(c.req.query('phase')));
  if (!project) return c.json({ error: 'unknown project' }, 404);
  const snapshots = scanSnapshots(project);
  syncSnapshotsToPg(project, snapshots).catch((err) => {
    console.error(`[snapshots] PG sync failed for ${project.slug}:`, err);
  });
  return c.json({ snapshots });
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
  const project = resolveProject(c.req.param('slug'));
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

  // Source files to copy verbatim
  const sourceFiles = ['SPEC.md', 'AGENTS.md', '.harness/config.json', '.harness/validation-contract.md'];
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
  const project = resolvePhasedProject(c.req.param('slug'), phasePhaseLabel(c.req.query('phase')));
  if (!project) return c.json({ error: 'unknown project' }, 404);
  const id = c.req.param('id').replace(/[^A-Za-z0-9_-]/g, '');
  if (!id || !/^\d+-iter-\d+$/.test(id)) {
    return c.json({ error: 'invalid snapshot id' }, 400);
  }
  const snapDir = join(harnessDir(project), 'snapshots', id);
  if (!existsSync(snapDir)) return c.json({ error: 'snapshot not found' }, 404);

  const body = await c.req.json().catch(() => ({})) as { includeSupervisorNotes?: boolean; includeConfig?: boolean };
  const includeSupervisorNotes = body.includeSupervisorNotes !== false;
  const includeConfig = body.includeConfig !== false;

  const restored: string[] = [];
  for (const f of SNAPSHOT_FILES) {
    if (f === 'supervisor-notes.md' && !includeSupervisorNotes) continue;
    if (f === 'config.json' && !includeConfig) continue;
    const src = join(snapDir, f);
    if (!existsSync(src)) continue;
    const dest = join(harnessDir(project), f);
    const tmp = `${dest}.tmp.${Date.now()}`;
    await copyFile(src, tmp);
    await rename(tmp, dest);
    restored.push(f);
  }

  return c.json({ ok: true, restored });
});

harness.delete('/:slug/snapshots/:id', async (c) => {
  const project = resolvePhasedProject(c.req.param('slug'), phasePhaseLabel(c.req.query('phase')));
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
  return c.json({ ok: true, deleted: true });
});

harness.post('/:slug/escalation/resolve', async (c) => {
  const project = resolvePhasedProject(c.req.param('slug'), phasePhaseLabel(c.req.query('phase')));
  if (!project) return c.json({ error: 'unknown project' }, 404);
  const body = await c.req.json().catch(() => ({}));
  const response = typeof body.response === 'string' ? body.response.trim() : '';
  const action = body.action === 'clear' ? 'clear' : 'keep';

  const supervisorNotesPath = join(harnessDir(project), 'supervisor-notes.md');
  if (response) {
    const block = `\n## Human response ${new Date().toISOString()}\n\n${response}\n`;
    await appendFile(supervisorNotesPath, block, 'utf8');
  }

  if (action === 'clear') {
    try { await unlink(join(harnessDir(project), 'escalation.md')); } catch {}
  }

  return c.json({
    ok: true,
    supervisorNotes: safeRead(supervisorNotesPath),
    cleared: action === 'clear',
  });
});

harness.post('/:slug/resume', async (c) => {
  const project = resolvePhasedProject(c.req.param('slug'), phasePhaseLabel(c.req.query('phase')));
  if (!project) return c.json({ error: 'unknown project' }, 404);
  try { await unlink(join(harnessDir(project), 'escalation.md')); } catch {}
  const result = launchRun(project);
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

harness.get('/:slug/hooks', (c) => {
  const project = resolvePhasedProject(c.req.param('slug'), phasePhaseLabel(c.req.query('phase')));
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
  const project = resolvePhasedProject(c.req.param('slug'), phasePhaseLabel(c.req.query('phase')));
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
  const project = resolvePhasedProject(c.req.param('slug'), phasePhaseLabel(c.req.query('phase')));
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

harness.get('/:slug/hook-logs', (c) => {
  const project = resolvePhasedProject(c.req.param('slug'), phasePhaseLabel(c.req.query('phase')));
  if (!project) return c.json({ error: 'unknown project' }, 404);
  const logDir = join(harnessDir(project), 'logs', 'hooks');
  if (!existsSync(logDir)) return c.json({ runs: [] });
  const runs = readdirSync(logDir)
    .filter((f) => f.endsWith('.log'))
    .map((f) => {
      const full = join(logDir, f);
      let size = 0;
      try { size = statSync(full).size; } catch {}
      const stem = f.replace(/\.log$/, '');
      const match = stem.match(/^(\d+)-(.+)$/);
      return {
        logId: stem,
        name: match ? match[2] : stem,
        ts: match ? Number(match[1]) * 1000 : 0,
        sizeBytes: size,
      };
    })
    .filter((r) => r.ts > 0)
    .sort((a, b) => b.ts - a.ts)
    .slice(0, 50);
  return c.json({ runs });
});

harness.get('/:slug/hook-logs/:logId', (c) => {
  const project = resolvePhasedProject(c.req.param('slug'), phasePhaseLabel(c.req.query('phase')));
  if (!project) return c.json({ error: 'unknown project' }, 404);
  const logId = c.req.param('logId').replace(/[^A-Za-z0-9_.-]/g, '');
  if (!logId) return c.json({ error: 'invalid logId' }, 400);
  const full = join(harnessDir(project), 'logs', 'hooks', `${logId}.log`);
  const content = safeRead(full);
  if (content === null) return c.json({ error: 'log not found' }, 404);
  return c.json({ logId, content });
});

harness.get('/:slug/git/show/:sha', async (c) => {
  const project = resolvePhasedProject(c.req.param('slug'), phasePhaseLabel(c.req.query('phase')));
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
  const project = resolvePhasedProject(c.req.param('slug'), phasePhaseLabel(c.req.query('phase')));
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
  const project = resolvePhasedProject(c.req.param('slug'), phasePhaseLabel(c.req.query('phase')));
  if (!project) return c.json({ error: 'unknown project' }, 404);
  const pids = findHarnessPids(project.path);
  const paused: number[] = [];
  for (const pid of pids) {
    try { process.kill(pid, 'SIGSTOP'); paused.push(pid); } catch {}
  }
  return c.json({ ok: true, paused });
});

harness.post('/:slug/unpause', async (c) => {
  const project = resolvePhasedProject(c.req.param('slug'), phasePhaseLabel(c.req.query('phase')));
  if (!project) return c.json({ error: 'unknown project' }, 404);
  const pids = findHarnessPids(project.path);
  const resumed: number[] = [];
  for (const pid of pids) {
    try { process.kill(pid, 'SIGCONT'); resumed.push(pid); } catch {}
  }
  return c.json({ ok: true, resumed });
});

harness.post('/:slug/stop', async (c) => {
  const project = resolvePhasedProject(c.req.param('slug'), phasePhaseLabel(c.req.query('phase')));
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

type IssueSeverity = 'critical' | 'major' | 'minor' | 'nit';
type IssueSource = 'validator' | 'worker' | 'human';
type IssueStatus = 'open' | 'acknowledged' | 'fixing' | 'closed' | 'wontfix';

interface IssueNote { ts: string; by: string; text: string }
interface Issue {
  id: string;
  title: string;
  severity: IssueSeverity;
  source: IssueSource;
  foundAt: string;
  foundDuring?: string;
  status: IssueStatus;
  repro?: string;
  evidence?: string;
  suggestedFix?: string;
  codePointer?: string;
  linkedFeatureId?: string;
  attempts: number;
  notes: IssueNote[];
}
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

// Read the validator's un-merged structured findings. Each line of
// pending-issues.jsonl is a raw finding lacking id/status; we synthesize
// placeholder fields so the UI can show them immediately (before the
// curator runs and assigns real ids). These entries are read-only from
// the UI's perspective — promotion/mutation goes through the curator.
function readPendingIssues(project: ProjectEntry): Issue[] {
  const path = join(harnessDir(project), 'pending-issues.jsonl');
  const raw = safeRead(path);
  if (!raw) return [];
  const out: Issue[] = [];
  const lines = raw.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    try {
      const p = JSON.parse(line);
      if (!p.title || !p.severity) continue;
      out.push({
        id: `PENDING-${i + 1}`,
        title: String(p.title),
        severity: p.severity,
        source: 'validator',
        foundAt: p.foundAt ?? new Date().toISOString(),
        foundDuring: p.foundDuring,
        status: 'open',
        repro: p.repro,
        evidence: p.evidence,
        suggestedFix: p.suggestedFix,
        codePointer: p.codePointer,
        attempts: 0,
        notes: [],
      });
    } catch {}
  }
  return out;
}

harness.get('/:slug/issues-list', (c) => {
  const project = resolvePhasedProject(c.req.param('slug'), phasePhaseLabel(c.req.query('phase')));
  if (!project) return c.json({ error: 'unknown project' }, 404);
  const file = loadIssuesOrSeed(project);
  const pending = readPendingIssues(project);
  return c.json({ ...file, pending });
});

harness.post('/:slug/issues', async (c) => {
  const project = resolvePhasedProject(c.req.param('slug'), phasePhaseLabel(c.req.query('phase')));
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
  const project = resolvePhasedProject(c.req.param('slug'), phasePhaseLabel(c.req.query('phase')));
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
  const line = JSON.stringify({
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
  }) + '\n';
  const path = join(harnessDir(project), 'pending-issues.jsonl');
  await appendFile(path, line, 'utf8');
  return c.json({ ok: true });
});

harness.post('/:slug/issues/:id/update', async (c) => {
  const project = resolvePhasedProject(c.req.param('slug'), phasePhaseLabel(c.req.query('phase')));
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
  const project = resolvePhasedProject(c.req.param('slug'), phasePhaseLabel(c.req.query('phase')));
  if (!project) return c.json({ error: 'unknown project' }, 404);

  const pending = readPendingIssues(project);
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
  // Truncate the validator's pending feed only when it actually exists. The
  // bootstrap-empty write was a remnant of the pre-DB flow; the file is
  // append-only by the validator and shouldn't be created here. If it never
  // existed, the post-merge state is "empty queue" by absence — same effect.
  const pendingPath = join(harnessDir(project), 'pending-issues.jsonl');
  if (existsSync(pendingPath)) await writeFile(pendingPath, '', 'utf8');

  return c.json({ ok: true, merged, deduped });
});

harness.post('/:slug/issues/:id/promote', async (c) => {
  const project = resolvePhasedProject(c.req.param('slug'), phasePhaseLabel(c.req.query('phase')));
  if (!project) return c.json({ error: 'unknown project' }, 404);
  const id = c.req.param('id');
  const file = loadIssuesOrSeed(project);
  const issue = file.issues.find((i) => i.id === id);
  if (!issue) return c.json({ error: 'issue not found' }, 404);
  if (issue.linkedFeatureId) return c.json({ error: 'already linked to ' + issue.linkedFeatureId }, 400);

  // Append a F-FIX-### entry to features.json
  const featuresPath = join(harnessDir(project), 'features.json');
  let featuresDoc: { features: any[] };
  try {
    featuresDoc = JSON.parse(readFileSync(featuresPath, 'utf8'));
  } catch {
    featuresDoc = { features: [] };
  }
  const existingFixIds = featuresDoc.features
    .map((f: any) => (typeof f.id === 'string' && f.id.startsWith('F-FIX-') ? Number(f.id.slice(6)) : 0))
    .filter((n) => Number.isFinite(n));
  const nextFixId = (existingFixIds.length ? Math.max(...existingFixIds) : 0) + 1;
  const featureId = `F-FIX-${String(nextFixId).padStart(3, '0')}`;

  const newFeature = {
    id: featureId,
    title: issue.title,
    claims: issue.codePointer ? [`VAL-FIX-${nextFixId} @ ${issue.codePointer}`] : [],
    status: 'todo',
    attempts: 0,
    sourceIssueId: issue.id,
    notes: [issue.evidence ?? '', issue.suggestedFix ? `Suggested fix: ${issue.suggestedFix}` : '']
      .filter(Boolean)
      .join('\n\n'),
  };
  featuresDoc.features.push(newFeature);
  await writeFile(featuresPath, JSON.stringify(featuresDoc, null, 2), 'utf8');

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

harness.get('/:slug/reviews', (c) => {
  const project = resolvePhasedProject(c.req.param('slug'), phasePhaseLabel(c.req.query('phase')));
  if (!project) return c.json({ error: 'unknown project' }, 404);
  const dir = reviewsDir(project);
  if (!existsSync(dir)) return c.json({ reviews: [] });
  const reviews: PendingReview[] = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.json')) continue;
    try {
      const raw = readFileSync(join(dir, f), 'utf8');
      const obj = JSON.parse(raw) as PendingReview;
      reviews.push(obj);
    } catch {}
  }
  reviews.sort((a, b) => b.ts - a.ts);
  return c.json({ reviews });
});

harness.get('/:slug/reviews/:id', (c) => {
  const project = resolvePhasedProject(c.req.param('slug'), phasePhaseLabel(c.req.query('phase')));
  if (!project) return c.json({ error: 'unknown project' }, 404);
  const id = c.req.param('id').replace(/[^A-Za-z0-9_.-]/g, '');
  const path = join(reviewsDir(project), `${id}.json`);
  const raw = safeRead(path);
  if (!raw) return c.json({ error: 'not found' }, 404);
  return c.json(JSON.parse(raw));
});

harness.post('/:slug/reviews/:id/resolve', async (c) => {
  const project = resolvePhasedProject(c.req.param('slug'), phasePhaseLabel(c.req.query('phase')));
  if (!project) return c.json({ error: 'unknown project' }, 404);
  const id = c.req.param('id').replace(/[^A-Za-z0-9_.-]/g, '');
  const body = await c.req.json() as { response?: string; accept?: boolean };
  const path = join(reviewsDir(project), `${id}.json`);
  const raw = safeRead(path);
  if (!raw) return c.json({ error: 'not found' }, 404);
  const review = JSON.parse(raw) as PendingReview;
  review.resolved = true;
  review.userResponse = body.response ?? (body.accept ? review.recommendedAnswer : '');

  // Append the response to supervisor-notes.md so the harness picks it up.
  const notesPath = join(harnessDir(project), 'supervisor-notes.md');
  const block = `\n## human ${new Date().toISOString()}\n\nReview ${review.id} resolved for ${review.featureId} (${review.kind}):\n\n> ${review.question}\n\nAnswer: ${review.userResponse || '(no text)'}\n`;
  await appendFile(notesPath, block, 'utf8');

  // Move the review to pending-reviews/resolved/ so GET /reviews stops listing it.
  const resolvedDir = join(reviewsDir(project), 'resolved');
  await mkdir(resolvedDir, { recursive: true });
  await writeFile(join(resolvedDir, `${id}.json`), JSON.stringify(review, null, 2), 'utf8');
  try { await unlink(path); } catch {}

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

// Architect chat — streams a single turn via `claude -p`.
// Body: { history: [{role:'user'|'assistant',content:string}], message: string, reviewId?: string }
// Response: text/event-stream; events are `delta` with a text chunk, then `done`.

harness.post('/:slug/architect/chat', async (c) => {
  const project = resolvePhasedProject(c.req.param('slug'), phasePhaseLabel(c.req.query('phase')));
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
  const features = safeRead(join(harnessDir(project), 'features.json')) ?? '';
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

## features.json (summary)
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

  // Stream the response via spawn('claude', ['-p', '--stream-json']).
  return new Response(new ReadableStream({
    async start(controller) {
      const enc = new TextEncoder();
      const send = (event: string, data: string) => {
        controller.enqueue(enc.encode(`event: ${event}\ndata: ${data.replace(/\n/g, '\\n')}\n\n`));
      };

      const claudeBin = process.env.CLAUDE_BIN ?? 'claude';
      const args = ['-p', '--output-format', 'stream-json', '--include-partial-messages', '--verbose'];
      const child = spawn(claudeBin, args, {
        cwd: project.path,
        env: { ...process.env },
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      // Send the prompt on stdin. Claude -p takes the prompt on stdin when
      // piped, so we combine system + user into a single message.
      child.stdin.write(`${systemPrompt}\n\n---\n\n${fullPrompt}\n`);
      child.stdin.end();

      let buf = '';
      let errBuf = '';
      child.stdout.on('data', (chunk: Buffer) => {
        buf += chunk.toString('utf8');
        let nl: number;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl);
          buf = buf.slice(nl + 1);
          if (!line.trim()) continue;
          try {
            const obj = JSON.parse(line);
            // stream-json from claude emits various event shapes. We surface
            // incremental assistant text_deltas to the browser.
            if (obj.type === 'stream_event' && obj.event?.type === 'content_block_delta') {
              const t = obj.event?.delta?.text;
              if (typeof t === 'string') send('delta', t);
            } else if (obj.type === 'assistant' && obj.message?.content) {
              for (const block of obj.message.content) {
                if (block.type === 'text') send('delta', block.text);
              }
            } else if (obj.type === 'result') {
              send('done', JSON.stringify({ cost: obj.total_cost_usd, input: obj.usage?.input_tokens, output: obj.usage?.output_tokens }));
            }
          } catch {}
        }
      });
      child.stderr.on('data', (chunk: Buffer) => { errBuf += chunk.toString('utf8'); });
      child.on('error', (err) => {
        send('error', `spawn: ${err.message}`);
        controller.close();
      });
      child.on('close', (code) => {
        if (code !== 0 && errBuf) send('error', errBuf.slice(0, 500));
        send('done', '{}');
        controller.close();
      });
    },
  }), {
    headers: {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      'connection': 'keep-alive',
    },
  });
});

// Accept an Architect-proposed patch — write it to the target file.
// Body: { target: 'SPEC.md' | 'contract' | 'supervisor-notes', content: string }
harness.post('/:slug/architect/apply', async (c) => {
  const project = resolvePhasedProject(c.req.param('slug'), phasePhaseLabel(c.req.query('phase')));
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
      await appendFile(notesPath, block, 'utf8');
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

harness.get('/:slug/brainstorm', (c) => {
  const project = resolvePhasedProject(c.req.param('slug'), phasePhaseLabel(c.req.query('phase')));
  if (!project) return c.json({ error: 'unknown project' }, 404);
  const content = safeRead(brainstormPath(project)) ?? '';
  return c.json({ content });
});

harness.put('/:slug/brainstorm', async (c) => {
  const project = resolvePhasedProject(c.req.param('slug'), phasePhaseLabel(c.req.query('phase')));
  if (!project) return c.json({ error: 'unknown project' }, 404);
  const body = await c.req.json().catch(() => ({}));
  if (typeof body.content !== 'string') return c.json({ error: 'content required' }, 400);
  await writeFile(brainstormPath(project), body.content, 'utf8');
  return c.json({ ok: true, bytes: body.content.length });
});

harness.get('/:slug/brainstorm-canvas', (c) => {
  const project = resolvePhasedProject(c.req.param('slug'), phasePhaseLabel(c.req.query('phase')));
  if (!project) return c.json({ error: 'unknown project' }, 404);
  const raw = safeRead(brainstormCanvasPath(project));
  if (!raw) return c.json({ scene: null });
  try { return c.json({ scene: JSON.parse(raw) }); }
  catch { return c.json({ scene: null }); }
});

harness.put('/:slug/brainstorm-canvas', async (c) => {
  const project = resolvePhasedProject(c.req.param('slug'), phasePhaseLabel(c.req.query('phase')));
  if (!project) return c.json({ error: 'unknown project' }, 404);
  const body = await c.req.json().catch(() => ({}));
  if (!body.scene) return c.json({ error: 'scene required' }, 400);
  await writeFile(brainstormCanvasPath(project), JSON.stringify(body.scene, null, 2), 'utf8');
  return c.json({ ok: true });
});

// Brainstorm chat — reuses the same Claude CLI pipe as architect/chat
// but with a different system prompt focused on expansive ideation.
harness.post('/:slug/brainstorm/chat', async (c) => {
  const project = resolvePhasedProject(c.req.param('slug'), phasePhaseLabel(c.req.query('phase')));
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
  const features = safeRead(join(harnessDir(project), 'features.json')) ?? '';

  const systemPrompt = `You are a BRAINSTORM PARTNER for a software project. You're chatting with the human supervisor of a coding harness to help them explore ideas before they become features.

Your job: expand the space of possibilities. Suggest analogues, probe "have you considered…", challenge hidden assumptions. You are expansive, not reductive. This is pre-SPEC ideation — nothing needs to be final yet.

Current state:

## SPEC.md
${spec.slice(0, 6000)}

## Existing features.json (summary)
${features.slice(0, 2000)}

## Brainstorm scratchpad (what the user is working on)
${brainstorm.slice(0, 8000)}

Rules:
- Lead with ideas, tradeoffs, analogues from other domains. Be concrete.
- When an idea matures enough to be acted on, emit a fenced action block:
  - \`\`\`promote:feature — append to features.json as a new todo feature. Put a short title on the first line, then markdown body explaining intent + optional claims.
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

  return new Response(new ReadableStream({
    async start(controller) {
      const enc = new TextEncoder();
      const send = (event: string, data: string) => {
        controller.enqueue(enc.encode(`event: ${event}\ndata: ${data.replace(/\n/g, '\\n')}\n\n`));
      };
      const claudeBin = process.env.CLAUDE_BIN ?? 'claude';
      const args = ['-p', '--output-format', 'stream-json', '--include-partial-messages', '--verbose'];
      const child = spawn(claudeBin, args, {
        cwd: project.path,
        env: { ...process.env },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      child.stdin.write(`${systemPrompt}\n\n---\n\n${fullPrompt}\n`);
      child.stdin.end();

      let buf = '';
      let errBuf = '';
      child.stdout.on('data', (chunk: Buffer) => {
        buf += chunk.toString('utf8');
        let nl: number;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl);
          buf = buf.slice(nl + 1);
          if (!line.trim()) continue;
          try {
            const obj = JSON.parse(line);
            if (obj.type === 'stream_event' && obj.event?.type === 'content_block_delta') {
              const t = obj.event?.delta?.text;
              if (typeof t === 'string') send('delta', t);
            } else if (obj.type === 'assistant' && obj.message?.content) {
              for (const block of obj.message.content) {
                if (block.type === 'text') send('delta', block.text);
              }
            } else if (obj.type === 'result') {
              send('done', JSON.stringify({ cost: obj.total_cost_usd }));
            }
          } catch {}
        }
      });
      child.stderr.on('data', (chunk: Buffer) => { errBuf += chunk.toString('utf8'); });
      child.on('error', (err) => {
        send('error', `spawn: ${err.message}`);
        controller.close();
      });
      child.on('close', (code) => {
        if (code !== 0 && errBuf) send('error', errBuf.slice(0, 500));
        send('done', '{}');
        controller.close();
      });
    },
  }), {
    headers: {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      'connection': 'keep-alive',
    },
  });
});

// Brainstorm promote — takes content from chat or a selection and
// routes it into features.json, SPEC.md, or issues.json.
harness.post('/:slug/brainstorm/promote', async (c) => {
  const project = resolvePhasedProject(c.req.param('slug'), phasePhaseLabel(c.req.query('phase')));
  if (!project) return c.json({ error: 'unknown project' }, 404);
  const body = await c.req.json().catch(() => ({}));
  const target = body.target as 'feature' | 'spec' | 'issue';
  const content = typeof body.content === 'string' ? body.content : '';
  if (!target || !content.trim()) return c.json({ error: 'target + content required' }, 400);

  if (target === 'feature') {
    const featuresPath = join(harnessDir(project), 'features.json');
    let doc: { features: any[] };
    try { doc = JSON.parse(readFileSync(featuresPath, 'utf8')); }
    catch { doc = { features: [] }; }
    const existingIdeaIds = doc.features
      .map((f: any) => (typeof f.id === 'string' && f.id.startsWith('F-IDEA-') ? Number(f.id.slice(7)) : 0))
      .filter((n) => Number.isFinite(n));
    const n = (existingIdeaIds.length ? Math.max(...existingIdeaIds) : 0) + 1;
    const id = `F-IDEA-${String(n).padStart(3, '0')}`;
    const [firstLine, ...rest] = content.trim().split('\n');
    doc.features.push({
      id,
      title: firstLine.trim().slice(0, 200),
      claims: [],
      status: 'todo',
      attempts: 0,
      source: 'brainstorm',
      notes: rest.join('\n').trim(),
    });
    await writeFile(featuresPath, JSON.stringify(doc, null, 2), 'utf8');
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

harness.get('/:slug/memory', (c) => {
  const project = resolvePhasedProject(c.req.param('slug'), phasePhaseLabel(c.req.query('phase')));
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

harness.get('/:slug/memory-file', (c) => {
  const project = resolvePhasedProject(c.req.param('slug'), phasePhaseLabel(c.req.query('phase')));
  if (!project) return c.json({ error: 'unknown project' }, 404);
  const path = c.req.query('path');
  if (!path) return c.json({ error: 'path required' }, 400);
  const r = resolveMemoryPath(project, path);
  if (!r) return c.json({ error: 'invalid path' }, 400);
  const { tier, meta } = detectTier(path);
  let content: string | null = null;
  let mtimeMs: number | null = null;
  let size = 0;
  try {
    content = readFileSync(r.abs, 'utf8');
    const s = statSync(r.abs);
    mtimeMs = s.mtimeMs;
    size = s.size;
  } catch {}
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
  const project = resolvePhasedProject(c.req.param('slug'), phasePhaseLabel(c.req.query('phase')));
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

  // Ensure parent dir exists
  const dir = r.abs.split('/').slice(0, -1).join('/');
  await mkdir(dir, { recursive: true });

  // Atomic write
  const tmp = `${r.abs}.tmp.${Date.now()}`;
  await writeFile(tmp, body.content, 'utf8');
  await rename(tmp, r.abs);

  return c.json({ ok: true, path: body.path, tier, wroteBytes: body.content.length });
});

// ─── MCP servers (.mcp.json at project root) ────────────────────────

function mcpPath(project: ProjectEntry): string {
  return join(project.path, '.mcp.json');
}

harness.get('/:slug/mcp', (c) => {
  const project = resolvePhasedProject(c.req.param('slug'), phasePhaseLabel(c.req.query('phase')));
  if (!project) return c.json({ error: 'unknown project' }, 404);
  const content = safeRead(mcpPath(project)) ?? '';
  return c.json({ content });
});

harness.put('/:slug/mcp', async (c) => {
  const project = resolvePhasedProject(c.req.param('slug'), phasePhaseLabel(c.req.query('phase')));
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
    return c.json({ ok: true, deleted: true });
  }
  await writeFile(path, body.content, 'utf8');
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

harness.get('/:slug/skills', (c) => {
  const project = resolvePhasedProject(c.req.param('slug'), phasePhaseLabel(c.req.query('phase')));
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

harness.get('/:slug/skills/:name', (c) => {
  const project = resolvePhasedProject(c.req.param('slug'), phasePhaseLabel(c.req.query('phase')));
  if (!project) return c.json({ error: 'unknown project' }, 404);
  const name = safeName(c.req.param('name'));
  if (!name) return c.json({ error: 'bad name' }, 400);
  const content = safeRead(join(skillsDir(project), name)) ?? '';
  return c.json({ name, content });
});

harness.put('/:slug/skills/:name', async (c) => {
  const project = resolvePhasedProject(c.req.param('slug'), phasePhaseLabel(c.req.query('phase')));
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
  const project = resolvePhasedProject(c.req.param('slug'), phasePhaseLabel(c.req.query('phase')));
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

harness.get('/:slug/supervisor-notes', (c) => {
  const project = resolvePhasedProject(c.req.param('slug'), phasePhaseLabel(c.req.query('phase')));
  if (!project) return c.json({ error: 'unknown project' }, 404);
  return c.json({ content: safeRead(supervisorPath(project)) ?? '' });
});

harness.put('/:slug/supervisor-notes', async (c) => {
  const project = resolvePhasedProject(c.req.param('slug'), phasePhaseLabel(c.req.query('phase')));
  if (!project) return c.json({ error: 'unknown project' }, 404);
  const body = await c.req.json().catch(() => ({}));
  if (typeof body.content !== 'string') return c.json({ error: 'content required' }, 400);
  await writeFile(supervisorPath(project), body.content, 'utf8');
  return c.json({ ok: true });
});

harness.post('/:slug/supervisor-notes/append', async (c) => {
  const project = resolvePhasedProject(c.req.param('slug'), phasePhaseLabel(c.req.query('phase')));
  if (!project) return c.json({ error: 'unknown project' }, 404);
  const body = await c.req.json().catch(() => ({}));
  const text = typeof body.text === 'string' ? body.text.trim() : '';
  if (!text) return c.json({ error: 'text required' }, 400);
  const speaker = typeof body.by === 'string' && body.by.trim() ? body.by.trim() : 'human';
  const block = `\n## ${speaker} ${new Date().toISOString()}\n\n${text}\n`;
  await appendFile(supervisorPath(project), block, 'utf8');
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

harness.get('/:slug/prompts', (c) => {
  const project = resolvePhasedProject(c.req.param('slug'), phasePhaseLabel(c.req.query('phase')));
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

harness.get('/:slug/prompts/:role', (c) => {
  const project = resolvePhasedProject(c.req.param('slug'), phasePhaseLabel(c.req.query('phase')));
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
  const project = resolvePhasedProject(c.req.param('slug'), phasePhaseLabel(c.req.query('phase')));
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
  const project = resolvePhasedProject(c.req.param('slug'), phasePhaseLabel(c.req.query('phase')));
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

harness.get('/:slug/claude-settings', (c) => {
  const project = resolvePhasedProject(c.req.param('slug'), phasePhaseLabel(c.req.query('phase')));
  if (!project) return c.json({ error: 'unknown project' }, 404);
  return c.json({ content: safeRead(claudeSettingsPath(project)) ?? '' });
});

harness.put('/:slug/claude-settings', async (c) => {
  const project = resolvePhasedProject(c.req.param('slug'), phasePhaseLabel(c.req.query('phase')));
  if (!project) return c.json({ error: 'unknown project' }, 404);
  const body = await c.req.json().catch(() => ({}));
  if (typeof body.content !== 'string') return c.json({ error: 'content required' }, 400);
  if (body.content.trim()) {
    try { JSON.parse(body.content); }
    catch (e: any) { return c.json({ error: `invalid JSON: ${e.message}` }, 400); }
  }
  const path = claudeSettingsPath(project);
  const dir = join(project.path, '.claude');
  if (!existsSync(dir)) {
    const { mkdir } = await import('node:fs/promises');
    await mkdir(dir, { recursive: true });
  }
  if (!body.content.trim()) {
    try { await unlink(path); } catch {}
    return c.json({ ok: true, deleted: true });
  }
  await writeFile(path, body.content, 'utf8');
  return c.json({ ok: true });
});

// ─── .env (read+write, with explicit confirmation header) ────────────
//
// Secrets pass through the wire and sit in browser memory when this tab is
// open. The UI includes a prominent warning. Value masking happens client-side.

function envPath(project: ProjectEntry): string {
  return join(project.path, '.env');
}

harness.get('/:slug/env', (c) => {
  const project = resolvePhasedProject(c.req.param('slug'), phasePhaseLabel(c.req.query('phase')));
  if (!project) return c.json({ error: 'unknown project' }, 404);
  return c.json({ content: safeRead(envPath(project)) ?? '' });
});

harness.put('/:slug/env', async (c) => {
  const project = resolvePhasedProject(c.req.param('slug'), phasePhaseLabel(c.req.query('phase')));
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

type Phase = 'staging' | 'testing' | 'production';
const PHASE_ORDER: Phase[] = ['staging', 'testing', 'production'];

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

// Find the path for a given phase: staging = project.path, testing/prod =
// sibling convention `<path>--<phase>` OR explicit override from config.json.
function phasePath(project: ProjectEntry, phase: Phase): string {
  if (phase === 'staging') return project.path;
  // Honor config override if present
  try {
    const raw = safeRead(join(project.path, '.harness', 'config.json'));
    if (raw) {
      const cfg = JSON.parse(raw);
      const override = cfg?.phases?.[phase]?.path;
      if (typeof override === 'string' && override.length > 0) return override;
    }
  } catch {}
  return `${project.path}--${phase}`;
}

function phasePhaseLabel(rawPhase: string | undefined): Phase {
  if (rawPhase === 'testing' || rawPhase === 'production' || rawPhase === 'staging') return rawPhase;
  return 'staging';
}

// Override existing resolveProject fetches so ?phase= can route to a sibling
// worktree. The cleanest backwards-compatible path is a helper that returns
// a "virtual project" pointing at the right worktree.
function resolvePhasedProject(slug: string, phase: Phase | undefined): ProjectEntry | null {
  const base = resolveProject(slug);
  if (!base) return null;
  if (!phase || phase === 'staging') return base;
  const p = phasePath(base, phase);
  return { ...base, path: p };
}

async function computePhaseInfo(project: ProjectEntry, phase: Phase): Promise<PhaseInfo> {
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

  // features / counts
  const feats = await parseFeatures(scopedProject);
  const counts = feats.reduce((a: Record<string, number>, f: any) => { a[f.status] = (a[f.status] ?? 0) + 1; return a; }, {} as Record<string, number>);
  const passed = counts.passed ?? 0;
  const total = feats.length;

  // cost via the shared cached helper (same as /status uses).
  const cost = aggregateCostFromLogDir(join(path, '.harness', 'logs')).cost;

  // iteration from run.log
  let iteration = 0;
  try {
    const runLog = tailFile(join(path, '.harness', 'logs', 'run.log'), 16 * 1024);
    const m = [...runLog.matchAll(/── iteration (\d+) ──/g)];
    if (m.length) iteration = Number(m[m.length - 1][1]);
  } catch {}

  // alive: run.sh proc with cwd inside this path
  let alive = false;
  try {
    const procs = readdirSync('/proc').filter((d) => /^\d+$/.test(d));
    for (const pid of procs) {
      try {
        const cwd = readFileSync(`/proc/${pid}/cwd`, 'utf8').trim();
        if (cwd.startsWith(path)) {
          const cmdline = readFileSync(`/proc/${pid}/cmdline`, 'utf8');
          if ((cmdline.includes('autonomous-harness/run.sh') || cmdline.includes('/harness/run.sh'))) { alive = true; break; }
        }
      } catch {}
    }
  } catch {}

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
  const project = resolvePhasedProject(c.req.param('slug'), phasePhaseLabel(c.req.query('phase')));
  if (!project) return c.json({ error: 'unknown project' }, 404);
  const out = await Promise.all(PHASE_ORDER.map((p) => computePhaseInfo(project, p)));
  return c.json({ phases: out });
});

harness.post('/:slug/phases/setup', async (c) => {
  const project = resolvePhasedProject(c.req.param('slug'), phasePhaseLabel(c.req.query('phase')));
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
  const project = resolvePhasedProject(c.req.param('slug'), phasePhaseLabel(c.req.query('phase')));
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
  await writeFile(join(reviewsDir, `${id}.json`), JSON.stringify(item, null, 2), 'utf8');

  // Signal the orchestrator via supervisor-notes.md
  const notesPath = join(fromPath, '.harness', 'supervisor-notes.md');
  const block = `\n## promotion ${new Date().toISOString()}\n\nFeature freeze initiated. Only process failing features. Emit promotion-handoff.md when all features passed.\nPromotion item: ${id}\n`;
  await appendFile(notesPath, block, 'utf8');

  return c.json({ ok: true, item });
});

harness.post('/:slug/promote/:id/confirm', async (c) => {
  const project = resolvePhasedProject(c.req.param('slug'), phasePhaseLabel(c.req.query('phase')));
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

  // Record in promotion-log.json (in the dest worktree)
  const logPath = join(toPath, '.harness', 'promotion-log.json');
  let log: any = { promotions: [] };
  try { const raw = safeRead(logPath); if (raw) log = JSON.parse(raw); } catch {}
  let newSha = '';
  try { newSha = execFileSync('git', ['-C', toPath, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(); } catch {}
  log.promotions = log.promotions ?? [];
  log.promotions.push({ id: obj.id, from, to, ts: Math.floor(Date.now() / 1000), sha: newSha });
  await writeFile(logPath, JSON.stringify(log, null, 2), 'utf8');

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
  const project = resolvePhasedProject(c.req.param('slug'), phasePhaseLabel(c.req.query('phase')));
  if (!project) return c.json({ error: 'unknown project' }, 404);
  const body = await c.req.json() as { phase?: string };
  const phase = phasePhaseLabel(body.phase);
  const path = phasePath(project, phase);
  if (!existsSync(path)) return c.json({ error: `no worktree for ${phase}` }, 400);

  const logPath = join(path, '.harness', 'promotion-log.json');
  const raw = safeRead(logPath);
  if (!raw) return c.json({ error: 'no promotion-log.json' }, 400);
  const log = JSON.parse(raw) as { promotions: Array<{ id: string; sha: string; ts: number }> };
  const promotions = log.promotions ?? [];
  if (promotions.length < 2) return c.json({ error: 'no previous promotion to roll back to' }, 400);
  const prior = promotions[promotions.length - 2];

  try {
    execFileSync('git', ['-C', path, 'reset', '--hard', prior.sha], { encoding: 'utf8' });
  } catch (e: any) {
    return c.json({ error: `rollback failed: ${String(e?.stderr ?? e?.message ?? e)}` }, 500);
  }

  log.promotions.push({ id: `rollback-${Date.now()}`, from: phase, to: phase, ts: Math.floor(Date.now() / 1000), sha: prior.sha } as any);
  await writeFile(logPath, JSON.stringify(log, null, 2), 'utf8');

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

harness.get('/:slug/tests', (c) => {
  const project = resolvePhasedProject(c.req.param('slug'), phasePhaseLabel(c.req.query('phase')));
  if (!project) return c.json({ error: 'unknown project' }, 404);
  const phase = phasePhaseLabel(c.req.query('phase'));
  return c.json({ tests: readTests(project, phase), phase });
});

harness.post('/:slug/tests/:id/run', async (c) => {
  const project = resolvePhasedProject(c.req.param('slug'), phasePhaseLabel(c.req.query('phase')));
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
