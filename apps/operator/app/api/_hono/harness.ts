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
import { papercuspPath } from '@/lib/papercusp-root';
import { DECISION_VERBS } from '@papercusp/orchestrator/decision-parse';
import { readFile, writeFile, unlink, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { harnessPackageDir, harnessPath } from '@/lib/harness-paths';

import { spawn, execFile } from 'node:child_process';
import { runAgentChat } from '@/lib/agent-chat-stream';
import { promisify } from 'node:util';
import {
  getLegacyClient,
  slugToSchemaName,
  getOrgPg,
  getHarnessPg,
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
import { phasePhaseLabel } from '@/lib/harness-phases';
import { scanAgentRunsCached, syncAgentRunsToPg } from '@/lib/harness-agent-runs';
import { activeStreams, HARNESS_STREAM_TOTAL_CAP, type StreamToken } from '@/lib/harness-active-streams';

import {
  countPulsesFromRunLog,
  aggregateCostFromLogDir,
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

import { getHarnessAdminUrl } from '@/lib/embedded-pg-discovery';
import {
  loadHarnessRegistry,
  saveHarnessRegistry,
  type HarnessRegistry as RegistryFile,
} from '@/lib/harness-registry';


// Single source of truth: harness_shared.harness_registry (PG).
// Per-workspace scoping via the workspace_id PK column.
const loadRegistry = loadHarnessRegistry;
const saveRegistry = saveHarnessRegistry;





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






