import { describe, expect, it } from 'vitest';
import { decideGatewayAdmission, issueForeignGatewayCredential } from './gateway-attribution';

describe('issueForeignGatewayCredential', () => {
  it('issues a credential attributed to the session, scoped to the hive, TTL-bounded', () => {
    const c = issueForeignGatewayCredential({ sessionId: 'sess-1', scopePotSlug: 'gh-777/widgets', now: 1000 });
    expect(c.sessionId).toBe('sess-1');
    expect(c.scopePotSlug).toBe('gh-777/widgets');
    expect(c.issuedAtMs).toBe(1000);
    expect(c.expiresAtMs).toBe(1000 + 15 * 60 * 1000);
  });

  it('respects a custom TTL', () => {
    const c = issueForeignGatewayCredential({ sessionId: 's', scopePotSlug: 'h', now: 0, ttlMs: 5000 });
    expect(c.expiresAtMs).toBe(5000);
  });

  it('rejects a blank sessionId / scopePotSlug / non-positive ttl', () => {
    expect(() => issueForeignGatewayCredential({ sessionId: '  ', scopePotSlug: 'h', now: 0 })).toThrow();
    expect(() => issueForeignGatewayCredential({ sessionId: 's', scopePotSlug: '', now: 0 })).toThrow();
    expect(() => issueForeignGatewayCredential({ sessionId: 's', scopePotSlug: 'h', now: 0, ttlMs: 0 })).toThrow();
  });
});

describe('decideGatewayAdmission', () => {
  const cred = issueForeignGatewayCredential({ sessionId: 'sess-1', scopePotSlug: 'gh-777/widgets', now: 1000 });

  it('refuses an unattributed loopback call (no credential) — never fail-open', () => {
    const d = decideGatewayAdmission({ credential: null, now: 1000, requestedPotSlug: 'gh-777/widgets' });
    expect(d.allow).toBe(false);
    if (!d.allow) expect(d.reason).toBe('unattributed_loopback_call');
  });

  it('allows a live, correctly-scoped credential', () => {
    const d = decideGatewayAdmission({ credential: cred, now: 1000, requestedPotSlug: 'gh-777/widgets' });
    expect(d.allow).toBe(true);
    if (d.allow) expect(d.sessionId).toBe('sess-1');
  });

  it('refuses an expired credential (boundary: now === expiresAtMs refuses)', () => {
    const d = decideGatewayAdmission({ credential: cred, now: cred.expiresAtMs, requestedPotSlug: 'gh-777/widgets' });
    expect(d.allow).toBe(false);
    if (!d.allow) expect(d.reason).toBe('credential_expired');
  });

  it('refuses a hive-scope mismatch (a credential cannot be reused cross-hive)', () => {
    const d = decideGatewayAdmission({ credential: cred, now: 1000, requestedPotSlug: 'gh-999/other' });
    expect(d.allow).toBe(false);
    if (!d.allow) expect(d.reason).toBe('hive_scope_mismatch');
  });
});
