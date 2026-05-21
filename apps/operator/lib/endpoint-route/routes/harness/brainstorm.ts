/**
 * Per-harness brainstorm surfaces (Migration 033 — PG-canonical via
 * `harness_shared.harness_brainstorm`, FS mirror best-effort):
 *
 *   GET/PUT /api/harness/:slug/brainstorm           — brainstorm.md (text)
 *   GET/PUT /api/harness/:slug/brainstorm-canvas    — brainstorm.canvas.json
 *   GET/PUT /api/harness/:slug/brainstorm-mindmap   — brainstorm.mindmap.json
 *
 * The `POST /:slug/brainstorm/promote` route stays in `_hono/harness.ts`
 * for a later batch — it depends on the features/issues helpers
 * (`auditFeatureChange`, `loadIssuesOrSeed`, `saveIssues`) not yet
 * relocated.
 *
 * Relocated from `_hono/harness.ts` (endpoint-hono-elimination-2026-05-21
 * A4 batch 18).
 */
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { resolvePhasedProject, harnessDir, safeRead } from '@/lib/harness-core';
import { phasePhaseLabel } from '@/lib/harness-phases';
import type { ProjectEntry } from '@/lib/harness-registry';
import { defineRoute } from '../../define-route';

function phaseFromReq(req: Request) {
  return phasePhaseLabel(new URL(req.url).searchParams.get('phase') ?? undefined);
}

const brainstormPath = (p: ProjectEntry) => join(harnessDir(p), 'brainstorm.md');
const brainstormCanvasPath = (p: ProjectEntry) => join(harnessDir(p), 'brainstorm.canvas.json');
const brainstormMindmapPath = (p: ProjectEntry) => join(harnessDir(p), 'brainstorm.mindmap.json');

/**
 * Migration 033: brainstorm.{md,canvas.json,mindmap.json} are PG-canonical
 * via harness_shared.harness_brainstorm. The PG row is authoritative if it
 * exists; otherwise we fall back to the FS file (legacy harnesses).
 */
async function loadBrainstorm(slug: string): Promise<{ content: string; canvas: unknown; mindmap: unknown }> {
  const { ensureBrainstormTable } = await import('@/lib/ensure-schema');
  await ensureBrainstormTable();
  const { db } = (await import('@restart/db-org')).getOrgPg();
  const { generated } = await import('@restart/db-org');
  const { and, eq } = await import('drizzle-orm');
  const hb = generated.harnessBrainstormInHarnessShared;
  const rows = await db
    .select({ content: hb.content, canvas: hb.canvas, mindmap: hb.mindmap })
    .from(hb)
    .where(and(eq(hb.harnessSlug, slug), eq(hb.phase, 'staging')))
    .limit(1);
  return rows[0] ?? { content: '', canvas: null, mindmap: null };
}

async function saveBrainstorm(slug: string, patch: { content?: string; canvas?: unknown; mindmap?: unknown }): Promise<void> {
  const { ensureBrainstormTable } = await import('@/lib/ensure-schema');
  await ensureBrainstormTable();
  const { db } = (await import('@restart/db-org')).getOrgPg();
  const { generated } = await import('@restart/db-org');
  const { sql: dsql } = await import('drizzle-orm');
  const hb = generated.harnessBrainstormInHarnessShared;
  const now = Date.now();
  await db
    .insert(hb)
    .values({
      harnessSlug: slug,
      phase: 'staging',
      content: patch.content ?? '',
      canvas: (patch.canvas ?? null) as any,
      mindmap: (patch.mindmap ?? null) as any,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [hb.harnessSlug, hb.phase],
      set: {
        content: dsql`COALESCE(${patch.content ?? null}, ${hb.content})`,
        canvas: dsql`COALESCE(${patch.canvas !== undefined ? JSON.stringify(patch.canvas) : null}::jsonb, ${hb.canvas})`,
        mindmap: dsql`COALESCE(${patch.mindmap !== undefined ? JSON.stringify(patch.mindmap) : null}::jsonb, ${hb.mindmap})`,
        updatedAt: now,
      },
    });
  const { notifySyncInvalidate } = await import('@/lib/sync-sse');
  await notifySyncInvalidate('harnessBrainstorm.byHarness', { harnessSlug: slug });
}

