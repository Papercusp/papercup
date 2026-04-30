/**
 * GET /publish/status/:deploymentId — JWT'd, audience=publish.
 *
 * Polls CF Pages, mirrors status into deployments row.
 */

import { Hono } from 'hono';
import type { Env } from '../env.ts';
import { getDeployment, getProject, setDeploymentStatus } from '../db.ts';
import { jwtMiddleware, type JwtCtxVars } from '../jwt-middleware.ts';
import { cfStageToStatus, getDeployment as cfGetDeployment } from '../cf-pages.ts';

export function publishStatusRoute(): Hono<{ Bindings: Env; Variables: JwtCtxVars }> {
  const app = new Hono<{ Bindings: Env; Variables: JwtCtxVars }>();

  app.get(
    '/publish/status/:deploymentId',
    jwtMiddleware({ audience: 'publish' }),
    async (c) => {
      const tenantId = c.get('tenantId');
      const dep = await getDeployment(c.env.DB, c.req.param('deploymentId')!);
      if (!dep) return c.json({ error: 'unknown deployment' }, 404);
      if (dep.tenant_id !== tenantId) return c.json({ error: 'forbidden' }, 403);

      let status: 'pending_create' | 'uploading' | 'building' | 'live' | 'failed' = dep.status;
      let failureReason: string | null = dep.failure_reason;

      if (dep.cf_deployment_id && (dep.status === 'building' || dep.status === 'uploading')) {
        const project = await getProject(c.env.DB, tenantId, dep.harness_slug);
        if (project) {
          try {
            const cfDep = await cfGetDeployment(
              c.env,
              project.cf_project_name,
              dep.cf_deployment_id,
            );
            const next = cfStageToStatus(cfDep.latest_stage);
            if (next !== dep.status) {
              status = next;
              const completed = next === 'live' || next === 'failed' ? Date.now() : undefined;
              await setDeploymentStatus(c.env.DB, dep.id, next, {
                completed_at: completed,
                failure_reason: next === 'failed' ? cfDep.latest_stage.name : undefined,
              });
              if (next === 'failed') failureReason = cfDep.latest_stage.name;
            }
          } catch {
            // Transient CF error; just return current row.
          }
        }
      }

      return c.json({
        status,
        vanityUrl: dep.vanity_url,
        failureReason: status === 'failed' ? failureReason : null,
      });
    },
  );

  return app;
}
