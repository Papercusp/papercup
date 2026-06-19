/**
 * Harness reader helpers — non-route operations shared by route handlers
 * and external callers.
 *
 * Relocated from `app/api/_hono/harness.ts` (endpoint-hono-elimination
 * -2026-05-21 A4 first batch). Routes still live in the legacy file for
 * now; subsequent A4 batches migrate them to `defineTool` modules. This
 * carve-out lets `lib/*` callers stop importing from `app/api/_hono/*`,
 * breaking the layering violation.
 *
 * Caches in this module are pinned to `globalThis` so Next dev module
 * re-evaluation doesn't reset them per request — same pattern as the
 * original harness.ts. See /docs/performance #A5.
 */
import {
  readFileSync, readlinkSync, existsSync, readdirSync, statSync,
  openSync, readSync, closeSync,
} from 'node:fs';
import { join } from 'node:path';
import { getLegacyClient } from '@papercusp/db-org';
import {
  HARNESS_SHARED_CONFIG_REL_PATH,
  isHarnessSharedConfig,
} from './harness/harness-shared-config-types';

import { loadHarnessRegistry, type ProjectEntry } from './harness-registry';
import { readRegistry, activeWorkspaceId } from './workspace-registry';
import { type Phase, phasePath } from './harness-phases';

/* ─────────────────────────────────────────────────────────────────────
 * tailLastResultLine — internal, used by aggregateCostFromLogDir.
 * Reads the last ~8KB of a .jsonl file and returns the last
 * `{"type":"result", ...}` object found there.
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

/* ─────────────────────────────────────────────────────────────────────
 * countPulsesFromRunLog — total `── iteration N ──` lines across run.log.
 * Incrementally cached; re-scans only the bytes appended since the last
 * cache hit. Eviction implicit when mtime moves backwards (rotation).
 * ───────────────────────────────────────────────────────────────────── */

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
  if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) {
    return cached.count;
  }

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

/* ─────────────────────────────────────────────────────────────────────
 * aggregateCostFromLogDir — per-dir + per-file mtime-keyed cache over the
 * tailed `{"type":"result"}` lines of every .jsonl in the log dir.
 * ───────────────────────────────────────────────────────────────────── */

export interface CostAggregate { cost: number; inputTokens: number; outputTokens: number }

type CostCacheEntry = { sig: string; expires: number; value: CostAggregate };
const __costCacheKey = '__papercuspCostCache';
type CostCacheGlobals = { [__costCacheKey]?: Map<string, CostCacheEntry> };
const __costCache: Map<string, CostCacheEntry> = (() => {
  const g = globalThis as CostCacheGlobals;
  if (!g[__costCacheKey]) g[__costCacheKey] = new Map();
  return g[__costCacheKey]!;
})();

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

/* ─────────────────────────────────────────────────────────────────────
 * Project lookups
 * ───────────────────────────────────────────────────────────────────── */

export async function resolveProject(
  slug: string,
  workspaceId?: string,
): Promise<ProjectEntry | null> {
  // Pass workspaceId so callers (e.g. a durable pipeline) can resolve in a FIXED
  // workspace rather than the volatile active one — the active workspace can
  // switch mid-flight (desktop UI), which would otherwise break in-flight runs.
  const reg = await loadHarnessRegistry(workspaceId);
  const hit = reg.projects.find((p) => p.slug === slug);
  if (hit) return hit;

  // Cross-workspace fallback (resolution safety net). A harness is registered in
  // a SPECIFIC workspace, but the active workspace flaps — multiple SU agents +
  // the desktop switch `registry.current` under us, and each harness typically
  // lives in only ONE workspace. Resolving a NAMED slug must not silently 404
  // just because the active workspace happens not to carry it: every harness
  // route (status / prompts / features / run / …) funnels through here, so
  // without this the operator can only ever touch the *currently-active*
  // workspace's harnesses. Safe because results + the on-disk folder are SHARED
  // by slug (D-1, link-not-move) — whichever workspace carries the slug resolves
  // the same path. Skipped when the caller PINNED a workspace (durable pipelines
  // pass workspaceId): those must stay in their fixed workspace, miss and all.
  if (workspaceId !== undefined) return null;
  try {
    for (const ws of readRegistry().workspaces) {
      const other = await loadHarnessRegistry(ws.id);
      const match = other.projects.find((p) => p.slug === slug);
      if (match) return match;
    }
  } catch { /* registry unreadable → fall through to null */ }
  return null;
}

