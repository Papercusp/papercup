/**
 * GET /api/harness/projects — registered harness projects.
 *
 * Operator-local read of ~/.restart-harness-projects.json + auto-discovery
 * of well-known dirs. Lightweight bypass of the Hono catch-all.
 *
 * Ported from app/api/harness/projects/route.ts. `auth: 'public'`.
 */
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { defineRoute } from '../../define-route';

const REGISTRY_PATH = join(homedir(), '.restart-harness-projects.json');

interface ProjectEntry {
  slug: string;
  path: string;
  harness_kind?: 'coding' | 'department' | 'org';
  department_slug?: string;
}

interface RegistryFile { projects: ProjectEntry[] }

function loadRegistry(): RegistryFile {
  if (existsSync(REGISTRY_PATH)) {
    try { return JSON.parse(readFileSync(REGISTRY_PATH, 'utf8')) as RegistryFile; } catch { /* fall through */ }
  }
  const autos: ProjectEntry[] = [];
  for (const name of ['sheets-clone', 'Restart']) {
    const p = join(homedir(), name);
    if (existsSync(join(p, '.harness'))) {
      autos.push({ slug: name.toLowerCase().replace(/[^a-z0-9]+/g, '-'), path: p });
    }
  }
  return { projects: autos };
}

export default defineRoute({
  method: 'GET',
  path: '/harness/projects',
  auth: 'public',
  handler() {
    const reg = loadRegistry();
    const enriched = reg.projects.map((p) => {
      const hDir = join(p.path, '.harness');
      const hasSpec = existsSync(join(p.path, 'SPEC.md'));
      return { ...p, hasState: false, hasSpec, harnessDir: hDir };
    });
    return Response.json({ projects: enriched });
  },
});
