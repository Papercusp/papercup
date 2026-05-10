import { NextResponse } from 'next/server';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * GET /api/harness/projects — registered harness projects.
 *
 * Bypasses the Hono catch-all `[[...route]]/route.ts` (which currently 500s
 * on the orchestrator package's missing `.js` imports). The dashboard treats
 * a 500 here as "no projects", so without this route the harness UI never
 * picks an active project — which kills `+ plugin`, the inbox, and most
 * other panels.
 */
const REGISTRY_PATH = join(homedir(), '.restart-harness-projects.json');

interface ProjectEntry {
  slug: string;
  path: string;
  harness_kind?: 'coding' | 'department' | 'org';
  department_slug?: string;
}

interface RegistryFile {
  projects: ProjectEntry[];
}

function loadRegistry(): RegistryFile {
  if (existsSync(REGISTRY_PATH)) {
    try { return JSON.parse(readFileSync(REGISTRY_PATH, 'utf8')) as RegistryFile; } catch { /* fall through */ }
  }
  // Auto-discover known default locations with a .harness/ dir.
  const autos: ProjectEntry[] = [];
  for (const name of ['sheets-clone', 'Restart']) {
    const p = join(homedir(), name);
    if (existsSync(join(p, '.harness'))) {
      autos.push({ slug: name.toLowerCase().replace(/[^a-z0-9]+/g, '-'), path: p });
    }
  }
  return { projects: autos };
}

export async function GET() {
  const reg = loadRegistry();
  const enriched = reg.projects.map((p) => {
    const hDir = join(p.path, '.harness');
    const hasSpec = existsSync(join(p.path, 'SPEC.md'));
    // hasState requires a DB roundtrip; dashboard tolerates `false` as
    // "unknown". The full Hono route does query it; this lightweight route
    // skips it to keep zero dependencies on the orchestrator chain.
    return { ...p, hasState: false, hasSpec, harnessDir: hDir };
  });
  return NextResponse.json({ projects: enriched });
}
