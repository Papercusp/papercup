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
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { getLegacyClient } from '@restart/db-org';
import {
  loadHarnessRegistry,
  saveHarnessRegistry,
} from '@/lib/harness-registry';
import { harnessDir } from '@/lib/harness-core';
import { defineRoute } from '../../define-route';

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

const lite = defineRoute({
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

const list = defineRoute({
  method: 'GET',
  path: '/harness/projects',
  auth: 'public',
  async handler(req) {
    const url = new URL(req.url);
    const reg = await loadHarnessRegistry();
    const filterParentSlug = url.searchParams.get('parent_slug');

    let sig = `n=${reg.projects.length}|slugs=${reg.projects.map((p) => p.slug).join(',')}`;
    try {
      const wsPath = join(homedir(), '.papercusp-workspaces', 'registry.json');
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

const create = defineRoute({
  method: 'POST',
  path: '/harness/projects',
  auth: 'public',
  async handler(req) {
    const body = await req.json();
    const slug = String((body as any).slug ?? '').trim();
    const rawPath = String((body as any).path ?? '').trim();
    if (!slug || !rawPath) return Response.json({ error: 'slug and path required' }, { status: 400 });
    const path = resolve(rawPath);
    if (!existsSync(path)) return Response.json({ error: 'path does not exist' }, { status: 400 });
    const reg = await loadHarnessRegistry();
    if (reg.projects.some((p) => p.slug === slug)) {
      return Response.json({ error: 'slug already exists' }, { status: 409 });
    }
    reg.projects.push({ slug, path });
    await saveHarnessRegistry(reg);

    let provisioning: { ok: true } | { ok: false; error: string };
    try {
      const { scaffoldHarnessSchema } = await import('@/lib/scaffold-harness-schema');
      await scaffoldHarnessSchema(slug);
      provisioning = { ok: true };
    } catch (e: any) {
      provisioning = { ok: false, error: String(e?.message ?? e).slice(0, 300) };
    }

    return Response.json({ ok: true, project: { slug, path }, provisioning });
  },
});

const remove = defineRoute({
  method: 'DELETE',
  path: '/harness/projects/:slug',
  auth: 'public',
  async handler(req, ctx) {
    const slug = ctx.params.slug as string;
    const reg = await loadHarnessRegistry();
    const before = reg.projects.length;
    reg.projects = reg.projects.filter((p) => p.slug !== slug);
    if (reg.projects.length === before) return Response.json({ error: 'not found' }, { status: 404 });
    await saveHarnessRegistry(reg);
    return Response.json({ ok: true });
  },
});

export default [lite, list, create, remove];
