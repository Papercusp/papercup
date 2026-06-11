/**
 * GET /api/harness/:slug/file?path=<rel> — read manifest-allowlisted config file.
 * PUT /api/harness/:slug/file — write same.
 *
 * Path constrained to harness manifest configFiles allowlist.
 *
 * Ported from app/api/harness/[slug]/file/route.ts. `auth: 'public'`.
 */
import { promises as fs, existsSync } from 'node:fs';
import { join, normalize, relative, dirname } from 'node:path';
import { papercuspPath } from '../../../papercusp-root';
import { loadHarnessRegistry } from '../../../harness-registry';
import { defineTool } from '@papercusp/agent-mcp';

interface ConfigFile { path: string; language?: string; label?: string }

async function loadAllowlist(projectPath: string): Promise<string[]> {
  const projectManifest = join(projectPath, '.papercusp', 'papercusp.json');
  let manifest: { configFiles?: unknown } | null = null;
  if (existsSync(projectManifest)) {
    try { manifest = JSON.parse(await fs.readFile(projectManifest, 'utf8')); } catch { /* ignore */ }
  }
  if (!manifest || !Array.isArray(manifest.configFiles)) {
    const harnessesDir = papercuspPath('harnesses');
    const dirs = await fs.readdir(harnessesDir, { withFileTypes: true }).catch(() => []);
    const dirManifests = await Promise.all(dirs.map(async (d) => {
      if (!d.isDirectory()) return null;
      try {
        const m = JSON.parse(await fs.readFile(join(harnessesDir, d.name, 'papercusp.json'), 'utf8'));
        return m && Array.isArray(m.configFiles) ? m : null;
      } catch { return null; }
    }));
    const found = dirManifests.find((m) => m != null);
    if (found) manifest = found;
  }
  const cfg = (manifest?.configFiles as ConfigFile[] | undefined) ?? [];
  if (cfg.length > 0) return cfg.map((c) => c.path);
  return [
    // SPEC.md + validation-contract.md dropped — deprecated (D-004/D-005).
    'AGENTS.md', '.papercusp/config.json',
    '.mcp.json', '.claude/settings.json',
    '.papercusp/supervisor-notes.md', '.papercusp/knowledge.md',
    '.env',
  ];
}

function resolveSafe(projectPath: string, rel: string): string | null {
  if (rel.startsWith('/') || rel.includes('..')) return null;
  const abs = normalize(join(projectPath, rel));
  const back = relative(projectPath, abs);
  if (back.startsWith('..') || back.startsWith('/')) return null;
  return abs;
}

async function authorize(slug: string, rel: string): Promise<{ ok: true; abs: string } | { ok: false; error: string; status: number }> {
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(slug)) return { ok: false, error: 'invalid slug', status: 400 };
  const project = (await loadHarnessRegistry()).projects.find((p) => p.slug === slug);
  if (!project) return { ok: false, error: 'unknown project', status: 404 };
  const allowlist = await loadAllowlist(project.path);
  if (!allowlist.includes(rel)) return { ok: false, error: `path "${rel}" not in manifest configFiles`, status: 403 };
  const abs = resolveSafe(project.path, rel);
  if (!abs) return { ok: false, error: 'path resolves outside project tree', status: 400 };
  return { ok: true, abs };
}

const get = defineTool({
  method: 'GET',
  path: '/harness/:slug/file',
  auth: 'public',
  async handler(req, ctx) {
    const slug = ctx.params.slug as string;
    const url = new URL(req.url);
    const rel = url.searchParams.get('path') ?? '';
    if (!rel) return Response.json({ error: 'path query param required' }, { status: 400 });
    const auth = await authorize(slug, rel);
    if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });
    if (!existsSync(auth.abs)) {
      return Response.json({ path: rel, content: null, exists: false });
    }
    const content = await fs.readFile(auth.abs, 'utf8').catch(() => null);
    return Response.json({ path: rel, content, exists: content !== null });
  },
});

const put = defineTool({
  method: 'PUT',
  path: '/harness/:slug/file',
  auth: 'loopback',
  async handler(req, ctx) {
    const slug = ctx.params.slug as string;
    let body: { path?: string; content?: unknown };
    try { body = await req.json(); } catch { return Response.json({ error: 'invalid json' }, { status: 400 }); }
    const rel = String(body.path ?? '').trim();
    if (!rel) return Response.json({ error: 'path required' }, { status: 400 });
    const auth = await authorize(slug, rel);
    if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });
    const content = typeof body.content === 'string' ? body.content : null;
    if (content === null) return Response.json({ error: 'content (string) required' }, { status: 400 });
    await fs.mkdir(dirname(auth.abs), { recursive: true });
    await fs.writeFile(auth.abs, content, 'utf8');
    return Response.json({ ok: true, path: rel, bytes: Buffer.byteLength(content, 'utf8') });
  },
});

export default [get, put];
