/**
 * POST /rotate-secret — JWT signed by old secret.
 * Returns { tenantSecret: <new> }; old secret invalidated atomically.
 */

import { Hono } from 'hono';
import { tenantSecret as newTenantSecret } from '@papercusp/publish-auth';
import type { Env } from '../env.ts';
import { audit, clientIp, rotateTenantSecret } from '../db.ts';
import { jwtMiddleware, type JwtCtxVars } from '../jwt-middleware.ts';

export function rotateSecretRoute(): Hono<{ Bindings: Env; Variables: JwtCtxVars }> {
  const app = new Hono<{ Bindings: Env; Variables: JwtCtxVars }>();

  app.post(
    '/rotate-secret',
    jwtMiddleware({ audience: 'publish' }),
    async (c) => {
      const tenantId = c.get('tenantId');
      const fresh = newTenantSecret();
      await rotateTenantSecret(c.env.DB, tenantId, fresh);
      await audit(c.env.DB, Date.now(), 'rotated', {
        tenantId,
        ip: clientIp(c.req.raw),
      });
      return c.json({ tenantSecret: fresh });
    },
  );

  return app;
}
