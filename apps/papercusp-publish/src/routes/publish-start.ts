/**
 * POST /publish/start — JCS canonical manifest in body.
 *
 * 1. JWT verified by middleware (sig + replay + aud).
 * 2. Body re-canonicalized; sha256 must match claims.sha256.
 * 3. Rate limits: tenant burst, tenant daily, IP publish daily.
 * 4. Validate caps: file count, total bytes, per-file bytes.
 * 5. ensureProject(cfProjectName) (D1-cached).
 * 6. Idempotency: re-POSTing the same manifest within 30 min returns the
 *    existing deploymentId; only files not yet uploaded are returned in missing[].
 * 7. Per-file signed-URL tokens minted for missing[].
 */

import { Hono } from 'hono';
import {
  manifestSha256Hex,
  mintFileToken,
  deploymentId as newDeploymentId,
  b64uDecode,
  type CanonicalManifest,
} from '@papercusp/publish-auth';
import type { Env } from '../env.ts';
import {
  audit,
  clientIp,
  findRecentDeploymentByManifest,
  getProject,
  insertDeployment,
  insertDeploymentFiles,
  insertProject,
  listDeploymentFiles,
} from '../db.ts';
import { jwtMiddleware, type JwtCtxVars } from '../jwt-middleware.ts';
import {
  checkIpPublishDaily,
  checkTenantBurst,
  checkTenantDaily,
  RateLimitError,
} from '../ratelimit.ts';
import { ensureProject } from '../cf-pages.ts';
import { cfProjectName, vanitySubdomain } from '../project-naming.ts';

const IDEMPOTENCY_WINDOW_MS = 30 * 60 * 1000;
const FILE_TOKEN_TTL_SEC = 900;

export function publishStartRoute(): Hono<{ Bindings: Env; Variables: JwtCtxVars }> {
  const app = new Hono<{ Bindings: Env; Variables: JwtCtxVars }>();

  app.post(
    '/publish/start',
    jwtMiddleware({ audience: 'publish' }),
    async (c) => {
      const env = c.env;
      const claims = c.get('jwt');
      const tenantId = c.get('tenantId');
      const ip = clientIp(c.req.raw);

      let manifest: CanonicalManifest;
      try {
        manifest = (await c.req.json()) as CanonicalManifest;
      } catch {
        return c.json({ error: 'invalid json body' }, 400);
      }

      if (!manifest?.deployment_slug || !Array.isArray(manifest.files)) {
        return c.json({ error: 'malformed manifest' }, 400);
      }

      const recomputed = await manifestSha256Hex(manifest);
      if (recomputed !== claims.sha256) {
        return c.json({ error: 'manifest sha256 does not match jwt claim' }, 400);
      }

      const filesCap = parseInt(env.DEPLOYMENT_FILES_CAP, 10);
      const bytesCap = parseInt(env.DEPLOYMENT_BYTES_CAP, 10);
      const perFileCap = parseInt(env.PER_FILE_BYTES_CAP, 10);
      if (manifest.files.length > filesCap) {
        return c.json({ error: `too many files (max ${filesCap})` }, 413);
      }
      let totalBytes = 0;
      for (const f of manifest.files) {
        if (f.bytes > perFileCap)
          return c.json(
            { error: `file ${f.path} exceeds per-file cap of ${perFileCap}` },
            413,
          );
        totalBytes += f.bytes;
      }
      if (totalBytes > bytesCap) {
        return c.json({ error: `total bytes ${totalBytes} exceeds cap ${bytesCap}` }, 413);
      }

      const tenantRow = await env.DB
        .prepare('SELECT tier FROM tenants WHERE id = ?')
        .bind(tenantId)
        .first<{ tier: 'free' | 'paid' | 'self-host-byo' }>();
      const tier = tenantRow?.tier ?? 'free';

      try {
        await checkTenantBurst(env, tenantId);
        await checkTenantDaily(env, tenantId, tier);
        await checkIpPublishDaily(env, ip);
      } catch (e) {
        if (e instanceof RateLimitError) {
          await audit(env.DB, Date.now(), 'rate_limited', { tenantId, ip });
          return c.json({ error: 'rate limited', bucket: e.bucket }, 429);
        }
        throw e;
      }

      // Idempotency: same manifest within 30min returns existing deploymentId.
      const existing = await findRecentDeploymentByManifest(
        env.DB,
        tenantId,
        manifest.deployment_slug,
        recomputed,
        Date.now() - IDEMPOTENCY_WINDOW_MS,
      );

      const tenantSecret = await env.DB
        .prepare('SELECT secret_b64 FROM tenants WHERE id = ?')
        .bind(tenantId)
        .first<{ secret_b64: string }>();
      if (!tenantSecret) return c.json({ error: 'tenant lookup failed' }, 500);

      const cfName = await cfProjectName(tenantSecret.secret_b64, manifest.deployment_slug);
      let project = await getProject(env.DB, tenantId, manifest.deployment_slug);
      let createdProject = false;

      if (!project) {
        const ensured = await ensureProject(env, cfName);
        createdProject = ensured.created;
        const vanity = vanitySubdomain(manifest.deployment_slug);
        const row = {
          tenant_id: tenantId,
          harness_slug: manifest.deployment_slug,
          cf_project_name: cfName,
          cf_subdomain: ensured.project.subdomain ?? null,
          vanity_subdomain: vanity,
          created_at: Date.now(),
        };
        await insertProject(env.DB, row);
        project = row;
      }

      let depId: string;
      if (existing) {
        depId = existing.id;
      } else {
        depId = newDeploymentId();
        await insertDeployment(env.DB, {
          id: depId,
          tenant_id: tenantId,
          harness_slug: manifest.deployment_slug,
          vanity_url: `https://${project.vanity_subdomain}.${env.VANITY_HOST}`,
          manifest_sha: recomputed,
          bytes_total: totalBytes,
          files_count: manifest.files.length,
          status: 'uploading',
          created_at: Date.now(),
        });
        await insertDeploymentFiles(env.DB, depId, manifest.files);
      }

      // Compute missing[] (not-yet-uploaded files).
      const persisted = await listDeploymentFiles(env.DB, depId);
      const uploadedShas = new Set(
        persisted.filter((p) => p.uploaded === 1).map((p) => p.sha256),
      );
      const exp = Math.floor(Date.now() / 1000) + FILE_TOKEN_TTL_SEC;
      const fileKey = b64uDecode(env.JWT_SECRET);
      const missing = await Promise.all(
        manifest.files
          .filter((f) => !uploadedShas.has(f.sha256))
          .map(async (f) => ({
            path: f.path,
            sha256: f.sha256,
            uploadUrl: `https://${env.PUBLISH_HOST}/publish/file/${depId}/${f.sha256}?token=${await mintFileToken(
              fileKey,
              { deploymentId: depId, sha256: f.sha256, exp },
            )}`,
          })),
      );

      await audit(env.DB, Date.now(), 'publish_started', {
        tenantId,
        harnessSlug: manifest.deployment_slug,
        deploymentId: depId,
        ip,
        manifestSha: recomputed,
        bytesTotal: totalBytes,
      });

      return c.json({
        deploymentId: depId,
        missing,
        vanityUrl: `https://${project.vanity_subdomain}.${env.VANITY_HOST}`,
        createdProject,
      });
    },
  );

  return app;
}
