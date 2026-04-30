import { describe, expect, it } from 'vitest';
import { hashTenantSecret, verifyTenantSecret } from './secret-hash';
import { randomBytes, tenantSecret } from './random';

describe('tenant secret hash', () => {
  it('verify returns true for matching secret', async () => {
    const pepper = randomBytes(32);
    const s = tenantSecret();
    const hash = await hashTenantSecret(s, pepper);
    expect(await verifyTenantSecret(s, pepper, hash)).toBe(true);
  });

  it('verify returns false for wrong secret', async () => {
    const pepper = randomBytes(32);
    const a = tenantSecret();
    const b = tenantSecret();
    const hash = await hashTenantSecret(a, pepper);
    expect(await verifyTenantSecret(b, pepper, hash)).toBe(false);
  });

  it('different peppers produce different hashes', async () => {
    const s = tenantSecret();
    const h1 = await hashTenantSecret(s, randomBytes(32));
    const h2 = await hashTenantSecret(s, randomBytes(32));
    expect(h1).not.toBe(h2);
  });

  it('hash is 64 hex chars', async () => {
    const h = await hashTenantSecret('s', randomBytes(32));
    expect(h).toMatch(/^[0-9a-f]{64}$/);
  });

  it('verify returns false on malformed stored hash', async () => {
    expect(await verifyTenantSecret('s', randomBytes(32), 'not-hex')).toBe(false);
  });
});