const getBrainstorm = defineRoute({
  method: 'GET',
  path: '/harness/:slug/brainstorm',
  auth: 'public',
  async handler(req, ctx) {
    const slug = ctx.params.slug as string;
    const project = await resolvePhasedProject(slug, phaseFromReq(req));
    if (!project) return Response.json({ error: 'unknown project' }, { status: 404 });
    const row = await loadBrainstorm(slug);
    const content = row.content || (safeRead(brainstormPath(project)) ?? '');
    return Response.json({ content });
  },
});

const putBrainstorm = defineRoute({
  method: 'PUT',
  path: '/harness/:slug/brainstorm',
  auth: 'public',
  async handler(req, ctx) {
    const slug = ctx.params.slug as string;
    const project = await resolvePhasedProject(slug, phaseFromReq(req));
    if (!project) return Response.json({ error: 'unknown project' }, { status: 404 });
    const body = await req.json().catch(() => ({} as any));
    if (typeof body.content !== 'string') return Response.json({ error: 'content required' }, { status: 400 });
    await saveBrainstorm(slug, { content: body.content });
    await writeFile(brainstormPath(project), body.content, 'utf8').catch(() => {});
    return Response.json({ ok: true, bytes: body.content.length });
  },
});

const getCanvas = defineRoute({
  method: 'GET',
  path: '/harness/:slug/brainstorm-canvas',
  auth: 'public',
  async handler(req, ctx) {
    const slug = ctx.params.slug as string;
    const project = await resolvePhasedProject(slug, phaseFromReq(req));
    if (!project) return Response.json({ error: 'unknown project' }, { status: 404 });
    const row = await loadBrainstorm(slug);
    if (row.canvas) return Response.json({ scene: row.canvas });
    const raw = safeRead(brainstormCanvasPath(project));
    if (!raw) return Response.json({ scene: null });
    try { return Response.json({ scene: JSON.parse(raw) }); }
    catch { return Response.json({ scene: null }); }
  },
});

const putCanvas = defineRoute({
  method: 'PUT',
  path: '/harness/:slug/brainstorm-canvas',
  auth: 'public',
  async handler(req, ctx) {
    const slug = ctx.params.slug as string;
    const project = await resolvePhasedProject(slug, phaseFromReq(req));
    if (!project) return Response.json({ error: 'unknown project' }, { status: 404 });
    const body = await req.json().catch(() => ({} as any));
    if (!body.scene) return Response.json({ error: 'scene required' }, { status: 400 });
    await saveBrainstorm(slug, { canvas: body.scene });
    await writeFile(brainstormCanvasPath(project), JSON.stringify(body.scene, null, 2), 'utf8').catch(() => {});
    return Response.json({ ok: true });
  },
});

const getMindmap = defineRoute({
  method: 'GET',
  path: '/harness/:slug/brainstorm-mindmap',
  auth: 'public',
  async handler(req, ctx) {
    const slug = ctx.params.slug as string;
    const project = await resolvePhasedProject(slug, phaseFromReq(req));
    if (!project) return Response.json({ error: 'unknown project' }, { status: 404 });
    const row = await loadBrainstorm(slug);
    if (row.mindmap) return Response.json({ tree: row.mindmap });
    const raw = safeRead(brainstormMindmapPath(project));
    if (!raw) return Response.json({ tree: null });
    try { return Response.json({ tree: JSON.parse(raw) }); }
    catch { return Response.json({ tree: null }); }
  },
});

const putMindmap = defineRoute({
  method: 'PUT',
  path: '/harness/:slug/brainstorm-mindmap',
  auth: 'public',
  async handler(req, ctx) {
    const slug = ctx.params.slug as string;
    const project = await resolvePhasedProject(slug, phaseFromReq(req));
    if (!project) return Response.json({ error: 'unknown project' }, { status: 404 });
    const body = await req.json().catch(() => ({} as any));
    if (!body.tree) return Response.json({ error: 'tree required' }, { status: 400 });
    await saveBrainstorm(slug, { mindmap: body.tree });
    await writeFile(brainstormMindmapPath(project), JSON.stringify(body.tree, null, 2), 'utf8').catch(() => {});
    return Response.json({ ok: true });
  },
});

export default [getBrainstorm, putBrainstorm, getCanvas, putCanvas, getMindmap, putMindmap];
