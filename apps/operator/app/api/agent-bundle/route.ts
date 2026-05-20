/**
 * GET /api/agent-bundle
 *   headers: Authorization: Bearer <power-user access token>
 *   returns: {
 *     persona, toolsmd, skills[], hooks[],
 *     mcp_url, workspace, user, expires_at
 *   }
 *
 * The bundle the @papercusp/omp plugin fetches on `connect`. It carries
 * everything needed to seed a workspace-power-user OMP session:
 *   - persona  — papercusp-su.persona.md (optional; '' if absent)
 *   - toolsmd  — papercusp-su.tools.md (the cross-tool playbook)
 *   - skills[] — prompts/power-user-skills/*.md
 *   - hooks[]  — scripts/hooks/omp/*.{ts,js} (L1/L2/L3 coordination
 *                hook; empty until the file-locking plan lands its hook)
 *   - mcp_url  — derived from the request origin, ?power_user=1, no token
 *
 * Prompts are read from disk at request time (no cache) so they stay
 * versioned with the code that describes them — see
 * docs/plans/omp-power-user-bundle-2026-05-20.md §4.2, D-001.
 *
 * Auth: the access token is workspace-scoped; the token's `workspaceId`
 * claim is authoritative. Any `?workspace=` query param is ignored.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve as resolvePath } from 'node:path';
import { NextRequest } from 'next/server';

import { getOrgPg } from '@restart/db-org';
import { verifyAccessToken } from '@/lib/power-user-token';
import { getActivePowerUserSession } from '@/lib/power-user-sessions';
import { workspaceById } from '@/lib/workspace-registry';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

interface BundleFile {
  name: string;
  source: string;
}

/**
 * Resolve `apps/operator/prompts/` across dev + standalone layouts.
 * Mirrors console-launcher.ts:resolveScriptsDir — pick the first
 * candidate that actually contains the playbook file.
 */
function resolvePromptsDir(): string | null {
  const cwd = process.cwd();
  const candidates = [
    resolvePath(cwd, 'prompts'),
    resolvePath(cwd, 'apps', 'operator', 'prompts'),
    resolvePath(cwd, '..', '..', 'prompts'),
    resolvePath(cwd, '..', '..', '..', 'prompts'),
  ];
  for (const c of candidates) {
    if (existsSync(join(c, 'papercusp-su.tools.md'))) return c;
  }
  return null;
}

/** Resolve `apps/operator/scripts/` across dev + standalone layouts. */
function resolveScriptsDir(): string | null {
  const cwd = process.cwd();
  const candidates = [
    resolvePath(cwd, 'scripts'),
    resolvePath(cwd, 'apps', 'operator', 'scripts'),
    resolvePath(cwd, '..', '..', 'scripts'),
    resolvePath(cwd, '..', '..', '..', 'scripts'),
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return null;
}

/**
 * Read every file with one of `exts` in `dir`, sorted by name.
 * `README.md` is always skipped — a README documents the directory,
 * it is never a content payload.
 */
function readDirFiles(dir: string | null, exts: string[]): BundleFile[] {
  if (!dir || !existsSync(dir)) return [];
  const out: BundleFile[] = [];
  for (const name of readdirSync(dir).sort()) {
    if (!exts.some((e) => name.endsWith(e))) continue;
    if (name.toLowerCase() === 'readme.md') continue;
    try {
      out.push({ name, source: readFileSync(join(dir, name), 'utf8') });
    } catch {
      /* unreadable file — skip, don't fail the whole bundle */
    }
  }
  return out;
}

function bearerFrom(req: NextRequest): string | null {
  const raw = req.headers.get('authorization') ?? '';
  if (!raw) return null;
  return raw.startsWith('Bearer ') ? raw.slice(7) : raw;
}

async function lookupUser(
  userId: string,
): Promise<{ id: string; username: string; displayName: string }> {
  try {
    const { sql } = getOrgPg();
    const rows = await sql<Array<{ id: string; username: string; display_name: string }>>`
      SELECT id, username, display_name
        FROM harness_shared.users
       WHERE id = ${userId}
       LIMIT 1
    `;
    if (rows.length > 0) {
      return { id: rows[0].id, username: rows[0].username, displayName: rows[0].display_name };
    }
  } catch {
    /* fall through to a minimal identity */
  }
  return { id: userId, username: userId, displayName: userId };
}

export async function GET(req: NextRequest): Promise<Response> {
  const claims = await verifyAccessToken(bearerFrom(req));
  if (!claims) {
    return Response.json({ error: 'invalid or expired access token' }, { status: 401 });
  }
  // Confirm the session row is still active — a revoked session must
  // not be able to re-fetch the bundle even with an unexpired token.
  const session = await getActivePowerUserSession(claims.authSessionId);
  if (!session) {
    return Response.json({ error: 'session revoked or unknown' }, { status: 401 });
  }

  const promptsDir = resolvePromptsDir();
  if (!promptsDir) {
    return Response.json(
      { error: 'agent-bundle: prompts directory not found at runtime' },
      { status: 500 },
    );
  }
  const toolsmd = readFileSync(join(promptsDir, 'papercusp-su.tools.md'), 'utf8');
  // papercusp-su.persona.md is optional — v1 has no separate persona
  // file; the playbook (tools.md) carries the behavioural contract.
  const personaPath = join(promptsDir, 'papercusp-su.persona.md');
  const persona = existsSync(personaPath) ? readFileSync(personaPath, 'utf8') : '';

  const skills = readDirFiles(join(promptsDir, 'power-user-skills'), ['.md']);
  const scriptsDir = resolveScriptsDir();
  const hooks = readDirFiles(
    scriptsDir ? join(scriptsDir, 'hooks', 'omp') : null,
    ['.ts', '.js', '.mjs'],
  );

  // mcp_url — derived from the request origin, never hardcoded. No token
  // in the URL (D-006); the plugin injects it as an Authorization header.
  const origin = new URL(req.url).origin;
  const mcpUrl = `${origin}/api/mcp?power_user=1`;

  const ws = workspaceById(claims.workspaceId);
  const user = await lookupUser(claims.userId);

  return Response.json({
    persona,
    toolsmd,
    skills,
    hooks,
    mcp_url: mcpUrl,
    workspace: { id: claims.workspaceId, name: ws?.name ?? claims.workspaceId },
    user,
    expires_at: new Date(claims.exp * 1000).toISOString(),
  });
}
