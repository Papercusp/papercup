import { describe, expect, it } from 'vitest';
import {
  activeSupportAccessBanner,
  assertGovernancePayloadSafe,
  normalizeHostedLocale,
  normalizeHostedTimeZone,
  supportAccessState,
  validateSupportAccessGrant,
} from './governance';

const NOW = new Date('2026-08-23T12:00:00.000Z');

describe('hosted governance core', () => {
  it('rejects secret-bearing keys and values at any payload depth', () => {
    expect(() => assertGovernancePayloadSafe({ nested: { refresh_token: 'redacted' } }))
      .toThrow(/forbidden governance field/);
    expect(() => assertGovernancePayloadSafe({ headers: ['Bearer abcdefghijklmnopqrstuvwxyz'] }))
      .toThrow(/credential-like material/);
    expect(() => assertGovernancePayloadSafe({ channel: 'email', digest: { enabled: true } }))
      .not.toThrow();
  });

  it('normalizes locale/timezone preferences and rejects invalid values', () => {
    expect(normalizeHostedLocale('en_US')).toBe('en-US');
    expect(normalizeHostedTimeZone('America/New_York')).toBe('America/New_York');
    expect(() => normalizeHostedLocale('not a locale')).toThrow(/invalid locale/);
    expect(() => normalizeHostedTimeZone('Moon/Sea_of_Tranquility')).toThrow(/invalid timeZone/);
  });

  it('requires bounded, purpose-scoped, non-wildcard support access', () => {
    const input = {
      organizationId: '11111111-1111-4111-8111-111111111111',
      staffPrincipalId: 'staff:case-42',
      grantedByUserId: '22222222-2222-4222-8222-222222222222',
      purpose: 'Diagnose workspace boot failure',
      scopes: ['workspace:read', 'logs:read', 'logs:read'],
      bannerMessage: 'Papercusp support has temporary access for case 42.',
      startsAt: new Date('2026-08-23T11:00:00.000Z'),
      expiresAt: new Date('2026-08-23T13:00:00.000Z'),
    };

    expect(validateSupportAccessGrant(input).scopes).toEqual(['workspace:read', 'logs:read']);
    expect(() => validateSupportAccessGrant({ ...input, scopes: ['*'] })).toThrow(/wildcard/);
    expect(() => validateSupportAccessGrant({ ...input, expiresAt: input.startsAt })).toThrow(/expire after/);
  });

  it('derives banner visibility from the grant window and revocation', () => {
    const grant = {
      startsAt: new Date('2026-08-23T11:00:00.000Z'),
      expiresAt: new Date('2026-08-23T13:00:00.000Z'),
      bannerMessage: 'Support access is active.',
    };

    expect(supportAccessState(grant, new Date('2026-08-23T10:59:59.000Z'))).toBe('pending');
    expect(supportAccessState(grant, NOW)).toBe('active');
    expect(activeSupportAccessBanner(grant, NOW)).toBe('Support access is active.');
    expect(supportAccessState(grant, grant.expiresAt)).toBe('expired');
    expect(activeSupportAccessBanner({ ...grant, revokedAt: NOW }, NOW)).toBeNull();
  });
});
