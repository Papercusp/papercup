import {
  parseJwt,
  verifyJwt,
  derivePublishKey,
  b64uDecode,
  type JwtClaims,
} from '@papercusp/publish-auth';
import type { Context, MiddlewareHandler } from 'hono';
import type { Env } from './env.ts';
import { audit, clientIp, consumeJti, getTenant, touchTenant } from './db.ts';

export interface JwtCtxVars {
  jwt: JwtClaims;
  tenantId: string;
}

const TYPED_CTX = {} as { Bindings: Env; Variables: JwtCtxVars };

export interface JwtMiddlewareOpts {
  audience: 'publish' | 'snapshot';
  expectedSha256?: (c: Context<typeof TYPED_CTX>) => string | undefined;
}

export function jwtMiddleware(
  opts: JwtMiddlewareOpts = { audience: 'publish' },
): MiddlewareHandler<typeof TYPED_CTX> {
  return async (c, next) => {
    const env = c.env;
    const tok = (c.req.header('authorization') ?? '').replace(/^Bearer /, '');
    if (!tok) return c.json({ error: 'missing bearer token' }, 401);

    let claims: JwtClaims;
    try {
      const parsed = parseJwt(tok);
      const tenant = await getTenant(env.DB, parsed.claims.sub);
      if (!tenant) {
        await auditFail(env, c, 'unknown_tenant');
        return c.json({ error: 'unknown tenant' }, 401);
      }
      if (tenant.status !== 'active') {
        await auditFail(env, c, `tenant_${tenant.status}`);
        return c.json({ error: 'tenant not active' }, 401);
      }

      const verifyKey = await derivePublishKey(b64uDecode(tenant.secret_b64));
      claims = await verifyJwt(verifyKey, tok, {
        audience: opts.audience,
        expectedSub: tenant.id,
        expectedSha256: opts.expectedSha256?.(c),
      });

      const ok = await consumeJti(env.DB, claims.jti, claims.exp);
      if (!ok) {
        await auditFail(env, c, 'jwt_replay', tenant.id);
        return c.json({ error: 'jwt replay detected' }, 401);
      }

      await touchTenant(env.DB, tenant.id, clientIp(c.req.raw), Date.now());
      c.set('jwt', claims);
      c.set('tenantId', tenant.id);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      await auditFail(env, c, 'invalid_jwt');
      return c.json({ error: msg }, 401);
    }
    await next();
  };
}

async function auditFail(
  env: Env,
  c: Context<typeof TYPED_CTX>,
  outcome: string,
  tenantId?: string,
): Promise<void> {
  await audit(env.DB, Date.now(), outcome, {
    tenantId: tenantId ?? null,
    ip: clientIp(c.req.raw),
    ua: c.req.header('user-agent') ?? null,
  });
}
