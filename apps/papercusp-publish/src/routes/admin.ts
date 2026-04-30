/**
 * Admin / cron endpoints. Hit by scheduled trigger only — not exposed
 * publicly (route reachable, but does no work without internal token).
 */

import { Hono } from 'hono';
import type { Env } from '../env.ts';
import { setDeploymentStatus } from '../db.ts';
import { deletePrefix } from '../r2-archive.ts';
import { deleteDeployment, getProject } from '../cf-pages.ts';

export function adminRoute(): Hono<{ Bindings: Env }> {
  const app = new Hono<{ Bindings: Env }>();

  // Deployments stuck in 'uploading' for > 1 hour: abandon them, delete CF
  // upload tokens (CF auto-expires those), GC the D1 row.
  app.post('/admin/gc/abandoned-uploads', async (c) => {
    const cutoff = Date.now() - 60 * 60 * 1000;
    const stale = await c.env.DB
      .prepare(
        "SELECT id, tenant_id, harness_slug FROM deployments WHERE status = 'uploading' AND created_at < ?",
      )
      .bind(cutoff)
      .all<{ id: string; tenant_id: string; harness_slug: string }>();
    let killed = 0;
    for (const r of stale.results ?? []) {
      await setDeploymentStatus(c.env.DB, r.id, 'failed', {
        failure_reason: 'abandoned (gc)',
      });
      killed++;
    }
    return c.json({ killed });
  });

  // R2 archive expiry — free 30d, paid 1y. Deletes prefixes past TTL.
  app.post('/admin/gc/expired-archives', async (c) => {
    const now = Date.now();
    const freeCutoff = now - 30 * 24 * 60 * 60 * 1000;
    const paidCutoff = now - 365 * 24 * 60 * 60 * 1000;
    const expired = await c.env.DB
      .prepare(
        `SELECT d.id, d.tenant_id, t.tier
         FROM deployments d JOIN tenants t ON d.tenant_id = t.id
         WHERE d.archive_path IS NOT NULL
           AND ((t.tier = 'free' AND d.created_at < ?)
             OR (t.tier = 'paid' AND d.created_at < ?))`,
      )
      .bind(freeCutoff, paidCutoff)
      .all<{ id: string; tenant_id: string; tier: string }>();
    let purged = 0;
    for (const r of expired.results ?? []) {
      await deletePrefix(c.env, r.tenant_id, r.id);
      await c.env.DB
        .prepare('UPDATE deployments SET archive_path = NULL WHERE id = ?')
        .bind(r.id)
        .run();
      purged++;
    }
    return c.json({ purged });
  });

  // Stale jti rows
  app.post('/admin/gc/jti', async (c) => {
    const now = Math.floor(Date.now() / 1000);
    await c.env.DB.prepare('DELETE FROM jti_used WHERE exp < ?').bind(now).run();
    return c.json({ ok: true });
  });

  return app;
}
