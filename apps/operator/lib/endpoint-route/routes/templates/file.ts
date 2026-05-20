/**
 * GET/PUT /api/templates/:slug/:version/file?path=<rel>
 *
 * Reads/writes a single file inside a saved template directory at
 * ~/.papercusp/templates/<slug>/<version>/. Path-allowlisted to the
 * manifest's configFiles[] plus papercusp.json + README.md; anything
 * else is rejected to keep the editor from leaking arbitrary FS reads.
 *
 * Ported from app/api/templates/[slug]/[version]/file/route.ts. `auth: 'public'`.
 */
import { existsSync, promises as fs } from 'node:fs';
import { join, normalize, relative, dirname } from 'node:path';
import { papercuspPath } from '@/lib/papercusp-root';
import { FLAGS } from '@papercusp/flags';
import { gateApiRoute } from '@/lib/require-flag';
import { defineRoute } from '../../define-route';

const SLUG_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/i;

interface ConfigFile { path: string }

async function loadAllowlist(dir: string): Promise<string[]> {
  const allowed = new Set<string>(['papercusp.json', 'README.md']);
  const manifestPath = join(dir, 'papercusp.json');
  if (existsSync(manifestPath)) {
    try {
      const m = JSON.parse(await fs.readFile(manifestPath, 'utf8')) as { configFiles?: ConfigFile[] };
      if (Array.isArray(m.configFiles)) {
        for (const cf of m.configFiles) {
          if (cf?.path && typeof cf.path === 'string') allowed.add(cf.path);
        }
      }
    } catch { /* malformed manifest */ }
  }
  return Array.from(allowed);
}

function resolveSafe(root: string, rel: string): string | null {
  if (rel.startsWith('/') || rel.includes('..')) return null;
  const abs = normalize(join(root, rel));
  const back = relative(root, abs);
  if (back.startsWith('..') || back.startsWith('/')) return null;
  return abs;
}

async function authorize(slug: string, version: string, rel: string) {
  if (!SLUG_RE.test(slug)) return { ok: false as const, status: 400, error: 'invalid slug' };
  if (!SLUG_RE.test(version)) return { ok: false as const, status: 400, error: 'invalid version' };
  const dir = papercuspPath('templates', slug, version);
  if (!existsSync(dir)) return { ok: false as const, status: 404, error: 'template not found' };
  const allowlist = await loadAllowlist(dir);
  if (!allowlist.includes(rel)) {
    return { ok: false as const, status: 403, error: `path "${rel}" not in template allowlist` };
  }
  const abs = resolveSafe(dir, rel);
  if (!abs) return { ok: false as const, status: 400, error: 'path resolves outside template' };
  return { ok: true as const, abs };
}

const get = defineRoute({
  method: 'GET',
  path: '/templates/:slug/:version/file',
  auth: 'public',
  async handler(req, ctx) {
    const blocked = await gateApiRoute(req, FLAGS.TEMPLATES);
    if (blocked) return blocked;
    const { slug, version } = ctx.params;
    const url = new URL(req.url);
    const rel = url.searchParams.get('path') ?? '';
    if (!rel) return Response.json({ error: 'path query param required' }, { status: 400 });
    const auth = await authorize(slug, version, rel);
    if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });
    if (!existsSync(auth.abs)) {
      return Response.json({ path: rel, content: null, exists: false });
    }
    const content = await fs.readFile(auth.abs, 'utf8').catch(() => null);
    return Response.json({ path: rel, content, exists: content !== null });
  },
});

const put = defineRoute({
  method: 'PUT',
  path: '/templates/:slug/:version/file',
  auth: 'public',
  async handler(req, ctx) {
    const blocked = await gateApiRoute(req, FLAGS.TEMPLATES);
    if (blocked) return blocked;
    const { slug, version } = ctx.params;
    let body: { path?: string; content?: unknown };
    try { body = await req.json(); } catch { return Response.json({ error: 'invalid json' }, { status: 400 }); }
    const rel = String(body.path ?? '').trim();
    if (!rel) return Response.json({ error: 'path required' }, { status: 400 });
    const auth = await authorize(slug, version, rel);
    if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });
    const content = typeof body.content === 'string' ? body.content : null;
    if (content === null) return Response.json({ error: 'content (string) required' }, { status: 400 });
    await fs.mkdir(dirname(auth.abs), { recursive: true });
    await fs.writeFile(auth.abs, content, 'utf8');
    return Response.json({ ok: true, path: rel, bytes: Buffer.byteLength(content, 'utf8') });
  },
});

export default [get, put];
