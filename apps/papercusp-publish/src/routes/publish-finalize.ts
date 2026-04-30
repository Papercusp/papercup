/**
 * POST /publish/finalize { deploymentId } — JWT'd, audience=publish.
 *
 * 1. All deployment_files rows must be uploaded=1.
 * 2. Build CF deployment manifest { path: { hash, size } } from rows.
 * 3. Call CF Pages /deployments → get cf_deployment_id.
 * 4. Update deployments.status='building', cf_deployment_id=...
 * 5. Async: write manifest.json to R2 archive.
 */

import { Hono } from 'hono';
import type { Env } from '../env.ts';
import {
  audit,
  clientIp,
  getDeployment,
  getProject,
  listDeploymentFiles,
  setDeploymentStatus,
} from '../db.ts';
import { jwtMiddleware, type JwtCtxVars } from '../jwt-middleware.ts';
import { createDeployment } from '../cf-pages.ts';
import { archivePath, writeManifest } from '../r2-archive.ts';

export function publishFinalizeRoute(): Hono<{ Bindings: Env; Variables: JwtCtxVars }> {
  const app = new Hono<{ Bindings: Env; Variables: JwtCtxVars }>();

  app.post(
    '/publish/finalize',
    jwtMiddleware({ audience: 'publish' }),
    async (c) => {
      const tenantId = c.get('tenantId');
      const env = c.env;
      const body = (await c.req.json().catch(() => ({}))) as { deploymentId?: string };
      if (!body.deploymentId) return c.json({ error: 'deploymentId required' }, 400);

      const dep = await getDeployment(env.DB, body.deploymentId);
      if (!dep) return c.json({ error: 'unknown deployment' }, 404);
      if (dep.tenant_id !== tenantId) return c.json({ error: 'forbidden' }, 403);

      const project = await getProject(env.DB, tenantId, dep.harness_slug);
      if (!project) return c.json({ error: 'project lookup failed' }, 500);

      const files = await listDeploymentFiles(env.DB, dep.id);
      const incomplete = files.filter((f) => f.uploaded !== 1);
      if (incomplete.length > 0) {
        return c.json(
          { error: 'uploads incomplete', missingCount: incomplete.length },
          409,
        );
      }

      const cfManifest: Record<string, { hash: string; size: number }> = {};
      for (const f of files) {
        cfManifest[f.path] = { hash: f.sha256, size: f.bytes };
      }

      let cfDeployment;
      try {
        cfDeployment = await createDeployment(env, project.cf_project_name, cfManifest);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        await setDeploymentStatus(env.DB, dep.id, 'failed', { failure_reason: msg });
        await audit(env.DB, Date.now(), 'cf_error', {
          tenantId,
          harnessSlug: dep.harness_slug,
          deploymentId: dep.id,
          ip: clientIp(c.req.raw),
        });
        return c.json({ error: 'cloudflare deployment failed', detail: msg }, 502);
      }

      const archiveKey = archivePath(env, tenantId, dep.id);
      await setDeploymentStatus(env.DB, dep.id, 'building', {
        cf_deployment_id: cfDeployment.id,
        archive_path: archiveKey,
      });

      // Fire-and-forget archive write (waitUntil keeps it alive past response).
      c.executionCtx.waitUntil(
        writeManifest(
          env,
          tenantId,
          dep.id,
          JSON.stringify({
            schemaVersion: 1,
            kind: 'publish',
            id: dep.id,
            tenant_id: tenantId,
            harness_slug: dep.harness_slug,
            manifest_sha: dep.manifest_sha,
            files: files.map((f) => ({ path: f.path, sha256: f.sha256, bytes: f.bytes })),
            created_at: dep.created_at,
            cf_project_name: project.cf_project_name,
            cf_deployment_id: cfDeployment.id,
          }),
        ),
      );

      await audit(env.DB, Date.now(), 'finalized', {
        tenantId,
        harnessSlug: dep.harness_slug,
        deploymentId: dep.id,
        ip: clientIp(c.req.raw),
        bytesTotal: dep.bytes_total,
      });

      return c.json({
        vanityUrl: dep.vanity_url,
        status: 'building',
      });
    },
  );

  return app;
}
