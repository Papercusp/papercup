/**
 * POST /register-tenant — anonymous v1 (OAuth-bound in v1.1).
 *
 * Returns { tenantId, tenantSecret } once. Substrate writes both to
 * ~/.papercusp/publish-credentials.json (chmod 600).
 *
 * Per-IP register-hourly rate limit (10/h) closes a register-spam loop.
 */

import { Hono } from 'hono';
import { tenantId as newTenantId, tenantSecret as newTenantSecret } from '@papercusp/publish-auth';
import type { Env } from '../env.ts';
import { audit, clientIp, insertTenant } from '../db.ts';
import { checkIpRegisterHourly, RateLimitError } from '../ratelimit.ts';

export function registerRoute(): Hono<{ Bindings: Env }> {
  const app = new Hono<{ Bindings: Env }>();

  app.post('/register-tenant', async (c) => {
    const ip = clientIp(c.req.raw);
    try {
      await checkIpRegisterHourly(c.env, ip);
    } catch (e) {
      if (e instanceof RateLimitError) {
        await audit(c.env.DB, Date.now(), 'rate_limited', { ip });
        return c.json({ error: 'rate limited' }, 429);
      }
      throw e;
    }

    const id = newTenantId();
    const secret = newTenantSecret();
    await insertTenant(c.env.DB, {
      id,
      secret_b64: secret,
      secret_v: 1,
      created_at: Date.now(),
      status: 'active',
      tier: 'free',
    });
    await audit(c.env.DB, Date.now(), 'registered', { tenantId: id, ip });
    return c.json({ tenantId: id, tenantSecret: secret });
  });

  return app;
}