/**
 * Resolve a harness slug → the workspace_id that carries it, via the AUTHORITATIVE
 * harness registry (`harness_shared.harness_registry` — what hive:create /
 * harness:create write and the work-items path reads). This is the de-facto
 * source of truth for the generic/hive world; `harness_shared.projects` is only
 * the org/department blueprint's PROJECTION (business cols owning_dept/vertical/
 * budget; the sole non-test writer is execute-action.ts' project-create), so a
 * non-papercup harness is resolvable HERE but absent THERE. Plan-scope resolution
 * (resolvePlanScope → fill_workspace_id_from_projects) falls back to this so a
 * hive's plans resolve the same way its work-items already do (closes the
 * split-registry asymmetry — peers su-a7f66 / su-632e0166, sibling EI-1511).
 *
 * Deterministic + confined-by-default:
 *   1. ACTIVE-workspace-FIRST — if the active session workspace carries the slug,
 *      return it, so a scoped session resolves its OWN workspace and never a
 *      foreign one (composes with the scoped-superuser workspace clamp, P-017 —
 *      do not turn this into a cross-workspace read vector).
 *   2. else cross-workspace fallback for an UNSCOPED caller — scan every
 *      workspace's registry: exactly one carrier → that workspace; TWO+ → THROW
 *      (a genuine cross-workspace slug collision, never picked silently); none →
 *      null (the caller fails loud).
 */
export async function resolveWorkspaceForHarnessSlug(slug: string): Promise<string | null> {
  const raw = slug?.trim();
  if (!raw) return null;
  // 1. Active-workspace-first (confined by default).
  const activeWs = activeWorkspaceId();
  try {
    const activeReg = await loadHarnessRegistry(activeWs);
    if (activeReg.projects.some((p) => p.slug === raw)) return activeWs;
  } catch { /* active registry unreadable → fall through to the cross-ws scan */ }
  // 2. Cross-workspace fallback (unscoped caller) — collision-aware.
  const carriers = new Set<string>();
  try {
    for (const ws of readRegistry().workspaces) {
      if (ws.id === activeWs) continue; // already checked in step 1
      const reg = await loadHarnessRegistry(ws.id);
      if (reg.projects.some((p) => p.slug === raw)) carriers.add(ws.id);
    }
  } catch { /* registry unreadable → treat as no cross-ws carriers */ }
  if (carriers.size === 0) return null;
  if (carriers.size > 1) {
    throw new Error(
      `resolveWorkspaceForHarnessSlug: harness slug '${raw}' is registered in ` +
        `${carriers.size} workspaces (${[...carriers].join(', ')}) and none is the active ` +
        `workspace ('${activeWs}'). Ambiguous cross-workspace collision — pass an explicit ` +
        `workspaceId to disambiguate.`,
    );
  }
  return [...carriers][0]!;
}

export function harnessDir(project: ProjectEntry): string {
  return join(project.path, '.papercusp');
}

export function safeRead(path: string): string | null {
  try { return readFileSync(path, 'utf8'); } catch { return null; }
}

/* ─────────────────────────────────────────────────────────────────────
 * Liveness — walk /proc looking for a harness driver process whose
 * cwd lives under projectPath. Cached for 2s; concurrent requests share
 * one walk via the cached value.
 * ───────────────────────────────────────────────────────────────────── */

/**
 * Single source of truth for "is this cmdline a harness driver process?".
 *
 * Matches the legacy bash driver: `autonomous-harness/run.sh` or
 * `/harness/run.sh`. (The TS-orchestrator `orchestrator/bin/run.ts` cmdline
 * match was removed 2026-06-06 — that entrypoint was archived with the legacy
 * run-loop; the live pipeline is the DBOS orchestrator, which runs in-process
 * and is not a separate driver process.)
 */
export function isHarnessDriverCmdline(cmdline: string): boolean {
  return (
    cmdline.includes('autonomous-harness/run.sh') ||
    cmdline.includes('/harness/run.sh')
  );
}

function scanForRunShCwd(projectPath: string): boolean {
  try {
    const procs = readdirSync('/proc');
    for (const pid of procs) {
      if (!/^\d+$/.test(pid)) continue;
      try {
        const cwd = readlinkSync(`/proc/${pid}/cwd`);
        if (!cwd.startsWith(projectPath)) continue;
        const cmdline = readFileSync(`/proc/${pid}/cmdline`, 'utf8');
        if (isHarnessDriverCmdline(cmdline)) return true;
      } catch { /* perm-denied PID — skip */ }
    }
  } catch { /* /proc unreadable — fall through */ }
  return false;
}

const __aliveCacheKey = Symbol.for('papercusp.harnessAliveCache');
type AliveCacheGlobals = typeof globalThis & {
  [__aliveCacheKey]?: Map<string, { value: boolean; expires: number; pending: Promise<boolean> | null }>;
};
const __aliveCache: Map<string, { value: boolean; expires: number; pending: Promise<boolean> | null }> = (() => {
  const g = globalThis as AliveCacheGlobals;
  if (!g[__aliveCacheKey]) g[__aliveCacheKey] = new Map();
  return g[__aliveCacheKey]!;
})();

