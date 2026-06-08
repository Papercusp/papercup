/**
 * Top-level harness registry routes:
 *
 *   GET    /api/harness/projects/lite     — small payload for sidebar polling
 *   GET    /api/harness/projects          — full enriched list (parent_slug + hasState + hasSpec)
 *   POST   /api/harness/projects          — register a new harness in the workspace
 *   DELETE /api/harness/projects/:slug    — remove a harness from the workspace
 *
 * Relocated from `_hono/harness.ts` (endpoint-hono-elimination-2026-05-21
 * A4 batch 44 — the final batch; harness.ts itself is empty after this).
 */
import { existsSync, statSync } from 'node:fs';
import { workspacesRoot } from '../../../workspace-registry';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { getLegacyClient } from '@papercusp/db-org';
import {
  loadHarnessRegistry,
  saveHarnessRegistry,
} from '../../../harness-registry';
import { harnessDir } from '../../../harness-core';
import { groupByHive, HIVE_KIND, type HiveGroupProject } from '../../../harness/hive-groups';
import { defineTool } from '@papercusp/agent-mcp';

// SSR self-fetch site for /harness/<slug>/page.tsx — every page render
// fans through here. On dev, Turbopack's per-request route re-eval flaps
// it 14ms-2.3s; under page-load contention the cold path lands at the
// 2s end and dominates TTFB. Cached.
interface LiteCacheEntry {
  ts: number;
  payload: unknown;
}
const __liteKey = Symbol.for('papercusp.harnessProjectsLiteCache');
type LiteGlobals = typeof globalThis & { [__liteKey]?: LiteCacheEntry };
const LITE_TTL_MS = 1000;

const lite = defineTool({
  method: 'GET',
  path: '/harness/projects/lite',
  auth: 'public',
  async handler() {
    const g = globalThis as LiteGlobals;
    const now = Date.now();
    const hit = g[__liteKey];
    if (hit && now - hit.ts < LITE_TTL_MS) {
      return Response.json(hit.payload as object);
    }
    const reg = await loadHarnessRegistry();
    // P-012: surface `parent_slug` + `harness_kind` so the AdvShell
    // selector can render a tree (P-014) without paying the full
    // /projects round-trip. parent_slug is a scaffold-time harness contract
    // artifact in .papercusp/config.json (NOT a migrated HarnessConfig field —
    // deprecate-harness-config-json-2026-06-06 D-005); the file persists for it.
    const projects = await Promise.all(reg.projects.map(async (p) => {
      const hDir = harnessDir(p);
      const cfgPath = join(p.path, '.papercusp', 'config.json');
      let parentSlug: string | null = null;
      try {
        if (existsSync(cfgPath)) {
          const txt = await readFile(cfgPath, 'utf8');
          const j = JSON.parse(txt) as { parent_slug?: unknown };
          parentSlug = typeof j?.parent_slug === 'string' && j.parent_slug ? j.parent_slug : null;
        }
      } catch { /* ignore — bad config = no parent */ }
      const isShared = existsSync(join(p.path, '.papercusp', 'shared.json'));
      return {
        slug: p.slug,
        path: p.path,
        harness_kind: (p as { harness_kind?: string }).harness_kind ?? null,
        // FORMAL Hive membership (shared-hive-federation): a registry field, so
        // grouping over it needs no PG `hives`-table read (harnesses-tab P-021).
        hive_slug: (p as { hive_slug?: string }).hive_slug ?? null,
        parent_slug: parentSlug,
        is_shared: isShared,
        hasState: existsSync(hDir),
        hasSpec: existsSync(join(p.path, 'SPEC.md')),
        harnessDir: hDir,
      };
    }));
    // P-021 — the registry exposes the Hive grouping NATIVELY so the client
    // (buildHarnessSelectOptions, member rail, all-mode cards) stops
    // tree-inferring it. Grouped over the formal `harness_kind:'hive'` home +
    // `hive_slug`, with `parent_slug` legacy fallback (D-002/D-008 seam).
    const hives = groupByHive(projects as unknown as HiveGroupProject[]);
    const payload = { projects, hives };
    g[__liteKey] = { ts: Date.now(), payload };
    return Response.json(payload);
  },
});

