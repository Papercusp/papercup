/**
 * /api/harness/:slug/projects/* — project-management routes. Phase A1
 * (endpoint-hono-elimination-2026-05-21). Ported off `_hono/projects.ts`
 * (mounted via `registerProjects`). URLs unchanged.
 *
 *   GET  /api/harness/:slug/projects
 *   GET  /api/harness/:slug/projects/:id
 *   GET  /api/harness/:slug/projects/:id/spec/revisions
 *   GET  /api/harness/:slug/projects/:id/spec/revisions/:revId
 *   PUT  /api/harness/:slug/projects/:id/spec
 *
 * `auth: 'public'` — the legacy `harness` sub-app gated none of these.
 *
 * (The PM auto-maintenance route POST .../regenerate-spec was retired with the
 * projects→spec-revision project_manager feature — D-020 / P-015. Manual spec
 * editing via PUT .../spec + revision viewing survive.)
 */
import { withWorkspaceLegacy } from '@papercusp/db-org';
import { defineTool } from '@papercusp/agent-mcp';
import { activeWorkspaceId } from '../../../workspace-registry';
import { getProjectDetail, listProjectsForHarness } from '../../../projects-data';

/* eslint-disable @typescript-eslint/no-explicit-any */

const listProjects = defineTool({
  method: 'GET',
  path: '/harness/:slug/projects',
  auth: 'public',
  async handler(_req, ctx) {
    try {
      return Response.json({ projects: await listProjectsForHarness(ctx.params.slug) });
    } catch (e) {
      return Response.json({ error: `failed to list projects: ${(e as Error).message}` }, { status: 500 });
    }
  },
});

const projectDetail = defineTool({
  method: 'GET',
  path: '/harness/:slug/projects/:id',
  auth: 'public',
  async handler(_req, ctx) {
    try {
      const detail = await getProjectDetail(ctx.params.slug, ctx.params.id);
      if (!detail) return Response.json({ error: 'project not found' }, { status: 404 });
      return Response.json(detail);
    } catch (e) {
      return Response.json({ error: `failed to load project: ${(e as Error).message}` }, { status: 500 });
    }
  },
});

const specRevisions = defineTool({
  method: 'GET',
  path: '/harness/:slug/projects/:id/spec/revisions',
  auth: 'public',
  async handler(req, ctx) {
    const { slug, id } = ctx.params;
    const limit = Math.min(parseInt(new URL(req.url).searchParams.get('limit') ?? '20', 10), 100);
    try {
      const rows = await withWorkspaceLegacy(slug, activeWorkspaceId(), async (db) => {
        return (await db.prepare(
          `SELECT id, summary, author_role, author, ts, include_decisions, tokens_in, tokens_out, cost_usd_cents
             FROM harness_shared.project_spec_revisions
            WHERE project_id = ?
            ORDER BY ts DESC
            LIMIT ?`,
        ).all(id, limit)) as any[];
      });
      const revisions = rows.map((r) => ({
        id: typeof r.id === 'bigint' ? Number(r.id) : r.id,
        summary: r.summary,
        author_role: r.author_role,
        author: r.author,
        ts: r.ts,
        include_decisions: typeof r.include_decisions === 'string'
          ? JSON.parse(r.include_decisions)
          : (r.include_decisions ?? null),
        tokens_in: typeof r.tokens_in === 'bigint' ? Number(r.tokens_in) : (r.tokens_in ?? 0),
        tokens_out: typeof r.tokens_out === 'bigint' ? Number(r.tokens_out) : (r.tokens_out ?? 0),
        cost_usd_cents: typeof r.cost_usd_cents === 'bigint' ? Number(r.cost_usd_cents) : (r.cost_usd_cents ?? 0),
      }));
      return Response.json({ revisions });
    } catch (e) {
      return Response.json({ error: `failed to load revisions: ${(e as Error).message}` }, { status: 500 });
    }
  },
});

const specRevision = defineTool({
  method: 'GET',
  path: '/harness/:slug/projects/:id/spec/revisions/:revId',
  auth: 'public',
  async handler(_req, ctx) {
    const { slug, id, revId } = ctx.params;
    try {
      const row = await withWorkspaceLegacy(slug, activeWorkspaceId(), async (db) => {
        return (await db.prepare(
          'SELECT * FROM harness_shared.project_spec_revisions WHERE project_id = ? AND id = ?',
        ).get(id, parseInt(revId, 10))) as any;
      });
      if (!row) return Response.json({ error: 'revision not found' }, { status: 404 });
      return Response.json({
        id: typeof row.id === 'bigint' ? Number(row.id) : row.id,
        spec: row.spec,
        summary: row.summary,
        author_role: row.author_role,
        author: row.author,
        ts: row.ts,
        include_decisions: typeof row.include_decisions === 'string'
          ? JSON.parse(row.include_decisions)
          : (row.include_decisions ?? null),
      });
    } catch (e) {
      return Response.json({ error: `failed to load revision: ${(e as Error).message}` }, { status: 500 });
    }
  },
});

const putSpec = defineTool({
  method: 'PUT',
  path: '/harness/:slug/projects/:id/spec',
  auth: 'loopback',
  async handler(req, ctx) {
    const { slug, id } = ctx.params;
    let body: { spec?: string; summary?: string; author?: string };
    try { body = await req.json(); } catch { return Response.json({ error: 'invalid JSON body' }, { status: 400 }); }
    const spec = body.spec ?? '';
    const summary = body.summary ?? 'Manual edit by operator';
    const author = body.author ?? 'user';
    const workspace = activeWorkspaceId();
    try {
      const ok = await withWorkspaceLegacy(slug, workspace, async (db) => {
        // Serialize on the project, including the first edit when no history row exists.
        const existing = await db.prepare(
          'SELECT spec FROM harness_shared.projects WHERE id = ? AND workspace_id = ? FOR UPDATE',
        ).get<{ spec: string | null }>(id, workspace);
        if (!existing) return false;
        if (existing.spec === spec) {
          const prior = await db.prepare(`
            SELECT spec, summary, author, author_role, include_decisions
              FROM harness_shared.project_spec_revisions
             WHERE project_id = ? AND workspace_id = ?
             ORDER BY id DESC LIMIT 1
          `).get<{ spec: string; summary: string | null; author: string | null;
            author_role: string; include_decisions: unknown }>(id, workspace);
          if (prior?.spec === spec && prior.summary === summary && prior.author === author &&
              prior.author_role === 'user' && prior.include_decisions === null) return true;
        }
        await db.prepare(`
          INSERT INTO harness_shared.project_spec_revisions
            (project_id, spec, summary, author_role, author, workspace_id, ts)
          VALUES (?, ?, ?, 'user', ?, ?, clock_timestamp())
        `).run(id, spec, summary, author, workspace);
        await db.prepare(`
          UPDATE harness_shared.projects
             SET spec = ?, spec_updated_at = statement_timestamp(), spec_manually_edited_at = statement_timestamp(), updated_ts = ?
           WHERE id = ? AND workspace_id = ?
        `).run(spec, Date.now(), id, workspace);
        return true;
      });
      if (!ok) return Response.json({ error: 'project not found' }, { status: 404 });
      return Response.json({ ok: true });
    } catch (e) {
      return Response.json({ error: `failed to update spec: ${(e as Error).message}` }, { status: 500 });
    }
  },
});

export default [listProjects, projectDetail, specRevisions, specRevision, putSpec];
