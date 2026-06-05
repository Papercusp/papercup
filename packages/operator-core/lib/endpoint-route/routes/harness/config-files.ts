/**
 * Project-root config files editable from the harness UI:
 *
 *   GET/PUT /api/harness/:slug/mcp              — .mcp.json
 *   GET/PUT /api/harness/:slug/claude-settings  — .claude/settings.json
 *   GET/PUT /api/harness/:slug/env              — .env (secrets — gated by header)
 *
 * mcp.json + claude-settings.json are PG-canonical (Phase 0d) via
 * text-artifacts with a custom disk mirror at the project root. .env is
 * FS-only (never mirrored to PG) and PUT requires an explicit
 * `X-Confirm-Secrets: yes` header.
 *
 * Relocated from `_hono/harness.ts` (endpoint-hono-elimination-2026-05-21
 * A4 batch 15).
 */
import { writeFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { resolvePhasedProject, safeRead } from '../../../harness-core';
import { phasePhaseLabel } from '../../../harness-phases';
import type { ProjectEntry } from '../../../harness-registry';
import { defineTool } from '@papercusp/agent-mcp';

function phaseFromReq(req: Request) {
  return phasePhaseLabel(new URL(req.url).searchParams.get('phase') ?? undefined);
}

const mcpPath = (p: ProjectEntry) => join(p.path, '.mcp.json');
const claudeSettingsPath = (p: ProjectEntry) => join(p.path, '.claude', 'settings.json');
const envPath = (p: ProjectEntry) => join(p.path, '.env');

/**
 * Build a GET+PUT pair for a PG-canonical (text-artifacts) JSON config
 * file with a custom disk mirror at the project root. Empty content on
 * PUT deletes the file + clears the PG row.
 */
function jsonConfigRoutes(opts: {
  routePath: string;
  artifactKey: string;
  diskPath: (p: ProjectEntry) => string;
}) {
  const get = defineTool({
    method: 'GET',
    path: opts.routePath,
    auth: 'public',
    async handler(req, ctx) {
      const slug = ctx.params.slug as string;
      const project = await resolvePhasedProject(slug, phaseFromReq(req));
      if (!project) return Response.json({ error: 'unknown project' }, { status: 404 });
      const { loadTextArtifact } = await import('../../../text-artifacts');
      const fromPg = await loadTextArtifact(slug, opts.artifactKey);
      return Response.json({ content: fromPg ?? safeRead(opts.diskPath(project)) ?? '' });
    },
  });
  const put = defineTool({
    method: 'PUT',
    path: opts.routePath,
    auth: 'public',
    async handler(req, ctx) {
      const slug = ctx.params.slug as string;
      const project = await resolvePhasedProject(slug, phaseFromReq(req));
      if (!project) return Response.json({ error: 'unknown project' }, { status: 404 });
      const body = await req.json().catch(() => ({} as any));
      if (typeof body.content !== 'string') {
        return Response.json({ error: 'content required' }, { status: 400 });
      }
      if (body.content.trim()) {
        try { JSON.parse(body.content); }
        catch (e: any) { return Response.json({ error: `invalid JSON: ${e.message}` }, { status: 400 }); }
      }
      const path = opts.diskPath(project);
      const { saveTextArtifact } = await import('../../../text-artifacts');
      if (!body.content.trim()) {
        try { await unlink(path); } catch {}
        await saveTextArtifact(slug, opts.artifactKey, '', { customDiskPath: path });
        return Response.json({ ok: true, deleted: true });
      }
      await saveTextArtifact(slug, opts.artifactKey, body.content, { customDiskPath: path });
      return Response.json({ ok: true });
    },
  });
  return [get, put];
}

const [getMcp, putMcp] = jsonConfigRoutes({
  routePath: '/harness/:slug/mcp',
  artifactKey: 'mcp.json',
  diskPath: mcpPath,
});

const [getClaudeSettings, putClaudeSettings] = jsonConfigRoutes({
  routePath: '/harness/:slug/claude-settings',
  artifactKey: 'claude-settings.json',
  diskPath: claudeSettingsPath,
});

const getEnv = defineTool({
  method: 'GET',
  path: '/harness/:slug/env',
  auth: 'public',
  async handler(req, ctx) {
    const project = await resolvePhasedProject(ctx.params.slug as string, phaseFromReq(req));
    if (!project) return Response.json({ error: 'unknown project' }, { status: 404 });
    return Response.json({ content: safeRead(envPath(project)) ?? '' });
  },
});

const putEnv = defineTool({
  method: 'PUT',
  path: '/harness/:slug/env',
  auth: 'public',
  async handler(req, ctx) {
    const project = await resolvePhasedProject(ctx.params.slug as string, phaseFromReq(req));
    if (!project) return Response.json({ error: 'unknown project' }, { status: 404 });
    // Secrets pass through the wire — require an explicit confirmation header.
    if (req.headers.get('x-confirm-secrets') !== 'yes') {
      return Response.json({ error: 'missing X-Confirm-Secrets: yes header' }, { status: 400 });
    }
    const body = await req.json().catch(() => ({} as any));
    if (typeof body.content !== 'string') {
      return Response.json({ error: 'content required' }, { status: 400 });
    }
    await writeFile(envPath(project), body.content, 'utf8');
    return Response.json({ ok: true });
  },
});

export default [getMcp, putMcp, getClaudeSettings, putClaudeSettings, getEnv, putEnv];
