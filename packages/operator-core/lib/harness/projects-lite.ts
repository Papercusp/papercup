/**
 * The /api/harness/projects/lite payload, extracted from the route so the
 * sync resolver (`harnessProjects.lite`, EI-206) and the registry write seam
 * can share it without importing the endpoint-route module.
 *
 * Cache notes (moved verbatim from the route): the payload is workspace-
 * dependent (loadHarnessRegistry resolves the request-scoped workspace via
 * the x-papercusp-workspace ALS), so entries are KEYED BY WORKSPACE — a
 * single global entry let one window's payload serve ANOTHER workspace's
 * callers for up to the TTL (dock.spec 404 flap, 2026-06-10 forensics).
 */
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { loadHarnessRegistry } from '../harness-registry';
import { harnessDir } from '../harness-core';
import { groupByHive, type HiveGroup, type HiveGroupProject } from './hive-groups';
import { activeWorkspaceId } from '../workspace-registry';

export interface ProjectsLiteEntry {
  slug: string;
  path: string;
  harness_kind: string | null;
  hive_slug: string | null;
  parent_slug: string | null;
  is_shared: boolean;
  hasState: boolean;
  hasSpec: boolean;
  harnessDir: string;
}

export interface ProjectsLitePayload {
  projects: ProjectsLiteEntry[];
  hives: HiveGroup<HiveGroupProject>[];
}

interface LiteCacheEntry {
  ts: number;
  payload: ProjectsLitePayload;
}
const __liteKey = Symbol.for('papercusp.harnessProjectsLiteCache');
type LiteGlobals = typeof globalThis & { [__liteKey]?: Map<string, LiteCacheEntry> };
const LITE_TTL_MS = 1000;

/** Drop every workspace's cached lite payload (call after a registry write). */
export function bustProjectsLiteCache(): void {
  delete (globalThis as LiteGlobals)[__liteKey];
}

export async function buildProjectsLitePayload(
  opts: { bypassCache?: boolean } = {},
): Promise<ProjectsLitePayload> {
  const g = globalThis as LiteGlobals;
  const now = Date.now();
  const ws = activeWorkspaceId();
  if (!opts.bypassCache) {
    const hit = g[__liteKey]?.get(ws);
    if (hit && now - hit.ts < LITE_TTL_MS) return hit.payload;
  }
  const reg = await loadHarnessRegistry();
  // P-012: surface `parent_slug` + `harness_kind` so the AdvShell selector can
  // render a tree (P-014) without paying the full /projects round-trip.
  // parent_slug is a scaffold-time harness contract artifact in
  // .papercusp/config.json (NOT a migrated HarnessConfig field —
  // deprecate-harness-config-json-2026-06-06 D-005); the file persists for it.
  const projects = await Promise.all(reg.projects.map(async (p): Promise<ProjectsLiteEntry> => {
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
  const payload: ProjectsLitePayload = { projects, hives };
  (g[__liteKey] ??= new Map()).set(ws, { ts: Date.now(), payload });
  return payload;
}
