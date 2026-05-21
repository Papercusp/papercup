/**
 * POST /api/templates/:slug/:version/install
 *
 * Materialises a saved template directly into a new harness, bypassing
 * the marketplace round-trip. Useful for testing a template before
 * publishing. Hands off to POST /api/harness/projects (existing
 * registry endpoint) to provision PG schema + registry entry.
 *
 * Ported from app/api/templates/[slug]/[version]/install/route.ts.
 * `auth: 'public'`, `timeoutSec: 120`.
 */
import { existsSync, promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { papercuspPath } from '@/lib/papercusp-root';
import { FLAGS } from '@papercusp/flags';
import { gateApiRoute } from '@/lib/require-flag';
import { defineTool } from '@papercusp/agent-mcp';

interface Body {
  projectSlug?: string;
  targetPath?: string;
}

const SKIP = new Set(['papercusp.json', '.published.json']);
const SLUG_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/i;
const PROJECT_SLUG_RE = /^[a-z][a-z0-9-]{0,63}$/;

async function copyDir(src: string, dst: string): Promise<string[]> {
  const copied: string[] = [];
  const entries = await fs.readdir(src, { withFileTypes: true });
  await fs.mkdir(dst, { recursive: true });
  for (const e of entries) {
    if (SKIP.has(e.name)) continue;
    const s = join(src, e.name);
    const d = join(dst, e.name);
    if (e.isDirectory()) {
      const inner = await copyDir(s, d);
      for (const p of inner) copied.push(join(e.name, p));
    } else {
      await fs.copyFile(s, d);
      copied.push(e.name);
    }
  }
  return copied;
}

export default defineTool({
  method: 'POST',
  path: '/templates/:slug/:version/install',
  auth: 'public',
  timeoutSec: 120,
  async handler(req, ctx) {
    const blocked = await gateApiRoute(req, FLAGS.TEMPLATES);
    if (blocked) return blocked;
    const { slug, version } = ctx.params;
    const body = (await req.json().catch(() => ({}))) as Body;

    if (!SLUG_RE.test(slug)) return Response.json({ ok: false, error: 'invalid slug' }, { status: 400 });
    if (!SLUG_RE.test(version)) return Response.json({ ok: false, error: 'invalid version' }, { status: 400 });

    const projectSlug = (body.projectSlug ?? `${slug}-test`).trim();
    if (!PROJECT_SLUG_RE.test(projectSlug)) {
      return Response.json(
        { ok: false, error: `invalid projectSlug "${projectSlug}" (lowercase letters, digits, hyphens)` },
        { status: 400 },
      );
    }

    const templateDir = papercuspPath('templates', slug, version);
    if (!existsSync(templateDir)) {
      return Response.json({ ok: false, error: 'template not found' }, { status: 404 });
    }

    const targetPath = body.targetPath
      ? resolve(body.targetPath.trim())
      : join(homedir(), 'papercusp-projects', projectSlug);

    if (existsSync(targetPath)) {
      return Response.json(
        { ok: false, error: `targetPath already exists at ${targetPath}` },
        { status: 409 },
      );
    }

    const copied = await copyDir(templateDir, targetPath);

    const origin = new URL(req.url).origin;
    const reg = await fetch(`${origin}/api/harness/projects`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: req.headers.get('cookie') ?? '' },
      body: JSON.stringify({ slug: projectSlug, path: targetPath }),
    });
    const regJson = await reg.json().catch(() => ({}));
    if (!reg.ok) {
      try { await fs.rm(targetPath, { recursive: true, force: true }); } catch { /* leak on failure */ }
      return Response.json(
        { ok: false, error: `registry rejected the new project: ${regJson.error ?? reg.status}` },
        { status: 502 },
      );
    }

    return Response.json({
      ok: true,
      projectSlug,
      targetPath,
      templateSlug: slug,
      templateVersion: version,
      copiedCount: copied.length,
      operatorUrl: `/harness/${encodeURIComponent(projectSlug)}`,
    });
  },
});