export function isProjectAlive(projectPath: string, ttlMs = 2000): boolean {
  const now = Date.now();
  const cached = __aliveCache.get(projectPath);
  if (cached && cached.expires > now) return cached.value;
  const value = scanForRunShCwd(projectPath);
  __aliveCache.set(projectPath, { value, expires: now + ttlMs, pending: null });
  return value;
}

/* ─────────────────────────────────────────────────────────────────────
 * parseFeatures — read harness_features from the per-harness PG schema.
 * ───────────────────────────────────────────────────────────────────── */

export function rowToFeature(r: any): any {
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
    // G1 Provenance (P-004): expose origin + author_pubkey so G2 (auditor) and
    // the UI can read the "is this mine?" signal. Rows inserted before migration
    // 097 have origin='local' by default (via column DEFAULT).
    origin: (r.origin as 'local' | 'remote') ?? 'local',
    author_pubkey: r.author_pubkey ?? null,
  };
}

export async function parseFeatures(project: ProjectEntry): Promise<any[]> {
  try {
    const c = getLegacyClient(project.slug);
    const rows = await c.prepare(`
      SELECT * FROM harness_features WHERE harness_slug = ? ORDER BY feature_id
    `).all(project.slug) as any[];
    return rows.map(rowToFeature);
  } catch {
    return [];
  }
}

/* ─────────────────────────────────────────────────────────────────────
 * tailFile — read only the last `maxBytes` of a file via openSync +
 * readSync(offset). Avoids the readFileSync().slice() whole-file alloc.
 * ───────────────────────────────────────────────────────────────────── */

export function tailFile(path: string, maxBytes = 64 * 1024): string {
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

/* ─────────────────────────────────────────────────────────────────────
 * Phase resolution — ?phase= routes pick a sibling worktree.
 * ───────────────────────────────────────────────────────────────────── */

export async function resolvePhasedProject(slug: string, phase: Phase | undefined): Promise<ProjectEntry | null> {
  const base = await resolveProject(slug);
  if (!base) return null;
  if (!phase || phase === 'staging') return base;
  // When the harness-phases flag is OFF, treat every phase as the base
  // project. The phase-suffixed worktrees (sheets-clone--production etc.)
  // only exist for users who explicitly opted into phases — for everyone
  // else, "production" is just a UI label, not a separate worktree.
  const { getFlag } = await import('@papercusp/flags/server');
  const { FLAGS } = await import('@papercusp/flags');
  const phasesEnabled = await getFlag(FLAGS.HARNESS_PHASES, 'system');
  if (!phasesEnabled) return base;
  const p = phasePath(base, phase);
  return { ...base, path: p };
}

/* ─────────────────────────────────────────────────────────────────────
 * getHarnessStatusFull — rich status payload (project + features + cost
 * + liveness + checkpoints + escalation). Shared between desktop and
 * mobile harness-status routes so both see the same shape.
 * ───────────────────────────────────────────────────────────────────── */

export async function getHarnessStatusFull(
  slug: string,
  phaseOverride?: Phase,
): Promise<Record<string, unknown> | null> {
  const project = await resolvePhasedProject(slug, phaseOverride);
  if (!project) return null;

  const features = await parseFeatures(project);
  const counts = features.reduce((acc, f) => {
    acc[f.status] = (acc[f.status] ?? 0) + 1;
    return acc;
  }, {} as Record<string, number>);

  const runLogPath = join(harnessDir(project), 'logs', 'run.log');
  const runLog = tailFile(runLogPath, 16 * 1024);
  const decisionMatch = [...runLog.matchAll(/ORCH decision: (\S[^\n]*)/g)];
  const lastDecision = decisionMatch.length ? decisionMatch[decisionMatch.length - 1][1] : null;
  const iteration = countPulsesFromRunLog(runLogPath);
  const escalation = safeRead(join(harnessDir(project), 'escalation.md'));
  const __agg = aggregateCostFromLogDir(join(harnessDir(project), 'logs'));
  const alive = isProjectAlive(project.path);

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

  let discord_channel_url: string | null = null;
  try {
    const sharedRaw = safeRead(join(project.path, HARNESS_SHARED_CONFIG_REL_PATH));
    if (sharedRaw) {
      const parsed: unknown = JSON.parse(sharedRaw);
      if (isHarnessSharedConfig(parsed) && parsed.discord_channel) {
        discord_channel_url = parsed.discord_channel;
      }
    }
  } catch {}

  return {
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
    missionCostUsd: __agg.cost,
    missionInputTokens: __agg.inputTokens,
    missionOutputTokens: __agg.outputTokens,
    discord_channel_url,
  };
}