// Cache the /projects payload — the underlying data (registry contents,
// SPEC.md presence, parent_slug, hasState) only changes when a harness is
// spawned/forked/deleted. Without this, /projects opens N per-slug PG
// connections per call; under c=10 that's 10×70 ≈ 700 connections in
// flight. With a 5s TTL keyed on the registry mtime, concurrent callers
// share one walk; the cache busts when the registry file is rewritten.
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

const list = defineTool({
  method: 'GET',
  path: '/harness/projects',
  auth: 'public',
  async handler(req) {
    const url = new URL(req.url);
    const reg = await loadHarnessRegistry();
    const filterParentSlug = url.searchParams.get('parent_slug');

    let sig = `n=${reg.projects.length}|slugs=${reg.projects.map((p) => p.slug).join(',')}`;
    try {
      const wsPath = join(workspacesRoot(), 'registry.json');
      const legacyPath = join(homedir(), '.restart-harness-projects.json');
      if (existsSync(wsPath)) sig += `|m=${statSync(wsPath).mtimeMs}`;
      if (existsSync(legacyPath)) sig += `|lm=${statSync(legacyPath).mtimeMs}`;
    } catch { /* ignore */ }

    const now = Date.now();
    const TTL_MS = 5_000;

    let enriched = __projectsCache.value;
    if (!(enriched && __projectsCache.sig === sig && __projectsCache.expires > now)) {
      if (!__projectsCache.inflight || __projectsCache.sig !== sig) {
        __projectsCache.sig = sig;
        __projectsCache.inflight = (async () => {
          const out = await Promise.all(reg.projects.map(async (p) => {
            const hDir = harnessDir(p);
            const cfgPath = join(p.path, '.papercusp', 'config.json');
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
                  const c2 = getLegacyClient(p.slug);
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
          __projectsCache.value = out;
          __projectsCache.expires = Date.now() + TTL_MS;
          __projectsCache.inflight = null;
          return out;
        })();
      }
      enriched = await __projectsCache.inflight;
    }

    const filtered = filterParentSlug
      ? (enriched as Array<{ parent_slug: string | null }>).filter((p) => p.parent_slug === filterParentSlug)
      : enriched;
    return Response.json({ projects: filtered });
  },
});

const create = defineTool({
  method: 'POST',
  path: '/harness/projects',
  auth: 'public',
  async handler(req) {
    const body = (await req.json()) as Record<string, unknown>;
    const slug = String(body.slug ?? '').trim();
    if (!slug) return Response.json({ error: 'slug required' }, { status: 400 });

    const reg = await loadHarnessRegistry();
    if (reg.projects.some((p) => p.slug === slug)) {
      return Response.json({ error: 'slug already exists' }, { status: 409 });
    }

    // P-011 (harnesses-tab-hive-model) — "add into hive": when the picker's
    // add-into-hive mode passes `hive` (the current `?slug=` scope), stamp the
    // membership edge to that scope. Validate FAIL-FAST here, before any dir/
    // clone side effect (mirrors harness:create's gate). Membership precedence
    // matches the grouping (hive-groups.ts): a FORMAL `kind:'hive'` home → the
    // `hive_slug` registry field (shared-hive-federation); a legacy root scope →
    // `parent_slug` in the new harness's .papercusp/config.json (the Phase-1
    // edge). Either way the new harness groups under that scope in the rail.
    const hiveScope = typeof body.hive === 'string' ? body.hive.trim() : '';
    const membershipResult = resolveProjectHiveMembership(reg.projects, hiveScope);
    if (!membershipResult.ok) {
      return Response.json({ error: membershipResult.error, code: membershipResult.code }, { status: 404 });
    }
    const membership = membershipResult.membership;

    // Resolve the harness path from the body shape — supports three
    // entry points so far (papercusp-dogfood-v5 §3 P-008/P-009/P-010):
    //   Entry 1 — new local dir:    { slug, parentDir, folderName }
    //                              → mkdir + git init then falls through.
    //   Entry 3 — existing folder:  { slug, path }
    //   Entry 2 — GitHub URL:       { slug, githubUrl, shallow? }
    //                              → clones to ~/.papercusp-workspaces/clones/<repo>
    //                                then falls through to the path flow.
    let path: string;
    let cloneInfo: { url: string; owner: string; repo: string } | null = null;
    let initInfo: { parentDir: string; folderName: string; initialized: boolean } | null = null;

    const githubUrl = typeof body.githubUrl === 'string' ? body.githubUrl.trim() : '';
    const rawPath = typeof body.path === 'string' ? body.path.trim() : '';
    const parentDir = typeof body.parentDir === 'string' ? body.parentDir.trim() : '';
    const folderName = typeof body.folderName === 'string' ? body.folderName.trim() : '';

    if (parentDir && folderName) {
      const { initLocalHarnessDir, InitLocalDirError } = await import('../../../harness/init-local-dir');
      try {
        const initResult = await initLocalHarnessDir({ parentDir, folderName });
        path = initResult.path;
        initInfo = { parentDir, folderName, initialized: initResult.initialized };
      } catch (e: unknown) {
        if (e instanceof InitLocalDirError) {
          const httpStatus =
            e.code === 'invalid_path'   ? 400 :
            e.code === 'parent_missing' ? 400 :
            e.code === 'dest_exists'    ? 409 :
            e.code === 'git_missing'    ? 500 :
                                          500;
          return Response.json(
            { error: e.message, code: e.code, detail: e.detail },
            { status: httpStatus },
          );
        }
        throw e;
      }
    } else if (githubUrl) {
      const { cloneGithubRepo, isCloneError } = await import('../../../harness/clone-github');
      const cloneResult = await cloneGithubRepo(githubUrl, {
        shallow: body.shallow === true,
      });
      if (isCloneError(cloneResult)) {
        const httpStatus =
          cloneResult.code === 'invalid_url'    ? 400 :
          cloneResult.code === 'dest_exists'    ? 409 :
          cloneResult.code === 'auth_required'  ? 401 :
          cloneResult.code === 'not_found'      ? 404 :
          cloneResult.code === 'git_missing'    ? 500 :
                                                  502;
        return Response.json(
          { error: cloneResult.message, code: cloneResult.code },
          { status: httpStatus },
        );
      }
      path = cloneResult.path;
      cloneInfo = {
        url: githubUrl,
        owner: cloneResult.parsed.owner,
        repo: cloneResult.parsed.repo,
      };
    } else if (rawPath) {
      path = resolve(rawPath);
      if (!existsSync(path)) {
        return Response.json({ error: 'path does not exist' }, { status: 400 });
      }
    } else {
      return Response.json(
        { error: 'one of `path` or `githubUrl` is required' },
        { status: 400 },
      );
    }

    // FORMAL membership rides on the registry entry; legacy membership is written
    // to the new harness's config.json below (after the dir exists).
    reg.projects.push(
      membership?.kind === 'hive_slug' ? { slug, path, hive_slug: membership.value } : { slug, path },
    );
    await saveHarnessRegistry(reg);

    // Legacy `parent_slug` membership (the Phase-1 edge): self-describing in the
    // new harness's .papercusp/config.json, same shape registerSubs writes.
    if (membership?.kind === 'parent_slug') {
      try {
        const { writeFile, mkdir } = await import('node:fs/promises');
        const cfgDir = join(path, '.papercusp');
        const cfgPath = join(cfgDir, 'config.json');
        let prior: Record<string, unknown> = {};
        try {
          if (existsSync(cfgPath)) prior = JSON.parse(await readFile(cfgPath, 'utf8')) as Record<string, unknown>;
        } catch { /* malformed = overwrite with our addition */ }
        if (prior.parent_slug !== membership.value) {
          if (!existsSync(cfgDir)) await mkdir(cfgDir, { recursive: true });
          await writeFile(cfgPath, JSON.stringify({ ...prior, parent_slug: membership.value }, null, 2), 'utf8');
        }
      } catch { /* best-effort — registration succeeded; membership is a soft edge */ }
    }
    // Bust the lite/projects caches so the new member appears in the rail + the
    // hive grouping on the next poll (membership changed the grouping).
    {
      const g = globalThis as LiteGlobals;
      delete g[__liteKey];
      __projectsCache.expires = 0;
    }

    // Entry-seam migration (deprecate-harness-config-json-2026-06-06): a harness
    // that ARRIVES with a legacy `.papercusp/config.json` (a gym substrate, an
    // externally-scaffolded repo, a clone) gets its instance content (phase/phases/
    // dept + knob overrides like parallelWorkers.workingStateCheck) lifted into the
    // workspace-PG registry HERE — the live config path never reads the file.
    // Best-effort: never blocks registration.
    let migratedConfigFields: string[] = [];
    try {
      const { migrateConfigJsonToInstance } = await import('../../../deployment/instance-config');
      const { activeWorkspaceId } = await import('../../../workspace-registry');
      const r = await migrateConfigJsonToInstance(slug, activeWorkspaceId());
      migratedConfigFields = r.fields;
    } catch { /* ignore — registration succeeded; config lift is best-effort */ }

    let provisioning: { ok: true } | { ok: false; error: string };
    try {
      const { scaffoldHarnessSchema } = await import('../../../scaffold-harness-schema');
      await scaffoldHarnessSchema(slug);
      provisioning = { ok: true };
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      provisioning = { ok: false, error: msg.slice(0, 300) };
    }

    return Response.json({
      ok: true,
      project: { slug, path },
      provisioning,
      ...(membership ? { membership: { hive: membership.value, edge: membership.kind } } : {}),
      ...(migratedConfigFields.length > 0 ? { migratedConfig: migratedConfigFields } : {}),
      ...(cloneInfo ? { clone: cloneInfo } : {}),
      ...(initInfo ? { init: initInfo } : {}),
    });
  },
});

/**
 * P-010 (harnesses-tab-hive-model) — "new hive from blueprint": stand up a new
 * Hive home (a `kind:'hive'` harness running the pot/Queen blueprint). The thin
 * HTTP face over the canonical `createHiveHarness` primitive (hive-tool-namespace
 * `hive:create`) so the CreateHarnessPicker's new-hive mode reaches it without an
 * MCP round-trip — reuses the team's transactional provision (no duplication).
 */
const createHive = defineTool({
  method: 'POST',
  path: '/harness/hives',
  auth: 'public',
  async handler(req) {
    let body: { slug?: string; parentDir?: string; wakeInSeconds?: number } = {};
    try { body = (await req.json()) as typeof body; } catch { /* empty body */ }
    const slug = String(body.slug ?? '').trim();
    if (!slug || !/^[a-z0-9][a-z0-9-]*$/.test(slug)) {
      return Response.json({ error: 'a valid lowercase slug is required', code: 'invalid_slug' }, { status: 400 });
    }
    const { createHiveHarness } = await import('../../../agent-tools/hive/_create');
    const { activeWorkspaceId } = await import('../../../workspace-registry');
    const res = await createHiveHarness({
      slug,
      workspaceId: activeWorkspaceId(),
      parentDir: typeof body.parentDir === 'string' && body.parentDir.trim() ? body.parentDir.trim() : undefined,
      wakeInSeconds: typeof body.wakeInSeconds === 'number' ? body.wakeInSeconds : undefined,
    });
    if (!res.ok) {
      const status = res.error === 'slug_exists' || res.error === 'dest_exists' ? 409 : 400;
      return Response.json({ error: res.message, code: res.error }, { status });
    }
    // Bust the registry caches so the new Hive home appears in the selector + grouping.
    const g = globalThis as LiteGlobals;
    delete g[__liteKey];
    __projectsCache.expires = 0;
    return Response.json({ ok: true, project: { slug: res.slug, path: res.path }, hive: true, waked: res.waked });
  },
});

const remove = defineTool({
  method: 'DELETE',
  path: '/harness/projects/:slug',
  auth: 'public',
  async handler(req, ctx) {
    const slug = ctx.params.slug as string;
    const reg = await loadHarnessRegistry();
    const before = reg.projects.length;
    reg.projects = reg.projects.filter((p) => p.slug !== slug);
    if (reg.projects.length === before) return Response.json({ error: 'not found' }, { status: 404 });
    // Intentional-removal path: deleting the last harness legitimately
    // empties the registry, so opt out of the catastrophic-empty guard.
    await saveHarnessRegistry(reg, undefined, { allowEmpty: true });
    return Response.json({ ok: true });
  },
});

/**
 * P-010 — sub-harness classifier (read-only diagnostic).
 *
 * POST /api/harness/projects/scan-subharnesses { slug }
 * Returns the SubmoduleNode list `classify-tree` would register, with
 * each node's qualifiedSlug. Persists nothing — callers preview the
 * result before invoking /register-subs.
 */
const scanSubharnesses = defineTool({
  method: 'POST',
  path: '/harness/projects/scan-subharnesses',
  auth: 'public',
  async handler(req) {
    let body: { slug?: string } = {};
    try { body = (await req.json()) as { slug?: string }; } catch { /* empty */ }
    const slug = typeof body.slug === 'string' ? body.slug.trim() : '';
    if (!slug) return Response.json({ error: 'slug required' }, { status: 400 });

    const reg = await loadHarnessRegistry();
    const project = reg.projects.find((p) => p.slug === slug);
    if (!project) return Response.json({ error: 'unknown harness slug' }, { status: 404 });

    const { walkHarnessTree } = await import('../../../harness/classify-tree');
    const nodes = walkHarnessTree(project.path, { parentSlug: slug });
    const submodules = nodes
      .filter((n) => n.kind === 'submodule')
      .map((n) => ({
        relPath: n.relPath,
        absPath: n.absPath,
        qualifiedSlug: (n as { qualifiedSlug: string }).qualifiedSlug,
        gitDirTarget: (n as { gitDirTarget: string }).gitDirTarget,
      }));
    return Response.json({
      ok: true,
      rootSlug: slug,
      rootPath: project.path,
      submodules,
    });
  },
});

/**
 * P-011 — persist sub-harness registration.
 *
 * POST /api/harness/projects/register-subs { rootSlug }
 * For each submodule the classifier returns, register a
 * `ProjectEntry { slug: qualifiedSlug, path: absPath, harness_kind: 'sub-harness' }`
 * and write `<absPath>/.papercusp/config.json:{ parent_slug: rootSlug }`.
 * Idempotent: skips slugs that already exist but reconciles parent_slug
 * on disk if it drifted. Per D-006 (on-demand) + D-007 (self-describing
 * config).
 */
const registerSubs = defineTool({
  method: 'POST',
  path: '/harness/projects/register-subs',
  auth: 'public',
  async handler(req) {
    let body: { rootSlug?: string } = {};
    try { body = (await req.json()) as { rootSlug?: string }; } catch { /* empty */ }
    const rootSlug = typeof body.rootSlug === 'string' ? body.rootSlug.trim() : '';
    if (!rootSlug) return Response.json({ error: 'rootSlug required' }, { status: 400 });

    const reg = await loadHarnessRegistry();
    const root = reg.projects.find((p) => p.slug === rootSlug);
    if (!root) return Response.json({ error: 'unknown root harness slug' }, { status: 404 });

    const { walkHarnessTree } = await import('../../../harness/classify-tree');
    const { writeFile, mkdir } = await import('node:fs/promises');
    const nodes = walkHarnessTree(root.path, { parentSlug: rootSlug });
    const submodules = nodes.filter((n): n is import('../../../harness/classify-tree').SubmoduleNode => n.kind === 'submodule');

    const registered: Array<{ slug: string; path: string; created: boolean }> = [];
    const reconciled: Array<{ slug: string; path: string }> = [];
    const errors: Array<{ slug: string; error: string }> = [];

    for (const node of submodules) {
      const subSlug = node.qualifiedSlug;
      const subPath = node.absPath;
      // P-021 safety: reject sub-harness slugs containing path-traversal
      // segments or absolute-path prefixes. classify-tree builds qualifiedSlug
      // from a sanitized relPath, but a defensive check at the registration
      // boundary keeps a malformed classifier output from corrupting the registry.
      if (!isSafeSubHarnessSlug(subSlug)) {
        errors.push({ slug: subSlug, error: 'unsafe slug rejected (path-traversal / absolute / control chars)' });
        continue;
      }
      try {
        const existing = reg.projects.find((p) => p.slug === subSlug);
        let created = false;
        if (!existing) {
          reg.projects.push({
            slug: subSlug,
            path: subPath,
            harness_kind: 'sub-harness',
          });
          created = true;
        }
        // Self-describing parent_slug on disk per D-007.
        const cfgDir = join(subPath, '.papercusp');
        const cfgPath = join(cfgDir, 'config.json');
        let prior: Record<string, unknown> = {};
        try {
          if (existsSync(cfgPath)) {
            prior = JSON.parse(await readFile(cfgPath, 'utf8')) as Record<string, unknown>;
          }
        } catch { /* malformed = overwrite with our additions */ }
        const desired = { ...prior, parent_slug: rootSlug };
        if (prior.parent_slug !== rootSlug) {
          if (!existsSync(cfgDir)) await mkdir(cfgDir, { recursive: true });
          await writeFile(cfgPath, JSON.stringify(desired, null, 2), 'utf8');
          if (!created) reconciled.push({ slug: subSlug, path: subPath });
        }
        if (created) registered.push({ slug: subSlug, path: subPath, created: true });
      } catch (e) {
        errors.push({ slug: subSlug, error: e instanceof Error ? e.message : String(e) });
      }
    }

    if (registered.length > 0 || reconciled.length > 0) {
      await saveHarnessRegistry(reg);
      // Bust the lite-cache so consumers see the new tree on next poll.
      const g = globalThis as LiteGlobals;
      delete g[__liteKey];
      __projectsCache.expires = 0;
    }

    return Response.json({
      ok: true,
      rootSlug,
      discovered: submodules.length,
      registered,
      reconciled,
      errors,
    });
  },
});

/**
 * Resolve the membership edge for an "add into hive" create (harnesses-tab P-011).
 *
 * Decides which edge a new harness should carry when the picker's add-into-hive
 * mode passes a `hive` scope (the current `?slug=`):
 *   - empty scope        → no membership (a standalone harness).
 *   - unknown scope       → error (the scope must exist in this workspace).
 *   - FORMAL `kind:'hive'` home → `hive_slug` (shared-hive-federation membership).
 *   - any other scope     → `parent_slug` (the Phase-1 legacy sub-harness edge).
 *
 * Pure over the registry projects so the formal-vs-legacy precedence is
 * unit-tested without fs/PG (mirrors `resolveCreateHiveMembership`). Exported
 * for tests + the POST handler.
 */
export function resolveProjectHiveMembership(
  projects: ReadonlyArray<{ slug: string; harness_kind?: string }>,
  hiveScope: string,
):
  | { ok: true; membership: { kind: 'hive_slug' | 'parent_slug'; value: string } | null }
  | { ok: false; error: string; code: 'hive_not_found' } {
  const scope = hiveScope.trim();
  if (!scope) return { ok: true, membership: null };
  const target = projects.find((p) => p.slug === scope);
  if (!target) {
    return { ok: false, error: `hive '${scope}' not found in this workspace`, code: 'hive_not_found' };
  }
  return {
    ok: true,
    membership: {
      kind: target.harness_kind === HIVE_KIND ? 'hive_slug' : 'parent_slug',
      value: scope,
    },
  };
}

/**
 * Sub-harness slug guard for P-021. Rejects slugs that would either
 * (a) traverse out of the root harness's directory or (b) break the
 * slug → path mapping downstream. Exported only for tests.
 */
export function isSafeSubHarnessSlug(slug: string): boolean {
  if (typeof slug !== 'string' || slug.length === 0) return false;
  if (slug.length > 200) return false;
  if (slug.startsWith('/') || slug.startsWith('\\')) return false;
  // Split into segments — any segment that is exactly '..' or '.' is rejected.
  const segments = slug.split('/');
  for (const seg of segments) {
    if (seg === '' || seg === '.' || seg === '..') return false;
    // No control chars, no whitespace.
    if (/[\x00-\x20]/.test(seg)) return false;
  }
  return true;
}

export default [lite, list, create, createHive, remove, scanSubharnesses, registerSubs];
