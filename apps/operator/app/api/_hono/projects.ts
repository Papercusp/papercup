/**
 * /api/harness/:slug/projects/* — project management endpoints.
 *
 * Projects live in `harness_shared.projects` (cross-harness; PROJ-XXX ids).
 * The Project Manager role curates per-project specs that get injected into
 * worker / validator / scoper prompts when those agents touch a feature
 * with `project_id` set.
 *
 * Endpoints:
 *   GET    /:slug/projects                            → list projects (with feature counts)
 *   GET    /:slug/projects/:id                        → detail (spec + counts)
 *   GET    /:slug/projects/:id/spec/revisions         → spec history
 *   PUT    /:slug/projects/:id/spec                   body: { spec, summary? }  — manual override
 *   POST   /:slug/projects/:id/regenerate-spec        → enqueue PM run (manual trigger)
 *
 * The PM run itself isn't exposed as a foreground endpoint — it's queued
 * via `harness_shared.pending_events (kind='pm_due')` and consumed by the
 * orchestrator's `NEXT_PROJECT_MANAGER` decision verb.
 */
import type { Hono } from 'hono';
import { randomUUID } from 'node:crypto';
import { getLegacyClient } from '@restart/db-org';
import { runProjectManager } from '../../../lib/pm-dispatch';

interface ProjectRow {
  id: string;
  name: string;
  status: string;
  budget_cents: number | null;
  spent_cents: number;
  owning_dept: string | null;
  vertical: string | null;
  spec: string | null;
  spec_updated_at: string | null;
  spec_manually_edited_at: string | null;
  created_ts: number;
  updated_ts: number;
}

interface ProjectWithCounts extends ProjectRow {
  feature_counts: {
    todo: number;
    in_progress: number;
    validating: number;
    failing: number;
    blocked: number;
    passed: number;
    rejected: number;
    total: number;
  };
}

function dbForSlug(slug: string) {
  return getLegacyClient(slug);
}

function rowToProject(r: any): ProjectRow {
  const num = (v: unknown) => (typeof v === 'bigint' ? Number(v) : (v as number | null));
  return {
    id: r.id,
    name: r.name,
    status: r.status,
    budget_cents: num(r.budget_cents),
    spent_cents: num(r.spent_cents) ?? 0,
    owning_dept: r.owning_dept ?? null,
    vertical: r.vertical ?? null,
    spec: r.spec ?? null,
    spec_updated_at: r.spec_updated_at ?? null,
    spec_manually_edited_at: r.spec_manually_edited_at ?? null,
    created_ts: num(r.created_ts) ?? 0,
    updated_ts: num(r.updated_ts) ?? 0,
  };
}

async function projectFeatureCounts(slug: string, projectId: string): Promise<ProjectWithCounts['feature_counts']> {
  try {
    const db = dbForSlug(slug);
    const rows = (await db.prepare(
      `SELECT status, COUNT(*)::bigint AS n FROM harness_features WHERE project_id = ? GROUP BY status`,
    ).all(projectId)) as Array<{ status: string; n: number | bigint }>;
    const counts = {
      todo: 0, in_progress: 0, validating: 0, failing: 0,
      blocked: 0, passed: 0, rejected: 0, total: 0,
    };
    for (const r of rows) {
      const n = typeof r.n === 'bigint' ? Number(r.n) : r.n;
      if (r.status in counts) (counts as any)[r.status] = n;
      counts.total += n;
    }
    return counts;
  } catch {
    return { todo: 0, in_progress: 0, validating: 0, failing: 0, blocked: 0, passed: 0, rejected: 0, total: 0 };
  }
}

