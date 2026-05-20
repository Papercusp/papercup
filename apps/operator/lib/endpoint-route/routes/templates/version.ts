/**
 * GET    /api/templates/:slug/:version — single template version detail.
 * DELETE /api/templates/:slug/:version — remove the local copy.
 *
 * Best-effort: delete only removes the local copy; published versions
 * stay live in the marketplace until retracted.
 *
 * Ported from app/api/templates/[slug]/[version]/route.ts. `auth: 'public'`.
 */
import { existsSync, promises as fs } from 'node:fs';
import { join } from 'node:path';
import { papercuspPath } from '@/lib/papercusp-root';
import { FLAGS } from '@papercusp/flags';
import { gateApiRoute } from '@/lib/require-flag';
import { defineRoute } from '../../define-route';

const SLUG_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/i;

const get = defineRoute({
  method: 'GET',
  path: '/templates/:slug/:version',
  auth: 'public',
  async handler(req, ctx) {
    const blocked = await gateApiRoute(req, FLAGS.TEMPLATES);
    if (blocked) return blocked;
    const { slug, version } = ctx.params;
    if (!SLUG_RE.test(slug)) return Response.json({ ok: false, error: 'invalid slug' }, { status: 400 });
    if (!SLUG_RE.test(version)) return Response.json({ ok: false, error: 'invalid version' }, { status: 400 });
    const dir = papercuspPath('templates', slug, version);
    const manifestPath = join(dir, 'papercusp.json');
    if (!existsSync(manifestPath)) {
      return Response.json({ ok: false, error: 'template not found' }, { status: 404 });
    }
    const stat = await fs.stat(dir);
    const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
    const sidecar = join(dir, '.published.json');
    let publishedSlugs: Array<{ slug: string; version: string; browseUrl?: string; publishedAtMs?: number }> = [];
    if (existsSync(sidecar)) {
      try {
        const arr = JSON.parse(await fs.readFile(sidecar, 'utf8'));
        if (Array.isArray(arr)) publishedSlugs = arr;
      } catch { /* ignore */ }
    }
    return Response.json({
      ok: true,
      template: { slug, version, path: dir, manifest, publishedSlugs, savedAtMs: stat.mtimeMs },
    });
  },
});

const del = defineRoute({
  method: 'DELETE',
  path: '/templates/:slug/:version',
  auth: 'public',
  async handler(_req, ctx) {
    const { slug, version } = ctx.params;
    if (!SLUG_RE.test(slug)) return Response.json({ ok: false, error: 'invalid slug' }, { status: 400 });
    if (!SLUG_RE.test(version)) return Response.json({ ok: false, error: 'invalid version' }, { status: 400 });
    const dir = papercuspPath('templates', slug, version);
    if (!existsSync(dir)) {
      return Response.json({ ok: false, error: 'template not found' }, { status: 404 });
    }
    await fs.rm(dir, { recursive: true, force: true });
    try {
      const parent = papercuspPath('templates', slug);
      const remaining = await fs.readdir(parent);
      if (remaining.length === 0) await fs.rmdir(parent);
    } catch { /* ignore */ }
    return Response.json({ ok: true, slug, version });
  },
});

export default [get, del];
