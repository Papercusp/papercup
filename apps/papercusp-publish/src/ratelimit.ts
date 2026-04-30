import type { Env } from './env.ts';

export class RateLimitError extends Error {
  constructor(
    public bucket: string,
    public retryAfterSec: number,
  ) {
    super(`rate limit exceeded: ${bucket}`);
  }
}

async function increment(
  kv: KVNamespace,
  key: string,
  ttlSec: number,
  cap: number,
): Promise<void> {
  const cur = parseInt((await kv.get(key)) ?? '0', 10) || 0;
  if (cur >= cap) throw new RateLimitError(key, ttlSec);
  await kv.put(key, String(cur + 1), { expirationTtl: ttlSec });
}

export async function checkTenantBurst(env: Env, tenantId: string): Promise<void> {
  await increment(
    env.COUNTERS,
    `ratelimit:burst:${tenantId}`,
    60,
    parseInt(env.RATE_PER_TENANT_BURST, 10),
  );
}

export async function checkTenantDaily(
  env: Env,
  tenantId: string,
  tier: 'free' | 'paid' | 'self-host-byo',
): Promise<void> {
  const cap =
    tier === 'paid'
      ? parseInt(env.RATE_PER_TENANT_DAILY_PAID, 10)
      : parseInt(env.RATE_PER_TENANT_DAILY_FREE, 10);
  await increment(env.COUNTERS, `ratelimit:daily:${tenantId}`, 86400, cap);
}

export async function checkIpPublishDaily(env: Env, ip: string): Promise<void> {
  if (!ip) return;
  await increment(
    env.COUNTERS,
    `ratelimit:ip-publish-daily:${ip}`,
    86400,
    parseInt(env.RATE_PER_IP_PUBLISH_DAILY, 10),
  );
}

export async function checkIpRegisterHourly(env: Env, ip: string): Promise<void> {
  if (!ip) return;
  await increment(
    env.COUNTERS,
    `ratelimit:ip-register-hourly:${ip}`,
    3600,
    parseInt(env.RATE_PER_IP_REGISTER_HOURLY, 10),
  );
}