export function registerProjects(harness: Hono): void {
  // ── List projects (cross-harness; filtered by features that exist in this harness) ──
  harness.get('/:slug/projects', async (c) => {
    const slug = c.req.param('slug');
    try {
      const db = dbForSlug(slug);
      // Limit to projects that have at least one feature in this harness.
      const rows = (await db.prepare(`
        SELECT p.* FROM harness_shared.projects p
        WHERE EXISTS (
          SELECT 1 FROM harness_features f
          WHERE f.harness_slug = ? AND f.project_id = p.id
        )
        ORDER BY p.updated_ts DESC
      `).all(slug)) as any[];
      const projects: ProjectWithCounts[] = await Promise.all(
        rows.map(async (r) => ({
          ...rowToProject(r),
          feature_counts: await projectFeatureCounts(slug, r.id),
        })),
      );
      return c.json({ projects });
    } catch (e) {
      return c.json({ error: `failed to list projects: ${(e as Error).message}` }, 500);
    }
  });

  // ── Project detail (with spec + counts) ──
  harness.get('/:slug/projects/:id', async (c) => {
    const slug = c.req.param('slug');
    const id = c.req.param('id');
    try {
      const db = dbForSlug(slug);
      const row = (await db.prepare('SELECT * FROM harness_shared.projects WHERE id = ?').get(id)) as any;
      if (!row) return c.json({ error: 'project not found' }, 404);
      const project = rowToProject(row);
      const counts = await projectFeatureCounts(slug, id);
      // Most recent revision for transparency
      const lastRev = (await db.prepare(
        'SELECT id, summary, author_role, ts FROM harness_shared.project_spec_revisions WHERE project_id = ? ORDER BY ts DESC LIMIT 1',
      ).get(id)) as any;
      return c.json({
        ...project,
        feature_counts: counts,
        last_spec_revision: lastRev ? {
          id: typeof lastRev.id === 'bigint' ? Number(lastRev.id) : lastRev.id,
          summary: lastRev.summary,
          author_role: lastRev.author_role,
          ts: lastRev.ts,
        } : null,
      });
    } catch (e) {
      return c.json({ error: `failed to load project: ${(e as Error).message}` }, 500);
    }
  });

  // ── Spec revision history ──
  harness.get('/:slug/projects/:id/spec/revisions', async (c) => {
    const id = c.req.param('id');
    const slug = c.req.param('slug');
    const limit = Math.min(parseInt(c.req.query('limit') ?? '20', 10), 100);
    try {
      const db = dbForSlug(slug);
      const rows = (await db.prepare(
        `SELECT id, summary, author_role, author, ts, include_decisions, tokens_in, tokens_out, cost_usd_cents
           FROM harness_shared.project_spec_revisions
          WHERE project_id = ?
          ORDER BY ts DESC
          LIMIT ?`,
      ).all(id, limit)) as any[];
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
      return c.json({ revisions });
    } catch (e) {
      return c.json({ error: `failed to load revisions: ${(e as Error).message}` }, 500);
    }
  });

  // ── Get full spec content of a specific revision ──
  harness.get('/:slug/projects/:id/spec/revisions/:revId', async (c) => {
    const id = c.req.param('id');
    const slug = c.req.param('slug');
    const revId = c.req.param('revId');
    try {
      const db = dbForSlug(slug);
      const row = (await db.prepare(
        'SELECT * FROM harness_shared.project_spec_revisions WHERE project_id = ? AND id = ?',
      ).get(id, parseInt(revId, 10))) as any;
      if (!row) return c.json({ error: 'revision not found' }, 404);
      return c.json({
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
      return c.json({ error: `failed to load revision: ${(e as Error).message}` }, 500);
    }
  });

  // ── Manual spec override (user edit) ──
  harness.put('/:slug/projects/:id/spec', async (c) => {
    const id = c.req.param('id');
    const slug = c.req.param('slug');
    let body: { spec?: string; summary?: string; author?: string };
    try { body = await c.req.json(); } catch { return c.json({ error: 'invalid JSON body' }, 400); }
    const spec = body.spec ?? '';
    const summary = body.summary ?? 'Manual edit by operator';
    const author = body.author ?? 'user';

    try {
      const db = dbForSlug(slug);
      const existing = (await db.prepare('SELECT id FROM harness_shared.projects WHERE id = ?').get(id)) as any;
      if (!existing) return c.json({ error: 'project not found' }, 404);
      // Persist as a revision and update the current pointer atomically.
      await db.transaction(async (tx: ReturnType<typeof getLegacyClient>) => {
        await tx.prepare(`
          INSERT INTO harness_shared.project_spec_revisions
            (project_id, spec, summary, author_role, author)
          VALUES (?, ?, ?, 'user', ?)
        `).run(id, spec, summary, author);
        await tx.prepare(`
          UPDATE harness_shared.projects
             SET spec = ?,
                 spec_updated_at = now(),
                 spec_manually_edited_at = now(),
                 updated_ts = ?
           WHERE id = ?
        `).run(spec, Date.now(), id);
      })();
      return c.json({ ok: true });
    } catch (e) {
      return c.json({ error: `failed to update spec: ${(e as Error).message}` }, 500);
    }
  });

  // ── Manually trigger a PM run for this project ──
  // ?async=1 → just queue a pm_due event for the orchestrator (cheap, returns
  //            immediately; PM runs on the next iteration tick).
  // default → run synchronously, returning the new revision id when done
  //            (slower, ~30s of claude time, but the caller knows the
  //            outcome before the response returns).
  harness.post('/:slug/projects/:id/regenerate-spec', async (c) => {
    const id = c.req.param('id');
    const slug = c.req.param('slug');
    const asyncMode = c.req.query('async') === '1';

    try {
      const db = dbForSlug(slug);
      const existing = (await db.prepare('SELECT id FROM harness_shared.projects WHERE id = ?').get(id)) as any;
      if (!existing) return c.json({ error: 'project not found' }, 404);

      if (asyncMode) {
        // Insert a pending_events row of kind='pm_due' that the orchestrator's
        // NEXT_PROJECT_MANAGER decision will pick up on its next tick.
        const eventId = randomUUID();
        await db.prepare(`
          INSERT INTO harness_shared.pending_events
            (id, install_slug, kind, target_role, payload, due_at)
          VALUES (?, ?, 'pm_due', 'project_manager', ?::jsonb, now())
        `).run(eventId, slug, JSON.stringify({ project_id: id, source: 'manual' }));
        return c.json({ ok: true, mode: 'async', event_id: eventId });
      }

      // Sync mode: spawn claude, parse, persist, return.
      const result = await runProjectManager({
        slug, projectId: id, bypassDebounce: true,
      });
      if (!result.ok) {
        return c.json({ error: result.error, detail: result.detail }, 500);
      }
      return c.json({ ok: true, mode: 'sync', ...result });
    } catch (e) {
      return c.json({ error: `failed to run PM: ${(e as Error).message}` }, 500);
    }
  });
}
